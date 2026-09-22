import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureBuildInputs, confirmBuildInputs, type BuildInputSelection } from '../src/BuildInputRecord';
import { ArduinoCompiler } from '../src/ArduinoCompiler';
import { Logger } from '../src/utils/Logger';
import { emitSimulationArtifactManifest } from '../src/ArtifactManifest';
import { captureExternalBuildInputs, splitInputArguments } from '../src/ExternalBuildInputs';
import { NinjaGenerator } from '../src/NinjaGenerator';
import { NinjaCompilationPipeline } from '../src/NinjaCompilationPipeline';
import { BuildInputRecording } from '../src/BuildInputRecording';

async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-build-inputs-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('aily-build-inputs-'));
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'), library = path.join(root, 'library'), build = path.join(source, '.build');
  await mkdir(build, { recursive: true });
  await mkdir(library);
  await writeFile(path.join(source, 'sketch.ino'), '#include "local.h"');
  await writeFile(path.join(source, 'local.h'), 'int count = 0;');
  await writeFile(path.join(library, 'library.cpp'), 'int increment(int n) { return n + 1; }');
  const selection: BuildInputSelection = { roots: [source, library], exclude: [build],
    configuration: { board: 'esp32:esp32:XIAO_ESP32S3', menu: { USBMode: 'hwcdc' }, args: ['-Og'] } };
  return { root, source, library, build, selection };
}

test('stable input identity covers local headers, libraries and options, not generated outputs', async t => {
  const f = await fixture(t);
  const before = await captureBuildInputs(f.selection);
  await writeFile(path.join(f.build, 'sketch.elf'), 'output');
  const record = await confirmBuildInputs(before, { ...f.selection, roots: [...f.selection.roots].reverse() });
  assert.equal(record.digest, before.record.digest);
  assert.equal(record.roots.flatMap(root => root.files).length, 3);
  assert.equal(JSON.stringify(record).includes(f.root), false, 'Do not publish absolute source paths.');
});

for (const change of ['header', 'library', 'addition', 'deletion', 'board', 'menu', 'args', 'toolchain']) {
  test(`rejects changed ${change} during compilation`, async t => {
    const f = await fixture(t), before = await captureBuildInputs(f.selection);
    if (change === 'header') await writeFile(path.join(f.source, 'local.h'), 'int count = 1;');
    else if (change === 'library') await writeFile(path.join(f.library, 'library.cpp'), 'int changed;');
    else if (change === 'addition') await writeFile(path.join(f.source, 'new.h'), 'int added;');
    else if (change === 'deletion') await rm(path.join(f.source, 'local.h'));
    else (f.selection.configuration as any)[change] = 'different';
    await assert.rejects(confirmBuildInputs(before, f.selection), { code: 'BUILD_INPUTS_CHANGED' });
  });
}

test('same-size edits with restored mtime are not accepted', async t => {
  const f = await fixture(t), filename = path.join(f.source, 'local.h');
  const original = await stat(filename), before = await captureBuildInputs(f.selection);
  await writeFile(filename, 'int count = 1;');
  await utimes(filename, original.atime, original.mtime);
  await assert.rejects(confirmBuildInputs(before, f.selection), { code: 'BUILD_INPUTS_CHANGED' });
});

test('implicit junction escape is rejected', async t => {
  const f = await fixture(t);
  await symlink(f.library, path.join(f.source, 'outside'), 'junction');
  await assert.rejects(captureBuildInputs(f.selection), /symlink\/junction/);
});

test('configuration object key ordering does not alter identity', async t => {
  const f = await fixture(t);
  const a = await captureBuildInputs({ ...f.selection, configuration: { a: 1, b: { c: 2, d: 3 } } });
  const b = await captureBuildInputs({ ...f.selection, configuration: { b: { d: 3, c: 2 }, a: 1 } });
  assert.equal(a.record.digest, b.record.digest);
});

test('artifact identity binds the input record even when firmware output bytes are identical', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.build, 'sketch.hex'), ':00000001FF');
  const first = await captureBuildInputs(f.selection);
  const options = { buildPath: f.build, sketchPath: path.join(f.source, 'sketch.ino'), board: 'arduino:avr:uno',
    manifestPath: path.join(f.build, 'aily-artifact-manifest.json') };
  const before = await emitSimulationArtifactManifest({ ...options, buildInputs: first.record });
  await writeFile(path.join(f.source, 'local.h'), 'int count = 1;');
  const second = await captureBuildInputs(f.selection);
  const after = await emitSimulationArtifactManifest({ ...options, buildInputs: second.record });
  assert.notEqual(before.artifactId, after.artifactId);
  assert.equal(after.build.inputs?.digest, second.record.digest);
});

