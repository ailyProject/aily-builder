import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import type { Dependency } from './DependencyAnalyzer';

export const ESP32_VHCI_PROVIDER = 'aily.esp32-vhci-v1';
export const ESP32C3_BLE_PROVIDER = 'aily.esp32c3-ble-vhci-v1';
export const ESP32C3_BLE_LINKER_WRAPPERS = Object.freeze([
  'esp_bt_controller_init', 'esp_bt_controller_enable', 'esp_bt_controller_disable', 'esp_bt_controller_deinit',
  'esp_vhci_host_check_send_available', 'esp_vhci_host_register_callback', 'esp_vhci_host_send_packet',
  'esp_ble_tx_power_get',
] as const);
export const ESP32C6_BLE_PROVIDER = 'aily.esp32c6-ble-nimble-v1';
export const ESP32C6_BLE_LINKER_WRAPPERS = Object.freeze([
  'esp_bt_controller_init', 'esp_bt_controller_enable', 'esp_bt_controller_disable', 'esp_bt_controller_deinit',
  'hci_transport_host_callback_register', 'hci_transport_host_cmd_tx', 'hci_transport_host_acl_tx',
  'r_ble_hci_trans_buf_alloc', 'r_ble_hci_trans_buf_free',
  'esp_ble_tx_power_get',
] as const);
export const ESP32C3_WIFI_PROVIDER = 'aily.esp32c3-wifi-sdk-driver-v1';
export const ESP32C6_WIFI_PROVIDER = 'aily.esp32c6-wifi-sdk-driver-v1';
/** Ordinary classic STA uses a versioned SDK driver over the actual OpenETH
 * device, separate from the historical split-radio simulationNetwork path. */
export const ESP32_WIFI_OPENETH_PROVIDER = 'aily.esp32-wifi-openeth-v1';
export const ESP32C3_WIFI_LINKER_WRAPPERS = Object.freeze([
  'esp_wifi_init', 'esp_wifi_deinit', 'esp_netif_create_default_wifi_sta',
  'esp_netif_create_default_wifi_ap', 'esp_netif_destroy_default_wifi',
  'esp_wifi_set_mode', 'esp_wifi_get_mode', 'esp_wifi_set_storage',
  'esp_wifi_set_config', 'esp_wifi_get_config', 'esp_wifi_start', 'esp_wifi_stop',
  'esp_wifi_connect', 'esp_wifi_disconnect', 'esp_wifi_set_ps', 'esp_wifi_get_mac',
  'phy_bbpll_en_usb', 'esp_wifi_get_protocol', 'esp_wifi_set_protocol',
  'esp_wifi_get_channel', 'esp_wifi_sta_get_ap_info', 'esp_wifi_scan_start',
  'esp_wifi_scan_get_ap_num', 'esp_wifi_scan_get_ap_records', 'esp_wifi_get_country',
  'esp_wifi_get_max_tx_power', 'esp_wifi_set_max_tx_power', 'esp_wifi_restore',
  'esp_wifi_set_channel', 'esp_wifi_set_bandwidth',
] as const);
const C3_DIRECTORY = 'aily-esp32c3-wifi-sdk-driver-v1';
const C3_FILES = ['aily-c3-wifi-driver-v1.c', 'awf-control-v1.h', 'aily_packet_abi.h'] as const;
const C3_DEPENDENCY = '__simulation_transport_c3_wifi__';
const C6_DIRECTORY = 'aily-esp32c6-wifi-sdk-driver-v1';
const C6_FILES = ['aily-c6-wifi-driver-v1.c', C3_FILES[1], C3_FILES[2]] as const;
const C6_DEPENDENCY = '__simulation_transport_c6_wifi__';
const C3_BLE_DIRECTORY = 'aily-esp32c3-ble-vhci-v1';
const C3_BLE_FILES = ['aily-c3-ble-vhci-v1.c', 'aily_packet_abi.h'] as const;
const C3_BLE_DEPENDENCY = '__simulation_transport_c3_ble__';
const C6_BLE_IPC_DIRECTORY = 'aily-esp32c6-ble-nimble-v1';
const C6_BLE_IPC_FILES = ['aily-c6-ble-hci-ipc-v1.c', 'aily_packet_abi.h'] as const;
const C6_BLE_IPC_DEPENDENCY = '__simulation_transport_c6_ble_ipc__';
const CLASSIC_WIFI_DIRECTORY = 'aily-esp32-wifi-openeth-v1';
const CLASSIC_WIFI_FILES = ['aily-classic-wifi-driver-v1.c', 'aily-openeth.c',
  'aily-openeth.h', 'awf-control-v1.h'] as const;
