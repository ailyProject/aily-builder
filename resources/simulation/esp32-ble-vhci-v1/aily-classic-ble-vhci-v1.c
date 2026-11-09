/* Simulation-only classic ESP32 SDK-controller ABI adapter, not a GATT/controller emulator.
 * The unmodified IDF Bluedroid host sends/receives complete H4 packets through AHC2.
 * No HCI event, command credit, address, ATT response or peer ACK is fabricated here.
 * The default selects LE. An explicit package-owned SPP inclusion selects the
 * Classic/BTDM controller mode over this same transport and lifecycle. Neither
 * inclusion fabricates controller responses or advertises peer readiness.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "esp_bt.h"
#include "esp_err.h"
#if !defined(AILY_CLASSIC_AHC2_SPP)
#include "esp_gap_ble_api.h"
#endif
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "aily_packet_abi.h"

#if !defined(CONFIG_IDF_TARGET_ESP32) || !CONFIG_BT_BLUEDROID_ENABLED
#error "This adapter requires the classic ESP32 Bluedroid SDK ABI."
#endif
#if defined(AILY_CLASSIC_AHC2_SPP)
#if AILY_CLASSIC_AHC2_SPP != 1 || !CONFIG_BT_CLASSIC_ENABLED || !CONFIG_BT_SPP_ENABLED
#error "The explicit SPP inclusion requires the classic ESP32 SPP SDK configuration."
#endif
#elif !CONFIG_BT_BLE_ENABLED
#error "The default inclusion requires the classic ESP32 BLE SDK configuration."
#endif
_Static_assert(sizeof(esp_bt_controller_config_t) == 48, "Classic SDK config ABI changed");
_Static_assert(offsetof(esp_bt_controller_config_t, mode) == 20, "Classic mode ABI changed");
_Static_assert(offsetof(esp_bt_controller_config_t, magic) == 44, "Classic magic ABI changed");
_Static_assert(sizeof(esp_vhci_host_callback_t) == 8, "Xtensa32 callback ABI changed");
#define AILY_HCI_CLASSIC_BASE UINT32_C(0x3ff7f000)

#if !defined(AILY_CLASSIC_AHC2_SPP)
/* IDF5.5.4 accepts an empty raw response, but its BTC deep-copy skips a
 * zero-length buffer while deep-free still releases a non-NULL pointer.
 * Arduino's empty String may point into SSO storage. Preserve the legal empty
 * operation with no borrowed buffer; the actual SDK owns all results/events. */
extern __typeof__(esp_ble_gap_config_scan_rsp_data_raw) __real_esp_ble_gap_config_scan_rsp_data_raw;
esp_err_t __wrap_esp_ble_gap_config_scan_rsp_data_raw(uint8_t *raw_data, uint32_t raw_data_len) {
  return __real_esp_ble_gap_config_scan_rsp_data_raw(raw_data_len == 0 ? NULL : raw_data, raw_data_len);
}

#endif

static const char *TAG = "aily-classic-vhci";
/* Guard objects have static lifetime; only the RX task is created/deleted per init.
 * This prevents a late API caller from using a freed synchronization object.
 */
static StaticSemaphore_t lock_storage, done_storage, quiet_storage;
static SemaphoreHandle_t lock, done, quiet;
static TaskHandle_t receiver;
static esp_bt_controller_status_t state = ESP_BT_CONTROLLER_STATUS_IDLE;
static esp_vhci_host_callback_t callbacks;
static esp_bt_mode_t configured_mode = ESP_BT_MODE_IDLE;
static unsigned released_modes;
static uint32_t transport_epoch;
static bool failed, stopping, joining, send_notify_pending, quiescing, quiet_waiting;
/* A contended nonblocking check must be revisited even when local capacity
 * never falls. This requests a capacity notification, never packet replay. */
static uint32_t send_check_retry;

