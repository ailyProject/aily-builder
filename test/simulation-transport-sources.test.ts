import { captureSketchSourceIdentity } from '../src/SketchSources';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { ArduinoCompiler } from '../src/ArduinoCompiler';
import { Logger } from '../src/utils/Logger';
import { applySimulationTransportCompileConfig, applySimulationTransportPlatform, prepareSimulationTransportSources,
  ESP32C3_WIFI_PROVIDER, ESP32C3_WIFI_LINKER_WRAPPERS, ESP32C6_WIFI_PROVIDER, ESP32S3_WIFI_PROVIDER, ESP32_VHCI_PROVIDER,
  verifyPreparedSimulationProviderInputs,
  ESP32C6_BLE_PROVIDER, ESP32C6_BLE_LINKER_WRAPPERS, ESP32S3_BLE_PROVIDER, ESP32C3_BLE_LINKER_WRAPPERS } from '../src/SimulationTransportSources';
import type { Dependency } from '../src/DependencyAnalyzer';
const abi = { platformVersion: '3.3.10', toolVersions: { 'esp32c3-libs': '3.3.10', 'esp-rv32': '14.2.0' } };
const root = path.resolve(__dirname, '..');
const resourceRoot = path.join(root, 'resources/simulation/esp32c3-wifi-sdk-driver-v1');
const files = ['aily-c3-wifi-driver-v1.c', 'awf-control-v1.h', 'aily_packet_abi.h'];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const library = (name: string): Dependency => ({ name, path: '/controlled-library/' + name, type: 'library', includes: [], others: [] });
async function fixture(t: any) { const directory = await mkdtemp(path.join(os.tmpdir(), 'aily-c3-provider-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

async function c6Fixture(t: any) {
  const build = await fixture(t);
  const sdkPath = path.join(build, 'arduino-sdk');
  const compilerSdkPath = path.join(build, 'esp32c6-libs');
  const wifiPath = path.join(sdkPath, 'libraries', 'WiFi', 'src');
  const config = path.join(compilerSdkPath, 'qio_qspi', 'include', 'sdkconfig.h');
  const idf = path.join(compilerSdkPath, 'include', 'esp_common', 'include', 'esp_idf_version.h');
  await Promise.all([mkdir(wifiPath, { recursive: true }), mkdir(path.dirname(config), { recursive: true }),
    mkdir(path.dirname(idf), { recursive: true })]);
  await writeFile(config, [
    '#define CONFIG_IDF_TARGET_ESP32C6 1', '#define CONFIG_IDF_TARGET "esp32c6"',
    '#define CONFIG_LIB_BUILDER_FLASHMODE "qio"', '',
  ].join('\n'));
  await writeFile(idf, '#define ESP_IDF_VERSION_MAJOR 5\n#define ESP_IDF_VERSION_MINOR 5\n#define ESP_IDF_VERSION_PATCH 4\n');
  const context = { platformVersion: '3.3.10', sdkPath, compilerSdkPath, memoryType: 'qio_qspi',
    toolVersions: { 'esp32c6-libs': '3.3.10', 'esp-rv32': '14.2.0' } };
  return { build, context, config, dependencies: [{ ...library('WiFi'), path: wifiPath }] };
}

async function s3Fixture(t: any, memoryType: 'qio_qspi' | 'qio_opi' = 'qio_qspi', sdkVersion: '5.4.1' | '3.3.10' = '5.4.1') {
  const build = await fixture(t), sdkPath = path.join(build, 'arduino-sdk');
  const compilerSdkPath = path.join(build, 'esp32s3-libs');
  const wifiPath = path.join(sdkPath, 'libraries/WiFi/src');
  const config = path.join(compilerSdkPath, memoryType, 'include/sdkconfig.h');
  const idf = path.join(compilerSdkPath, 'include/esp_common/include/esp_idf_version.h');
  const selected = [config, idf, path.join(compilerSdkPath, 'include/esp_netif/include/esp_netif_types.h'),
    path.join(compilerSdkPath, 'lib/libesp_netif.a'), path.join(compilerSdkPath, 'lib/libesp_wifi.a'),
    path.join(sdkPath, 'libraries/WiFi/library.properties'), path.join(wifiPath, 'WiFiGeneric.cpp'), path.join(wifiPath, 'STA.cpp')];
  for (const file of selected) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'controlled SDK input ' + path.basename(file)); }
  await writeFile(config, '#define CONFIG_IDF_TARGET_ESP32S3 1\n#define CONFIG_IDF_TARGET "esp32s3"\n'
    + `#define CONFIG_IDF_INIT_VERSION "${sdkVersion === '3.3.10' ? '5.5.4' : '5.4.2'}"\n`
    + '#define CONFIG_IDF_TARGET_ARCH_XTENSA 1\n#define CONFIG_LIB_BUILDER_FLASHMODE "qio"\n'
    + (memoryType === 'qio_opi' ? '#define CONFIG_SPIRAM 1\n#define CONFIG_SPIRAM_MODE_OCT 1\n#define CONFIG_SPIRAM_BOOT_INIT 1\n' : ''));
  await writeFile(idf, '#define ESP_IDF_VERSION_MAJOR 5\n' + (sdkVersion === '3.3.10'
    ? '#define ESP_IDF_VERSION_MINOR 5\n#define ESP_IDF_VERSION_PATCH 4\n'
    : '#define ESP_IDF_VERSION_MINOR 4\n#define ESP_IDF_VERSION_PATCH 2\n'));
  const context = { platformVersion: '3.3.10', sdkPath, compilerSdkPath, memoryType,
    toolVersions: { 'esp32s3-libs': sdkVersion, 'esp-x32': '14.2.0' } };
  return { build, context, config, idf, dependencies: [{ ...library('WiFi'), path: wifiPath }] };
}

test('normal C3 provider discovery copies exact package-owned C and headers without legacy network metadata', async t => {
  const build = await fixture(t), dependencies = [library('WiFi'), library('HTTPClient')];
  const result = await prepareSimulationTransportSources(build, true, 'esp32c3', dependencies, abi);
  assert.deepEqual(result, { providers: [ESP32C3_WIFI_PROVIDER] });
  const dependency = dependencies.find(item => item.name === '__simulation_transport_c3_wifi__')!;
  assert.equal(dependency.type, 'sketch'); assert.equal(dependency.includes!.length, 1); assert.equal(dependency.others!.length, 2);
  for (const filename of files) assert.equal(sha(await readFile(path.join(dependency.path, filename))), sha(await readFile(path.join(resourceRoot, filename))));
});

test('provider fixed wrap table exactly matches actual compiled driver exports', async () => {
  const source = await readFile(path.join(resourceRoot, files[0]), 'utf8');
  const actual = [...source.matchAll(/__wrap_([a-zA-Z0-9_]+)\(/g)].map(match => match[1]).sort();
  assert.deepEqual([...ESP32C3_WIFI_LINKER_WRAPPERS].sort(), actual);
  assert.equal(new Set(ESP32C3_WIFI_LINKER_WRAPPERS).size, actual.length);
  assert.equal(Object.isFrozen(ESP32C3_WIFI_LINKER_WRAPPERS), true);
});

test('hardware, other targets and no-WiFi builds never select the Wi-Fi provider', async t => {
  const build = await fixture(t);
  for (const [simulation, mcu, deps] of [[false, 'esp32c3', [library('WiFi')]], [false, 'esp32c6', [library('WiFi')]],
    [true, 'esp32c3', [library('Network')]], [true, 'esp32c6', [library('Network')]],
    [false, 'esp32s3', [library('WiFi')]], [true, 'esp32s3', [library('Network')]], [true, 'esp32s2', [library('WiFi')]]] as const) {
    assert.deepEqual(await prepareSimulationTransportSources(build, simulation, mcu, [...deps]), { providers: [] });
  }
});

test('C6 simulation uses the shared driver under its own Wi-Fi identity and preserves ordinary builds', async t => {
  const { build, context, dependencies } = await c6Fixture(t);
  assert.deepEqual(await prepareSimulationTransportSources(build, true, 'esp32c6', dependencies, context),
    { providers: [ESP32C6_WIFI_PROVIDER] });
  const dependency = dependencies.find(item => item.name === '__simulation_transport_c6_wifi__')!;
  assert.equal(dependency.type, 'sketch');
  assert.equal(path.basename(dependency.includes![0]), 'aily-c6-wifi-driver-v1.c');
  assert.deepEqual(dependency.others!.map(file => path.basename(file)), files.slice(1));
  assert.equal(sha(await readFile(dependency.includes![0])), sha(await readFile(path.join(resourceRoot, files[0]))));
  for (const name of files.slice(1)) {
    assert.equal(sha(await readFile(path.join(dependency.path, name))), sha(await readFile(path.join(resourceRoot, name))));
  }
  const before = { args: { ld: '-Wl,base' }, platform: { 'compiler.c.elf.extra_flags': '-Wl,user' } };
  const c6 = [ESP32C6_WIFI_PROVIDER], c3 = [ESP32C3_WIFI_PROVIDER];
  assert.deepEqual(applySimulationTransportCompileConfig(before, c6), applySimulationTransportCompileConfig(before, c3));
  assert.deepEqual(applySimulationTransportPlatform(before, c6), applySimulationTransportPlatform(before, c3));
  assert.throws(() => applySimulationTransportCompileConfig(before, [...c6, ...c3]), /cannot be mixed/);
  assert.deepEqual(await prepareSimulationTransportSources(build, false, 'esp32c6', dependencies, context), { providers: [] });
  assert.equal(dependencies.length, 1);
  await assert.rejects(stat(dependency.path), { code: 'ENOENT' });
});

test('C6 Wi-Fi rejects a mismatched SDK, nonselected WiFi library or Bluetooth mix before publishing', async t => {
  const { build, context, config, dependencies } = await c6Fixture(t);
  for (const [candidate, libraries, error] of [
    [abi, dependencies, /requires exact Arduino/],
    [{ ...context, memoryType: 'qio_opi' }, dependencies, /dio_qspi or qio_qspi/],
    [context, [...dependencies, library('BLE')], /cannot be mixed with a Bluetooth/],
    [context, [{ ...library('WiFi'), path: context.sdkPath }], /selected Arduino SDK WiFi library/],
  ] as const) {
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c6', [...libraries], candidate), error);
  }
  await writeFile(config, '#define CONFIG_IDF_TARGET_ESP32C3 1\n');
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c6', dependencies, context), /selected ESP32-C6 SDK configuration/);
  assert.equal(dependencies.length, 1);
  await assert.rejects(stat(path.join(build, 'sketch/aily-esp32c6-wifi-sdk-driver-v1')), { code: 'ENOENT' });
});

test('S3 simulation selects the same AWF1 driver with its own exact SDK leaf and input bookends', async t => {
  const { build, context, dependencies } = await s3Fixture(t);
  const result = await prepareSimulationTransportSources(build, true, 'esp32s3', dependencies, context);
  assert.deepEqual(result.providers, [ESP32S3_WIFI_PROVIDER]);
  assert.equal(result.network, undefined);
  assert.equal(result.providerSourceInputs?.provider, ESP32S3_WIFI_PROVIDER);
  assert.equal(result.providerSourceInputs?.sources.length, 3);
  assert.equal(result.providerSourceInputs?.selectedSdk.length, 8);
  const dependency = dependencies.find(item => item.name === '__simulation_transport_s3_wifi__')!;
  assert.equal(path.basename(dependency.includes![0]), 'aily-s3-wifi-driver-v1.c');
  assert.equal(sha(await readFile(dependency.includes![0])), sha(await readFile(path.join(resourceRoot, files[0]))));
  for (const name of files.slice(1)) assert.equal(sha(await readFile(path.join(dependency.path, name))), sha(await readFile(path.join(resourceRoot, name))));
  const cached = { args: { ld: '-Wl,base' }, platform: { 'compiler.c.elf.extra_flags': '-Wl,user' } };
  assert.deepEqual(applySimulationTransportCompileConfig(cached, [ESP32S3_WIFI_PROVIDER]),
    applySimulationTransportCompileConfig(cached, [ESP32C3_WIFI_PROVIDER]));
  assert.deepEqual(applySimulationTransportPlatform(cached, [ESP32S3_WIFI_PROVIDER]),
    applySimulationTransportPlatform(cached, [ESP32C6_WIFI_PROVIDER]));
  assert.throws(() => applySimulationTransportCompileConfig(cached, [ESP32S3_WIFI_PROVIDER, ESP32C3_WIFI_PROVIDER]), /cannot be mixed/);
  await verifyPreparedSimulationProviderInputs(result.providerSourceInputs);
  await writeFile(path.join(context.sdkPath, 'libraries/WiFi/src/WiFiGeneric.cpp'), 'changed after preparation');
  await assert.rejects(verifyPreparedSimulationProviderInputs(result.providerSourceInputs), /S3 Wi-Fi input changed/);
  await writeFile(path.join(build, 'sketch/user-code.c'), 'user');
  assert.deepEqual(await prepareSimulationTransportSources(build, false, 'esp32s3', dependencies, context), { providers: [] });
  assert.equal(dependencies.length, 1);
  await assert.rejects(stat(dependency.path), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(build, 'sketch/user-code.c'), 'utf8'), 'user');
});

test('S3 qio_opi uses the same driver and requires actual octal PSRAM boot configuration', async t => {
  const { build, context, config, dependencies } = await s3Fixture(t, 'qio_opi');
  const result = await prepareSimulationTransportSources(build, true, 'esp32s3', dependencies, context);
  assert.deepEqual(result.providers, [ESP32S3_WIFI_PROVIDER]);
  assert.equal(result.providerSourceInputs?.sources.length, 3);
  assert.equal(result.providerSourceInputs?.selectedSdk.length, 8);
  assert.equal(result.providerSourceInputs?.selectedSdk[0].path, config);
  assert.equal(result.providerSourceInputs?.selectedSdk[0].sha256, sha(await readFile(config)));
  await verifyPreparedSimulationProviderInputs(result.providerSourceInputs);
  const selected = await readFile(config, 'utf8');
  for (const required of ['CONFIG_SPIRAM', 'CONFIG_SPIRAM_MODE_OCT', 'CONFIG_SPIRAM_BOOT_INIT']) {
    await writeFile(config, selected.replace(new RegExp(`^#define ${required} 1\\n`, 'm'), ''));
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [...dependencies], context), /selected ESP32-S3/);
  }
  await writeFile(config, selected + '#define CONFIG_SPIRAM_MODE_QUAD 1\n');
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [...dependencies], context), /selected ESP32-S3/);
  await writeFile(config, selected);
  await verifyPreparedSimulationProviderInputs(result.providerSourceInputs);
  const dependency = dependencies.find(item => item.name === '__simulation_transport_s3_wifi__')!;
  assert.equal(sha(await readFile(dependency.includes![0])), sha(await readFile(path.join(resourceRoot, files[0]))));
});

