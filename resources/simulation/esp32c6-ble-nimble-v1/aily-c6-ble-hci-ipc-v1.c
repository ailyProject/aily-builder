/* Simulation-only ESP32-C6 NimBLE SDK IPC adapter for the shared AHC2 mailbox. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "esp_bt.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_hci_internal.h"
#include "esp_hci_transport.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mempool.h"
#include "aily_packet_abi.h"

#if !defined(CONFIG_IDF_TARGET_ESP32C6) || !CONFIG_SOC_ESP_NIMBLE_CONTROLLER || \
    !CONFIG_BT_CONTROLLER_ENABLED || !CONFIG_BT_NIMBLE_ENABLED || \
    !CONFIG_BT_LE_HCI_INTERFACE_USE_RAM || !CONFIG_BT_NIMBLE_STATIC_TO_DYNAMIC
#error "The adapter requires the ESP32-C6 NimBLE RAM IPC SDK profile."
#endif

_Static_assert(CONFIG_VERSION == 0x20260123 && CONFIG_MAGIC == 0x5A5AA5A5,
               "C6 controller config ABI changed");
_Static_assert(HCI_TRANSPORT_CMD_SZ == 260 && ESP_HCI_INTERNAL_BUF_CMD == 3,
               "C6 command buffer ABI changed");
_Static_assert(ESP_PWR_LVL_INVALID == 0xFF, "SDK invalid-power sentinel changed");
_Static_assert(CONFIG_BT_NIMBLE_TRANSPORT_EVT_SIZE == 70 &&
               CONFIG_BT_NIMBLE_TRANSPORT_EVT_COUNT == 30 &&
               CONFIG_BT_NIMBLE_TRANSPORT_EVT_DISCARD_COUNT == 8 &&
               CONFIG_BT_NIMBLE_TRANSPORT_ACL_SIZE == 255,
               "C6 NimBLE transport pool ABI changed");
_Static_assert(CONFIG_BT_NIMBLE_MSYS_1_BLOCK_COUNT == 24 &&
               CONFIG_BT_NIMBLE_MSYS_1_BLOCK_SIZE == 128 &&
               CONFIG_BT_NIMBLE_MSYS_2_BLOCK_COUNT == 24 &&
               CONFIG_BT_NIMBLE_MSYS_2_BLOCK_SIZE == 320,
               "C6 SDK MSYS pool ABI changed");

/* Present in the pinned SDK archives but not exported as public headers. */
extern int esp_register_npl_funcs(struct npl_funcs_t *);
extern void esp_unregister_npl_funcs(void);
extern void npl_freertos_mempool_deinit(void);

/* The first AHC2 consumer supplied the shared address under its board name. */
#define AILY_HCI_MAILBOX_BASE AILY_HCI_C3_BASE

enum {
  EVT_HIGH = 1,
  EVT_LOW = 2,
  EVT_SIZE = CONFIG_BT_NIMBLE_TRANSPORT_EVT_SIZE,
  EVT_HIGH_COUNT = CONFIG_BT_NIMBLE_TRANSPORT_EVT_COUNT,
  EVT_LOW_COUNT = CONFIG_BT_NIMBLE_TRANSPORT_EVT_DISCARD_COUNT,
  ACL_SIZE = CONFIG_BT_NIMBLE_TRANSPORT_ACL_SIZE + 4,
  MSYS1_COUNT = CONFIG_BT_NIMBLE_MSYS_1_BLOCK_COUNT,
  MSYS1_SIZE = CONFIG_BT_NIMBLE_MSYS_1_BLOCK_SIZE,
  MSYS2_COUNT = CONFIG_BT_NIMBLE_MSYS_2_BLOCK_COUNT,
  MSYS2_SIZE = CONFIG_BT_NIMBLE_MSYS_2_BLOCK_SIZE,
  /* Pinned libble_app.a marks both vendor Host MSYS pools with bit 1.
   * r_os_msys_get_pkthdr selects only pools with that bit set.
   */
  MSYS_HOST_POOL = 1 << 1,
};

