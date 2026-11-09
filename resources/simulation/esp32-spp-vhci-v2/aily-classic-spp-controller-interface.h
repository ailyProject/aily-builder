/******************************************************************************
 *
 *  Copyright (C) 2014 Google, Inc.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at:
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 ******************************************************************************/

/* Private exact-SDK contract, not a public Bluetooth interface.
 * Source: ESP-IDF735507283d5b2f9fb363a1901172dbd9e847945d,
 * components/bt/host/bluedroid/device/include/device/controller.h
 * SHA2567a6633003e055e878aa52e95d8436d53612e076a2e0d54738dc2b6b1026e42b2.
 * Selected libbt.a SHA256d500529efd1d391492a4e5798f39f722e3bf0bbc359ff7c819bce56b1ca7141f.
 * The selected34slots were checked against the actual archive relocations and
 * target compiler ABI. BLE50 optional slots are absent; SCO tail slots exist.
 * Pointer-only SDK value types stay opaque: no payload representation is used.
 */
#ifndef AILY_CLASSIC_SPP_CONTROLLER_INTERFACE_H
#define AILY_CLASSIC_SPP_CONTROLLER_INTERFACE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef struct aily_spp_opaque_bdaddr aily_spp_bdaddr_t;
typedef struct aily_spp_opaque_version aily_spp_version_t;
typedef struct aily_spp_opaque_features aily_spp_features_t;
typedef struct aily_spp_controller_t {
  void (*start_up)(void);
  void (*shut_down)(void);
  bool (*get_is_ready)(void);
  const aily_spp_bdaddr_t *(*get_address)(void);
  const aily_spp_version_t *(*get_bt_version)(void);
  const aily_spp_features_t *(*get_features_classic)(int index);
  uint8_t (*get_last_features_classic_index)(void);
  const aily_spp_features_t *(*get_features_ble)(void);
  const uint8_t *(*get_ble_supported_states)(void);
  bool (*supports_simple_pairing)(void);
  bool (*supports_secure_connections)(void);
  bool (*supports_simultaneous_le_bredr)(void);
  bool (*supports_reading_remote_extended_features)(void);
  bool (*supports_interlaced_inquiry_scan)(void);
  bool (*supports_rssi_with_inquiry_results)(void);
  bool (*supports_extended_inquiry_response)(void);
  bool (*supports_master_slave_role_switch)(void);
  bool (*supports_ble)(void);
  bool (*supports_ble_packet_extension)(void);
  bool (*supports_ble_connection_parameters_request)(void);
  bool (*supports_ble_privacy)(void);
  uint16_t (*get_acl_data_size_classic)(void);
  uint16_t (*get_acl_data_size_ble)(void);
  uint16_t (*get_acl_packet_size_classic)(void);
  uint16_t (*get_acl_packet_size_ble)(void);
  uint16_t (*get_ble_default_data_packet_length)(void);
  uint16_t (*get_ble_default_data_packet_txtime)(void);
  uint16_t (*get_acl_buffer_count_classic)(void);
  uint8_t (*get_acl_buffer_count_ble)(void);
  uint8_t (*get_ble_white_list_size)(void);
  uint8_t (*get_ble_resolving_list_max_size)(void);
  void (*set_ble_resolving_list_max_size)(int resolving_list_max_size);
  uint8_t (*get_sco_data_size)(void);
  uint8_t (*get_sco_buffer_count)(void);
} aily_spp_controller_t;
/* The actual production target is32bit. Host software tests separately check
 * table copying with their native pointer size; they are not target ABI proof. */
#if UINTPTR_MAX == UINT32_MAX
_Static_assert(sizeof(aily_spp_controller_t) ==136,"Selected controller interface size differs");
_Static_assert(_Alignof(aily_spp_controller_t) ==4,"Selected controller interface alignment differs");
_Static_assert(offsetof(aily_spp_controller_t,start_up) ==0,"Selected start_up slot differs");
_Static_assert(offsetof(aily_spp_controller_t,shut_down) ==4,"Selected shut_down slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_is_ready) ==8,"Selected get_is_ready slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_address) ==12,"Selected get_address slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_bt_version) ==16,"Selected get_bt_version slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_features_classic) ==20,"Selected get_features_classic slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_last_features_classic_index) ==24,"Selected get_last_features_classic_index slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_features_ble) ==28,"Selected get_features_ble slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_ble_supported_states) ==32,"Selected get_ble_supported_states slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_simple_pairing) ==36,"Selected supports_simple_pairing slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_secure_connections) ==40,"Selected supports_secure_connections slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_simultaneous_le_bredr) ==44,"Selected supports_simultaneous_le_bredr slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_reading_remote_extended_features) ==48,"Selected supports_reading_remote_extended_features slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_interlaced_inquiry_scan) ==52,"Selected supports_interlaced_inquiry_scan slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_rssi_with_inquiry_results) ==56,"Selected supports_rssi_with_inquiry_results slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_extended_inquiry_response) ==60,"Selected supports_extended_inquiry_response slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_master_slave_role_switch) ==64,"Selected supports_master_slave_role_switch slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_ble) ==68,"Selected supports_ble slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_ble_packet_extension) ==72,"Selected supports_ble_packet_extension slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_ble_connection_parameters_request) ==76,"Selected supports_ble_connection_parameters_request slot differs");
_Static_assert(offsetof(aily_spp_controller_t,supports_ble_privacy) ==80,"Selected supports_ble_privacy slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_acl_data_size_classic) ==84,"Selected get_acl_data_size_classic slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_acl_data_size_ble) ==88,"Selected get_acl_data_size_ble slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_acl_packet_size_classic) ==92,"Selected get_acl_packet_size_classic slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_acl_packet_size_ble) ==96,"Selected get_acl_packet_size_ble slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_ble_default_data_packet_length) ==100,"Selected get_ble_default_data_packet_length slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_ble_default_data_packet_txtime) ==104,"Selected get_ble_default_data_packet_txtime slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_acl_buffer_count_classic) ==108,"Selected get_acl_buffer_count_classic slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_acl_buffer_count_ble) ==112,"Selected get_acl_buffer_count_ble slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_ble_white_list_size) ==116,"Selected get_ble_white_list_size slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_ble_resolving_list_max_size) ==120,"Selected get_ble_resolving_list_max_size slot differs");
_Static_assert(offsetof(aily_spp_controller_t,set_ble_resolving_list_max_size) ==124,"Selected set_ble_resolving_list_max_size slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_sco_data_size) ==128,"Selected get_sco_data_size slot differs");
_Static_assert(offsetof(aily_spp_controller_t,get_sco_buffer_count) ==132,"Selected get_sco_buffer_count slot differs");
#endif
_Static_assert(__builtin_types_compatible_p(__typeof__(((aily_spp_controller_t*)0)->get_ble_default_data_packet_length),uint16_t(*)(void)),"Selected default length return ABI differs");
_Static_assert(__builtin_types_compatible_p(__typeof__(((aily_spp_controller_t*)0)->supports_ble),bool(*)(void)),"Selected BLE support return ABI differs");
extern const aily_spp_controller_t *__real_controller_get_interface(void);
#endif