test('S3 normal registry SDK selects only libs3.3.10/IDF5.5.4 qio_opi and rejects cross-pairs', async t => {
  const normal = await s3Fixture(t, 'qio_opi', '3.3.10');
  const result = await prepareSimulationTransportSources(normal.build, true, 'esp32s3', normal.dependencies, normal.context);
  assert.deepEqual(result.providers, [ESP32S3_WIFI_PROVIDER]);
  assert.equal(result.providerSourceInputs?.selectedSdk.length, 8);
  assert.equal(result.providerSourceInputs?.sources.length, 3);
  assert.equal(result.providerSourceInputs?.selectedSdk[0].path, normal.config);
  await verifyPreparedSimulationProviderInputs(result.providerSourceInputs);
  for (const context of [
    { ...normal.context, memoryType: 'qio_qspi' },
    { ...normal.context, toolVersions: { ...normal.context.toolVersions, 'esp32s3-libs': '5.4.1' } },
  ]) await assert.rejects(prepareSimulationTransportSources(normal.build, true, 'esp32s3', [...normal.dependencies], context), /S3 Wi-Fi/);
  const legacy = await s3Fixture(t, 'qio_opi');
  await assert.rejects(prepareSimulationTransportSources(legacy.build, true, 'esp32s3', legacy.dependencies,
    { ...legacy.context, toolVersions: { ...legacy.context.toolVersions, 'esp32s3-libs': '3.3.10' } }), /ESP-IDF 5.5.4/);
  const config = await readFile(normal.config, 'utf8');
  await writeFile(normal.config, config.replace('CONFIG_IDF_INIT_VERSION "5.5.4"', 'CONFIG_IDF_INIT_VERSION "5.4.2"'));
  await assert.rejects(prepareSimulationTransportSources(normal.build, true, 'esp32s3', [...normal.dependencies], normal.context), /selected ESP32-S3/);
  await writeFile(normal.config, config.replace('#define CONFIG_SPIRAM_MODE_OCT 1', ''));
  await assert.rejects(prepareSimulationTransportSources(normal.build, true, 'esp32s3', [...normal.dependencies], normal.context), /selected ESP32-S3/);
  await assert.rejects(verifyPreparedSimulationProviderInputs(result.providerSourceInputs), /input changed/);
  await writeFile(normal.config, config);
  await verifyPreparedSimulationProviderInputs(result.providerSourceInputs);
});

