/*
 * Aily simulation-only ESP32 VHCI provider, compiled as an ordinary source unit.
 * BluetoothSerial, Bluedroid, L2CAP, SDP and RFCOMM remain Espressif/Arduino code.
 * AHC1 is a virtual H4 byte transport; it never fabricates controller replies.
 * SPDX-License-Identifier: MIT
 */
#include <stdint.h>
#include <string.h>
#include "esp_bt.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#define AHC_REG(offset) (*(volatile uint32_t *)(0x3ff7f000u + (offset)))
#define H4_BUFFER_BYTES 4096

static esp_bt_controller_status_t controller_status = ESP_BT_CONTROLLER_STATUS_IDLE;
static esp_bt_mode_t controller_mode;
static unsigned released_modes;
static esp_vhci_host_callback_t host_callback;
static TaskHandle_t transport_task;
static SemaphoreHandle_t transport_lock;
static uint8_t receive_packet[H4_BUFFER_BYTES];
static size_t receive_count, receive_expected;
static bool send_was_available;

static bool transport_connected(void)
{
    return AHC_REG(0) == 0x41484331 && (AHC_REG(4) & 1);
}

static void transport_worker(void *unused)
{
    for (;;) {
        if (controller_status == ESP_BT_CONTROLLER_STATUS_ENABLED && transport_connected()) {
            if (host_callback.notify_host_recv) {
                while (AHC_REG(8)) {
                    uint8_t byte = AHC_REG(12);

                    if (receive_count == 0 && byte != 0x02 && byte != 0x04) {
                        /* H4 SCO/ISO are outside this provider's SPP contract. */
                        AHC_REG(24) = 2;
                        controller_status = ESP_BT_CONTROLLER_STATUS_INITED;
                        break;
                    }

                    receive_packet[receive_count++] = byte;

                    if (receive_packet[0] == 0x04 && receive_count == 3) receive_expected = 3 + receive_packet[2];
                    if (receive_packet[0] == 0x02 && receive_count == 5) receive_expected = 5 + receive_packet[3] + (receive_packet[4] << 8);

                    if (receive_expected > H4_BUFFER_BYTES) {
                        AHC_REG(24) = 2;
                        controller_status = ESP_BT_CONTROLLER_STATUS_INITED;
                        receive_count = receive_expected = 0;
                        break;
                    }

                    if (receive_expected && receive_count == receive_expected) {
                        host_callback.notify_host_recv(receive_packet, receive_count);
                        receive_count = receive_expected = 0;
                    }
                }
            }

            bool available = AHC_REG(16) >= H4_BUFFER_BYTES;

            if (available && !send_was_available && host_callback.notify_host_send_available) host_callback.notify_host_send_available();

            send_was_available = available;
        } else send_was_available = false;

        vTaskDelay(1);
    }
}

