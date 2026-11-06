/* Explicit simulation-only packet mailbox, not Espressif controller registers.
 * Native source GPL-2.0-or-later; this ABI declaration may be used by guest glue.
 * Packet data is H4 or Ethernet-II, never OS UART/HCI device handles.
 */
#ifndef AILY_PACKET_ABI_V1_H
#define AILY_PACKET_ABI_V1_H
#include <stdint.h>
#define AILY_HCI_C3_BASE       UINT32_C(0x600f0000)
#define AILY_NETWORK_C3_BASE   UINT32_C(0x600f1000)
#define AILY_HCI_MAGIC         UINT32_C(0x41484332) /* AHC2, incompatible with byte FIFO AHC1 */
#define AILY_NETWORK_MAGIC     UINT32_C(0x414e5031) /* ANP1 */
#define AILY_PACKET_SCHEMA     UINT32_C(1)
#define AILY_HCI_MAX_PACKET    1029u /* complete H4 command/event/ACL, ACL payload<=1024 */
#define AILY_NETWORK_MAX_PACKET 1514u /* complete untagged Ethernet-II, no FCS */
#define AILY_PACKET_QUEUE_MAX  32u
#define AILY_PACKET_QUEUE_BYTES 65536u
#define AILY_PACKET_MAGIC_REG  0x00u
#define AILY_PACKET_SCHEMA_REG 0x04u
#define AILY_PACKET_STATUS_REG 0x08u
#define AILY_PACKET_CTRL_REG   0x0cu
#define AILY_PACKET_EPOCH_REG  0x10u
#define AILY_PACKET_MAX_REG    0x14u
#define AILY_PACKET_RX_LEN_REG 0x18u
#define AILY_PACKET_RX_DATA_REG 0x1cu /* low8bits, one byte per aligned32bit read; empty=UINT32_MAX */
#define AILY_PACKET_RX_REMAIN_REG 0x20u
#define AILY_PACKET_RX_ACK_REG 0x24u /* only after full read; write the original RX_LEN */
#define AILY_PACKET_TX_CAP_REG 0x28u /* complete-packet admission capacity, not peer credit */
#define AILY_PACKET_TX_DATA_REG 0x2cu /* append one byte per aligned32bit write, value<=255 */
#define AILY_PACKET_TX_LEN_REG 0x30u
#define AILY_PACKET_TX_COMMIT_REG 0x34u /* write exact staged length; queued only, not HCI/peer ACK */
#define AILY_PACKET_ERROR_REG 0x38u
#define AILY_PACKET_RX_QUEUED_REG 0x3cu
#define AILY_PACKET_TX_QUEUED_REG 0x40u
#define AILY_PACKET_CONNECTED  UINT32_C(1)
#define AILY_PACKET_ENABLED    UINT32_C(2)
#define AILY_PACKET_FAULT      UINT32_C(4)
#define AILY_PACKET_RX_READY   UINT32_C(8)
#define AILY_PACKET_TX_PENDING UINT32_C(16)
#define AILY_PACKET_ENABLE     UINT32_C(1)
#define AILY_PACKET_RESET      UINT32_C(2) /* clears queues/fault, disables, epoch++; never replays */
#define AILY_PACKET_CLOSE      UINT32_C(4) /* clears queues, disables, epoch++; no fake OS close ACK */
/* HCI TX: command(1)/ACL(2); HCI RX: event(4)/ACL(2). SCO/ISO rejected.
 * HCI chardev carries H4 directly. Network chardev uses BEuint32 length+frame.
 * Reset cannot label untagged bytes still in an external Worker/pipe queue:
 * composition must retire old peer and drain/clear its queue before re-enable.
 * CONNECTED says only chardev readiness. It is not WiFi association, BLE-ready,
 * a granted permission, a delivered packet, or a successful guest operation.
 */
#endif