test('S3 rejects wrong ABI, foreign WiFi, Bluetooth mix and changed target before publication', async t => {
  const { build, context, config, idf, dependencies } = await s3Fixture(t);
  for (const candidate of [undefined, { ...context, platformVersion: '3.3.12' },
    { ...context, memoryType: 'dio_qspi' }, { ...context, memoryType: 'opi_opi' },
    { ...context, toolVersions: { ...context.toolVersions, 'esp32s3-libs': '3.3.10' } },
    { ...context, toolVersions: { ...context.toolVersions, 'esp-x32': '13.2.0' } },
    { ...context, toolVersions: { ...context.toolVersions, 'esp-rv32': '14.2.0' } }]) {
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [...dependencies], candidate), /S3 Wi-Fi/);
  }
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [{ ...library('WiFi'), path: context.sdkPath }], context), /selected Arduino SDK WiFi library/);
  for (const name of ['BLE', 'BluetoothSerial', 'NimBLE-Arduino']) {
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [...dependencies, library(name)], context), /cannot be mixed/);
  }
  await writeFile(idf, '#define ESP_IDF_VERSION_MAJOR 5\n#define ESP_IDF_VERSION_MINOR 5\n#define ESP_IDF_VERSION_PATCH 4\n');
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [...dependencies], context), /ESP-IDF 5.4.2/);
  await writeFile(config, '#define CONFIG_IDF_TARGET_ESP32C6 1\n');
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [...dependencies], context), /selected ESP32-S3/);
  await assert.rejects(stat(path.join(build, 'sketch/aily-esp32s3-wifi-sdk-driver-v1')), { code: 'ENOENT' });
  assert.equal(dependencies.length, 1);
});

