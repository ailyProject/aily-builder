import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { ESP32_BLE_PROVIDER, ESP32_BLE_LINKER_WRAPPERS, ESP32_BLE_LINKER_BINDINGS, ESP32_VHCI_PROVIDER, ESP32_WIFI_OPENETH_PROVIDER,
  applySimulationTransportCompileConfig, applySimulationTransportPlatform, prepareSimulationTransportSources } from '../src/SimulationTransportSources';
import type { Dependency } from '../src/DependencyAnalyzer';
const library = (name: string): Dependency => ({ name, path: '/controlled/' + name, type: 'library', includes: [], others: [] });
const resource = path.resolve(__dirname, '../resources/simulation/esp32-ble-vhci-v1');
async function fixture(t: any) { const p = await mkdtemp(path.join(os.tmpdir(), 'aily-classic-ble-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }

test('classic BLE uses its fixed ten wrappers and common AHC2 packet ABI, never legacy SPP', async () => {
  const source = await readFile(path.join(resource, 'aily-classic-ble-vhci-v1.c'), 'utf8');
  assert.deepEqual([...source.matchAll(/__wrap_([a-zA-Z0-9_]+)\(/g)].map(x => x[1]).sort(), [...ESP32_BLE_LINKER_WRAPPERS].sort());
  assert.equal(Object.isFrozen(ESP32_BLE_LINKER_WRAPPERS), true);
  assert.equal(new Set(ESP32_BLE_LINKER_WRAPPERS).size, 10);
  assert.deepEqual(await readFile(path.join(resource, 'aily_packet_abi.h')),
    await readFile(path.resolve(resource, '../esp32c3-ble-vhci-v1/aily_packet_abi.h')));
  assert.match(source, /AILY_HCI_CLASSIC_BASE UINT32_C\(0x3ff7f000\)/);
  assert.doesNotMatch(source, /__wrap_esp_bt_(?:controller_)?mem_release\(/);
  assert.match(source, /esp_err_t aily_classic_bt_controller_mem_release\(/);
  assert.match(source, /esp_err_t aily_classic_bt_mem_release\(/);
  const config = { platform: { 'compiler.c.elf.extra_flags': '-Wl,base' }, args: { ld: '-Wl,base' } };
  const wrapped = applySimulationTransportCompileConfig(config, [ESP32_BLE_PROVIDER]);
  assert.equal(wrapped.args.ld, '-Wl,base ' + [...ESP32_BLE_LINKER_WRAPPERS.map(n => '-Wl,--wrap,' + n), ...ESP32_BLE_LINKER_BINDINGS.map(n => '-Wl,--defsym,' + n)].join(' '));
  assert.equal(ESP32_BLE_LINKER_BINDINGS.length, 2);
  assert.equal(config.args.ld, '-Wl,base');
  assert.equal(applySimulationTransportPlatform(config, [ESP32_BLE_PROVIDER]).platform['compiler.c.elf.extra_flags'], wrapped.args.ld);
  for (const other of [ESP32_VHCI_PROVIDER, ESP32_WIFI_OPENETH_PROVIDER])
    assert.throws(() => applySimulationTransportCompileConfig(config, [ESP32_BLE_PROVIDER, other]), /cannot be mixed/);
});

test('actual classic raw scan-response wrapper normalizes only empty buffers and preserves SDK results', async t => {
  const source = await readFile(path.join(resource, 'aily-classic-ble-vhci-v1.c'), 'utf8');
  // Compile the unchanged production function in isolation. This is a local
  // argument/return contract test, not a substitute for the selected SDK/ELF.
  const definition = source.match(/esp_err_t __wrap_esp_ble_gap_config_scan_rsp_data_raw\([^{}]+\) \{[^{}]+\n\}/)?.[0];
  assert.ok(definition);
  const directory = await fixture(t);
  const input = path.join(directory, 'empty-scan-contract.c');
  const executable = path.join(directory, 'empty-scan-contract');
  await writeFile(input, `#include <assert.h>
#include <stddef.h>
#include <stdint.h>
typedef int esp_err_t;
static uint8_t *seen_data;
static uint32_t seen_length;
static int calls, actual_result;
esp_err_t __real_esp_ble_gap_config_scan_rsp_data_raw(uint8_t *data, uint32_t length) {
  seen_data = data; seen_length = length; ++calls; return actual_result;
}
${definition}
int main(void) {
  uint8_t data[32] = {0};
  uint8_t *inputs[] = {data, NULL, data, NULL, data};
  const uint32_t lengths[] = {0, 0, 31, 1, 32};
  const int results[] = {0, -1, 0x102, 0x103};
  for (unsigned r = 0; r < sizeof(results) / sizeof(results[0]); ++r) {
    actual_result = results[r];
    for (unsigned i = 0; i < sizeof(inputs) / sizeof(inputs[0]); ++i) {
      int before = calls;
      assert(__wrap_esp_ble_gap_config_scan_rsp_data_raw(inputs[i], lengths[i]) == actual_result);
      assert(calls == before + 1);
      assert(seen_data == (lengths[i] == 0 ? NULL : inputs[i]));
      assert(seen_length == lengths[i]);
    }
  }
  return 0;
}
`);
  execFileSync('cc', ['-std=gnu11', '-Wall', '-Wextra', '-Werror', input, '-o', executable]);
  execFileSync(executable);
});

test('classic BLE rejects mixed or substituted SDK intent before mutating dependencies or publishing', async t => {
  const build = await fixture(t);
  for (const name of ['WiFi', 'BluetoothSerial', 'NimBLE-Arduino']) {
    const deps = [library('BLE'), library(name)];
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32', deps), /cannot be mixed/);
    assert.equal(deps.length, 2);
  }
  for (const abi of [undefined, {}, { platformVersion: '3.3.10', memoryType: 'qio_opi',
    toolVersions: { 'esp32-libs': '3.3.10', 'esp-x32': '14.2.0' } }]) {
    const deps = [library('BLE')];
    await assert.rejects(prepareSimulationTransportSources(build, true, 'esp32', deps, abi), /Classic BLE VHCI requires Arduino/);
    assert.equal(deps.length, 1);
  }
  await assert.rejects(stat(path.join(build, 'sketch/aily-esp32-ble-vhci-v1')), { code: 'ENOENT' });
});

test('hardware, other targets and no-BLE builds preserve their existing provider selection', async t => {
  const build = await fixture(t);
  for (const [debug, target, deps] of [[false, 'esp32', [library('BLE')]], [true, 'esp32s3', [library('BLE')]],
    [true, 'esp32', []]] as const) assert.deepEqual(await prepareSimulationTransportSources(build, debug, target, [...deps]), { providers: [] });
  assert.deepEqual((await prepareSimulationTransportSources(build, true, 'esp32', [library('BluetoothSerial')])).providers, [ESP32_VHCI_PROVIDER]);
});


test('classic BLE re-notifies real capacity after a contended send check without replaying packets', async t => {
  const source = await readFile(path.join(resource, 'aily-classic-ble-vhci-v1.c'), 'utf8');
  const directory = await fixture(t);
  // Execute the real provider bodies. Only scheduling, RTOS and MMIO are mocked.
  const signatures = [
    'static bool identity(void)', 'static void fence_locked(const char *reason)',
    'static bool healthy_locked(void)',
    'static bool h4_valid(const uint8_t *bytes, uint16_t size, bool incoming)',
    'static void receive_loop(void *unused)',
    'esp_err_t __wrap_esp_bt_controller_init(esp_bt_controller_config_t *cfg)',
    'esp_err_t __wrap_esp_bt_controller_enable(esp_bt_mode_t mode)',
    'bool __wrap_esp_vhci_host_check_send_available(void)',
  ];
  function body(signature: string) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, signature);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; ++i) {
      if (source[i] === '{') ++depth;
      if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    assert.fail('Unclosed provider function: ' + signature);
  }
  const start = source.indexOf('static const char *TAG =');
  const end = source.indexOf('static uint32_t reg_read(', start);
  assert.ok(start >= 0 && end > start);
  await writeFile(path.join(directory, 'provider-globals.inc'), source.slice(start, end));
  await writeFile(path.join(directory, 'provider-functions.inc'), signatures.map(body).join('\n\n'));
  await writeFile(path.join(directory, 'aily_packet_abi.h'), await readFile(path.join(resource, 'aily_packet_abi.h')));
  const input = path.join(directory, 'send-ready-harness.c');
  const executable = path.join(directory, 'send-ready-harness');
  await writeFile(input, await readFile(path.join(__dirname, 'fixtures/classic-ble-send-ready-harness.c')));
  execFileSync('cc', ['-std=gnu11', '-Wall', '-Wextra', '-Werror', '-I', directory, input, '-o', executable]);
  const cases = execFileSync(executable, { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(cases.length, 7);
  assert.ok(cases.every(row => row.passed && row.rxAckWrites === 0 && row.txCommitWrites === 0));
});
