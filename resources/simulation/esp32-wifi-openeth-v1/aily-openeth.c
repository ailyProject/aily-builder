#include "aily-openeth.h"
#include "sdkconfig.h"
#include "esp_heap_caps.h"
#include <stdlib.h>
#include <string.h>
#include <limits.h>

#if !CONFIG_IDF_TARGET_ESP32
#error "aily-openeth is only for the explicitly selected classic ESP32 simulation provider"
#endif

/* Matches the audited P15+AIO e40f8921 Native open_eth, not a hardware EMAC
 * register specification. Source hw/net/opencores_eth.c plus esp32.c:893.
 * This transport is deliberately polling-only: INT_MASK=0, no IRQ38 owner. */
#define OE_BASE UINT32_C(0x3ff69000)
#define OE_DESC UINT32_C(0x3ff69400)
#define OE_REG(offset) (*(volatile uint32_t *)(uintptr_t)(OE_BASE + (offset)))
#define OE_DESC_WORD(index, word) (*(volatile uint32_t *)(uintptr_t)(OE_DESC + (index) * 8u + (word) * 4u))
#define OE_MODER 0x00u
#define OE_INT_SOURCE 0x04u
#define OE_INT_MASK 0x08u
#define OE_PACKETLEN 0x18u
#define OE_TX_BD_NUM 0x20u
#define OE_MIICOMMAND 0x2cu
#define OE_MIIADDRESS 0x30u
#define OE_MIIRX_DATA 0x38u
#define OE_MAC_ADDR0 0x40u
#define OE_MAC_ADDR1 0x44u
#define OE_RXEN UINT32_C(1)
#define OE_TXEN UINT32_C(2)
#define OE_RST UINT32_C(0x800)
#define OE_READY UINT32_C(0x8000)
#define OE_WRAP UINT32_C(0x2000)
#define OE_RX_ERRORS UINT32_C(0x7f)
#define OE_TX_ERRORS UINT32_C(0x1ff)
#define OE_MIN_FRAME 14u
#define OE_MAX_FRAME 1514u
#define OE_RX_BYTES (OE_MAX_FRAME + 4u)
#define OE_RX_COUNT 2u

static bool opened;
static uint32_t epoch;
static unsigned rx_index = 1u;
static uint8_t *tx_buffer;
static uint8_t *rx_buffer[OE_RX_COUNT];

static inline void oe_barrier(void) { __asm__ volatile("memw" ::: "memory"); }
static uint32_t rx_flags(unsigned index) { return OE_READY | (index == OE_RX_COUNT ? OE_WRAP : 0u); }

bool aily_openeth_present(void)
{
    /* QEMU's synchronous DP83848C subset provides stable PHY IDs. The MMIO
     * device has no custom magic/version register. This is a finite model
     * presence check, not discovery of an arbitrary hardware network device. */
    const uint32_t saved_addr = OE_REG(OE_MIIADDRESS);
    const uint32_t saved_cmd = OE_REG(OE_MIICOMMAND);
    OE_REG(OE_MIIADDRESS) = (2u << 8) | 1u;
    OE_REG(OE_MIICOMMAND) = 2u;
    const uint32_t id1 = OE_REG(OE_MIIRX_DATA);
    OE_REG(OE_MIIADDRESS) = (3u << 8) | 1u;
    OE_REG(OE_MIICOMMAND) = 2u;
    const uint32_t id2 = OE_REG(OE_MIIRX_DATA);
    OE_REG(OE_MIIADDRESS) = saved_addr;
    OE_REG(OE_MIICOMMAND) = saved_cmd;
    return id1 == UINT32_C(0x2000) && id2 == UINT32_C(0x5c90);
}

bool aily_openeth_is_open(uint32_t expected_epoch) { return opened && expected_epoch != 0u && expected_epoch == epoch; }

void aily_openeth_close(void)
{
    /* Stop DMA before retiring storage. close remains idempotent and does not
     * probe/write an absent MMIO device before the first successful open. */
    if (opened) {
        OE_REG(OE_MODER) = 0;
        OE_REG(OE_INT_MASK) = 0;
        oe_barrier();
        for (unsigned index = 0; index <= OE_RX_COUNT; ++index) {
            OE_DESC_WORD(index, 0) = 0;
            OE_DESC_WORD(index, 1) = 0;
        }
        OE_REG(OE_INT_SOURCE) = UINT32_MAX;
        opened = false;
    }
    free(tx_buffer); tx_buffer = NULL;
    for (unsigned index = 0; index < OE_RX_COUNT; ++index) {
        free(rx_buffer[index]); rx_buffer[index] = NULL;
    }
    rx_index = 1u;
}