test('normal C6 BLE IPC selection requires simulation, real selected BLE and exact ABI', async t => {
  const { build, context, dependencies } = await c6Fixture(t);
  const ble = library('BLE');
  for (const [debug, mcu, libs] of [[false, 'esp32c6', [ble]], [false, 'esp32c6', [library('NimBLE-Arduino')]],
    [true, 'esp32s2', [ble]], [true, 'esp32c6', []]] as const) {
    assert.deepEqual(await prepareSimulationTransportSources(build, debug, mcu, [...libs], context), { providers: [] });
  }
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c6', [...dependencies, ble], context), /cannot be mixed/);
  for (const name of ['BluetoothSerial', 'NimBLE-Arduino']) {
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c6', [library(name)], context),
      /requires the selected Arduino SDK BLE library/);
  }
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c6', [ble],
    { ...context, memoryType: 'dio_qspi' }), /requires Arduino 3.3.10/);
  const selected = path.join(context.sdkPath, 'libraries/BLE/src');
  const substituted = path.join(context.sdkPath, 'libraries/replacement/src');
  await Promise.all([mkdir(selected, { recursive: true }), mkdir(substituted, { recursive: true })]);
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c6', [{ ...ble, path: substituted }],
    context), /requires the selected Arduino SDK BLE library/);
  for (const member of ['include/bt/porting/transport/include/esp_hci_transport.h', 'lib/libbt.a', 'lib/libble_app.a']) {
    const file = path.join(context.compilerSdkPath, member);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'modified');
  }
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c6', [{ ...ble, path: selected }],
    context), /SDK input differs/);
  await assert.rejects(stat(path.join(build, 'sketch/aily-esp32c6-ble-nimble-v1')), { code: 'ENOENT' });
  const config = { args: { ld: '-Wl,base' } };
  const wrapped = applySimulationTransportCompileConfig(config, [ESP32C6_BLE_PROVIDER]);
  assert.equal(wrapped.args.ld, '-Wl,base ' + ESP32C6_BLE_LINKER_WRAPPERS.map(name => '-Wl,--wrap,' + name).join(' '));
  assert.equal(config.args.ld, '-Wl,base');
  assert.throws(() => applySimulationTransportCompileConfig(config, [ESP32C6_BLE_PROVIDER, ESP32C6_WIFI_PROVIDER]),
    /cannot be mixed/);
});