static const char *TAG = "aily-c6-nimble";
static StaticSemaphore_t lock_storage, done_storage, quiet_storage;
static SemaphoreHandle_t lock, done, quiet;
static TaskHandle_t receiver;
static esp_bt_controller_status_t state = ESP_BT_CONTROLLER_STATUS_IDLE;
static struct ble_npl_eventq *default_eventq;
static hci_transport_host_recv_fn *callback;
static uint32_t transport_epoch;
static bool failed, stopping, joining, quiescing, quiet_waiting, registered_npl, pools_ready;

/* Flat buffers and MSYS mbufs deliberately use different allocators.
 * SDK RX callbacks can free flat buffers while the mailbox lock is released.
 */
static portMUX_TYPE flat_lock = portMUX_INITIALIZER_UNLOCKED;
static bool flat_enabled, command_in_use;
static uint32_t event_high_in_use, event_low_in_use;
struct event_slot {
  _Alignas(uint32_t) uint8_t data[EVT_SIZE];
};
static _Alignas(uint32_t) uint8_t command[HCI_TRANSPORT_CMD_SZ];
static struct event_slot event_high[EVT_HIGH_COUNT], event_low[EVT_LOW_COUNT];
static struct os_mempool msys1, msys2;
static struct os_mbuf_pool mbuf1, mbuf2;
static os_membuf_t msys1_storage[OS_MEMPOOL_SIZE(MSYS1_COUNT, MSYS1_SIZE)];
static os_membuf_t msys2_storage[OS_MEMPOOL_SIZE(MSYS2_COUNT, MSYS2_SIZE)];

static uint8_t *take_event(struct event_slot *slots, uint32_t *busy, unsigned count) {
  uint32_t free_slots = ~*busy & ((UINT32_C(1) << count) - 1);
  if (!free_slots) return NULL;
  unsigned index = (unsigned)__builtin_ctz(free_slots);
  *busy |= UINT32_C(1) << index;
  return slots[index].data;
}

uint8_t *__wrap_r_ble_hci_trans_buf_alloc(int type) {
  uint8_t *buf = NULL;
  portENTER_CRITICAL(&flat_lock);
  if (flat_enabled) {
    if (type == ESP_HCI_INTERNAL_BUF_CMD && !command_in_use) {
      command_in_use = true;
      buf = command;
    } else if (type == EVT_HIGH || type == EVT_LOW) {
      if (type == EVT_HIGH) buf = take_event(event_high, &event_high_in_use, EVT_HIGH_COUNT);
      if (!buf) buf = take_event(event_low, &event_low_in_use, EVT_LOW_COUNT);
    }
  }
  portEXIT_CRITICAL(&flat_lock);
  return buf;
}

static bool release_event(uint8_t *buf, struct event_slot *slots, uint32_t *busy, unsigned count) {
  uintptr_t offset = (uintptr_t)buf - (uintptr_t)slots;
  if (offset >= count * sizeof(*slots) || offset % sizeof(*slots)) return false;
  uint32_t bit = UINT32_C(1) << (offset / sizeof(*slots));
  if (!(*busy & bit)) return false;
  *busy &= ~bit;
  return true;
}

void __wrap_r_ble_hci_trans_buf_free(uint8_t *buf) {
  bool owned;
  portENTER_CRITICAL(&flat_lock);
  if (buf == command) {
    owned = command_in_use;
    command_in_use = false;
  } else {
    owned = release_event(buf, event_high, &event_high_in_use, EVT_HIGH_COUNT) ||
            release_event(buf, event_low, &event_low_in_use, EVT_LOW_COUNT);
  }
  portEXIT_CRITICAL(&flat_lock);
  if (!owned) ESP_LOGE(TAG, "unexpected flat-buffer release");
}

static uint32_t reg_read(unsigned offset) {
  return *(volatile uint32_t *)(uintptr_t)(AILY_HCI_MAILBOX_BASE + offset);
}

static void reg_write(unsigned offset, uint32_t value) {
  *(volatile uint32_t *)(uintptr_t)(AILY_HCI_MAILBOX_BASE + offset) = value;
}