const CLASSIC_WIFI_DEPENDENCY = '__simulation_transport_classic_wifi__';
export interface SimulationTransportAbi {
  platformVersion?: string;
  sdkPath?: string;
  compilerSdkPath?: string;
  memoryType?: string;
  toolVersions?: Readonly<Record<string, string>>;
}
export interface PreparedSimulationProviderInputs {
  schemaVersion: 1;
  provider: typeof ESP32C3_BLE_PROVIDER | typeof ESP32C6_BLE_PROVIDER | typeof ESP32_WIFI_OPENETH_PROVIDER;
  scope: 'prepared-and-verified-sources-not-compiler-consumption';
  sources: Array<{ path: string; bytes: number; sha256: string }>;
  selectedSdk: Array<{ path: string; bytes: number; sha256: string }>;
}
export interface SimulationTransportSources {
  providers: string[];
  providerSourceInputs?: PreparedSimulationProviderInputs;
  network?: { wifi: true; httpPort?: number };
}

function selectWrappedProvider(providers: readonly string[]) {
  const c6BleIpc = providers.includes(ESP32C6_BLE_PROVIDER)
    ? { name: 'C6 BLE IPC', symbols: ESP32C6_BLE_LINKER_WRAPPERS }
    : undefined;
  const selected = providers.includes(ESP32_WIFI_OPENETH_PROVIDER)
    ? { name: 'Classic Wi-Fi OpenETH', symbols: ESP32C3_WIFI_LINKER_WRAPPERS }
    : c6BleIpc ?? (providers.includes(ESP32C3_BLE_PROVIDER)
    ? { name: 'C3 BLE', symbols: ESP32C3_BLE_LINKER_WRAPPERS }
    : providers.includes(ESP32C3_WIFI_PROVIDER)
      ? { name: 'C3 Wi-Fi', symbols: ESP32C3_WIFI_LINKER_WRAPPERS }
      : providers.includes(ESP32C6_WIFI_PROVIDER)
        ? { name: 'C6 Wi-Fi', symbols: ESP32C3_WIFI_LINKER_WRAPPERS }
        : undefined);
  if (selected && providers.length !== 1) {
    throw new Error(`${selected.name} provider cannot be mixed with another controller provider.`);
  }
  return selected;
}

/** Add only the package-owned fixed wraps. Clone the effective platform so a
 * reused preprocess result never inherits simulation link intent. */
export function applySimulationTransportPlatform<T>(configuration: T, providers: readonly string[]): T {
  const selected = selectWrappedProvider(providers);
  if (!selected) return configuration;
  const record = configuration as any;
  if (!record || typeof record !== 'object' || !record.platform || typeof record.platform !== 'object') {
    throw new Error(`${selected.name} provider requires a resolved Arduino platform.`);
  }
  const previous = record.platform['compiler.c.elf.extra_flags'];
  if (previous !== undefined && typeof previous !== 'string') throw new Error('Invalid resolved linker flags.');
  const wraps = selected.symbols.map(symbol => `-Wl,--wrap,${symbol}`).join(' ');
  return { ...record, platform: { ...record.platform,
    'compiler.c.elf.extra_flags': previous ? `${previous} ${wraps}` : wraps } } as T;
}

/** The current Parser resolves linker properties into args.ld before provider
 * discovery. Appending only the platform variable would leave a dead variable
 * in Ninja. Apply the same fixed flags to the cloned, actually consumed IR. */
export function applySimulationTransportCompileConfig<T>(configuration: T, providers: readonly string[]): T {
  const selected = selectWrappedProvider(providers);
  if (!selected) return configuration;
  const record = configuration as any;
  if (!record || typeof record !== 'object' || !record.args || typeof record.args.ld !== 'string') {
    throw new Error(`${selected.name} provider requires resolved linker arguments.`);
  }
  const wraps = selected.symbols.map(symbol => `-Wl,--wrap,${symbol}`).join(' ');
  return { ...record, args: { ...record.args, ld: `${record.args.ld} ${wraps}` } } as T;
}

