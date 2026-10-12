import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuildInputRecording, type BuildTargetSelection } from '../src/BuildInputRecord';
import { ArduinoCompiler } from '../src/ArduinoCompiler';
import { ArduinoConfigParser } from '../src/ArduinoConfigParser';
import { Logger } from '../src/utils/Logger';
import { emitSimulationArtifactManifest } from '../src/ArtifactManifest';
import { NinjaGenerator } from '../src/NinjaGenerator';
import { NinjaCompilationPipeline } from '../src/NinjaCompilationPipeline';

const stages = ['sketch', 'libraries', 'core', 'linking'];
const graph = Buffer.from('rule cc\n  command = compiler source.cpp\nbuild output.o: cc source.cpp\n');
function recorded(configuration: unknown = { board: 'test' }, definition = graph, targetSelection?: BuildTargetSelection) {
  const recording = new BuildInputRecording(configuration, targetSelection);
  for (const stage of stages) recording.recordNinja(stage, definition);
  return recording.finish();
}
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-build-facts-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('aily-build-facts-'));
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'), build = path.join(source, '.build');
  await mkdir(build, { recursive: true });
  await writeFile(path.join(source, 'sketch.ino'), 'void setup() {}');
  await writeFile(path.join(build, 'build.ninja'), graph);
  return { root, source, build };
}

