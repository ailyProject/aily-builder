import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { ESP32_SPP_PROVIDER, ESP32_SPP_TRANSPORT_PROFILE, ESP32_SPP_LINKER_WRAPPERS,
  ESP32_SPP_LINKER_BINDINGS, ESP32_VHCI_PROVIDER, ESP32_BLE_PROVIDER, ESP32_WIFI_OPENETH_PROVIDER,
  validateSimulationTransportProfile, applySimulationTransportCompileConfig, applySimulationTransportPlatform,
  prepareSimulationTransportSources, verifyPreparedSimulationProviderInputs, type SimulationTransportAbi } from '../src/SimulationTransportSources';
import { ArduinoCompiler } from '../src/ArduinoCompiler';
import { captureSketchSourceIdentity } from '../src/SketchSources';
import { Logger } from '../src/utils/Logger';
import { BuildInputRecording } from '../src/BuildInputRecord';
import type { Dependency } from '../src/DependencyAnalyzer';

const sdkPath = process.env.AILY_SPP_TEST_SDK_PATH;
const compilerSdkPath = process.env.AILY_SPP_TEST_COMPILER_SDK_PATH;
const realSdk = !!sdkPath && !!compilerSdkPath;
const library = (name: string, source = '/controlled/' + name): Dependency => ({ name, path: source, type: 'library', includes: [], others: [] });
const resource = path.resolve(__dirname, '../resources/simulation/esp32-ble-vhci-v1');
const abi = (): SimulationTransportAbi => ({ profile: ESP32_SPP_TRANSPORT_PROFILE, platformVersion: '3.3.10', sdkPath, compilerSdkPath,
  memoryType: 'dio_qspi', toolVersions: { 'esp32-libs': '3.3.10', 'esp-x32': '14.2.0' } });
async function temporary(t: any) { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-classic-spp-')); t.after(() => fs.remove(p)); return p; }
const spp = () => library('BluetoothSerial', path.join(sdkPath!, 'libraries/BluetoothSerial/src'));

test('normal Builder CLI advertises only the exact project profile and rejects unknown serialization before compilation', () => {
  const root = path.resolve(__dirname, '..');
  const result = execFileSync(process.execPath, ['--import', 'tsx', path.join(root, 'main.ts'), 'capabilities', '--json'], { encoding: 'utf8', cwd: root });
  assert.deepEqual(JSON.parse(result).capabilities.simulationTransportProfile, {
    schemaVersion: 1, cliOption: '--simulation-transport-profile', allowedValues: [ESP32_SPP_TRANSPORT_PROFILE],
    providerByProfile: { [ESP32_SPP_TRANSPORT_PROFILE]: ESP32_SPP_PROVIDER },
    requiresSimulationDebug: true, requiresBuildInputRecord: true, requiresArtifactManifest: true,
  });
  const invalid = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'main.ts'), 'compile', 'unopened-sketch.ino',
    '--simulation-transport-profile', 'unadmitted-profile'], { encoding: 'utf8', cwd: root });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Allowed choices|choices/i);
  assert.doesNotMatch(invalid.stdout, /Starting compilation/);
});

test('SPP AHC2 is exact explicit intent; absent intent preserves the historical AHC1 provider', async t => {
  assert.equal(validateSimulationTransportProfile(undefined), undefined);
  assert.equal(validateSimulationTransportProfile(ESP32_SPP_TRANSPORT_PROFILE), ESP32_SPP_TRANSPORT_PROFILE);
  for (const bad of ['', null, false, {}, [], 'esp32-classic-spp-ahc2-v1', 'esp32-classic-spp-ahc2-v2-extra'])
    assert.throws(() => validateSimulationTransportProfile(bad), /Unknown explicit/);
  const build = await temporary(t);
  const old = await prepareSimulationTransportSources(build, true, 'esp32', [library('BluetoothSerial')]);
  assert.deepEqual(old.providers, [ESP32_VHCI_PROVIDER]);
  for (const [simulation, target, deps] of [[false, 'esp32', [library('BluetoothSerial')]],
    [true, 'esp32s3', [library('BluetoothSerial')]], [true, 'esp32c3', [library('BluetoothSerial')]],
    [true, 'esp32c6', [library('BluetoothSerial')]], [true, 'esp32', []]] as const) {
    const original = JSON.stringify(deps);
    await assert.rejects(prepareSimulationTransportSources(build, simulation, target, [...deps], { profile: ESP32_SPP_TRANSPORT_PROFILE }), /profile requires/);
    assert.equal(JSON.stringify(deps), original);
  }
});