static uint32_t reg_read(unsigned offset) {
  return *(volatile uint32_t *)(uintptr_t)(AILY_HCI_CLASSIC_BASE + offset);
}
static void reg_write(unsigned offset, uint32_t value) {
  *(volatile uint32_t *)(uintptr_t)(AILY_HCI_CLASSIC_BASE + offset) = value;
}
static bool identity(void) {
  return reg_read(AILY_PACKET_MAGIC_REG) == AILY_HCI_MAGIC &&
    reg_read(AILY_PACKET_SCHEMA_REG) == AILY_PACKET_SCHEMA &&
    reg_read(AILY_PACKET_MAX_REG) == AILY_HCI_MAX_PACKET;
}
static void fence_locked(const char *reason) {
  if (!failed) ESP_LOGE(TAG, "transport fenced: %s (not a peer ACK)", reason);
  failed = true;
  if (identity()) reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
  /* Keep controller state until explicit disable/deinit; availability becomes false. */
}
static bool healthy_locked(void) {
  uint32_t status = reg_read(AILY_PACKET_STATUS_REG);
  if (failed || state != ESP_BT_CONTROLLER_STATUS_ENABLED) return false;
  if (!identity() || reg_read(AILY_PACKET_EPOCH_REG) != transport_epoch ||
      (status & (AILY_PACKET_CONNECTED | AILY_PACKET_ENABLED | AILY_PACKET_FAULT)) !=
        (AILY_PACKET_CONNECTED | AILY_PACKET_ENABLED)) {
    fence_locked("controller identity, epoch, connection or status changed");
    return false;
  }
  return true;
}
static bool h4_valid(const uint8_t *bytes, uint16_t size, bool incoming) {
  if (!bytes || !size || size > AILY_HCI_MAX_PACKET) return false;
  if (bytes[0] == 2) { /* ACL: handle/flags LE16, payload length LE16. */
    return size >= 5 && ((unsigned)bytes[3] | ((unsigned)bytes[4] << 8)) <= 1024 &&
      size == 5u + ((unsigned)bytes[3] | ((unsigned)bytes[4] << 8));
  }
  if (incoming && bytes[0] == 4) return size >= 3 && size == 3u + bytes[2];
  if (!incoming && bytes[0] == 1) return size >= 4 && size == 4u + bytes[3];
  return false; /* No SCO/ISO, wrong direction or truncated packet. */
}

static void receive_loop(void *unused) {
  (void)unused;
  bool was_available = false;
  uint8_t bytes[AILY_HCI_MAX_PACKET];
  for (;;) {
    void (*available_callback)(void) = NULL;
    int (*receive_callback)(uint8_t *, uint16_t) = NULL;
    uint32_t packet_epoch = 0;
    uint16_t size = 0;
    xSemaphoreTake(lock, portMAX_DELAY);
    if (stopping) {
      xSemaphoreGive(lock);
      xSemaphoreGive(done);
      /* Deinit joins this checkpoint then deletes this exact task. */
      vTaskSuspend(NULL);
      continue;
    }
    if (quiescing) {
      /* All callbacks selected in the prior turn have actually returned. */
      xSemaphoreGive(quiet);
      xSemaphoreGive(lock);
      vTaskDelay(1);
      continue;
    }
    if (healthy_locked()) {
      bool available = reg_read(AILY_PACKET_TX_CAP_REG) >= AILY_HCI_MAX_PACKET;
      /* Exchange only inside the real availability gate. A later contended
       * check remains latched for the next polling turn. */
      bool retry = available && callbacks.notify_host_send_available &&
        __atomic_exchange_n(&send_check_retry, 0u, __ATOMIC_ACQ_REL) != 0;
      if (available && (!was_available || send_notify_pending || retry) && callbacks.notify_host_send_available) {
        available_callback = callbacks.notify_host_send_available;
        send_notify_pending = false;
      }
      was_available = available;
      uint32_t length = reg_read(AILY_PACKET_RX_LEN_REG);
      if (length && callbacks.notify_host_recv) {
        if (length > AILY_HCI_MAX_PACKET || reg_read(AILY_PACKET_RX_REMAIN_REG) != length) {
          fence_locked("invalid RX front packet length");
        } else {
          bool invalid = false;
          for (unsigned index = 0; index < length; ++index) {
            uint32_t value = reg_read(AILY_PACKET_RX_DATA_REG);
            if (value > 255) { invalid = true; break; }
            bytes[index] = (uint8_t)value;
          }
          if (invalid || reg_read(AILY_PACKET_RX_REMAIN_REG) != 0 ||
              !h4_valid(bytes, (uint16_t)length, true)) {
            fence_locked("malformed or incomplete incoming H4");
          } else {
            packet_epoch = transport_epoch;
            size = (uint16_t)length;
            receive_callback = callbacks.notify_host_recv;
          }
        }
      }
    } else was_available = false;
    xSemaphoreGive(lock);
    /* Actual SDK callback can reenter check/send. Never hold our mutex across it. */
    if (receive_callback) {
      int result = receive_callback(bytes, size);
      xSemaphoreTake(lock, portMAX_DELAY);
      if (healthy_locked() && transport_epoch == packet_epoch) {
        if (result != 0) fence_locked("Bluedroid RX callback rejected packet; no replay");
        else {
          reg_write(AILY_PACKET_RX_ACK_REG, size);
          (void)healthy_locked();
        }
      }
      xSemaphoreGive(lock);
    }
    if (available_callback) {
      xSemaphoreTake(lock, portMAX_DELAY);
      bool invoke = healthy_locked() && callbacks.notify_host_send_available == available_callback;
      xSemaphoreGive(lock);
      if (invoke) available_callback();
    }
    vTaskDelay(1); /* Bounded one-packet polling turn, yields to the real Host. */
  }
}