static bool identity(void) {
  return reg_read(AILY_PACKET_MAGIC_REG) == AILY_HCI_MAGIC &&
    reg_read(AILY_PACKET_SCHEMA_REG) == AILY_PACKET_SCHEMA &&
    reg_read(AILY_PACKET_MAX_REG) == AILY_HCI_MAX_PACKET;
}

static void fence_locked(const char *reason) {
  if (!failed) ESP_LOGE(TAG, "transport fenced: %s", reason);
  failed = true;
  if (identity()) reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
}

static bool healthy_locked(void) {
  if (failed || state != ESP_BT_CONTROLLER_STATUS_ENABLED) return false;
  uint32_t status = reg_read(AILY_PACKET_STATUS_REG);
  if (!identity() || reg_read(AILY_PACKET_EPOCH_REG) != transport_epoch ||
      (status & (AILY_PACKET_CONNECTED | AILY_PACKET_ENABLED | AILY_PACKET_FAULT)) !=
        (AILY_PACKET_CONNECTED | AILY_PACKET_ENABLED)) {
    fence_locked("mailbox identity, connection or epoch changed");
    return false;
  }
  return true;
}

static unsigned acl_data_size(const uint8_t *h4) {
  return (unsigned)h4[3] | ((unsigned)h4[4] << 8);
}

static bool acl_valid(const uint8_t *h4, unsigned size) {
  return size >= 5 && size <= ACL_SIZE + 1 && size == 5 + acl_data_size(h4);
}

static bool incoming_valid(const uint8_t *h4, unsigned size) {
  if (h4[0] == HCI_ACL_IND) return acl_valid(h4, size);
  return h4[0] == HCI_EVT_IND && size >= 3 && size <= EVT_SIZE + 1 && size == 3u + h4[2];
}

static int deliver(hci_transport_host_recv_fn *recv, const uint8_t *h4, unsigned size) {
  /* The C6 RAM driver hands the host a flat event or an SDK mbuf, with len=0. */
  if (h4[0] == HCI_ACL_IND) {
    struct os_mbuf *om = os_msys_get_pkthdr(size - 1, ESP_HCI_INTERNAL_ACL_MBUF_LEADINGSPCAE);
    if (!om) return ESP_ERR_NO_MEM;
    if (os_mbuf_append(om, h4 + 1, size - 1)) {
      os_mbuf_free_chain(om);
      return ESP_ERR_NO_MEM;
    }
    return recv(HCI_ACL_IND, (uint8_t *)om, 0);
  }
  /* Only explicit advertising reports can be discarded on low-pool exhaustion. */
  bool discardable = h4[1] == 0x3e && size >= 4 && (h4[3] == 0x02 || h4[3] == 0x0d);
  uint8_t *evt = __wrap_r_ble_hci_trans_buf_alloc(discardable ? EVT_LOW : EVT_HIGH);
  if (!evt) return discardable ? ESP_OK : ESP_ERR_NO_MEM;
  memcpy(evt, h4 + 1, size - 1);
  return recv(HCI_EVT_IND, evt, 0);
}

static void receive_loop(void *unused) {
  (void)unused;
  uint8_t h4[ACL_SIZE + 1];
  for (;;) {
    hci_transport_host_recv_fn *recv = NULL;
    uint32_t size = 0, epoch = 0;
    xSemaphoreTake(lock, portMAX_DELAY);
    if (stopping) {
      xSemaphoreGive(lock);
      xSemaphoreGive(done);
      vTaskSuspend(NULL);
      continue;
    }
    if (quiescing) {
      xSemaphoreGive(quiet);
    } else if (callback && healthy_locked()) {
      size = reg_read(AILY_PACKET_RX_LEN_REG);
      if (size) {
        if (size > sizeof(h4) || reg_read(AILY_PACKET_RX_REMAIN_REG) != size) {
          fence_locked("invalid RX front length");
        } else {
          unsigned index = 0;
          for (; index < size; ++index) {
            uint32_t value = reg_read(AILY_PACKET_RX_DATA_REG);
            if (value > UINT8_MAX) break;
            h4[index] = (uint8_t)value;
          }
          if (index != size || reg_read(AILY_PACKET_RX_REMAIN_REG) != 0 ||
              !incoming_valid(h4, size)) {
            fence_locked("malformed incoming H4 packet");
          } else {
            recv = callback;
            epoch = transport_epoch;
          }
        }
      }
    }
    xSemaphoreGive(lock);
    if (recv) {
      int result = deliver(recv, h4, size);
      xSemaphoreTake(lock, portMAX_DELAY);
      if (healthy_locked() && transport_epoch == epoch) {
        if (result) fence_locked("NimBLE RX ownership or capacity failure");
        else {
          reg_write(AILY_PACKET_RX_ACK_REG, size);
          (void)healthy_locked();
        }
      }
      xSemaphoreGive(lock);
    }
    vTaskDelay(1);
  }
}

