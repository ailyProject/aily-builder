#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

/* Target-only simulation transport. Not an ESP32 Wi-Fi hardware driver.
 * Caller serializes all operations and owns its polling/task lifecycle. */
bool aily_openeth_present(void);
bool aily_openeth_is_open(uint32_t epoch);
/* Successful open increments a local guest lifecycle epoch, not a Native ABI
 * epoch. Native retains the Worker-admitted NIC MAC across reset. The SDK
 * station MAC must match that admitted MAC. No ANP1/AWF1 MMIO is used. */
esp_err_t aily_openeth_open(uint32_t *out_epoch);
#define AILY_OPENETH_MAX_FRAME 1514u
void aily_openeth_close(void);
/* Copies bytes. ESP_OK means only Native descriptor consumption, not peer
 * receipt or application delivery. Ethernet-II, 14..1514B, FCS excluded. */
esp_err_t aily_openeth_send(const uint8_t *frame, size_t length);
/* Returns an owned malloc copy without the Native's four zero FCS bytes.
 * ESP_ERR_NOT_FOUND means no frame. Caller transfers to esp_netif_receive;
 * successful receive is freed by its configured free_rx_buffer callback;
 * caller frees on receive error. No callback is invoked by this transport. */
esp_err_t aily_openeth_read(uint8_t **out, size_t *out_length);