/* Called with lock held; returns with it held. A successful checkpoint means
 * the original RX task has left every old callback, not that a peer received
 * anything. The selected SDK itself waits portMAX_DELAY during HCI deinit and
 * ignores its dummy-registration result before freeing buffers. Do not return
 * a made-up successful replacement while an old callback still owns them.
 */
static esp_err_t quiesce_locked(void) {
  if (!receiver || quiet_waiting || stopping || joining || xTaskGetCurrentTaskHandle() == receiver)
    return ESP_ERR_INVALID_STATE;
  if (!quiescing) {
    quiescing = true;
    (void)xSemaphoreTake(quiet, 0);
  }
  quiet_waiting = true;
  xSemaphoreGive(lock);
  bool confirmed = xSemaphoreTake(quiet, portMAX_DELAY) == pdTRUE;
  xSemaphoreTake(lock, portMAX_DELAY);
  quiet_waiting = false;
  if (!confirmed) return ESP_ERR_TIMEOUT; /* Keep original quiescence for explicit retry. */
  return ESP_OK;
}

esp_err_t __wrap_esp_bt_controller_init(esp_bt_controller_config_t *cfg) {
  if (!cfg || cfg->magic != ESP_BT_CONTROLLER_CONFIG_MAGIC_VAL ||
#if defined(AILY_CLASSIC_AHC2_SPP)
      (cfg->mode != ESP_BT_MODE_CLASSIC_BT && cfg->mode != ESP_BT_MODE_BTDM))
#else
      (cfg->mode != ESP_BT_MODE_BLE && cfg->mode != ESP_BT_MODE_BTDM))