test('input evidence is a detached sidecar and cannot contaminate a second build', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.build, 'sketch.hex'), ':00000001FF');
  const options = { buildPath: f.build, sketchPath: path.join(f.source, 'sketch.ino'), board: 'arduino:avr:uno',
    manifestPath: path.join(f.build, 'aily-artifact-manifest.json') };
  const first = await captureBuildInputs(f.selection);
  const a = await emitSimulationArtifactManifest({ ...options, buildInputs: first.record });
  assert.equal(a.build.inputs?.kind, 'aily-build-input-reference');
  assert.equal((a.build.inputs as any).roots, undefined);
  assert.equal(a.files.find(file => file.path === 'aily-build-inputs.json')?.role, 'build-inputs');
  const sidecar = JSON.parse(await readFile(path.join(f.build, a.build.inputs!.path), 'utf8'));
  assert.deepEqual(sidecar, first.record);
  const second = await captureBuildInputs(f.selection);
  assert.equal(second.record.digest, first.record.digest);
  const b = await emitSimulationArtifactManifest({ ...options, buildInputs: second.record });
  assert.equal(b.artifactId, a.artifactId);
  assert.equal((await confirmBuildInputs(second, f.selection)).digest, first.record.digest);
  const withoutEvidence = await emitSimulationArtifactManifest(options);
  assert.equal(withoutEvidence.build.inputs, undefined);
  assert.equal(withoutEvidence.files.some(file => file.role === 'build-inputs'), false);
  await assert.rejects(stat(path.join(f.build, 'aily-build-inputs.json')), { code: 'ENOENT' });
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

test('recipe and GNU response tokenizers distinguish Windows paths from response escapes', () => {
  assert.deepEqual(splitInputArguments(String.raw`"@C:\SDK path\flags" -DVALUE=1`), ['@C:\\SDK path\\flags', '-DVALUE=1']);
  assert.deepEqual(splitInputArguments(String.raw`'two words' escaped\ space "C:\\SDK\\flags"`, true), ['two words', 'escaped space', 'C:\\SDK\\flags']);
  assert.throws(() => splitInputArguments('"unclosed'), /Unterminated/);
});

async function externalFixture(t: any) {
  const f = await fixture(t), tools = path.join(f.root, 'tools');
  await mkdir(tools);
  const compiler = path.join(tools, process.platform === 'win32' ? 'test-g++.exe' : 'test-g++');
  await writeFile(compiler, 'compiler identity');
  await writeFile(path.join(f.build, 'outer flags'), '@nested.rsp -DNAME="value"');
  await writeFile(path.join(f.build, 'nested.rsp'), '-I/sdk/include');
  f.selection.external = { recipes: ['"@outer flags" -Wl,@nested.rsp'], tools: { cpp: path.basename(compiler), ld: compiler },
    cwd: f.build, searchPath: tools };
  return { ...f, tools, compiler };
}

test('response files inside excluded build output are explicit inputs, tool bytes and roles are deduplicated', async t => {
  const f = await externalFixture(t), before = await captureBuildInputs(f.selection);
  const files = before.record.external!.files;
  assert.equal(files.length, 3);
  assert.deepEqual(files.find(file => file.roles.includes('tool:cpp'))!.roles, ['tool:cpp', 'tool:ld']);
  assert.equal(JSON.stringify(files).includes(f.root), false);
  await writeFile(path.join(f.build, 'aily-build-delivery.json'), 'metadata');
  assert.equal((await confirmBuildInputs(before, f.selection)).digest, before.record.digest);
});

for (const change of ['response', 'tool', 'nested', 'resolution']) test(`record detects external ${change} change`, async t => {
  const f = await externalFixture(t), before = await captureBuildInputs(f.selection);
  if (change === 'response') await writeFile(path.join(f.build, 'outer flags'), '@nested.rsp -DOTHER=1');
  if (change === 'nested') await writeFile(path.join(f.build, 'nested.rsp'), '-DCHANGED=1');
  if (change === 'tool') await writeFile(f.compiler, 'different compiler');
  if (change === 'resolution') {
    const shadow = path.join(f.root, 'shadow'); await mkdir(shadow);
    await writeFile(path.join(shadow, path.basename(f.compiler)), 'shadow compiler');
    f.selection.external!.searchPath = shadow + path.delimiter + f.tools;
  }
  await assert.rejects(confirmBuildInputs(before, f.selection), { code: 'BUILD_INPUTS_CHANGED' });
});