/* The SDK drops registration's return value before destroying the old Host. */
static esp_err_t quiesce_locked(void) {
  if (!receiver || quiet_waiting || stopping || joining || xTaskGetCurrentTaskHandle() == receiver)
    return ESP_ERR_INVALID_STATE;
  quiescing = true;
  quiet_waiting = true;
  (void)xSemaphoreTake(quiet, 0);
  xSemaphoreGive(lock);
  bool confirmed = xSemaphoreTake(quiet, portMAX_DELAY) == pdTRUE;
  xSemaphoreTake(lock, portMAX_DELAY);
  quiet_waiting = false;
  return confirmed ? ESP_OK : ESP_ERR_TIMEOUT;
}

static int send_packet(const uint8_t *h4, unsigned size, bool valid, uint8_t *cmd) {
  if (!lock) return ESP_ERR_INVALID_STATE;
  xSemaphoreTake(lock, portMAX_DELAY);
  int result = ESP_ERR_INVALID_STATE;
  if (!stopping && !quiescing && healthy_locked()) {
    result = ESP_FAIL;
    if (!valid || reg_read(AILY_PACKET_TX_CAP_REG) < size || reg_read(AILY_PACKET_TX_LEN_REG)) {
      fence_locked("outgoing H4 invalid or mailbox capacity unavailable");
    } else {
      for (unsigned index = 0; index < size; ++index) reg_write(AILY_PACKET_TX_DATA_REG, h4[index]);
      if (reg_read(AILY_PACKET_TX_LEN_REG) != size) {
        fence_locked("mailbox TX staging failed");
      } else {
        reg_write(AILY_PACKET_TX_COMMIT_REG, size);
        if (healthy_locked()) {
          /* The stock Host frees the command itself on nonzero TX results.
           * On success release it before unlocking the incoming completion.
           */
          if (cmd) __wrap_r_ble_hci_trans_buf_free(cmd);
          result = ESP_OK;
        }
      }
    }
  }
  xSemaphoreGive(lock);
  return result;
}

int __wrap_hci_transport_host_cmd_tx(uint8_t *data, uint32_t length) {
  uint8_t h4[1 + HCI_TRANSPORT_CMD_SZ];
  unsigned size = 0;
  portENTER_CRITICAL(&flat_lock);
  if (data == command && command_in_use) {
    size = 4u + data[2];
    h4[0] = HCI_CMD_IND;
    memcpy(h4 + 1, data, size - 1);
  }
  portEXIT_CRITICAL(&flat_lock);
  if (!size) return ESP_ERR_INVALID_ARG;
  return send_packet(h4, size, length == 0, data);
}

int __wrap_hci_transport_host_acl_tx(uint8_t *data, uint32_t length) {
  if (!data) return ESP_ERR_INVALID_ARG;
  struct os_mbuf *om = (struct os_mbuf *)data;
  uint8_t h4[ACL_SIZE + 1];
  h4[0] = HCI_ACL_IND;
  unsigned size = (OS_MBUF_IS_PKTHDR(om) ? OS_MBUF_PKTLEN(om) : 0) + 1u;
  bool valid = size >= 5 && size <= sizeof(h4) &&
    os_mbuf_copydata(om, 0, size - 1, h4 + 1) == 0 && acl_valid(h4, size);
  os_mbuf_free_chain(om);
  return send_packet(h4, size, valid && length == 0, NULL);
}