async function parsedTargetFixture(t: any, buildProperties: Record<string, string> = {}) {
  const f = await fixture(t), sdk = path.join(f.root, 'synthetic-platform');
  await mkdir(sdk);
  await writeFile(path.join(sdk, 'boards.txt'), [
    'BoardCase.build.mcu=atmega328p', 'BoardCase.build.core=arduino', 'BoardCase.build.variant=standard',
    'BoardCase.menu.Speed.Slow=Slow', 'BoardCase.menu.Speed.Slow.build.f_cpu=8000000L',
    'BoardCase.menu.Speed.Fast=Fast', 'BoardCase.menu.Speed.Fast.build.f_cpu=16000000L',
    'BoardCase.menu.Mode.MixedCase=Default', 'BoardCase.menu.Mode.MixedCase.build.mode=default',
    'BoardCase.menu.Mode.alt=Alternate', 'BoardCase.menu.Mode.alt.build.mode=alternate',
  ].join('\n'));
  await writeFile(path.join(sdk, 'platform.txt'), 'name=Synthetic test platform\nversion=1.0.0\n');
  const keys = ['SDK_PATH', 'package', 'platform', 'BUILD_MCU', 'COMPILER_PATH', 'COMPILER_GPP_PATH',
    'SDK_CORE_PATH', 'SDK_VARIANT_PATH', 'SDK_CORE_LIBRARIES_PATH'];
  const previous = keys.map(key => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.SDK_PATH = sdk;
  const parsed = await new ArduinoConfigParser().parseByFQBN('vendor:avr:BoardCase', buildProperties);
  return { ...f, parsed };
}
test('metadata identity is stable, detached and does not expose absolute paths', () => {
  const config = { board: 'test', dependencies: [{ path: 'D:/private/sdk', includes: ['x.cpp'] }] };
  const recorder = new BuildInputRecording(config);
  config.board = 'changed later';
  for (const stage of stages) recorder.recordNinja(stage, graph);
  const value = recorder.finish();
  assert.equal(value.scope, 'build-graph-facts');
  assert.equal(value.digest, recorded({ dependencies: [{ path: 'D:/private/sdk', includes: ['x.cpp'] }], board: 'test' }).digest);
  assert.equal(JSON.stringify(value).includes('D:/private'), false);
  assert.notEqual(value.digest, recorded(config).digest);
  assert.notEqual(value.digest, recorded(config, Buffer.from('different plan')).digest);
  assert.throws(() => recorder.finish(), /already finalized/);
  assert.throws(() => recorder.recordNinja('sketch', graph), /Invalid/);
});

test('parser records default menus in actual FQBN order with case-preserving sorted menu facts', async t => {
  const { parsed } = await parsedTargetFixture(t);
  assert.deepEqual(parsed.targetSelection, {
    schemaVersion: 1,
    requestedFqbn: 'vendor:avr:BoardCase',
    effectiveFqbn: 'vendor:avr:BoardCase:Speed=Slow,Mode=MixedCase',
    menuOptions: { Mode: 'MixedCase', Speed: 'Slow' },
    platform: { package: 'vendor', architecture: 'avr', version: '1.0.0' },
    resolvedBuildProperties: { 'build.arch': 'AVR', 'build.core': 'arduino', 'build.f_cpu': '8000000L',
      'build.flash_total': '2097152', 'build.mcu': 'atmega328p', 'build.variant': 'standard' },
  });
  assert.equal(parsed.board['build.fqbn'], parsed.targetSelection.effectiveFqbn);
  assert.equal(parsed.board['build.f_cpu'], '8000000L');
});

test('parser records explicit menus from real menu resolution', async t => {
  const { parsed } = await parsedTargetFixture(t, { Speed: 'Fast', Mode: 'alt' });
  assert.deepEqual(parsed.targetSelection, {
    schemaVersion: 1,
    requestedFqbn: 'vendor:avr:BoardCase',
    effectiveFqbn: 'vendor:avr:BoardCase:Speed=Fast,Mode=alt',
    menuOptions: { Mode: 'alt', Speed: 'Fast' },
    platform: { package: 'vendor', architecture: 'avr', version: '1.0.0' },
    resolvedBuildProperties: { 'build.arch': 'AVR', 'build.core': 'arduino', 'build.f_cpu': '16000000L',
      'build.flash_total': '2097152', 'build.mcu': 'atmega328p', 'build.variant': 'standard' },
  });
  assert.equal(parsed.board['build.f_cpu'], '16000000L');
  assert.equal(parsed.board['build.mode'], 'alternate');
});

test('target selection is detached, sorted and digest-bound without publishing configuration paths', () => {
  const selection: BuildTargetSelection = { schemaVersion: 1, requestedFqbn: 'vendor:avr:BoardCase',
    effectiveFqbn: 'vendor:avr:BoardCase:Speed=Slow,Mode=MixedCase',
    menuOptions: { Speed: 'Slow', Mode: 'MixedCase' },
    platform: { package: 'vendor', architecture: 'avr', version: '1.0.0' },
    resolvedBuildProperties: { 'build.variant': 'standard', 'build.mcu': 'atmega328p' } };
  const recorder = new BuildInputRecording({ sdk: 'D:/private/sdk' }, selection);
  const expected = recorded({ sdk: 'D:/private/sdk' }, graph, { ...selection,
    menuOptions: { Mode: 'MixedCase', Speed: 'Slow' } });
  selection.menuOptions.Speed = 'changed';
  selection.requestedFqbn = 'changed';
  selection.platform.version = 'changed';
  selection.resolvedBuildProperties['build.mcu'] = 'changed';
  for (const stage of stages) recorder.recordNinja(stage, graph);
  const value = recorder.finish();
  assert.deepEqual(value, expected);
  assert.deepEqual(Object.keys(value.targetSelection!.menuOptions), ['Mode', 'Speed']);
  assert.equal(JSON.stringify(value).includes('D:/private'), false);
  const changed = recorded({ sdk: 'D:/private/sdk' }, graph, {
    ...expected.targetSelection!, effectiveFqbn: 'vendor:avr:BoardCase:Speed=Fast,Mode=MixedCase',
    menuOptions: { Speed: 'Fast', Mode: 'MixedCase' },
  });
  assert.equal(changed.configurationSha256, value.configurationSha256);
  assert.notEqual(changed.digest, value.digest);
  assert.equal(recorded().targetSelection, undefined, 'Legacy records explicitly have no recorded selection.');
});

test('target selection rejects invalid, inconsistent, path-bearing and oversized facts', () => {
  const selection: BuildTargetSelection = { schemaVersion: 1, requestedFqbn: 'vendor:avr:BoardCase',
    effectiveFqbn: 'vendor:avr:BoardCase:Speed=Slow', menuOptions: { Speed: 'Slow' },
    platform: { package: 'vendor', architecture: 'avr', version: null }, resolvedBuildProperties: {} };
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`M${i}`, 'default']));
  const invalid: any[] = [null, {}, [], { ...selection, extra: 'unrequested' },
    { ...selection, requestedFqbn: 'D:/private/sdk' }, { ...selection, requestedFqbn: 'vendor::BoardCase' },
    { ...selection, effectiveFqbn: 'vendor:avr:boardcase:Speed=Slow' },
    { ...selection, effectiveFqbn: 'vendor:avr:BoardCase:Speed=slow' },
    { ...selection, effectiveFqbn: 'vendor:avr:BoardCase:Speed=Slow,Speed=Slow' },
    { ...selection, menuOptions: new Map([['Speed', 'Slow']]) },
    { ...selection, menuOptions: { Speed: 'D:/private/sdk' } },
    { ...selection, menuOptions: { Speed: 42 } }, { ...selection, menuOptions: { '': 'Slow' } },
    { ...selection, menuOptions: { Speed: '' } }, { ...selection, menuOptions: tooMany },
    { ...selection, menuOptions: { ['x'.repeat(129)]: 'Slow' } },
    { ...selection, menuOptions: { Speed: 'x'.repeat(129) } },
    { ...selection, effectiveFqbn: 'x'.repeat(16 * 1024 + 1) },
    { ...selection, schemaVersion: 2 },
    { ...selection, platform: { package: 'wrong', architecture: 'avr', version: null } },
    { ...selection, platform: { package: 'vendor', architecture: 'stm32', version: null } },
    { ...selection, platform: { package: 'vendor', architecture: 'avr' } },
    { ...selection, platform: { package: 'vendor', architecture: 'avr', version: 'D:/private/sdk' } },
    { ...selection, resolvedBuildProperties: { 'runtime.platform.path': 'relative/sdk' } },
    { ...selection, resolvedBuildProperties: { 'build.mcu': '{chip}' } },
    { ...selection, resolvedBuildProperties: { 'build.variant': '../outside' } },
    { ...selection, resolvedBuildProperties: { 'build.variant': 'D:/private/sdk' } },
    { ...selection, resolvedBuildProperties: { 'build.variant': 'x'.repeat(4097) } },
  ];
  for (const value of invalid) assert.throws(() => new BuildInputRecording({}, value),
    { code: 'BUILD_INPUT_RECORD_INVALID' });
  assert.deepEqual(recorded({}, graph, { schemaVersion: 1, requestedFqbn: 'arduino:avr:uno',
    effectiveFqbn: 'arduino:avr:uno', menuOptions: {},
    platform: { package: 'arduino', architecture: 'avr', version: null },
    resolvedBuildProperties: {} }).targetSelection?.menuOptions, {});
});