test('S3 BLE stages the sole normal SDK VHCI leaf and reuses the packet contract', async t => {
  const { build, context, config } = await s3Fixture(t, 'qio_opi', '3.3.10');
  const blePath = path.join(context.sdkPath, 'libraries/BLE/src');
  const libBt = path.join(context.compilerSdkPath, 'lib/libbt.a');
  const btHeader = path.join(context.compilerSdkPath, 'include/bt/include/esp32c3/include/esp_bt.h');
  const configBase = await readFile(config, 'utf8');
  const configBle = configBase + '#define CONFIG_BT_CONTROLLER_ENABLED 1\n#define CONFIG_BT_NIMBLE_ENABLED 1\n'
    + '#define CONFIG_BT_NIMBLE_LEGACY_VHCI_ENABLE 1\n';
  await writeFile(config, configBle);
  for (const file of [libBt, btHeader, path.join(blePath, 'BLEDevice.cpp')]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'controlled SDK input ' + path.basename(file));
  }
  await writeFile(path.join(blePath, '..', 'library.properties'), 'name=BLE\nversion=3.3.10\n');
  const host = { ...library('BLE'), path: blePath };
  const dependencies = [host];
  const result = await prepareSimulationTransportSources(build, true, 'esp32s3', dependencies, context);
  assert.deepEqual(result.providers, [ESP32S3_BLE_PROVIDER]);
  assert.equal(result.network, undefined);
  assert.equal(dependencies[0], host);
  const sourceInputs = result.providerSourceInputs!;
  assert.deepEqual(sourceInputs.sources.map(input => path.basename(input.path)), ['aily-s3-ble-vhci-v1.c', 'aily_packet_abi.h']);
  assert.equal(sourceInputs.selectedSdk.length, 6);
  assert(sourceInputs.selectedSdk.some(input => input.path === libBt));
  const source = await readFile(sourceInputs.sources[0].path, 'utf8');
  const wrapperNames = [...source.matchAll(/__wrap_([a-zA-Z0-9_]+)\(/g)].map(match => match[1]);
  assert.deepEqual(wrapperNames.sort(), [...ESP32C3_BLE_LINKER_WRAPPERS].sort());
  assert.match(source, /sizeof\(esp_bt_controller_config_t\) == 72/);
  assert.match(source, /AILY_HCI_S3_BASE UINT32_C\(0x600f0000\)/);
  assert.deepEqual(await readFile(sourceInputs.sources[1].path), await readFile(path.join(resourceRoot, 'aily_packet_abi.h')));
  const compileConfig = { args: { ld: '-Wl,base' } };
  assert.equal(applySimulationTransportCompileConfig(compileConfig, result.providers).args.ld,
    '-Wl,base ' + ESP32C3_BLE_LINKER_WRAPPERS.map(name => '-Wl,--wrap,' + name).join(' '));
  assert.throws(() => applySimulationTransportCompileConfig(compileConfig, [ESP32S3_BLE_PROVIDER, ESP32S3_WIFI_PROVIDER]), /cannot be mixed/);
  await verifyPreparedSimulationProviderInputs(sourceInputs);
  await writeFile(libBt, 'changed SDK archive');
  await assert.rejects(verifyPreparedSimulationProviderInputs(sourceInputs), /S3 BLE input changed/);
  for (const configuration of [configBase, configBle + '#define CONFIG_BT_BLUEDROID_ENABLED 1\n']) {
    await writeFile(config, configuration);
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [host], context), /NimBLE legacy VHCI/);
  }
  await writeFile(config, configBle);
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [{ ...host, path: build }], context),
    /selected Arduino SDK BLE library/);
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [host],
    { ...context, toolVersions: { ...context.toolVersions, 'esp32s3-libs': '5.4.1' } }), /requires exact Arduino/);
  for (const name of ['WiFi', 'BluetoothSerial', 'NimBLE-Arduino']) {
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32s3', [host, library(name)], context), /S3 (?:Wi-Fi|BLE)/);
  }
  assert.deepEqual(await prepareSimulationTransportSources(build, false, 'esp32s3', dependencies), { providers: [] });
  assert.deepEqual(dependencies, [host]);
  await assert.rejects(stat(path.dirname(sourceInputs.sources[0].path)), { code: 'ENOENT' });
});