test('external collection rejects missing tools, cyclic/unresolved/oversized response files', async t => {
  const f = await externalFixture(t), selection = f.selection.external!;
  await assert.rejects(captureExternalBuildInputs({ ...selection, tools: { cpp: 'nonexistent-build-tool' } }), /Cannot resolve/);
  await writeFile(path.join(f.build, 'nested.rsp'), '@outer\\ flags');
  await assert.rejects(captureExternalBuildInputs(selection), /cycle/);
  await assert.rejects(captureExternalBuildInputs({ ...selection, recipes: ['@%UNKNOWN%'] }), /Unresolved/);
  await writeFile(path.join(f.build, 'nested.rsp'), 'x'.repeat(4 * 1024 * 1024));
  await assert.rejects(captureExternalBuildInputs(selection), /4 MiB/);
});

test('recorded Ninja graph uses a stable identity dependency even when objects look newer', async t => {
  const f = await fixture(t), generator: any = new NinjaGenerator(new Logger());
  // Isolate graph identity wiring from platform-specific recipe generation.
  generator.invalidateArduinoCoreBuildObjectsIfNeeded = async () => {};
  generator.setupGlobalVariables = () => {};
  generator.generateRules = () => {};
  generator.generateBuilds = async () => { generator.ninjaFile.builds.push({ outputs: ['x.o'], rule: 'cpp_compile', inputs: ['x.cpp'] }, { outputs: ['core.a'], rule: 'archive', inputs: ['x.o'] }); };
  generator.generateLinkTargets = () => {};
  const options = { dependencies: [], compileConfig: { args: {}, compiler: {} }, buildPath: f.build, jobs: 1, inputIdentity: 'a'.repeat(64) };
  const file = await generator.generateNinjaFile(options), marker = path.join(f.build, 'aily-input-identity.txt');
  assert.match(await readFile(file, 'utf8'), /x\.o.*\| aily-input-identity\.txt/);
  const first = await stat(marker);
  await generator.generateNinjaFile(options);
  assert.equal((await stat(marker)).mtimeMs, first.mtimeMs);
  await generator.generateNinjaFile({ ...options, inputIdentity: 'b'.repeat(64) });
  assert.equal(await readFile(marker, 'utf8'), 'b'.repeat(64));
});

test('recorded pipeline neither restores nor publishes unbound object/archive caches', async t => {
  const f = await fixture(t), pipeline: any = new NinjaCompilationPipeline(new Logger());
  const priorBuildPath = process.env.BUILD_PATH;
  process.env.BUILD_PATH = f.build;
  t.after(() => { if (priorBuildPath === undefined) delete process.env.BUILD_PATH; else process.env.BUILD_PATH = priorBuildPath; });
  const noCache = () => { throw new Error('recorded build must not use unbound cache'); };
  pipeline.archiveCloudCacheManager = { restoreArchives: noCache, startRemoteFetches: noCache, storeArchives: noCache };
  pipeline.restoreFromCache = noCache; pipeline.storeSingleFileToCache = noCache;
  let received: any;
  pipeline.ninjaGenerator = { generateNinjaFile: async (options: any) => { received = options; return path.join(f.build, 'build.ninja'); } };
  const stages: string[] = [];
  pipeline.runNinjaStage = async (_file: string, target: string) => { stages.push(target); return true; };
  pipeline.getExistingOutputFilePath = async () => path.join(f.build, 'sketch.bin');
  const result = await pipeline.compile({ dependencies: [], compileConfig: { args: {}, compiler: {} }, inputIdentity: 'c'.repeat(64) });
  assert.equal(result.success, true);
  assert.equal(received.inputIdentity, 'c'.repeat(64));
  assert.deepEqual(stages, [NinjaGenerator.SKETCH_TARGET, NinjaGenerator.LIBRARIES_TARGET, NinjaGenerator.CORE_TARGET,
    'sketch.elf']);
  await pipeline.handleCompilationProgress('cc x.cpp -o x.o', f.build);
});

test('phase recording binds temporary hook inputs and permits their later restoration', async t => {
  const f = await externalFixture(t), response = path.join(f.build, 'nested.rsp');
  async function run() {
    const recording = await BuildInputRecording.open(() => f.selection);
    for (const phase of ['sketch', 'libraries', 'core', 'link', 'objcopy']) {
      if (phase === 'core') await writeFile(response, '-DCORE_PHASE=1');
      const checkpoint = await recording.beginPhase(phase);
      await checkpoint.confirm();
      await assert.rejects(checkpoint.confirm(), /already confirmed/);
      if (phase === 'core') await writeFile(response, '-I/sdk/include');
    }
    const record = await recording.finish();
    await recording.confirmFinal();
    return record;
  }
  const first = await run(), second = await run();
  assert.equal(first.digest, second.digest, 'phase markers/evidence must not perturb repeat builds');
  const responseSha = (phase: any) => phase.external.files.find((file: any) => file.name === 'nested.rsp').sha256;
  assert.notEqual(responseSha(first.phases![0]), responseSha(first.phases![2]));
  assert.equal(responseSha(first.phases![0]), responseSha(first.phases![3]));
});