for (const selected of [false, true]) test(`preprocess reuse keeps parsed selection=${selected} and manifest FQBN requested`, async t => {
  const f = await parsedTargetFixture(t), compiler: any = new ArduinoCompiler(new Logger());
  if (!selected) delete (f.parsed as any).targetSelection;
  await writeFile(path.join(f.build, 'sketch.hex'), ':00000001FF');
  compiler.runGlobalPrebuild = async () => {};
  compiler.prepareBuildDirectory = async () => {};
  compiler.calculateFirmwareSize = async () => ({ sections: [] });
  compiler.ninjaPipeline.compile = async ({ inputRecording }: any) => {
    for (const stage of stages) inputRecording.recordNinja(stage, graph);
    return { success: true, outFilePath: path.join(f.build, 'sketch.hex') };
  };
  const result = await compiler.compile({ sketchPath: path.join(f.source, 'sketch.ino'), buildPath: f.build,
    board: f.parsed.fqbn, buildProperties: { Speed: 'Fast' }, recordBuildInputs: true,
    artifactManifestPath: path.join(f.build, 'aily-artifact-manifest.json'),
    preprocessResult: { success: true, preprocessTime: 0, arduinoConfig: f.parsed,
      compileConfig: { args: {}, compiler: {} }, dependencies: [] },
  });
  assert.equal(result.success, true, result.error);
  const inputs = JSON.parse(await readFile(path.join(f.build, 'aily-build-inputs.json'), 'utf8'));
  assert.deepEqual(inputs.targetSelection, f.parsed.targetSelection);
  if (selected) assert.equal(inputs.targetSelection.menuOptions.Speed, 'Slow');
  else assert.equal('targetSelection' in inputs, false, 'Do not infer missing legacy selection from properties.');
  assert.equal(result.artifactManifest.target.fqbn, f.parsed.fqbn);
  assert.equal(result.artifactManifest.build.inputs.digest, inputs.digest);
  assert.equal(JSON.stringify(inputs).includes(f.root), false);
});