test('requested C3 simulation rejects absent, changed or incomplete exact ABI before provider publication', async t => {
  const build = await fixture(t);
  for (const context of [undefined, {}, { ...abi, platformVersion: '3.3.11' },
    { ...abi, toolVersions: { ...abi.toolVersions, 'esp32c3-libs': '3.3.1' } },
    { ...abi, toolVersions: { ...abi.toolVersions, 'esp-rv32': '15.0.0' } }]) {
    const dependencies = [library('WiFi')];
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c3', dependencies, context), /requires exact/);
    assert.equal(dependencies.length, 1);
    await assert.rejects(stat(path.join(build, 'sketch/aily-esp32c3-wifi-sdk-driver-v1')), { code: 'ENOENT' });
  }
});

test('classic SPP retains its byte-identical legacy source independently of unverified WiFi mixing', async t => {
  const build = await fixture(t), dependencies = [library('BluetoothSerial')];
  assert.deepEqual(await prepareSimulationTransportSources(build, true, 'esp32', dependencies),
    { providers: [ESP32_VHCI_PROVIDER] });
  assert.equal(sha(await readFile(path.join(build, 'sketch/aily-esp32-vhci-v1.c'))), sha(await readFile(path.join(root, 'resources/simulation/esp32-vhci-v1.c'))));
  await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32',
    [library('WiFi'), library('BluetoothSerial')]), /cannot be mixed/);
});

