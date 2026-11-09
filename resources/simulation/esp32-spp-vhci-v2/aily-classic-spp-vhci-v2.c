/* Explicit ordinary Arduino BluetoothSerial provider. The package stages the
 * authoritative AHC2 implementation below as an include, never a transport fork.
 * No SPP/RFCOMM/L2CAP/SDP packet or peer acknowledgement is synthesized here. */
#define AILY_CLASSIC_AHC2_SPP 1
#include "aily-classic-vhci-ahc2.inc"
#include "aily-classic-spp-controller-interface.h"

static const aily_spp_controller_t *aily_spp_real_controller;
static aily_spp_controller_t aily_spp_controller_facade;
static portMUX_TYPE aily_spp_controller_mux = portMUX_INITIALIZER_UNLOCKED;

/* The selected Bluedroid LCB allocator reads this BLE-only field even for a
 * BR link. Preserve the real readiness assertion and real BLE value. A ready
 * BR-only controller leaves the unused BLE field at its zero initial value;
 * this is not the BR ACL size, a controller feature or an HCI completion. */
static uint16_t aily_spp_get_default_data_length(void) {
  const aily_spp_controller_t *original = aily_spp_real_controller;
  if (!original->get_is_ready()) return original->get_ble_default_data_packet_length();
  if (!original->supports_ble()) return 0;
  return original->get_ble_default_data_packet_length();
}

const aily_spp_controller_t *__wrap_controller_get_interface(void) {
  const aily_spp_controller_t *original = __real_controller_get_interface();
  if (!original) return original;
  const aily_spp_controller_t *result;
  /* Never call a real SDK getter while holding this short publication lock. */
  portENTER_CRITICAL(&aily_spp_controller_mux);
  if (!aily_spp_real_controller) {
    aily_spp_controller_facade = *original;
    aily_spp_real_controller = original;
    aily_spp_controller_facade.get_ble_default_data_packet_length = aily_spp_get_default_data_length;
  }
  /* The pinned SDK owns one const table. Preserve an unexpected real table
   * unchanged rather than redirecting an older facade to a different owner. */
  result = aily_spp_real_controller == original ? &aily_spp_controller_facade : original;
  portEXIT_CRITICAL(&aily_spp_controller_mux);
  return result;
}