test('ordinary compilation does not require complete simulation MCU facts or build recording', async t => {
  const f = await parsedTargetFixture(t, { 'build.mcu': '{unknown.chip}' });
  const compiler: any = new ArduinoCompiler(new Logger());
  assert.equal('build.mcu' in f.parsed.targetSelection.resolvedBuildProperties, false);
  compiler.runGlobalPrebuild = async () => {};
  compiler.prepareBuildDirectory = async () => {};
  compiler.calculateFirmwareSize = async () => ({ sections: [] });
  compiler.ninjaPipeline.compile = async ({ inputRecording }: any) => {
    assert.equal(inputRecording, undefined);
    return { success: true, outFilePath: path.join(f.build, 'sketch.hex') };
  };
  const result = await compiler.compile({ sketchPath: path.join(f.source, 'sketch.ino'), buildPath: f.build,
    board: f.parsed.fqbn, preprocessResult: { success: true, preprocessTime: 0, arduinoConfig: f.parsed,
      compileConfig: { args: {}, compiler: {} }, dependencies: [] } });
  assert.equal(result.success, true, result.error);
  assert.equal(result.artifactManifest, undefined);
});
test('recording never follows configuration source, tool, response or linker paths', async t => {
  const f = await fixture(t), sdk = path.join(f.root, 'sdk');
  await mkdir(sdk);
  await symlink(sdk, path.join(sdk, 'cycle'), 'junction');
  const config = { dependencies: [{ path: sdk, includes: ['missing.cpp'] }],
    compiler: { cpp: path.join(sdk, 'missing.exe') }, args: { ld: '@missing.rsp -L' + sdk } };
  const before = recorded(config);
  await writeFile(path.join(sdk, 'unused.h'), 'unused');
  await rm(path.join(f.source, 'sketch.ino'));
  assert.deepEqual(recorded(config), before, 'This is metadata provenance, not source freshness or byte closure.');
});
test('incomplete, out-of-order and oversized facts fail without a byte-scanning fallback', () => {
  const recorder = new BuildInputRecording({});
  assert.throws(() => recorder.finish(), /incomplete/);
  assert.throws(() => recorder.recordNinja('core', graph), /Invalid/);
  assert.throws(() => recorder.recordNinja('sketch', Buffer.alloc(8 * 1024 * 1024 + 1)), /Invalid/);
  assert.throws(() => new BuildInputRecording('x'.repeat(16 * 1024 * 1024)), /budget/);
});
test('successful recipe facts are bounded and bind the commands without publishing them', () => {
  const recorder = new BuildInputRecording({});
  recorder.recordRecipes('empty', []);
  recorder.recordRecipes('prebuild', ['private/tool --secret-location']);
  for (const stage of stages) recorder.recordNinja(stage, graph);
  const value = recorder.finish();
  assert.equal(value.steps.length, 5);
  assert.deepEqual(value.steps[0], { kind: 'recipe-run', name: 'prebuild',
    sha256: require('node:crypto').createHash('sha256').update(JSON.stringify(['private/tool --secret-location'])).digest('hex'),
    commandCount: 1 });
  assert.equal(JSON.stringify(value).includes('private/tool'), false);
});
test('artifact binds metadata identity; ordinary builds remove the optional sidecar', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.build, 'sketch.hex'), ':00000001FF');
  const options = { buildPath: f.build, sketchPath: path.join(f.source, 'sketch.ino'), board: 'arduino:avr:uno',
    manifestPath: path.join(f.build, 'aily-artifact-manifest.json') };
  const first = recorded(), second = recorded({ board: 'different' });
  const a = await emitSimulationArtifactManifest({ ...options, buildInputs: first });
  const b = await emitSimulationArtifactManifest({ ...options, buildInputs: second });
  assert.notEqual(a.artifactId, b.artifactId);
  for (const invalid of [{ ...second, scope: 'prepared-dependency-trees' }, { ...second, digest: 'f'.repeat(64) }]) {
    await assert.rejects(emitSimulationArtifactManifest({ ...options, buildInputs: invalid as any }), /Unsupported or inconsistent/);
  }
  await emitSimulationArtifactManifest({ ...options, buildInputs: second });
  assert.equal(b.build.inputs?.scope, 'build-graph-facts');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.build, 'aily-build-inputs.json'), 'utf8')), second);
  assert.equal(b.files.some(file => file.path.includes('context')), false);
  const ordinary = await emitSimulationArtifactManifest(options);
  assert.equal(ordinary.build.inputs, undefined);
  await assert.rejects(stat(path.join(f.build, 'aily-build-inputs.json')), { code: 'ENOENT' });
});