test('classic WiFi requires its exact selected SDK and never affects ordinary hardware builds', async t => {
  const build = await fixture(t), dependencies = [library('WiFi')];
  assert.deepEqual(await prepareSimulationTransportSources(build, false, 'esp32', dependencies), { providers: [] });
  for (const context of [undefined, abi, { ...abi, toolVersions: { 'esp32-libs': '3.3.10', 'esp-x32': '14.2.0' } }]) {
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32', [...dependencies], context),
      /requires Arduino 3.3.10/);
  }
  await assert.rejects(stat(path.join(build, 'sketch/aily-esp32-wifi-openeth-v1')), { code: 'ENOENT' });
  assert.equal(dependencies.length, 1);
});

test('same build directory reselect/disable removes only owned provider sources and never duplicates dependencies', async t => {
  const build = await fixture(t), dependencies = [library('WiFi')];
  await prepareSimulationTransportSources(build, true, 'esp32c3', dependencies, abi);
  await prepareSimulationTransportSources(build, true, 'esp32c3', dependencies, abi);
  assert.equal(dependencies.filter(item => item.name === '__simulation_transport_c3_wifi__').length, 1);
  const userFile = path.join(build, 'sketch/user-code.c'); await fs.writeFile(userFile, 'user');
  assert.deepEqual(await prepareSimulationTransportSources(build, false, 'esp32c3', dependencies), { providers: [] });
  assert.equal(dependencies.length, 1); assert.equal(await readFile(userFile, 'utf8'), 'user');
  await assert.rejects(stat(path.join(build, 'sketch/aily-esp32c3-wifi-sdk-driver-v1')), { code: 'ENOENT' });
});