esp_err_t esp_bt_controller_init(esp_bt_controller_config_t *cfg)
{
    if (!cfg || cfg->magic != ESP_BT_CONTROLLER_CONFIG_MAGIC_VAL || cfg->mode < ESP_BT_MODE_BLE || cfg->mode > ESP_BT_MODE_BTDM) return ESP_ERR_INVALID_ARG;
    if (controller_status != ESP_BT_CONTROLLER_STATUS_IDLE || (released_modes & cfg->mode)) return ESP_ERR_INVALID_STATE;
    if (!transport_connected()) return ESP_ERR_NOT_FOUND;

    transport_lock = xSemaphoreCreateMutex();
    if (!transport_lock) return ESP_ERR_NO_MEM;

    AHC_REG(24) = 2;
    controller_mode = cfg->mode;
    receive_count = receive_expected = 0;
    memset(&host_callback, 0, sizeof(host_callback));

    if (xTaskCreate(transport_worker, "aily-vhci", 4096, NULL, configMAX_PRIORITIES - 3, &transport_task) != pdPASS) {
        vSemaphoreDelete(transport_lock);
        transport_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    controller_status = ESP_BT_CONTROLLER_STATUS_INITED;
    return ESP_OK;
}

esp_err_t esp_bt_controller_enable(esp_bt_mode_t mode)
{
    if (mode != controller_mode) return ESP_ERR_INVALID_ARG;
    if (controller_status != ESP_BT_CONTROLLER_STATUS_INITED) return ESP_ERR_INVALID_STATE;
    if (!transport_connected()) return ESP_ERR_NOT_FOUND;

    AHC_REG(24) = 3;
    send_was_available = false;
    controller_status = ESP_BT_CONTROLLER_STATUS_ENABLED;
    return ESP_OK;
}

esp_err_t esp_bt_controller_disable(void)
{
    if (controller_status != ESP_BT_CONTROLLER_STATUS_ENABLED) return ESP_ERR_INVALID_STATE;

    controller_status = ESP_BT_CONTROLLER_STATUS_INITED;
    AHC_REG(24) = 2;
    receive_count = receive_expected = 0;
    send_was_available = false;
    return ESP_OK;
}

esp_err_t esp_bt_controller_deinit(void)
{
    if (controller_status != ESP_BT_CONTROLLER_STATUS_INITED) return ESP_ERR_INVALID_STATE;

    vTaskDelete(transport_task);
    vSemaphoreDelete(transport_lock);
    transport_task = NULL;
    transport_lock = NULL;
    memset(&host_callback, 0, sizeof(host_callback));
    controller_status = ESP_BT_CONTROLLER_STATUS_IDLE;
    return ESP_OK;
}

esp_bt_controller_status_t esp_bt_controller_get_status(void)
{
    return controller_status;
}

esp_err_t esp_bt_controller_mem_release(esp_bt_mode_t mode)
{
    if (mode < ESP_BT_MODE_BLE || mode > ESP_BT_MODE_BTDM) return ESP_ERR_INVALID_ARG;
    if (controller_status != ESP_BT_CONTROLLER_STATUS_IDLE) return ESP_ERR_INVALID_STATE;

    /* No RF heap is allocated by this provider; released modes cannot return. */
    released_modes |= mode;
    return ESP_OK;
}

esp_err_t esp_bt_mem_release(esp_bt_mode_t mode)
{
    return esp_bt_controller_mem_release(mode);
}

bool esp_vhci_host_check_send_available(void)
{
    return controller_status == ESP_BT_CONTROLLER_STATUS_ENABLED && transport_connected() && AHC_REG(16) >= H4_BUFFER_BYTES;
}

void esp_vhci_host_send_packet(uint8_t *data, uint16_t length)
{
    if (!data || !length || !transport_lock) return;

    xSemaphoreTake(transport_lock, portMAX_DELAY);

    if (controller_status == ESP_BT_CONTROLLER_STATUS_ENABLED && transport_connected() && AHC_REG(16) >= length) {
        /* MMIO copies every byte before Bluedroid reuses its H4 staging buffer. */
        for (unsigned i = 0; i < length; i++) AHC_REG(20) = data[i];

        AHC_REG(28) = 1;
        send_was_available = false;
    }

    xSemaphoreGive(transport_lock);
}

esp_err_t esp_vhci_host_register_callback(const esp_vhci_host_callback_t *callback)
{
    if (!callback || !callback->notify_host_recv || !callback->notify_host_send_available) return ESP_ERR_INVALID_ARG;
    if (controller_status == ESP_BT_CONTROLLER_STATUS_IDLE) return ESP_ERR_INVALID_STATE;

    host_callback = *callback;
    send_was_available = false;
    return ESP_OK;
}

esp_err_t esp_bredr_tx_power_get(esp_power_level_t *minimum, esp_power_level_t *maximum)
{
    return ESP_ERR_NOT_SUPPORTED;
}

esp_power_level_t esp_ble_tx_power_get(esp_ble_power_type_t type)
{
    return (esp_power_level_t)-1;
}

esp_err_t esp_bredr_sco_datapath_set(esp_sco_data_path_t path)
{
    return ESP_ERR_NOT_SUPPORTED;
}