esp_err_t aily_openeth_open(uint32_t *out_epoch)
{
    if (!out_epoch) return ESP_ERR_INVALID_ARG;
    if (opened || epoch == UINT32_MAX) return ESP_ERR_INVALID_STATE;
    if (!aily_openeth_present()) return ESP_ERR_NOT_SUPPORTED;
    tx_buffer = heap_caps_malloc(OE_MAX_FRAME, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    for (unsigned index = 0; index < OE_RX_COUNT; ++index) {
        rx_buffer[index] = heap_caps_malloc(OE_RX_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (!tx_buffer || !rx_buffer[0] || !rx_buffer[1]) { aily_openeth_close(); return ESP_ERR_NO_MEM; }

    OE_REG(OE_MODER) = OE_RST;
    OE_REG(OE_MODER) = 0;
    OE_REG(OE_INT_MASK) = 0;
    OE_REG(OE_INT_SOURCE) = UINT32_MAX;
    /* MINFL=0 avoids Native minimum-size padding. MAXFL=1518 always leaves
     * four FCS zero bytes for every admitted <=1514B Ethernet frame. */
    OE_REG(OE_PACKETLEN) = OE_RX_BYTES;
    OE_REG(OE_TX_BD_NUM) = 1;
    /* open_eth_reset restores the exact MAC from the Worker NICConf. Do not
     * invent or silently replace a Runtime-admitted identity in the guest. */
    /* Reset does not clear the Native descriptor array. Explicitly clear all
     * 128 before enabling TX/RX; only our bounded three descriptors exist. */
    for (unsigned index = 0; index < 128u; ++index) {
        OE_DESC_WORD(index, 0) = 0;
        OE_DESC_WORD(index, 1) = 0;
    }
    OE_DESC_WORD(0, 1) = (uint32_t)(uintptr_t)tx_buffer;
    for (unsigned index = 1; index <= OE_RX_COUNT; ++index) {
        OE_DESC_WORD(index, 1) = (uint32_t)(uintptr_t)rx_buffer[index - 1u];
        OE_DESC_WORD(index, 0) = rx_flags(index);
    }
    oe_barrier();
    rx_index = 1u;
    opened = true;
    ++epoch;
    *out_epoch = epoch;
    /* BRO=0 admits broadcast. PAD/CRC/PRO/IAM/IRQ are intentionally off. */
    OE_REG(OE_MODER) = OE_RXEN | OE_TXEN;
    return ESP_OK;
}

esp_err_t aily_openeth_send(const uint8_t *frame, size_t length)
{
    if (!opened) return ESP_ERR_INVALID_STATE;
    if (!frame || length < OE_MIN_FRAME || length > OE_MAX_FRAME) return ESP_ERR_INVALID_ARG;
    if (OE_DESC_WORD(0, 0) & OE_READY) return ESP_ERR_TIMEOUT;
    memcpy(tx_buffer, frame, length);
    oe_barrier();
    /* Publishing RD last triggers Native's synchronous descriptor consume.
     * WR always returns Native's one-slot TX ring to descriptor zero. */
    OE_DESC_WORD(0, 0) = ((uint32_t)length << 16) | OE_READY | OE_WRAP;
    oe_barrier();
    const uint32_t result = OE_DESC_WORD(0, 0);
    if (result & OE_READY) return ESP_ERR_TIMEOUT;
    return (result & OE_TX_ERRORS) ? ESP_FAIL : ESP_OK;
}

esp_err_t aily_openeth_read(uint8_t **out, size_t *out_length)
{
    if (!out || !out_length) return ESP_ERR_INVALID_ARG;
    *out = NULL; *out_length = 0;
    if (!opened) return ESP_ERR_INVALID_STATE;
    const uint32_t status = OE_DESC_WORD(rx_index, 0);
    if (status & OE_READY) return ESP_ERR_NOT_FOUND;
    oe_barrier();
    const size_t with_fcs = status >> 16;
    esp_err_t result = ESP_OK;
    if (with_fcs < OE_MIN_FRAME + 4u || with_fcs > OE_RX_BYTES || (status & OE_RX_ERRORS)) result = ESP_ERR_INVALID_SIZE;
    else {
        const size_t length = with_fcs - 4u;
        uint8_t *copy = malloc(length);
        /* Retain a completed descriptor on OOM for bounded retry rather than
         * delivering a dangling buffer or falsely acknowledging a packet. */
        if (!copy) return ESP_ERR_NO_MEM;
        memcpy(copy, rx_buffer[rx_index - 1u], length);
        *out = copy; *out_length = length;
    }
    oe_barrier();
    OE_DESC_WORD(rx_index, 0) = rx_flags(rx_index);
    rx_index = rx_index == OE_RX_COUNT ? 1u : rx_index + 1u;
    return result;
}
