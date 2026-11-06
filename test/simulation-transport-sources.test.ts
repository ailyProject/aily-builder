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
  ESP32C3_WIFI_PROVIDER, ESP32C3_WIFI_LINKER_WRAPPERS, ESP32C6_WIFI_PROVIDER, ESP32_VHCI_PROVIDER,
  ESP32C6_BLE_PROVIDER, ESP32C6_BLE_LINKER_WRAPPERS } from '../src/SimulationTransportSources';
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
    [true, 'esp32c3', [library('Network')]], [true, 'esp32c6', [library('Network')]], [true, 'esp32s3', [library('WiFi')]]] as const) {
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

test('normal C6 BLE IPC selection requires simulation, real selected BLE and exact ABI', async t => {
  const { build, context, dependencies } = await c6Fixture(t);
  const ble = library('BLE');
  for (const [debug, mcu, libs] of [[false, 'esp32c6', [ble]], [false, 'esp32c6', [library('NimBLE-Arduino')]],
    [true, 'esp32s3', [ble]], [true, 'esp32c6', []]] as const) {
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

test('classic WiFi, WebServer and BluetoothSerial retain the prior exact result and source', async t => {
  const build = await fixture(t), dependencies = [library('WiFi'), library('WebServer'), library('BluetoothSerial')];
  assert.deepEqual(await prepareSimulationTransportSources(build, true, 'esp32', dependencies),
    { providers: [ESP32_VHCI_PROVIDER], network: { wifi: true, httpPort: 80 } });
  assert.equal(sha(await readFile(path.join(build, 'sketch/aily-esp32-vhci-v1.c'))), sha(await readFile(path.join(root, 'resources/simulation/esp32-vhci-v1.c'))));
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
  const preprocess = { success: true, preprocessTime: 0,
    arduinoConfig: { fqbn: 'esp32:esp32:esp32c3', board: { 'build.mcu': 'esp32c3' }, platform: { version: '3.3.10', 'compiler.c.elf.extra_flags': '-Wl,baseline' } },
    compileConfig: { args: { c: '-c -Os', cpp: '-c -Os', s: '-c', ld: '-Wl,baseline-link -o out' }, compiler: {} }, dependencies: [library('WiFi')] };
  const before = JSON.stringify(preprocess), observed: any[] = [];
  compiler.runGlobalPrebuild = async () => {}; compiler.prepareBuildDirectory = async () => {};
  compiler.ninjaPipeline.compile = async (value: any) => { observed.push(value); return { success: false, error: 'controlled stop before tool execution' }; };
  for (const simulationDebug of [true, false]) {
    const result = await compiler.compile({ sketchPath: path.join(directory, 'sketch.ino'), buildPath: path.join(directory, 'build'),
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