test('artifact validates new selection semantics and requested FQBN even when record digest is correct', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.build, 'sketch.hex'), ':00000001FF');
  const options = { buildPath: f.build, sketchPath: path.join(f.source, 'sketch.ino'), board: 'arduino:avr:uno',
    manifestPath: path.join(f.build, 'aily-artifact-manifest.json') };
  const targetSelection: BuildTargetSelection = { schemaVersion: 1, requestedFqbn: 'arduino:avr:uno',
    effectiveFqbn: 'arduino:avr:uno', menuOptions: {},
    platform: { package: 'arduino', architecture: 'avr', version: '1.8.6' },
    resolvedBuildProperties: { 'build.core': 'arduino', 'build.mcu': 'atmega328p', 'build.variant': 'standard' } };
  const correct = recorded({}, graph, targetSelection);
  const artifact = await emitSimulationArtifactManifest({ ...options, buildInputs: correct });
  assert.equal(artifact.target.fqbn, 'arduino:avr:uno');
  const wrongTarget = recorded({}, graph, { ...targetSelection, requestedFqbn: 'arduino:avr:nano',
    effectiveFqbn: 'arduino:avr:nano' });
  await assert.rejects(emitSimulationArtifactManifest({ ...options, buildInputs: wrongTarget }), /does not match/);
  for (const invalidSelection of [
    { requestedFqbn: targetSelection.requestedFqbn, effectiveFqbn: targetSelection.effectiveFqbn, menuOptions: {} },
    { ...targetSelection, platform: { ...targetSelection.platform, version: 'D:/private/sdk' } },
    { ...targetSelection, resolvedBuildProperties: { 'build.mcu': '{unresolved.chip}' } },
  ]) {
    const { digest: _digest, ...body } = correct;
    const invalidBody = { ...body, targetSelection: invalidSelection };
    const digest = require('node:crypto').createHash('sha256').update(JSON.stringify(invalidBody)).digest('hex');
    await assert.rejects(emitSimulationArtifactManifest({ ...options,
      buildInputs: { ...invalidBody, digest } as any }), { code: 'BUILD_INPUT_RECORD_INVALID' });
  }
});
test('a failed compile removes its previous manifest, without deleting an outside path', async t => {
  const f = await fixture(t), manifest = path.join(f.build, 'aily-artifact-manifest.json');
  await writeFile(manifest, 'stale');
  const compiler = new ArduinoCompiler(new Logger());
  (compiler as any).preprocess = async () => ({ success: false, preprocessTime: 0, error: 'expected test failure' });
  const options = { sketchPath: path.join(f.source, 'sketch.ino'), board: 'test:test:test', buildPath: f.build, artifactManifestPath: manifest };
  assert.equal((await compiler.compile(options)).success, false);
  await assert.rejects(stat(manifest), { code: 'ENOENT' });
  const outside = path.join(f.root, 'outside.json');
  await writeFile(outside, 'preserve');
  await assert.rejects(compiler.compile({ ...options, artifactManifestPath: outside }), /inside the build directory/);
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
  await symlink(f.root, path.join(f.build, 'escape'), 'junction');
  await assert.rejects(compiler.compile({ ...options, artifactManifestPath: path.join(f.build, 'escape', 'outside.json') }), /escapes the build directory/);
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
});


