import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArduinoConfigParser } from '../src/ArduinoConfigParser';
import { ArchiveCloudCacheManager } from '../src/ArchiveCloudCacheManager';
import {
  BuildInputRecording, BuildTargetSelection, isSafeResolvedBuildProperty,
  RESOLVED_BUILD_PROPERTY_KEYS, MAX_RESOLVED_BUILD_PROPERTIES_BYTES,
} from '../src/BuildInputRecord';
import { projectResolvedBuildTargetSelection } from '../src/ResolvedBuildTargetSelection';

function selection(properties: Record<string, string>, version?: string): BuildTargetSelection {
  return projectResolvedBuildTargetSelection({ requestedFqbn: 'vendor:avr:Board', effectiveFqbn: 'vendor:avr:Board',
    packageName: 'vendor', architecture: 'avr', selectedMenus: new Map(),
    resolvedProperties: { ...properties, ...(version === undefined ? {} : { version }) } });
}
function record(targetSelection: BuildTargetSelection) {
  const recorder = new BuildInputRecording({}, targetSelection);
  for (const stage of ['sketch', 'libraries', 'core', 'linking']) recorder.recordNinja(stage, Buffer.from('plan'));
  return recorder.finish();
}
async function platformFixture(t: any, boards: string[], platform: string[]) {
  const sdk = await mkdtemp(path.join(os.tmpdir(), 'aily-resolved-target-'));
  t.after(async () => {
    assert.equal(path.dirname(sdk), os.tmpdir());
    assert.ok(path.basename(sdk).startsWith('aily-resolved-target-'));
    await rm(sdk, { recursive: true, force: true });
  });
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  await writeFile(path.join(sdk, 'boards.txt'), boards.join('\n'));
  await writeFile(path.join(sdk, 'platform.txt'), platform.join('\n'));
  process.env.SDK_PATH = sdk;
  return new ArduinoConfigParser();
}

test('facts project only allowed resolved values, preserve disablement and do not infer MCU or versions', () => {
  const properties = { 'build.variant': 'STM32F4xx/F407V(E-G)T_F417V(E-G)T', 'build.mcu': 'cortex-m4',
    'build.product_line': 'STM32F407xx', 'build.core': 'arduino', 'build.psram': '',
    'build.hse': '{unknown.hse}', 'build.lse': '%CLOCK_VALUE%', 'build.ldscript': 'D:/secret/ldscript.ld',
    'runtime.platform.path': 'D:/private/sdk', 'build.unrelated': 'private-value' };
  const projected = selection(properties);
  assert.deepEqual(projected.platform, { package: 'vendor', architecture: 'avr', version: null });
  assert.deepEqual(projected.resolvedBuildProperties, {
    'build.core': 'arduino', 'build.mcu': 'cortex-m4', 'build.product_line': 'STM32F407xx',
    'build.psram': '', 'build.variant': 'STM32F4xx/F407V(E-G)T_F417V(E-G)T',
  });
  assert.equal('mcu' in projected, false);
  assert.equal('build.core.version' in projected.resolvedBuildProperties, false);
  assert.equal('build.variant.version' in projected.resolvedBuildProperties, false);
  assert.equal(JSON.stringify(record(projected)).includes('private'), false);
  properties['build.mcu'] = 'changed';
  assert.equal(projected.resolvedBuildProperties['build.mcu'], 'cortex-m4');
  assert.equal(selection({}, '3.0.0').platform.version, '3.0.0');
  assert.equal(selection({}, 'D:/sdk/3.0.0').platform.version, null);
});

test('portable fact boundary excludes absolute paths, templates, traversal and excessive values', () => {
  const unsafe = ['D:/sdk', 'C:\\sdk', '\\\\server\\sdk', '/private/sdk', '-I/private/sdk',
    'name="/private/sdk"', '-I C:/private/sdk', '--path=C:/private/sdk', '-Wl,-T,/private/sdk',
    '@/private/options', '-I\\\\server\\private', '../private', 'variant/../private', '-I../private', '-L"../private"', '{build.variant}', '%VARIANT_PATH%',
    'unsafe\nvalue', 'x'.repeat(4097)];
  for (const value of unsafe) {
    assert.equal(isSafeResolvedBuildProperty(value), false, value);
    assert.equal('build.variant' in selection({ 'build.variant': value }).resolvedBuildProperties, false);
    assert.equal('build.extra_flags' in selection({ 'build.extra_flags': value }).resolvedBuildProperties, false);
    const invalid = { ...selection({}), resolvedBuildProperties: { 'build.variant': value } };
    assert.throws(() => record(invalid), { code: 'BUILD_INPUT_RECORD_INVALID' });
  }
  for (const value of ['', 'standard', 'subdir/variant', 'ldscript.ld', '-mfpu=fpv4-sp-d16']) {
    assert.equal(isSafeResolvedBuildProperty(value), true, value);
  }
});