#endif
    return ESP_ERR_INVALID_ARG;
  if (!lock) {
    lock = xSemaphoreCreateMutexStatic(&lock_storage);
    done = xSemaphoreCreateBinaryStatic(&done_storage);
    quiet = xSemaphoreCreateBinaryStatic(&quiet_storage);
    if (!lock || !done || !quiet) return ESP_ERR_NO_MEM;
  }
  xSemaphoreTake(lock, portMAX_DELAY);
  if (state != ESP_BT_CONTROLLER_STATUS_IDLE || receiver) {
    xSemaphoreGive(lock); return ESP_ERR_INVALID_STATE;
  }
  if ((released_modes & (unsigned)cfg->mode) != 0) {
    xSemaphoreGive(lock); return ESP_ERR_INVALID_STATE;
  }
  if (!identity() || !(reg_read(AILY_PACKET_STATUS_REG) & AILY_PACKET_CONNECTED)) {
    xSemaphoreGive(lock); return ESP_ERR_NOT_FOUND;
  }
  reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_RESET);
  transport_epoch = reg_read(AILY_PACKET_EPOCH_REG);
  __atomic_store_n(&send_check_retry, 0u, __ATOMIC_RELEASE);
  failed = false; stopping = false; joining = false; quiescing = false; quiet_waiting = false; send_notify_pending = true;
  memset(&callbacks, 0, sizeof(callbacks));
  (void)xSemaphoreTake(done, 0);
  if (xTaskCreate(receive_loop, "aily-classic-vhci", 4096, NULL, 6, &receiver) != pdPASS) {
    receiver = NULL; reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
    xSemaphoreGive(lock); return ESP_ERR_NO_MEM;
  }
  configured_mode = (esp_bt_mode_t)cfg->mode;
  state = ESP_BT_CONTROLLER_STATUS_INITED;
  xSemaphoreGive(lock);
  return ESP_OK; /* Local adapter initialized, not a BLE-ready or HCI-response claim. */
}
esp_err_t __wrap_esp_bt_controller_enable(esp_bt_mode_t mode) {
#if defined(AILY_CLASSIC_AHC2_SPP)
  if (!lock || (mode != ESP_BT_MODE_CLASSIC_BT && mode != ESP_BT_MODE_BTDM)) return ESP_ERR_INVALID_ARG;
#else
  if (!lock || (mode != ESP_BT_MODE_BLE && mode != ESP_BT_MODE_BTDM)) return ESP_ERR_INVALID_ARG;
#endif
  xSemaphoreTake(lock, portMAX_DELAY);
  if (state != ESP_BT_CONTROLLER_STATUS_INITED || mode != configured_mode || stopping || quiescing || failed) {
    xSemaphoreGive(lock); return ESP_ERR_INVALID_STATE;
  }
  if (!identity() || !(reg_read(AILY_PACKET_STATUS_REG) & AILY_PACKET_CONNECTED) ||
      reg_read(AILY_PACKET_EPOCH_REG) != transport_epoch) {
    xSemaphoreGive(lock); return ESP_ERR_NOT_FOUND;
  }
  reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_ENABLE);
  uint32_t status = reg_read(AILY_PACKET_STATUS_REG);
  if ((status & (AILY_PACKET_CONNECTED | AILY_PACKET_ENABLED | AILY_PACKET_FAULT)) !=
      (AILY_PACKET_CONNECTED | AILY_PACKET_ENABLED)) {
    fence_locked("enable did not complete"); xSemaphoreGive(lock); return ESP_FAIL;
  }
  state = ESP_BT_CONTROLLER_STATUS_ENABLED;
  send_notify_pending = true;
  xSemaphoreGive(lock); return ESP_OK;
}
esp_err_t __wrap_esp_bt_controller_disable(void) {
  if (!lock) return ESP_ERR_INVALID_STATE;
  xSemaphoreTake(lock, portMAX_DELAY);
  if (state != ESP_BT_CONTROLLER_STATUS_ENABLED || stopping) {
    xSemaphoreGive(lock); return ESP_ERR_INVALID_STATE;
  }
  esp_err_t quiet_result = quiesce_locked();
  if (quiet_result != ESP_OK) { xSemaphoreGive(lock); return quiet_result; }
  reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
  transport_epoch = reg_read(AILY_PACKET_EPOCH_REG);
  state = ESP_BT_CONTROLLER_STATUS_INITED;
  quiescing = false;
  xSemaphoreGive(lock); return ESP_OK;
}
esp_err_t __wrap_esp_bt_controller_deinit(void) {
  if (!lock || xTaskGetCurrentTaskHandle() == receiver) return ESP_ERR_INVALID_STATE;
  xSemaphoreTake(lock, portMAX_DELAY);
  if (state != ESP_BT_CONTROLLER_STATUS_INITED || !receiver || joining || quiescing) {
    xSemaphoreGive(lock); return ESP_ERR_INVALID_STATE;
  }
  stopping = true; joining = true;
  reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
  TaskHandle_t task = receiver;
  xSemaphoreGive(lock);
  if (xSemaphoreTake(done, pdMS_TO_TICKS(1000)) != pdTRUE) {
    xSemaphoreTake(lock, portMAX_DELAY); joining = false; xSemaphoreGive(lock);
    return ESP_ERR_TIMEOUT; /* Retain the exact task for explicit cleanup retry. */
  }
  /* The checkpoint has no remaining callback or MMIO operation. */
  vTaskDelete(task);
  xSemaphoreTake(lock, portMAX_DELAY);
  receiver = NULL;
  memset(&callbacks, 0, sizeof(callbacks));
  state = ESP_BT_CONTROLLER_STATUS_IDLE;
  configured_mode = ESP_BT_MODE_IDLE;
  stopping = false; joining = false;
  xSemaphoreGive(lock); return ESP_OK;
}
bool __wrap_esp_vhci_host_check_send_available(void) {
  if (!lock) return false;
  if (xSemaphoreTake(lock, 0) != pdTRUE) {
    __atomic_store_n(&send_check_retry, 1u, __ATOMIC_RELEASE);
    return false;
  }
  bool result = healthy_locked() && reg_read(AILY_PACKET_TX_CAP_REG) >= AILY_HCI_MAX_PACKET;
  xSemaphoreGive(lock); return result;
}
void __wrap_esp_vhci_host_send_packet(uint8_t *bytes, uint16_t size) {
  if (!lock) return;
  xSemaphoreTake(lock, portMAX_DELAY);
  if (!healthy_locked()) { xSemaphoreGive(lock); return; }
  if (!h4_valid(bytes, size, false) || reg_read(AILY_PACKET_TX_CAP_REG) < size ||
      reg_read(AILY_PACKET_TX_LEN_REG) != 0) {
    fence_locked("outgoing H4 invalid or send without local capacity; no retry");
    xSemaphoreGive(lock); return;
  }
  for (unsigned index = 0; index < size; ++index) reg_write(AILY_PACKET_TX_DATA_REG, bytes[index]);
  if (reg_read(AILY_PACKET_TX_LEN_REG) != size) fence_locked("outgoing H4 staging failed");
  else {
    reg_write(AILY_PACKET_TX_COMMIT_REG, size);
    /* The SDK consumes one send semaphore per packet. The mailbox can stay
     * writable across a commit, so a capacity transition alone is insufficient.
     * The receiver reports real local capacity, independently of any HCI ACK. */
    if (healthy_locked()) send_notify_pending = true;
  }
  xSemaphoreGive(lock);
}
esp_err_t __wrap_esp_vhci_host_register_callback(const esp_vhci_host_callback_t *value) {
  if (!lock || !value || !value->notify_host_recv || !value->notify_host_send_available)
    return ESP_ERR_INVALID_ARG;
  xSemaphoreTake(lock, portMAX_DELAY);
  if (state == ESP_BT_CONTROLLER_STATUS_IDLE || stopping || joining || quiet_waiting) {
    xSemaphoreGive(lock); return ESP_ERR_INVALID_STATE;
  }
  if (!quiescing && callbacks.notify_host_recv == value->notify_host_recv &&
      callbacks.notify_host_send_available == value->notify_host_send_available) {
    xSemaphoreGive(lock); return ESP_OK;
  }
  esp_vhci_host_callback_t next = *value; /* Caller table need not outlive this API. */
  esp_err_t quiet_result = quiesce_locked();
  if (quiet_result != ESP_OK) { xSemaphoreGive(lock); return quiet_result; }
  callbacks = next;
  quiescing = false;
  send_notify_pending = true;
  xSemaphoreGive(lock); return ESP_OK;
}