int __wrap_hci_transport_host_callback_register(hci_transport_host_recv_fn *next) {
  if (!lock || !next) return ESP_ERR_INVALID_ARG;
  xSemaphoreTake(lock, portMAX_DELAY);
  int result = ESP_ERR_INVALID_STATE;
  if (state == ESP_BT_CONTROLLER_STATUS_ENABLED && !stopping) {
    if (!callback && default_eventq) {
      callback = next;
      result = ESP_OK;
    } else if (callback == next) {
      result = ESP_OK;
    } else if (callback && quiesce_locked() == ESP_OK) {
      /* Stock HCI IPC's only replacement is its deinit sink, which consumes nothing.
       * Return ownership of the default queue to esp_nimble_deinit at this edge.
       */
      callback = NULL;
      default_eventq = NULL;
      quiescing = false;
      result = ESP_OK;
    }
  }
  xSemaphoreGive(lock);
  return result;
}

static void stop_host_support(void) {
  if (default_eventq) {
    ble_npl_eventq_deinit(default_eventq);
    default_eventq = NULL;
  }
  os_msys_reset();
  npl_freertos_mempool_deinit();
  if (registered_npl) {
    esp_unregister_npl_funcs();
    registered_npl = false;
  }
  npl_freertos_funcs_deinit();
  pools_ready = false;
  portENTER_CRITICAL(&flat_lock);
  flat_enabled = false;
  portEXIT_CRITICAL(&flat_lock);
}

static esp_err_t start_host_support(void) {
  ble_npl_count_info_t controller_counts = {0};
  npl_freertos_funcs_init();
  if (esp_register_npl_funcs(npl_freertos_funcs_get()) != ESP_OK) return ESP_FAIL;
  registered_npl = true;
  if (npl_freertos_set_controller_npl_info(&controller_counts) ||
      npl_freertos_mempool_init() ||
      os_mempool_init(&msys1, MSYS1_COUNT, MSYS1_SIZE, msys1_storage, "aily-msys1") ||
      os_mempool_init(&msys2, MSYS2_COUNT, MSYS2_SIZE, msys2_storage, "aily-msys2") ||
      os_mbuf_pool_init(&mbuf1, &msys1, MSYS1_SIZE, MSYS1_COUNT) ||
      os_mbuf_pool_init(&mbuf2, &msys2, MSYS2_SIZE, MSYS2_COUNT))
    return ESP_ERR_NO_MEM;
  msys1.mp_flags |= MSYS_HOST_POOL;
  msys2.mp_flags |= MSYS_HOST_POOL;
  if (os_msys_register(&mbuf1) || os_msys_register(&mbuf2)) return ESP_ERR_NO_MEM;
  pools_ready = true;
  portENTER_CRITICAL(&flat_lock);
  flat_enabled = true;
  portEXIT_CRITICAL(&flat_lock);
  return ESP_OK;
}

esp_err_t __wrap_esp_bt_controller_init(esp_bt_controller_config_t *cfg) {
  if (!cfg || cfg->config_version != CONFIG_VERSION || cfg->config_magic != CONFIG_MAGIC)
    return ESP_ERR_INVALID_ARG;
  if (!lock) {
    lock = xSemaphoreCreateMutexStatic(&lock_storage);
    done = xSemaphoreCreateBinaryStatic(&done_storage);
    quiet = xSemaphoreCreateBinaryStatic(&quiet_storage);
    if (!lock || !done || !quiet) return ESP_ERR_NO_MEM;
  }
  xSemaphoreTake(lock, portMAX_DELAY);
  if (state != ESP_BT_CONTROLLER_STATUS_IDLE || receiver) {
    xSemaphoreGive(lock);
    return ESP_ERR_INVALID_STATE;
  }
  if (!identity() || !(reg_read(AILY_PACKET_STATUS_REG) & AILY_PACKET_CONNECTED)) {
    xSemaphoreGive(lock);
    return ESP_ERR_NOT_FOUND;
  }
  esp_err_t result = start_host_support();
  if (result == ESP_OK) {
    reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_RESET);
    transport_epoch = reg_read(AILY_PACKET_EPOCH_REG);
    failed = false;
    (void)xSemaphoreTake(done, 0);
    if (xTaskCreate(receive_loop, "aily-c6-nimble", 4096, NULL, 6, &receiver) != pdPASS) {
      receiver = NULL;
      reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
      result = ESP_ERR_NO_MEM;
    }
  }
  if (result == ESP_OK) state = ESP_BT_CONTROLLER_STATUS_INITED;
  else stop_host_support();
  xSemaphoreGive(lock);
  return result;
}