test('projection and record bound the fact payload without widening to all SDK properties', () => {
  const properties = Object.fromEntries(RESOLVED_BUILD_PROPERTY_KEYS.map(key => [key, 'x'.repeat(4096)]));
  const projected = selection(properties);
  assert.ok(Buffer.byteLength(JSON.stringify(projected.resolvedBuildProperties)) <= MAX_RESOLVED_BUILD_PROPERTIES_BYTES);
  assert.ok(Object.keys(projected.resolvedBuildProperties).length < RESOLVED_BUILD_PROPERTY_KEYS.length);
  assert.doesNotThrow(() => record(projected));
  assert.throws(() => record({ ...projected, resolvedBuildProperties: properties }),
    { code: 'BUILD_INPUT_RECORD_INVALID' });
});

test('same requested FQBN records actual STM32 chip menu and capacity facts without guessing silicon', async t => {
  const parser = await platformFixture(t, [
    'Generic.build.core=arduino', 'Generic.build.mcu=cortex-m4',
    'Generic.menu.pnum.F407VE=F407VE', 'Generic.menu.pnum.F407VE.build.board=GENERIC_F407VETX',
    'Generic.menu.pnum.F407VE.build.product_line=STM32F407xx',
    'Generic.menu.pnum.F407VE.build.variant=STM32F4xx/shared-F407',
    'Generic.menu.pnum.F407VE.upload.maximum_size=524288',
    'Generic.menu.pnum.F407VG=F407VG', 'Generic.menu.pnum.F407VG.build.board=GENERIC_F407VGTX',
    'Generic.menu.pnum.F407VG.build.product_line=STM32F407xx',
    'Generic.menu.pnum.F407VG.build.variant=STM32F4xx/shared-F407',
    'Generic.menu.pnum.F407VG.upload.maximum_size=1048576',
    'Generic.menu.pnum.F401CC=F401CC', 'Generic.menu.pnum.F401CC.build.board=GENERIC_F401CCTX',
    'Generic.menu.pnum.F401CC.build.product_line=STM32F401xC',
    'Generic.menu.pnum.F401CC.build.variant=STM32F4xx/F401C',
    'Generic.menu.pnum.F401CC.upload.maximum_size=262144',
  ], ['name=Synthetic STM32 platform', 'version=3.0.0']);
  const first = await parser.parseByFQBN('vendor:stm32:Generic');
  const larger = await parser.parseByFQBN('vendor:stm32:Generic', { pnum: 'F407VG' });
  const other = await parser.parseByFQBN('vendor:stm32:Generic', { pnum: 'F401CC' });
  assert.equal(first.targetSelection.requestedFqbn, other.targetSelection.requestedFqbn);
  assert.equal(first.targetSelection.resolvedBuildProperties['build.mcu'], 'cortex-m4');
  assert.equal(first.targetSelection.resolvedBuildProperties['build.product_line'], 'STM32F407xx');
  assert.equal(first.targetSelection.resolvedBuildProperties['upload.maximum_size'], '524288');
  assert.equal(larger.targetSelection.resolvedBuildProperties['upload.maximum_size'], '1048576');
  assert.equal(other.targetSelection.resolvedBuildProperties['build.product_line'], 'STM32F401xC');
  assert.notEqual(record(first.targetSelection).digest, record(larger.targetSelection).digest);
  assert.notEqual(record(first.targetSelection).digest, record(other.targetSelection).digest);
  assert.equal('mcu' in first.targetSelection, false);
});

