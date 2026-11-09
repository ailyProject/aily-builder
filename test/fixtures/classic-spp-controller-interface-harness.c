/* The test runner extracts the production query functions unchanged. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#include "aily-classic-spp-controller-interface.h"

typedef struct { unsigned held; } portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED {0}
static const aily_spp_controller_t *aily_spp_real_controller;
static aily_spp_controller_t aily_spp_controller_facade;
static portMUX_TYPE aily_spp_controller_mux = portMUX_INITIALIZER_UNLOCKED;
static unsigned critical_depth, critical_entries, factory_calls, getter_calls, callback_calls;
static bool sdk_ready, sdk_ble;
static bool expect_fence;
static jmp_buf original_getter_fence;
static uint16_t sdk_length;
static const aily_spp_controller_t *factory_result;
static void enter_critical(portMUX_TYPE *mux) {
  assert(mux == &aily_spp_controller_mux && !mux->held && !critical_depth);
  mux->held = 1; critical_depth = 1; critical_entries++;
}
static void exit_critical(portMUX_TYPE *mux) {
  assert(mux == &aily_spp_controller_mux && mux->held && critical_depth == 1);
  mux->held = 0; critical_depth = 0;
}
#define portENTER_CRITICAL(mux) enter_critical(mux)
#define portEXIT_CRITICAL(mux) exit_critical(mux)
static void outside_critical(void) { assert(!critical_depth && !aily_spp_controller_mux.held); }
static bool real_ready(void) { outside_critical(); return sdk_ready; }
static bool real_ble(void) { outside_critical(); assert(sdk_ready); return sdk_ble; }
static uint16_t real_length(void) {
  outside_critical(); getter_calls++;
  if (expect_fence && !sdk_ready) longjmp(original_getter_fence, 1);
  return sdk_length;
}
static void unexpected(void) { outside_critical(); callback_calls++; assert(!"unrelated SDK callback invoked"); }
static void trap_void(void) { unexpected(); }
static bool trap_bool(void) { unexpected(); return false; }
static uint8_t trap_u8(void) { unexpected(); return 0; }
static uint16_t trap_u16(void) { unexpected(); return 0; }
static void trap_set(int value) { (void)value; unexpected(); }
static const aily_spp_bdaddr_t *trap_address(void) { unexpected(); return NULL; }
static const aily_spp_version_t *trap_version(void) { unexpected(); return NULL; }
static const aily_spp_features_t *trap_features(void) { unexpected(); return NULL; }
static const aily_spp_features_t *trap_classic(int page) { (void)page; unexpected(); return NULL; }
static const uint8_t *trap_states(void) { unexpected(); return NULL; }
static const aily_spp_controller_t real_table = {
  .start_up=trap_void, .shut_down=trap_void, .get_is_ready=real_ready,
  .get_address=trap_address, .get_bt_version=trap_version, .get_features_classic=trap_classic,
  .get_last_features_classic_index=trap_u8, .get_features_ble=trap_features, .get_ble_supported_states=trap_states,
  .supports_simple_pairing=trap_bool, .supports_secure_connections=trap_bool, .supports_simultaneous_le_bredr=trap_bool,
  .supports_reading_remote_extended_features=trap_bool, .supports_interlaced_inquiry_scan=trap_bool,
  .supports_rssi_with_inquiry_results=trap_bool, .supports_extended_inquiry_response=trap_bool,
  .supports_master_slave_role_switch=trap_bool, .supports_ble=real_ble, .supports_ble_packet_extension=trap_bool,
  .supports_ble_connection_parameters_request=trap_bool, .supports_ble_privacy=trap_bool,
  .get_acl_data_size_classic=trap_u16, .get_acl_data_size_ble=trap_u16,
  .get_acl_packet_size_classic=trap_u16, .get_acl_packet_size_ble=trap_u16,
  .get_ble_default_data_packet_length=real_length, .get_ble_default_data_packet_txtime=trap_u16,
  .get_acl_buffer_count_classic=trap_u16, .get_acl_buffer_count_ble=trap_u8, .get_ble_white_list_size=trap_u8,
  .get_ble_resolving_list_max_size=trap_u8, .set_ble_resolving_list_max_size=trap_set,
  .get_sco_data_size=trap_u8, .get_sco_buffer_count=trap_u8,
};
const aily_spp_controller_t *__real_controller_get_interface(void) {
  outside_critical(); factory_calls++; return factory_result;
}
#include "controller-query-functions.inc"

int main(void) {
  assert(__wrap_controller_get_interface() == NULL && factory_calls == 1);
  assert(!aily_spp_real_controller && !getter_calls && !callback_calls);
  factory_result = &real_table;
  const aily_spp_controller_t *facade = __wrap_controller_get_interface();
  assert(facade && facade != &real_table);
  aily_spp_controller_t expected = real_table;
  expected.get_ble_default_data_packet_length = aily_spp_get_default_data_length;
  assert(memcmp(facade, &expected, sizeof(expected)) == 0);
  sdk_ready = false; sdk_ble = false; sdk_length = UINT16_C(0xe731);
  expect_fence = true;
  if (setjmp(original_getter_fence) == 0) {
    (void)facade->get_ble_default_data_packet_length();
    assert(!"unready getter did not retain the original SDK fence");
  }
  expect_fence = false;
  assert(getter_calls == 1);
  sdk_ready = true; sdk_ble = false;
  assert(facade->get_ble_default_data_packet_length() == 0 && getter_calls == 1);
  sdk_ble = true; sdk_length = UINT16_C(0xfedc);
  assert(facade->get_ble_default_data_packet_length() == UINT16_C(0xfedc) && getter_calls == 2);
  for (unsigned i = 0; i < 8; i++) {
    assert(__wrap_controller_get_interface() == facade);
    assert(memcmp(facade, &expected, sizeof(expected)) == 0);
  }
  factory_result = NULL;
  assert(__wrap_controller_get_interface() == NULL);
  factory_result = &real_table;
  assert(__wrap_controller_get_interface() == facade);
  assert(memcmp(facade, &expected, sizeof(expected)) == 0);
  assert(real_table.get_ble_default_data_packet_length == real_length);
  outside_critical(); assert(critical_entries && !callback_calls && getter_calls == 2);
  puts("classic-spp-controller-interface: passed");
  return 0;
}