/* Arduino HAL polls this state across init, enable, disable and deinit. The
 * original RF controller status is not the mailbox adapter lifecycle. */
esp_bt_controller_status_t __wrap_esp_bt_controller_get_status(void) {
  if (!lock) return ESP_BT_CONTROLLER_STATUS_IDLE;
  xSemaphoreTake(lock, portMAX_DELAY);
  esp_bt_controller_status_t result = state;
  xSemaphoreGive(lock);
  return result;
}

/* Arduino already owns --wrap for these two APIs and records released modes.
 * Bind their real calls to these unique transport functions, not a second HAL wrapper. There
 * is no RF controller heap in this adapter; release permanently disables the
 * requested mode for this VM boot and cannot silently re-enable it later. */
esp_err_t aily_classic_bt_controller_mem_release(esp_bt_mode_t mode) {
  if (mode != ESP_BT_MODE_BLE && mode != ESP_BT_MODE_CLASSIC_BT && mode != ESP_BT_MODE_BTDM)
    return ESP_ERR_INVALID_ARG;
  if (lock) xSemaphoreTake(lock, portMAX_DELAY);
  if (state != ESP_BT_CONTROLLER_STATUS_IDLE || receiver) {
    if (lock) xSemaphoreGive(lock);
    return ESP_ERR_INVALID_STATE;
  }
  released_modes |= (unsigned)mode;
  if (lock) xSemaphoreGive(lock);
  return ESP_OK;
}
esp_err_t aily_classic_bt_mem_release(esp_bt_mode_t mode) {
  return aily_classic_bt_controller_mem_release(mode);
}

#if !defined(AILY_CLASSIC_AHC2_SPP)
/* No RF power model. Classic SDK lacks the C3 INVALID enumerator; the shared
 * real BLEDevice::getPower default maps the unrecognized 0xff value to -128. */
esp_power_level_t __wrap_esp_ble_tx_power_get(esp_ble_power_type_t power_type) {
  (void)power_type;
  return (esp_power_level_t)0xff;
}

#endif