for (const enabled of [false, true]) test(`recording=${enabled} keeps normal object/archive cache policy`, async t => {
  const f = await fixture(t), pipeline: any = new NinjaCompilationPipeline(new Logger()), calls: string[] = [];
  const previous = process.env.BUILD_PATH;
  process.env.BUILD_PATH = f.build;
  t.after(() => { if (previous === undefined) delete process.env.BUILD_PATH; else process.env.BUILD_PATH = previous; });
  pipeline.archiveCloudCacheManager = {
    restoreArchives: async () => { calls.push('archives'); return new Map(); },
    startRemoteFetches: () => { calls.push('remote'); return new Map(); },
    storeArchives: async () => { calls.push('store'); },
  };
  pipeline.restoreFromCache = async () => { calls.push('objects'); };
  pipeline.ninjaGenerator = { generateNinjaFile: async (options: any) => {
    assert.equal('inputIdentity' in options, false);
    return path.join(f.build, 'build.ninja');
  } };
  pipeline.executeNinjaBuild = async () => ({ success: true });
  pipeline.getExistingOutputFilePath = async () => path.join(f.build, 'sketch.bin');
  const inputRecording = enabled ? new BuildInputRecording({}) : undefined;
  const result = await pipeline.compile({ dependencies: [], compileConfig: { args: {}, compiler: {} }, inputRecording });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(calls, ['archives', 'remote', 'objects', 'store']);
  if (inputRecording) assert.deepEqual(inputRecording.finish().steps.map(step => step.name), stages);
});
test('failed Ninja actions do not publish a completed step', async t => {
  const f = await fixture(t), pipeline: any = new NinjaCompilationPipeline(new Logger());
  const recorder = new BuildInputRecording({});
  pipeline.inputRecording = recorder;
  pipeline.executeNinjaBuild = async () => ({ success: false });
  assert.equal(await pipeline.runNinjaStage(path.join(f.build, 'build.ninja'), 'target', [],
    { stage: 'sketch', start: 0, end: 1, message: 'test' }), false);
  assert.throws(() => recorder.finish(), /incomplete/);
  await writeFile(path.join(f.build, 'build.ninja'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(pipeline.readRecordedNinjaGraph(path.join(f.build, 'build.ninja')), /budget/);
});
test('posthooks always run and facts never add a second phase invalidation', async () => {
  const pipeline: any = new NinjaCompilationPipeline(new Logger()), events: string[] = [];
  pipeline.runRecipeGroup = async (_runner: any, name: string) => { events.push(name); };
  await assert.rejects(pipeline.runRecipePhase(undefined, 'pre', 'post', 'Core', async () => {
    events.push('action'); throw new Error('expected');
  }), /expected/);
  assert.deepEqual(events, ['pre', 'action', 'post']);
});
test('Ninja owns ordinary source dependencies without record identity marker edges', async t => {
  const f = await fixture(t), generator: any = new NinjaGenerator(new Logger());
  generator.setupGlobalVariables = () => {};
  generator.generateRules = () => {};
  generator.generateBuilds = async () => {
    generator.ninjaFile.builds.push({ outputs: ['x.o'], rule: 'cpp_compile', inputs: ['x.cpp'] });
  };
  generator.generateLinkTargets = () => {};
  const file = await generator.generateNinjaFile({ buildPath: f.build, jobs: 1,
    dependencies: [], compileConfig: { compiler: {}, args: {} } });
  assert.equal((await readFile(file, 'utf8')).includes('aily-input-identity'), false);
});