test('SPP rejects mixed libraries or invalid SDK intent before publishing or mutating dependencies', async t => {
  const build = await temporary(t);
  for (const name of ['BLE', 'WiFi', 'NimBLE-Arduino']) {
    const deps = [library('BluetoothSerial'), library(name)], before = JSON.stringify(deps);
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32', deps, { profile: ESP32_SPP_TRANSPORT_PROFILE }), /cannot be mixed/);
    assert.equal(JSON.stringify(deps), before);
  }
  for (const wrong of [{ profile: ESP32_SPP_TRANSPORT_PROFILE }, { ...abi(), memoryType: 'qio_opi' },
    { ...abi(), toolVersions: { 'esp32-libs': '3.3.12', 'esp-x32': '14.2.0' } }]) {
    const deps = [library('BluetoothSerial')];
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32', deps, wrong as any), /Classic SPP AHC2 requires Arduino/);
    assert.equal(deps.length, 1);
  }
  assert.equal(await fs.pathExists(path.join(build, 'sketch/aily-esp32-spp-vhci-v2')), false);
});

test('SPP has nine fixed controller/VHCI/query wrappers and original HAL release bindings', () => {
  assert.equal(Object.isFrozen(ESP32_SPP_LINKER_WRAPPERS), true); assert.equal(ESP32_SPP_LINKER_WRAPPERS.length, 9);
  assert.equal(new Set(ESP32_SPP_LINKER_WRAPPERS).size, 9); assert.equal(ESP32_SPP_LINKER_BINDINGS.length, 2);
  assert(ESP32_SPP_LINKER_WRAPPERS.includes('controller_get_interface'));
  const original = { platform: { 'compiler.c.elf.extra_flags': '-Wl,base -Wl,--wrap=esp_bt_mem_release' },
    args: { ld: '-Wl,base -Wl,--wrap=esp_bt_mem_release' } };
  const expected = [...ESP32_SPP_LINKER_WRAPPERS.map(name => '-Wl,--wrap,' + name),
    ...ESP32_SPP_LINKER_BINDINGS.map(binding => '-Wl,--defsym,' + binding)].join(' ');
  const actual = applySimulationTransportCompileConfig(original, [ESP32_SPP_PROVIDER]);
  assert.equal(actual.args.ld, original.args.ld + ' ' + expected);
  assert.equal(applySimulationTransportPlatform(original, [ESP32_SPP_PROVIDER]).platform['compiler.c.elf.extra_flags'], actual.args.ld);
  for (const other of [ESP32_VHCI_PROVIDER, ESP32_BLE_PROVIDER, ESP32_WIFI_OPENETH_PROVIDER])
    assert.throws(() => applySimulationTransportCompileConfig(original, [ESP32_SPP_PROVIDER, other]), /cannot be mixed/);
  for (const flags of ['-Wl,--wrap,esp_ble_tx_power_get', '-Wl,--wrap=esp_vhci_host_send_packet',
    '-Wl,--wrap,esp_bt_controller_init', '-Wl,--wrap=controller_get_interface',
    '-Wl,--defsym,esp_bt_mem_release=aily_classic_bt_mem_release']) {
    assert.throws(() => applySimulationTransportCompileConfig({ args: { ld: flags } }, [ESP32_SPP_PROVIDER]), /cannot mix or replay/);
    assert.throws(() => applySimulationTransportPlatform({ platform: { 'compiler.c.elf.extra_flags': flags } }, [ESP32_SPP_PROVIDER]), /cannot mix or replay/);
  }
  assert.equal(original.args.ld, '-Wl,base -Wl,--wrap=esp_bt_mem_release');
});