esp_err_t __wrap_esp_bt_controller_enable(esp_bt_mode_t mode) {
  if (!lock || mode != ESP_BT_MODE_BLE) return ESP_ERR_INVALID_ARG;
  xSemaphoreTake(lock, portMAX_DELAY);
  esp_err_t result = ESP_ERR_INVALID_STATE;
  if (state == ESP_BT_CONTROLLER_STATUS_INITED && !failed && !stopping) {
    reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_ENABLE);
    state = ESP_BT_CONTROLLER_STATUS_ENABLED;
    result = ESP_FAIL;
    if (healthy_locked()) {
      default_eventq = nimble_port_get_dflt_eventq();
      if (default_eventq) {
        ble_npl_eventq_init(default_eventq);
        result = ESP_OK;
      } else {
        result = ESP_ERR_NO_MEM;
      }
    }
    if (result != ESP_OK) {
      state = ESP_BT_CONTROLLER_STATUS_INITED;
      reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
    }
  }
  xSemaphoreGive(lock);
  return result;
}

esp_err_t __wrap_esp_bt_controller_disable(void) {
  if (!lock) return ESP_ERR_INVALID_STATE;
  xSemaphoreTake(lock, portMAX_DELAY);
  esp_err_t result = ESP_ERR_INVALID_STATE;
  if (state == ESP_BT_CONTROLLER_STATUS_ENABLED && !stopping && !callback) {
    result = quiesce_locked();
    if (result == ESP_OK) {
      reg_write(AILY_PACKET_CTRL_REG, AILY_PACKET_CLOSE);
      transport_epoch = reg_read(AILY_PACKET_EPOCH_REG);
      state = ESP_BT_CONTROLLER_STATUS_INITED;
      quiescing = false;
    }
  }
  xSemaphoreGive(lock);
  return result;
}

esp_err_t __wrap_esp_bt_controller_deinit(void) {
  if (!lock || xTaskGetCurrentTaskHandle() == receiver) return ESP_ERR_INVALID_STATE;
  xSemaphoreTake(lock, portMAX_DELAY);
  if (state != ESP_BT_CONTROLLER_STATUS_INITED || !receiver || joining || quiescing) {
    xSemaphoreGive(lock);
    return ESP_ERR_INVALID_STATE;
  }
  portENTER_CRITICAL(&flat_lock);
  bool flat_drained = !command_in_use && !event_high_in_use && !event_low_in_use;
  portEXIT_CRITICAL(&flat_lock);
  if (!flat_drained || (pools_ready && (msys1.mp_num_free != MSYS1_COUNT ||
                                      msys2.mp_num_free != MSYS2_COUNT))) {
    fence_locked("SDK buffers still owned after Host deinit");
    xSemaphoreGive(lock);
    return ESP_ERR_INVALID_STATE;
  }
  stopping = true;
  joining = true;
  TaskHandle_t task = receiver;
  xSemaphoreGive(lock);
  if (xSemaphoreTake(done, pdMS_TO_TICKS(1000)) != pdTRUE) {
    xSemaphoreTake(lock, portMAX_DELAY);
    joining = false;
    xSemaphoreGive(lock);
    return ESP_ERR_TIMEOUT;
  }
  vTaskDelete(task);
  xSemaphoreTake(lock, portMAX_DELAY);
  receiver = NULL;
  stop_host_support();
  state = ESP_BT_CONTROLLER_STATUS_IDLE;
  stopping = false;
  joining = false;
  xSemaphoreGive(lock);
  return ESP_OK;
}

/* Arduino BLEAdvertising::reset queries this even when RF is unavailable.
 * The stock function dereferences the physical LL scan environment.
 */
esp_power_level_t __wrap_esp_ble_tx_power_get(esp_ble_power_type_t power_type) {
  (void)power_type;
  return ESP_PWR_LVL_INVALID;
}