test('missing package-owned provider fails rather than resolving a project or SDK replacement', async t => {
  const build = await fixture(t), original = fs.pathExists;
  (fs as any).pathExists = async (filename: string) => filename.includes('esp32c3-wifi-sdk-driver-v1') ? false : original(filename);
  try { await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32c3', [library('WiFi')], abi), /resource is missing/); }
  finally { fs.pathExists = original; }
});

test('fixed wrappers apply to a clone, preserve user flags, and cannot mix controller identities', () => {
  const original = { platform: { version: '3.3.10', 'compiler.c.elf.extra_flags': '-Wl,baseline' }, nested: { unchanged: true } };
  const before = JSON.stringify(original), result = applySimulationTransportPlatform(original, [ESP32C3_WIFI_PROVIDER]);
  assert.notEqual(result, original); assert.notEqual(result.platform, original.platform); assert.equal(JSON.stringify(original), before);
  const flags = result.platform['compiler.c.elf.extra_flags']; assert.ok(flags.startsWith('-Wl,baseline '));
  assert.equal(flags.split(' ').length, ESP32C3_WIFI_LINKER_WRAPPERS.length + 1);
  for (const name of ESP32C3_WIFI_LINKER_WRAPPERS) assert.ok(flags.split(' ').includes('-Wl,--wrap,' + name));
  assert.equal(applySimulationTransportPlatform(original, []), original);
  assert.equal(applySimulationTransportPlatform(original, ['unknown-provider']), original);
  assert.throws(() => applySimulationTransportPlatform(original, [ESP32C3_WIFI_PROVIDER, ESP32_VHCI_PROVIDER]), /cannot be mixed/);
});

test('real Compiler reused preprocess is not polluted by simulation intent or injected dependencies', async t => {
  const directory = await fixture(t), compiler: any = new ArduinoCompiler(new Logger());
  await mkdir(path.join(directory, 'source'));
  await writeFile(path.join(directory, 'source/sketch.ino'), 'void setup() {}\nvoid loop() {}\n');
  const preprocess = { success: true, preprocessTime: 0, sketchSourceIdentity: await captureSketchSourceIdentity(path.join(directory, 'source/sketch.ino')),
    arduinoConfig: { fqbn: 'esp32:esp32:esp32c3', board: { 'build.mcu': 'esp32c3' }, platform: { version: '3.3.10', 'compiler.c.elf.extra_flags': '-Wl,baseline' } },
    compileConfig: { args: { c: '-c -Os', cpp: '-c -Os', s: '-c', ld: '-Wl,baseline-link -o out' }, compiler: {} }, dependencies: [library('WiFi')] };
  const before = JSON.stringify(preprocess), observed: any[] = [];
  compiler.runGlobalPrebuild = async () => {}; compiler.prepareBuildDirectory = async () => {};
  compiler.ninjaPipeline.compile = async (value: any) => { observed.push(value); return { success: false, error: 'controlled stop before tool execution' }; };
  for (const simulationDebug of [true, false]) {
    const result = await compiler.compile({ sketchPath: path.join(directory, 'source/sketch.ino'), buildPath: path.join(directory, 'build'),
      board: 'esp32:esp32:esp32c3', simulationDebug, recordBuildInputs: true,
      artifactManifestPath: path.join(directory, 'build/aily-artifact-manifest.json'),
      toolVersions: { ...abi.toolVersions }, preprocessResult: preprocess });
    assert.equal(result.success, false); assert.equal(result.error, 'controlled stop before tool execution');
    assert.equal(JSON.stringify(preprocess), before);
  }
  assert.equal(observed.length, 2); assert.ok(observed[0].inputRecording);
  assert.ok(observed[0].compileConfig.arduino.platform['compiler.c.elf.extra_flags'].includes('--wrap,esp_wifi_init'));
  assert.ok(observed[0].compileConfig.args.ld.includes('--wrap,esp_wifi_init'));
  assert.ok(observed[0].dependencies.some((dependency: Dependency) => dependency.name === '__simulation_transport_c3_wifi__'));
  assert.equal(observed[1].compileConfig.arduino.platform['compiler.c.elf.extra_flags'], '-Wl,baseline');
  assert.equal(observed[1].dependencies.length, 1); assert.equal(observed[1].compileConfig.args.c, '-c -Os');
  assert.equal(observed[1].compileConfig.args.ld, '-Wl,baseline-link -o out');
});

test('normal package asset producer carries every C3 source/header byte, not a development-only path', async t => {
  const directory = await fixture(t);
  const { copyNinja } = createRequire(__filename)('../copy-ninja.js');
  await copyNinja(path.join(directory, 'ninja'));
  for (const filename of files) assert.equal(sha(await readFile(path.join(directory, 'resources/simulation/esp32c3-wifi-sdk-driver-v1', filename))), sha(await readFile(path.join(resourceRoot, filename))));
});

test('resolved linker command receives only the fixed wraps without mutating cached IR', () => {
  const cached = { args: { c: '-c', ld: '-Wl,baseline-link -o firmware.elf' }, other: true };
  const before = JSON.stringify(cached), selected = applySimulationTransportCompileConfig(cached, [ESP32C3_WIFI_PROVIDER]);
  assert.equal(JSON.stringify(cached), before); assert.notEqual(selected.args, cached.args);
  assert.equal(selected.args.ld.split(' ').filter(value => value.startsWith('-Wl,--wrap,')).length, 30);
  assert.ok(selected.args.ld.startsWith(cached.args.ld + ' '));
  assert.equal(applySimulationTransportCompileConfig(cached, []), cached);
  assert.throws(() => applySimulationTransportCompileConfig({ args: {} }, [ESP32C3_WIFI_PROVIDER]), /resolved linker/);
});