test('same MCU keeps actual expanded flash/PSRAM/partition configuration and override facts', async t => {
  const parser = await platformFixture(t, [
    'Board.build.core=esp32', 'Board.build.variant=esp32s3', 'Board.build.mcu=esp32s3',
    'Board.build.boot=qio', 'Board.build.psram_type=qspi',
    'Board.menu.Flash.small=4MB', 'Board.menu.Flash.small.build.flash_size=4MB',
    'Board.menu.Flash.large=8MB', 'Board.menu.Flash.large.build.flash_size=8MB',
    'Board.menu.PSRAM.disabled=Disabled', 'Board.menu.PSRAM.disabled.build.psram_type=qspi',
    'Board.menu.PSRAM.disabled.build.defines=',
    'Board.menu.PSRAM.enabled=QSPI', 'Board.menu.PSRAM.enabled.build.psram_type=qspi',
    'Board.menu.PSRAM.enabled.build.defines=-DBOARD_HAS_PSRAM',
    'Board.menu.PSRAM.opi=OPI', 'Board.menu.PSRAM.opi.build.psram_type=opi',
    'Board.menu.PSRAM.opi.build.defines=-DBOARD_HAS_PSRAM',
    'Board.menu.PartitionScheme.default=Default', 'Board.menu.PartitionScheme.default.build.partitions=default',
    'Board.menu.PartitionScheme.huge=Huge', 'Board.menu.PartitionScheme.huge.build.partitions=huge_app',
  ], ['version=3.2.0', 'build.memory_type={build.boot}_{build.psram_type}', 'build.flash_freq=80m']);
  // The FQBN's architecture is synthetic to avoid optional ESP32 tool discovery.
  const first = await parser.parseByFQBN('vendor:testarch:Board');
  const second = await parser.parseByFQBN('vendor:testarch:Board',
    { Flash: 'large', PSRAM: 'opi', PartitionScheme: 'huge', 'build.flash_freq': '120m' });
  assert.equal(first.targetSelection.resolvedBuildProperties['build.memory_type'], 'qio_qspi');
  assert.equal(first.targetSelection.resolvedBuildProperties['build.defines'], '');
  assert.equal(second.targetSelection.resolvedBuildProperties['build.defines'], '-DBOARD_HAS_PSRAM');
  assert.equal(second.targetSelection.resolvedBuildProperties['build.memory_type'], 'qio_opi');
  assert.equal(second.targetSelection.resolvedBuildProperties['build.flash_size'], '8MB');
  assert.equal(second.targetSelection.resolvedBuildProperties['build.partitions'], 'huge_app');
  assert.equal(second.targetSelection.resolvedBuildProperties['build.flash_freq'], '120m');
  assert.equal(first.targetSelection.resolvedBuildProperties['build.mcu'], second.targetSelection.resolvedBuildProperties['build.mcu']);
  assert.notEqual(record(first.targetSelection).digest, record(second.targetSelection).digest);
  const qspiEnabled = await parser.parseByFQBN('vendor:testarch:Board', { PSRAM: 'enabled' });
  assert.equal(qspiEnabled.targetSelection.resolvedBuildProperties['build.memory_type'],
    first.targetSelection.resolvedBuildProperties['build.memory_type']);
  assert.notEqual(qspiEnabled.targetSelection.resolvedBuildProperties['build.defines'],
    first.targetSelection.resolvedBuildProperties['build.defines']);
  assert.notEqual(record(first.targetSelection).digest, record(qspiEnabled.targetSelection).digest);
  const cache: any = Object.create(ArchiveCloudCacheManager.prototype);
  const a = cache.createBoardSignature(first.platform), b = cache.createBoardSignature(second.platform);
  assert.notDeepEqual(a, b, 'Existing archive cache signatures already include effective FQBN and build.*; do not add another policy.');
  assert.equal(a.fqbn, first.targetSelection.effectiveFqbn);
  assert.equal(b.fqbn, second.targetSelection.effectiveFqbn);
});

test('missing and untrusted MCU facts remain absent in an ordinary successful parse', async t => {
  const parser = await platformFixture(t, [
    'Board.build.core=arduino', 'Board.build.variant=standard', 'Board.build.mcu={unresolved.chip}',
  ], ['name=Unknown platform', 'version={unresolved.version}']);
  const parsed = await parser.parseByFQBN('vendor:avr:Board');
  assert.equal(parsed.targetSelection.platform.version, null);
  assert.equal('build.mcu' in parsed.targetSelection.resolvedBuildProperties, false);
  assert.equal(parsed.board['build.mcu'], '{unresolved.chip}');
  assert.doesNotThrow(() => record(parsed.targetSelection));
});

test('new selection schema rejects the old incomplete selection rather than upgrading it from names', () => {
  assert.throws(() => record({ requestedFqbn: 'vendor:avr:Board', effectiveFqbn: 'vendor:avr:Board',
    menuOptions: {} } as any), { code: 'BUILD_INPUT_RECORD_INVALID' });
});