test('real selected SDK stages the one shared AHC2 implementation, not a transport fork', { skip: !realSdk }, async t => {
  for (const memoryType of ['dio_qspi', 'qio_qspi']) {
    const build = await temporary(t), deps = [spp()];
    const prepared = await prepareSimulationTransportSources(build, true, 'esp32', deps, { ...abi(), memoryType });
    assert.deepEqual(prepared.providers, [ESP32_SPP_PROVIDER]); assert.equal(prepared.providerSourceInputs?.sources.length, 4);
    assert.equal(prepared.providerSourceInputs?.selectedSdk.length, 21);
    const own = deps.find(item => item.name === '__simulation_transport_classic_spp_v2__')!;
    assert.equal(own.includes?.length, 1); assert.equal(own.others?.length, 3);
    const wrapper = await fs.readFile(own.includes![0], 'utf8');
    assert.match(wrapper, /#define AILY_CLASSIC_AHC2_SPP 1/); assert.match(wrapper, /#include "aily-classic-vhci-ahc2.inc"/);
    assert.doesNotMatch(wrapper, /transport_epoch|receive_loop/);
    assert.deepEqual([...wrapper.matchAll(/__wrap_([a-zA-Z0-9_]+)\(/g)].map(x => x[1]), ['controller_get_interface']);
    assert.deepEqual(await fs.readFile(own.others![0]), await fs.readFile(path.join(resource, 'aily-classic-ble-vhci-v1.c')));
    assert.deepEqual(await fs.readFile(own.others![1]), await fs.readFile(path.join(resource, 'aily_packet_abi.h')));
    assert.deepEqual(await fs.readFile(own.others![2]), await fs.readFile(path.resolve(resource, '../esp32-spp-vhci-v2/aily-classic-spp-controller-interface.h')));
    assert.equal(await fs.pathExists(path.join(build, 'sketch/aily-esp32-vhci-v1.c')), false);
    await verifyPreparedSimulationProviderInputs(prepared.providerSourceInputs);
    await fs.appendFile(own.others![2], '\n/* changed prepared private ABI input */\n');
    await assert.rejects(verifyPreparedSimulationProviderInputs(prepared.providerSourceInputs), /input changed/);
  }
});

test('substituted BluetoothSerial bytes and extra SDK host sources fail before staging', { skip: !realSdk }, async t => {
  const root = await temporary(t), copy = path.join(root, 'sdk');
  await fs.copy(path.join(sdkPath!, 'libraries/BluetoothSerial'), path.join(copy, 'libraries/BluetoothSerial'));
  for (const name of ['esp32-hal-bt.c', 'esp32-hal-bt.h', 'esp32-hal-alloc-bt-classic-mem.h'])
    await fs.copy(path.join(sdkPath!, 'cores/esp32', name), path.join(copy, 'cores/esp32', name));
  const deps = [library('BluetoothSerial', path.join(copy, 'libraries/BluetoothSerial/src'))];
  await fs.appendFile(path.join(copy, 'libraries/BluetoothSerial/src/BluetoothSerial.cpp'), '\n// substituted SDK bytes\n');
  await assert.rejects(prepareSimulationTransportSources(root, true, 'esp32', deps, { ...abi(), sdkPath: copy }), /SDK input differs/);
  assert.equal(deps.length, 1); assert.equal(await fs.pathExists(path.join(root, 'sketch/aily-esp32-spp-vhci-v2')), false);
  await fs.outputFile(path.join(copy, 'libraries/BluetoothSerial/src/unadmitted.cpp'), 'void extra() {}\n');
  await assert.rejects(prepareSimulationTransportSources(root, true, 'esp32', deps, { ...abi(), sdkPath: copy }), /source set differs/);
});

test('BuildInputRecord binds explicit profile, shared source/SDK identities and consumed linker IR', { skip: !realSdk }, async t => {
  const root = await temporary(t), prepared = await prepareSimulationTransportSources(root, true, 'esp32', [spp()], abi());
  const configuration = { ...applySimulationTransportCompileConfig({ args: { ld: '-Wl,base' } }, prepared.providers),
    simulationTransportProfile: ESP32_SPP_TRANSPORT_PROFILE, simulationProviderSourceInputs: prepared.providerSourceInputs };
  const record = (value: unknown) => { const actual = new BuildInputRecording(value);
    for (const phase of ['sketch', 'libraries', 'core', 'linking']) actual.recordNinja(phase, Buffer.from('controlled-' + phase));
    return actual.finish(); };
  const proof = record(configuration); assert.equal(proof.scope, 'build-graph-facts');
  for (const mutate of [(value: any) => delete value.simulationTransportProfile,
    (value: any) => value.simulationProviderSourceInputs.sources[1].sha256 = '0'.repeat(64),
    (value: any) => value.simulationProviderSourceInputs.sources[3].sha256 = '0'.repeat(64),
    (value: any) => value.simulationProviderSourceInputs.selectedSdk[0].bytes++,
    (value: any) => value.args.ld = value.args.ld.replace('-Wl,--wrap,esp_vhci_host_send_packet', '')]) {
    const changed = JSON.parse(JSON.stringify(configuration)); mutate(changed);
    assert.notEqual(record(changed).digest, proof.digest);
  }
});

test('actual Compiler receives explicit SPP source identity and final linker IR without contaminating hardware reuse', { skip: !realSdk }, async t => {
  const root = await temporary(t), sketchPath = path.join(root, 'source/sketch.ino');
  await fs.outputFile(sketchPath, '#include <BluetoothSerial.h>\nvoid setup() {}\nvoid loop() {}\n');
  const source = await captureSketchSourceIdentity(sketchPath);
  const preprocess = { success: true, preprocessTime: 0, sketchSourceIdentity: source,
    arduinoConfig: { fqbn: 'esp32:esp32:esp32', board: { 'build.mcu': 'esp32' }, platform: { version: '3.3.10',
      'runtime.platform.path': sdkPath, 'compiler.sdk.path': compilerSdkPath, 'build.memory_type': 'dio_qspi', 'compiler.c.elf.extra_flags': '-Wl,base' } },
    compileConfig: { args: { c: '-c -Os', cpp: '-c -Os', s: '-c', ld: '-Wl,base' }, compiler: {} }, dependencies: [spp()] };
  const before = JSON.stringify(preprocess), compiler: any = new ArduinoCompiler(new Logger()), observed: any[] = [];
  compiler.runGlobalPrebuild = async () => {}; compiler.prepareBuildDirectory = async () => {};
  compiler.ninjaPipeline.compile = async (input: any) => {
    observed.push(input);
    if (input.compileConfig.simulationProviderSourceInputs) await verifyPreparedSimulationProviderInputs(input.compileConfig.simulationProviderSourceInputs);
    return { success: false, error: 'controlled stop before compiler or Ninja execution' };
  };
  const common = { sketchPath, buildPath: path.join(root, 'build'), board: 'esp32:esp32:esp32',
    toolVersions: abi().toolVersions, preprocessResult: preprocess, recordBuildInputs: true,
    artifactManifestPath: path.join(root, 'build/manifest.json') };
  assert.equal((await compiler.compile({ ...common, simulationDebug: true, simulationTransportProfile: ESP32_SPP_TRANSPORT_PROFILE })).error,
    'controlled stop before compiler or Ninja execution');
  assert.equal((await compiler.compile({ ...common, simulationDebug: false })).error, 'controlled stop before compiler or Ninja execution');
  assert.equal(observed.length, 2); const first = observed[0], hardware = observed[1];
  assert.equal(first.compileConfig.simulationTransportProfile, ESP32_SPP_TRANSPORT_PROFILE);
  assert.equal(first.compileConfig.simulationProviderSourceInputs.provider, ESP32_SPP_PROVIDER);
  assert.equal(first.compileConfig.args.ld.split(' ').filter((part: string) => part.startsWith('-Wl,--wrap,')).length, 9);
  assert(first.inputRecording); assert.equal(first.dependencies.length, 2);
  assert.equal(hardware.dependencies.length, 1); assert.equal(hardware.compileConfig.args.ld, '-Wl,base');
  assert.equal(Object.hasOwn(hardware.compileConfig, 'simulationProviderSourceInputs'), false);
  assert.equal(Object.hasOwn(hardware.compileConfig, 'simulationTransportProfile'), false);
  assert.equal(JSON.stringify(preprocess), before);
  // Exercise the normal Compiler's selected path, not a guessed global SDK.
  // Corrupt only a physical task-local copy; the installed SDK stays read-only.
  const wrongSdk = path.join(root, 'wrong-selected-sdk');
  for (const row of first.compileConfig.simulationProviderSourceInputs.selectedSdk) {
    const relative = path.relative(compilerSdkPath!, row.path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const target = path.join(wrongSdk, relative); await fs.ensureDir(path.dirname(target));
    await fs.copyFile(row.path, target);
  }
  const wrongLib = path.join(wrongSdk, 'lib/libbt.a'), bytes = await fs.readFile(wrongLib);
  bytes[0] ^= 1; await fs.writeFile(wrongLib, bytes);
  const wrongPreprocess = JSON.parse(before);
  wrongPreprocess.arduinoConfig.platform['compiler.sdk.path'] = wrongSdk;
  const rejected = await compiler.compile({ ...common, buildPath: path.join(root, 'rejected-build'),
    artifactManifestPath: path.join(root, 'rejected-build/manifest.json'),
    preprocessResult: wrongPreprocess, simulationDebug: true, simulationTransportProfile: ESP32_SPP_TRANSPORT_PROFILE });
  assert.match(rejected.error, /Classic SPP AHC2 SDK input differs: libbt\.a/);
  assert.equal(observed.length, 2, 'Wrong selected SDK must never reach Ninja/compiler consumption');
  assert.equal(await fs.pathExists(path.join(root, 'rejected-build/sketch/aily-esp32-spp-vhci-v2')), false);
});

test('actual SPP controller query facade preserves the original table, BR/LE values and readiness fence', async t => {
  const root = await temporary(t), sppResource = path.resolve(resource, '../esp32-spp-vhci-v2');
  const source = await fs.readFile(path.join(sppResource, 'aily-classic-spp-vhci-v2.c'), 'utf8');
  const extract = (signature: string) => {
    const start = source.indexOf(signature); assert(start >= 0); const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    assert.fail('Unclosed actual controller query function');
  };
  await fs.writeFile(path.join(root, 'controller-query-functions.inc'), [
    extract('static uint16_t aily_spp_get_default_data_length(void)'),
    extract('const aily_spp_controller_t *__wrap_controller_get_interface(void)'),
  ].join('\n\n'));
  const input = path.join(root, 'controller-interface-harness.c'), output = path.join(root, 'controller-interface-harness');
  await fs.copyFile(path.join(__dirname, 'fixtures/classic-spp-controller-interface-harness.c'), input);
  execFileSync('cc', ['-std=gnu11', '-Wall', '-Wextra', '-Werror', '-I', sppResource, '-I', root, input, '-o', output]);
  assert.equal(execFileSync(output, { encoding: 'utf8' }).trim(), 'classic-spp-controller-interface: passed');
});

test('SPP mode uses the actual shared send-ready retry bodies for Classic controller mode', async t => {
  const source = await fs.readFile(path.join(resource, 'aily-classic-ble-vhci-v1.c'), 'utf8'), root = await temporary(t);
  const signatures = ['static bool identity(void)', 'static void fence_locked(const char *reason)', 'static bool healthy_locked(void)',
    'static bool h4_valid(const uint8_t *bytes, uint16_t size, bool incoming)', 'static void receive_loop(void *unused)',
    'esp_err_t __wrap_esp_bt_controller_init(esp_bt_controller_config_t *cfg)',
    'esp_err_t __wrap_esp_bt_controller_enable(esp_bt_mode_t mode)', 'bool __wrap_esp_vhci_host_check_send_available(void)'];
  const body = (signature: string) => { const start = source.indexOf(signature), open = source.indexOf('{', start); assert(start >= 0);
    let depth = 0; for (let i = open; i < source.length; i++) { if (source[i] === '{') depth++; if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
    assert.fail('unclosed actual provider function'); };
  const start = source.indexOf('static const char *TAG ='), end = source.indexOf('static uint32_t reg_read(', start);
  await fs.writeFile(path.join(root, 'provider-globals.inc'), source.slice(start, end));
  await fs.writeFile(path.join(root, 'provider-functions.inc'), signatures.map(body).join('\n\n'));
  await fs.copyFile(path.join(resource, 'aily_packet_abi.h'), path.join(root, 'aily_packet_abi.h'));
  let harness = await fs.readFile(path.join(__dirname, 'fixtures/classic-ble-send-ready-harness.c'), 'utf8');
  harness = '#define AILY_CLASSIC_AHC2_SPP 1\n' + harness.replace('ESP_BT_MODE_BLE=1,', 'ESP_BT_MODE_BLE=1,ESP_BT_MODE_CLASSIC_BT=2,')
    .replace(/\.mode=ESP_BT_MODE_BLE/g, '.mode=ESP_BT_MODE_CLASSIC_BT')
    .replace(/__wrap_esp_bt_controller_enable\(ESP_BT_MODE_BLE\)/g, '__wrap_esp_bt_controller_enable(ESP_BT_MODE_CLASSIC_BT)');
  harness = harness.replace('int main(void){', `int main(void){
 reset_fixture(false);
 assert(__wrap_esp_bt_controller_enable(ESP_BT_MODE_BLE)==ESP_ERR_INVALID_ARG);
 receiver=NULL;state=ESP_BT_CONTROLLER_STATUS_IDLE;
 esp_bt_controller_config_t mode_cfg={.magic=ESP_BT_CONTROLLER_CONFIG_MAGIC_VAL,.mode=ESP_BT_MODE_BLE};
 assert(__wrap_esp_bt_controller_init(&mode_cfg)==ESP_ERR_INVALID_ARG);
 mode_cfg.mode=ESP_BT_MODE_BTDM;
 assert(__wrap_esp_bt_controller_init(&mode_cfg)==ESP_OK);
 assert(__wrap_esp_bt_controller_enable(ESP_BT_MODE_CLASSIC_BT)==ESP_ERR_INVALID_STATE);
 assert(__wrap_esp_bt_controller_enable(ESP_BT_MODE_BTDM)==ESP_OK);
 result("explicit-spp-controller-mode-boundary");`);
  const input = path.join(root, 'classic-mode-harness.c'), output = path.join(root, 'classic-mode-harness');
  await fs.writeFile(input, harness); execFileSync('cc', ['-std=gnu11', '-Wall', '-Wextra', '-Werror', '-I', root, input, '-o', output]);
  const rows = execFileSync(output, { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 8); assert(rows.every(row => row.passed && row.rxAckWrites === 0 && row.txCommitWrites === 0));
});