function requireC3Abi(abi: SimulationTransportAbi | undefined, provider = 'C3 Wi-Fi'): void {
  if (abi?.platformVersion !== '3.3.10' || abi.toolVersions?.['esp32c3-libs'] !== '3.3.10'
    || abi.toolVersions?.['esp-rv32'] !== '14.2.0') {
    throw new Error(`${provider} simulation requires exact Arduino 3.3.10, esp32c3-libs 3.3.10 and esp-rv32 14.2.0.`);
  }
}

export function isC6WifiMemoryType(value: unknown): value is 'dio_qspi' | 'qio_qspi' {
  return value === 'dio_qspi' || value === 'qio_qspi';
}

async function requireC6WifiSdk(abi: SimulationTransportAbi | undefined, dependencies: Dependency[]) {
  if (abi?.platformVersion !== '3.3.10' || abi.toolVersions?.['esp32c6-libs'] !== '3.3.10'
    || abi.toolVersions?.['esp-rv32'] !== '14.2.0') {
    throw new Error('C6 Wi-Fi simulation requires exact Arduino 3.3.10, esp32c6-libs 3.3.10 and esp-rv32 14.2.0.');
  }
  if (!isC6WifiMemoryType(abi.memoryType) || !abi.sdkPath || !abi.compilerSdkPath
    || [abi.sdkPath, abi.compilerSdkPath].some(value => !path.isAbsolute(value) || /[{}\x00-\x1f]/.test(value))) {
    throw new Error('C6 Wi-Fi requires resolved SDK paths and the selected dio_qspi or qio_qspi memory profile.');
  }
  const libraries = dependencies.filter(item => item.type === 'library' && item.name === 'WiFi');
  const expectedLibrary = await fs.realpath(path.join(abi.sdkPath, 'libraries', 'WiFi', 'src'));
  if (libraries.length !== 1 || await fs.realpath(libraries[0].path) !== expectedLibrary) {
    throw new Error('C6 Wi-Fi requires the selected Arduino SDK WiFi library.');
  }
  const [configuration, idf] = await Promise.all([
    fs.readFile(path.join(abi.compilerSdkPath, abi.memoryType, 'include', 'sdkconfig.h'), 'utf8'),
    fs.readFile(path.join(abi.compilerSdkPath, 'include', 'esp_common', 'include', 'esp_idf_version.h'), 'utf8'),
  ]);
  const flashMode = abi.memoryType === 'qio_qspi' ? 'qio' : 'dio';
  if (!/^#define\s+CONFIG_IDF_TARGET_ESP32C6\s+1\s*$/m.test(configuration)
    || !/^#define\s+CONFIG_IDF_TARGET\s+"esp32c6"\s*$/m.test(configuration)
    || !new RegExp(`^#define\\s+CONFIG_LIB_BUILDER_FLASHMODE\\s+"${flashMode}"\\s*$`, 'm').test(configuration)
    || ![['MAJOR', 5], ['MINOR', 5], ['PATCH', 4]].every(([part, value]) =>
      new RegExp(`^#define\\s+ESP_IDF_VERSION_${part}\\s+${value}\\s*$`, 'm').test(idf))) {
    throw new Error('C6 Wi-Fi requires its selected ESP32-C6 SDK configuration and ESP-IDF 5.5.4.');
  }
}
async function sourceIdentity(filename: string, maximum: number) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid bounded C3 BLE provider input.');
  const bytes = await fs.readFile(filename);
  if (bytes.length !== stat.size) throw new Error('C3 BLE provider input changed while preparing.');
  return { path: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
/** Same prepared files must still match after a successful pipeline. This
 * bookend does not assert that a compiler executed or consumed any given byte. */
export async function verifyPreparedSimulationProviderInputs(inputs?: PreparedSimulationProviderInputs): Promise<void> {
  if (!inputs) return;
  if (inputs.provider === ESP32_WIFI_OPENETH_PROVIDER) {
    if (inputs.schemaVersion !== 1 || inputs.sources.length !== 4 || inputs.selectedSdk.length !== 8) {
      throw new Error('Invalid prepared classic Wi-Fi OpenETH input identity.');
    }
    for (const expected of [...inputs.sources, ...inputs.selectedSdk]) {
      const actual = await sourceIdentity(expected.path, 4 * 1024 * 1024);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error('Prepared classic Wi-Fi OpenETH input changed before Artifact emission.');
      }
    }
    return;
  }
  if (inputs.provider === ESP32C6_BLE_PROVIDER) {
    if (inputs.schemaVersion !== 1 || inputs.sources.length !== 2 || inputs.selectedSdk.length !== 7) {
      throw new Error('Invalid prepared C6 BLE IPC input identity.');
    }
    for (const expected of [...inputs.sources, ...inputs.selectedSdk]) {
      const actual = await sourceIdentity(expected.path, 4 * 1024 * 1024);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error('Prepared C6 BLE IPC input changed before Artifact emission.');
      }
    }
    return;
  }
  if (inputs.schemaVersion !== 1 || inputs.provider !== ESP32C3_BLE_PROVIDER || inputs.sources.length !== 2 || inputs.selectedSdk.length !== 4) throw new Error('Invalid prepared C3 BLE input identity.');
  for (const expected of [...inputs.sources, ...inputs.selectedSdk]) {
    const actual = await sourceIdentity(expected.path, 128 * 1024);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('Prepared C3 BLE input changed before Artifact publication.');
  }
}
async function requireC3BleSdk(abi: SimulationTransportAbi | undefined, dependencies: Dependency[]) {
  requireC3Abi(abi, 'C3 BLE');
  const absolute = (value: string | undefined) => {
    if (!value || !path.isAbsolute(value) || /[{}\x00-\x1f]/.test(value)) throw new Error('C3 BLE requires resolved SDK paths.');
    return path.resolve(value);
  };
  const sdk = absolute(abi.sdkPath), compilerSdk = absolute(abi.compilerSdkPath);
  if (!abi.memoryType || !/^[A-Za-z0-9_-]{1,64}$/.test(abi.memoryType)) throw new Error('C3 BLE requires a resolved memory profile.');
  const libraries = dependencies.filter(item => item.type === 'library' && item.name === 'BLE');
  const expectedLibrary = await fs.realpath(path.join(sdk, 'libraries', 'BLE', 'src'));
  if (libraries.length !== 1 || await fs.realpath(libraries[0].path) !== expectedLibrary) throw new Error('C3 BLE requires the selected real Arduino SDK BLE library.');
  const filenames = [path.join(compilerSdk, abi.memoryType, 'include', 'sdkconfig.h'),
    path.join(compilerSdk, 'include', 'esp_common', 'include', 'esp_idf_version.h'),
    path.join(sdk, 'libraries', 'BLE', 'library.properties'), path.join(expectedLibrary, 'BLEDevice.cpp')];
  const selectedSdk = await Promise.all(filenames.map(filename => sourceIdentity(filename, 128 * 1024)));
  const contents = await Promise.all(filenames.map(filename => fs.readFile(filename, 'utf8')));
  if (contents.some((value, index) => createHash('sha256').update(value).digest('hex') !== selectedSdk[index].sha256)) throw new Error('C3 BLE selected SDK input changed during validation.');
  const [configuration, idf, properties] = contents;
  for (const name of ['CONFIG_IDF_TARGET_ESP32C3', 'CONFIG_BT_NIMBLE_ENABLED', 'CONFIG_BT_NIMBLE_LEGACY_VHCI_ENABLE']) {
    if (!new RegExp(`^#define\\s+${name}\\s+1\\s*$`, 'm').test(configuration)) throw new Error('C3 BLE requires selected C3 NimBLE legacy-VHCI configuration.');
  }
  if (/^#define\s+CONFIG_BT_BLUEDROID_ENABLED\s+1\s*$/m.test(configuration)) throw new Error('C3 BLE does not support the Bluedroid target configuration.');
  for (const [part, value] of [['MAJOR', '5'], ['MINOR', '5'], ['PATCH', '4']]) {
    if (!new RegExp(`^#define\\s+ESP_IDF_VERSION_${part}\\s+${value}\\s*$`, 'm').test(idf)) throw new Error('C3 BLE requires exact selected ESP-IDF5.5.4.');
  }
  if (!/^name=BLE\s*$/m.test(properties) || !/^version=3\.3\.10\s*$/m.test(properties)) throw new Error('C3 BLE requires the selected Arduino3.3.10 BLE host library.');
  // Record prepared bytes, not compiler consumption, HCI success or RF power.
  return selectedSdk;
}

async function requireC6BleIpcSdk(abi: SimulationTransportAbi | undefined, dependencies: Dependency[]) {
  if (abi?.platformVersion !== '3.3.10' || abi.toolVersions?.['esp32c6-libs'] !== '3.3.10'
    || abi.toolVersions?.['esp-rv32'] !== '14.2.0' || abi.memoryType !== 'qio_qspi'
    || !abi.sdkPath || !abi.compilerSdkPath
    || [abi.sdkPath, abi.compilerSdkPath].some(value => !path.isAbsolute(value) || /[{}\x00-\x1f]/.test(value))) {
    throw new Error('C6 BLE IPC requires Arduino 3.3.10, esp32c6-libs 3.3.10 qio_qspi and esp-rv32 14.2.0.');
  }
  const library = path.join(abi.sdkPath, 'libraries', 'BLE');
  const expectedLibrary = await fs.realpath(path.join(library, 'src'));
  const selected = dependencies.filter(item => item.type === 'library' && item.name === 'BLE');
  if (selected.length !== 1 || await fs.realpath(selected[0].path) !== expectedLibrary) {
    throw new Error('C6 BLE IPC requires the selected Arduino SDK BLE library.');
  }
  const pinnedSdk = {
    'qio_qspi/include/sdkconfig.h': '4823ee2f037efafa0084136560ef18b4bff32223d439534b5aa57c4a0560b966',
    'include/esp_common/include/esp_idf_version.h': 'da41e7251d748325eea76ae95f329f77434092afde399882dd9ee3d42ea68b20',
    'include/bt/porting/transport/include/esp_hci_transport.h': '8025d6d6bbff17f2e59a430122d0176ef3af2046147e060bd210e837f7d514d2',
    'lib/libbt.a': '83266e5c2fc64c748a44f5f535fd16bb8c693d65fd000580a96f622d2631e87f',
    'lib/libble_app.a': '35f95b10e9c5701ccfe34510d88d42935a60dd60c1f8fe4b1b003b2d7908935d',
  };
  const compilerSdk = abi.compilerSdkPath;
  const identities = await Promise.all(Object.entries(pinnedSdk).map(async ([member, sha256]) => {
    const identity = await sourceIdentity(path.join(compilerSdk, member), 4 * 1024 * 1024);
    if (identity.sha256 !== sha256) throw new Error(`C6 BLE IPC SDK input differs: ${member}`);
    return identity;
  }));
  const stock = {
    [path.join(library, 'library.properties')]: 'acee400594ae05f7d1f8a4fa4055efae3b507fd71fc7d3b78e436c6fb65a2f2c',
    [path.join(expectedLibrary, 'BLEDevice.cpp')]: 'ec3735051f3263fc0101986fe33602a2593c294c6ccbd9f7b1b416c15529c3c9',
  };
  return [...identities, ...await Promise.all(Object.entries(stock).map(async ([member, sha256]) => {
    const identity = await sourceIdentity(member, 128 * 1024);
    if (identity.sha256 !== sha256) throw new Error(`C6 BLE IPC SDK input differs: ${path.basename(member)}`);
    return identity;
  }))];
}

async function requireClassicWifiSdk(abi: SimulationTransportAbi | undefined, dependencies: Dependency[]) {
  if (abi?.platformVersion !== '3.3.10' || abi.toolVersions?.['esp32-libs'] !== '3.3.10'
    || abi.toolVersions?.['esp-x32'] !== '14.2.0'
    || !isC6WifiMemoryType(abi.memoryType) || !abi.sdkPath || !abi.compilerSdkPath
    || [abi.sdkPath, abi.compilerSdkPath].some(value => !path.isAbsolute(value) || /[{}\x00-\x1f]/.test(value))) {
    throw new Error('Classic Wi-Fi OpenETH requires Arduino 3.3.10, esp32-libs 3.3.10 dio_qspi/qio_qspi and esp-x32 14.2.0.');
  }
  const selected = dependencies.filter(item => item.type === 'library' && item.name === 'WiFi');
  const library = path.join(abi.sdkPath, 'libraries', 'WiFi');
  const expected = await fs.realpath(path.join(library, 'src'));
  if (selected.length !== 1 || await fs.realpath(selected[0].path) !== expected) {
    throw new Error('Classic Wi-Fi OpenETH requires the selected Arduino SDK WiFi library.');
  }
  // Pin the selected public driver ABI and original WiFi host sources. This is
  // preparation identity, not a claim that a compiler consumed a given byte.
  const pinned = classicWifiSdkPins(abi.memoryType, library, abi.compilerSdkPath);
  return Promise.all(Object.entries(pinned).map(async ([filename, sha256]) => {
    const identity = await sourceIdentity(filename, 4 * 1024 * 1024);
    if (identity.sha256 !== sha256) throw new Error(`Classic Wi-Fi OpenETH SDK input differs: ${path.basename(filename)}`);
    return identity;
  }));
}

function classicWifiSdkPins(memoryType: 'dio_qspi' | 'qio_qspi', library: string, sdk: string): Record<string, string> {
  return {
    [path.join(sdk, memoryType, 'include/sdkconfig.h')]: memoryType === 'dio_qspi'
      ? '1ce600ddcbc213ab68d518f5150d99fa26a325e1992cfbcd521860de5e65dc72'
      : 'd10e864388ee37191e43a605bef5b99033cc51e939aa5425169d231647735b6b',
    [path.join(sdk, 'include/esp_common/include/esp_idf_version.h')]: 'da41e7251d748325eea76ae95f329f77434092afde399882dd9ee3d42ea68b20',
    [path.join(sdk, 'include/esp_netif/include/esp_netif_types.h')]: 'feaec5a6dffcbe3a840f6590e7d61cebf85d46542507f59fad0e3e495905986a',
    [path.join(sdk, 'lib/libesp_netif.a')]: '0eb199ec747d711e14fee483c7f8d82744e7845b0c6a905dfc90d5179a95ca69',
    [path.join(sdk, 'lib/libesp_wifi.a')]: '340d9319360baac3516d84eb9ae3e6062440694476620bf4c77b861e56d93fe5',
    [path.join(library, 'library.properties')]: '0bd56ad5dc0461f770f36ac28901cccf13d34cefb77cd0278dfdc3d378544bcc',
    [path.join(library, 'src/WiFiGeneric.cpp')]: '57928f366c63e16e41988d26a9f65d5569340ef20d3e453d4dd49e1a9181cc44',
    [path.join(library, 'src/STA.cpp')]: 'ae3598b10d51d27bc3048a350fe231f6e995731a939621ce9c26d2a32c775855',
  };
}

async function resource(relative: string): Promise<string> {
  // Both TypeScript and bundled distributions keep resources beside the entry.
  for (const directory of [path.join(__dirname, 'resources'), path.resolve(__dirname, '..', 'resources')]) {
    const filename = path.join(directory, 'simulation', relative);
    if (await fs.pathExists(filename)) return filename;
  }
  throw new Error(`Simulation provider resource is missing from Builder: ${relative}`);
}

/** A simulation build retains the actual guest protocol libraries and replaces
 * only the explicitly versioned controller/driver transport boundary. */
export async function prepareSimulationTransportSources(
  buildPath: string,
  simulationDebug: boolean,
  mcu: string | undefined,
  dependencies: Dependency[],
  abi?: SimulationTransportAbi,
): Promise<SimulationTransportSources> {
  const destination = path.join(buildPath, 'sketch', 'aily-esp32-vhci-v1.c');
  const c3Directory = path.join(buildPath, 'sketch', C3_DIRECTORY);
  const c6Directory = path.join(buildPath, 'sketch', C6_DIRECTORY);
  const c3BleDirectory = path.join(buildPath, 'sketch', C3_BLE_DIRECTORY);
  const c6BleIpcDirectory = path.join(buildPath, 'sketch', C6_BLE_IPC_DIRECTORY);
  const classicWifiDirectory = path.join(buildPath, 'sketch', CLASSIC_WIFI_DIRECTORY);
  const requestedLibrary = (name: string) => dependencies.some(item => item.type === 'library' && item.name === name);
  const classicWifi = simulationDebug && mcu === 'esp32' && requestedLibrary('WiFi');
  if (classicWifi && ['BLE', 'BluetoothSerial', 'NimBLE-Arduino'].some(requestedLibrary)) {
    throw new Error('Classic Wi-Fi OpenETH cannot be mixed with an unverified Bluetooth controller provider.');
  }
  const selectedClassicWifiSdk = classicWifi ? await requireClassicWifiSdk(abi, dependencies) : undefined;
  if (simulationDebug && mcu === 'esp32c3' && requestedLibrary('NimBLE-Arduino')) throw new Error('C3 BLE requires the selected real Arduino SDK BLE host library, not an unverified third-party library.');
  const c3Ble = simulationDebug && mcu === 'esp32c3' && requestedLibrary('BLE');
  if (c3Ble && (requestedLibrary('WiFi') || requestedLibrary('BluetoothSerial') || requestedLibrary('NimBLE-Arduino'))) throw new Error('C3 BLE provider cannot be mixed with an unverified Wi-Fi, SPP or third-party controller provider.');
  const c6Simulation = simulationDebug && mcu === 'esp32c6';
  const c6Wifi = c6Simulation && requestedLibrary('WiFi');
  if (c6Wifi) {
    if (['BLE', 'BluetoothSerial', 'NimBLE-Arduino'].some(requestedLibrary)) {
      throw new Error('C6 Wi-Fi simulation cannot be mixed with a Bluetooth controller provider.');
    }
    await requireC6WifiSdk(abi, dependencies);
  }
  if (c6Simulation && ['BluetoothSerial', 'NimBLE-Arduino'].some(requestedLibrary)) {
    throw new Error('C6 BLE requires the selected Arduino SDK BLE library.');
  }
  const c6BleIpc = c6Simulation && requestedLibrary('BLE');
  const selectedBleSdk = c3Ble ? await requireC3BleSdk(abi, dependencies) : undefined;
  const selectedC6BleSdk = c6BleIpc ? await requireC6BleIpcSdk(abi, dependencies) : undefined;
  const ownedPaths = new Set([destination, ...C3_FILES.map(name => path.join(c3Directory, name)),
    ...C6_FILES.map(name => path.join(c6Directory, name)), ...C3_BLE_FILES.map(name => path.join(c3BleDirectory, name)),
    ...C6_BLE_IPC_FILES.map(name => path.join(c6BleIpcDirectory, name)),
    ...CLASSIC_WIFI_FILES.map(name => path.join(classicWifiDirectory, name))]
    .map(value => path.resolve(value)));
  for (let index = dependencies.length - 1; index >= 0; index--) {
    if (['__simulation_transport__', C3_DEPENDENCY, C6_DEPENDENCY, C3_BLE_DEPENDENCY, C6_BLE_IPC_DEPENDENCY, CLASSIC_WIFI_DEPENDENCY].includes(dependencies[index].name)) dependencies.splice(index, 1);
  }
  for (const dependency of dependencies) {
    if (dependency.includes) dependency.includes = dependency.includes.filter(source => !ownedPaths.has(path.resolve(source)));
    if (dependency.others) dependency.others = dependency.others.filter(source => !ownedPaths.has(path.resolve(source)));
  }
  const library = (name: string) => dependencies.some(dependency => dependency.type === 'library' && dependency.name === name);
  const classic = simulationDebug && mcu === 'esp32';
  const classicBluetooth = classic && library('BluetoothSerial');
  const c3Wifi = simulationDebug && mcu === 'esp32c3' && library('WiFi');
  // Validate before publishing/copying any provider for a requested C3 ABI.
  if (c3Wifi) requireC3Abi(abi);
  if (!c3Wifi) await fs.remove(c3Directory);
  if (!c6Wifi) await fs.remove(c6Directory);
  if (!c3Ble) await fs.remove(c3BleDirectory);
  if (!c6BleIpc) await fs.remove(c6BleIpcDirectory);
  if (!classicBluetooth) await fs.remove(destination);
  if (!classicWifi) await fs.remove(classicWifiDirectory);
  if (selectedClassicWifiSdk) {
    const originals = await Promise.all(CLASSIC_WIFI_FILES.map(name => resource(name === 'awf-control-v1.h'
      ? `esp32c3-wifi-sdk-driver-v1/${name}` : `esp32-wifi-openeth-v1/${name}`)));
    await fs.ensureDir(classicWifiDirectory);
    const staged = await Promise.all(CLASSIC_WIFI_FILES.map(async (name, index) => {
      const target = path.join(classicWifiDirectory, name);
      await fs.copyFile(originals[index], target);
      const before = await sourceIdentity(originals[index], 64 * 1024);
      const after = await sourceIdentity(target, 64 * 1024);
      if (before.bytes !== after.bytes || before.sha256 !== after.sha256) throw new Error('Classic Wi-Fi copied source changed.');
      return after;
    }));
    dependencies.push({ name: CLASSIC_WIFI_DEPENDENCY, path: classicWifiDirectory, type: 'sketch',
      includes: staged.slice(0, 2).map(item => item.path), others: staged.slice(2).map(item => item.path) });
    return { providers: [ESP32_WIFI_OPENETH_PROVIDER], providerSourceInputs: { schemaVersion: 1,
      provider: ESP32_WIFI_OPENETH_PROVIDER, scope: 'prepared-and-verified-sources-not-compiler-consumption',
      sources: staged, selectedSdk: selectedClassicWifiSdk } };
  }
  if (selectedC6BleSdk) {
    const sources = await Promise.all(C6_BLE_IPC_FILES.map(name => resource(`esp32c6-ble-nimble-v1/${name}`)));
    await fs.ensureDir(c6BleIpcDirectory);
    const staged = await Promise.all(C6_BLE_IPC_FILES.map(async (name, index) => {
      const target = path.join(c6BleIpcDirectory, name);
      await fs.copyFile(sources[index], target);
      const original = await sourceIdentity(sources[index], 64 * 1024);
      const identity = await sourceIdentity(target, 64 * 1024);
      if (original.bytes !== identity.bytes || original.sha256 !== identity.sha256) {
        throw new Error('C6 BLE IPC copied source changed.');
      }
      return identity;
    }));
    dependencies.push({ name: C6_BLE_IPC_DEPENDENCY, path: c6BleIpcDirectory, type: 'sketch',
      includes: [staged[0].path], others: [staged[1].path] });
    return { providers: [ESP32C6_BLE_PROVIDER], providerSourceInputs: { schemaVersion: 1,
      provider: ESP32C6_BLE_PROVIDER, scope: 'prepared-and-verified-sources-not-compiler-consumption',
      sources: staged, selectedSdk: selectedC6BleSdk } };
  }
  if (c3Ble) {
    const sources = await Promise.all(C3_BLE_FILES.map(name => resource(`esp32c3-ble-vhci-v1/${name}`)));
    await fs.ensureDir(c3BleDirectory);
    for (let index = 0; index < C3_BLE_FILES.length; index++) await fs.copyFile(sources[index], path.join(c3BleDirectory, C3_BLE_FILES[index]));
    const identities = await Promise.all(C3_BLE_FILES.map(name => sourceIdentity(path.join(c3BleDirectory, name), 64 * 1024)));
    const originals = await Promise.all(sources.map(filename => sourceIdentity(filename, 64 * 1024)));
    if (identities.some((value, index) => value.bytes !== originals[index].bytes || value.sha256 !== originals[index].sha256)) throw new Error('C3 BLE copied provider input changed.');
    dependencies.push({ name: C3_BLE_DEPENDENCY, path: c3BleDirectory, type: 'sketch',
      includes: [path.join(c3BleDirectory, C3_BLE_FILES[0])], others: [path.join(c3BleDirectory, C3_BLE_FILES[1])] });
    return { providers: [ESP32C3_BLE_PROVIDER], providerSourceInputs: { schemaVersion: 1, provider: ESP32C3_BLE_PROVIDER,
      scope: 'prepared-and-verified-sources-not-compiler-consumption', sources: identities, selectedSdk: selectedBleSdk } };
  }
  if (c3Wifi || c6Wifi) {
    const directory = c6Wifi ? c6Directory : c3Directory;
    const filenames = c6Wifi ? C6_FILES : C3_FILES;
    const sources = await Promise.all(C3_FILES.map(name => resource(`esp32c3-wifi-sdk-driver-v1/${name}`)));
    await fs.ensureDir(directory);
    for (let index = 0; index < filenames.length; index++) await fs.copyFile(sources[index], path.join(directory, filenames[index]));
    dependencies.push({ name: c6Wifi ? C6_DEPENDENCY : C3_DEPENDENCY, path: directory, type: 'sketch',
      includes: [path.join(directory, filenames[0])], others: filenames.slice(1).map(name => path.join(directory, name)) });
    // STA-client uses AWF1/ANP1 from its exact provider. Do not label it as the
    // legacy classic network or allocate an unnecessary Guest HTTP route.
    return { providers: [c6Wifi ? ESP32C6_WIFI_PROVIDER : ESP32C3_WIFI_PROVIDER] };
  }
  if (!classicBluetooth) return { providers: [] };
  await fs.ensureDir(path.dirname(destination));
  await fs.copyFile(await resource('esp32-vhci-v1.c'), destination);
  dependencies.push({ name: '__simulation_transport__', path: path.dirname(destination), type: 'sketch', includes: [destination], others: [] });
  return { providers: [ESP32_VHCI_PROVIDER] };
}