for (const change of ['response-during-phase', 'source-between-phases', 'tool-between-phases']) test(`phase recording refuses ${change}`, async t => {
  const f = await externalFixture(t), recording = await BuildInputRecording.open(() => f.selection);
  const checkpoint = await recording.beginPhase('sketch');
  if (change === 'response-during-phase') {
    await writeFile(path.join(f.build, 'nested.rsp'), '-DUNEXPECTED_EDIT=1');
    await assert.rejects(checkpoint.confirm(), { code: 'BUILD_INPUTS_CHANGED' });
  } else {
    await checkpoint.confirm();
    await writeFile(change === 'source-between-phases' ? path.join(f.source, 'local.h') : f.compiler, 'changed');
    await assert.rejects(recording.beginPhase('libraries'), { code: 'BUILD_INPUTS_CHANGED' });
  }
});

test('recording rejects skipped, concurrent and incomplete phases', async t => {
  const f = await externalFixture(t), recording = await BuildInputRecording.open(() => f.selection);
  await assert.rejects(recording.beginPhase('core'), /phase order/);
  const first = await recording.beginPhase('sketch');
  await assert.rejects(recording.beginPhase('sketch'), /phase order/);
  await first.confirm();
  await assert.rejects(recording.finish(), /Incomplete/);
});

test('phase confirmation occurs before posthook restoration, including failure cleanup', async () => {
  for (const rejected of [false, true]) {
    const pipeline: any = new NinjaCompilationPipeline(new Logger()), events: string[] = [];
    pipeline.runRecipeGroup = async (_runner: any, name: string) => { events.push(name); };
    pipeline.invalidateChangedPhaseInputs = async () => { events.push('invalidate'); };
    pipeline.inputRecording = { beginPhase: async () => {
      events.push('capture');
      return { phase: 'core', identity: 'a'.repeat(64), confirm: async () => {
        events.push('confirm'); if (rejected) throw new Error('unexpected edit');
      } };
    } };
    const run = pipeline.runRecipePhase(undefined, 'pre', 'post', 'Core', async () => { events.push('compile'); return true; });
    if (rejected) await assert.rejects(run, /unexpected edit/); else assert.equal(await run, true);
    assert.deepEqual(events, ['pre', 'capture', 'invalidate', 'compile', 'confirm', 'post']);
  }
});

test('phase input identity invalidates only owned outputs and stays stable for unchanged input', async t => {
  const f = await fixture(t), pipeline: any = new NinjaCompilationPipeline(new Logger());
  const previous = process.env.BUILD_PATH;
  process.env.BUILD_PATH = f.build;
  t.after(() => { if (previous === undefined) delete process.env.BUILD_PATH; else process.env.BUILD_PATH = previous; });
  const object = path.join(f.build, 'core/core.cpp.o'), keep = path.join(f.build, 'user-data.txt');
  await mkdir(path.dirname(object)); await writeFile(object, 'old'); await writeFile(keep, 'preserve');
  await pipeline.invalidateChangedPhaseInputs('core', 'a'.repeat(64));
  await assert.rejects(stat(object), { code: 'ENOENT' });
  await writeFile(object, 'rebuilt');
  const marker = path.join(f.build, 'aily-input-core.txt'), first = await stat(marker);
  await pipeline.invalidateChangedPhaseInputs('core', 'a'.repeat(64));
  assert.equal(await readFile(object, 'utf8'), 'rebuilt');
  assert.equal((await stat(marker)).mtimeMs, first.mtimeMs);
  await pipeline.invalidateChangedPhaseInputs('core', 'b'.repeat(64));
  await assert.rejects(stat(object), { code: 'ENOENT' });
  assert.equal(await readFile(keep, 'utf8'), 'preserve');
});

test('ordinary pipeline retains cache restore and publication', async t => {
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
  pipeline.ninjaGenerator = { generateNinjaFile: async () => path.join(f.build, 'build.ninja') };
  pipeline.runNinjaStage = async () => true;
  pipeline.getExistingOutputFilePath = async () => path.join(f.build, 'sketch.bin');
  assert.equal((await pipeline.compile({ dependencies: [], compileConfig: { args: {}, compiler: {} } })).success, true);
  assert.deepEqual(calls, ['archives', 'remote', 'objects', 'store']);
});
