import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { NinjaGenerator } from '../src/NinjaGenerator';
import { NinjaCompilationPipeline } from '../src/NinjaCompilationPipeline';
import { ArduinoCompiler } from '../src/ArduinoCompiler';
import { Logger } from '../src/utils/Logger';
import { BuildInputRecording } from '../src/BuildInputRecord';
import { captureSketchSourceIdentity, collectUserSketchSources, normalizeSketchInputs, sameSketchSourceIdentity, USER_SKETCH_DEPENDENCY_NAME } from '../src/SketchSources';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-user-sources-'));
  const source = path.join(root, 'sketch'), build = path.join(root, 'build'), entry = path.join(source, 'entry.cpp');
  await fs.ensureDir(source); await fs.ensureDir(build);
  await fs.writeFile(entry, 'int main() { return 0; }\n');
  const old = { ...process.env };
  for (const key of ['SDK_CORE_PATH', 'SDK_VARIANT_PATH', 'SDK_CORE_LIBRARIES_PATH', 'LIBRARIES_PATH']) delete process.env[key];
  Object.assign(process.env, { SKETCH_PATH: entry, SKETCH_DIR_PATH: source, SKETCH_NAME: 'entry', BUILD_PATH: build });
  t.after(async () => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); await fs.remove(root); });
  const write = async (relative: string, bytes: string) => { const filename = path.join(source, relative); await fs.outputFile(filename, bytes); return filename; };
  const config = { platform: {}, fqbnParsed: { package: 'synthetic' } };
  const analyze = () => new DependencyAnalyzer(new Logger()).preprocess(config);
  return { root, source, build, entry, write, analyze };
}

test('real dependency graph and native Ninja link consume unreferenced C/C++/assembly, local headers, nested src and colliding basenames', async t => {
  const f = await fixture(t), library = path.join(f.root, 'libraries/Support/src');
  await fs.outputFile(path.join(library, 'Support.h'), 'int support();\n');
  await fs.outputFile(path.join(library, 'Support.cpp'), 'int support() { return 24; }\n');
  process.env.LIBRARIES_PATH = path.dirname(path.dirname(library));
  await f.write('include/config.h', '#pragma once\n#define VALUE 7\n#include <Support.h>\n');
  await f.write('entry.cpp', '#include "include/config.h"\nint user(); int main() { return user() == 31 ? 0 : 1; }\n');
  await f.write('helper.cpp', '#include "include/config.h"\nint user() { return VALUE + support(); }\n');
  await f.write('src/a/helper.cpp', 'int duplicate_basename() { return 1; }\n');
  await f.write('src/a_b/thing.cpp', 'int collision_one() { return 1; }\n');
  await f.write('src/a/b_thing.cpp', 'int collision_two() { return 2; }\n');
  await f.write('extra.c', 'int from_c(void) { return 1; }\n');
  await f.write('extra.cc', 'int from_cc() { return 1; }\n');
  await f.write('extra.cxx', 'int from_cxx() { return 1; }\n');
  await f.write('empty.S', '\n'); await f.write('empty.s', '\n');
  await f.write('include/not-a-unit.cpp', '#error MUST_NOT_COMPILE_INCLUDE_DIRECTORY_CPP\n');
  const sentinel = await f.write('standalone.cpp', '#error USER_CPP_STANDALONE_MUST_COMPILE\n');
  const generatedRoot = path.join(f.build, 'sketch');
  await fs.outputFile(path.join(generatedRoot, 'helper.cpp'), 'int generated_helper() { return 1; }\n');
  const core = path.join(f.root, 'core'); await fs.outputFile(path.join(core, 'core.c'), 'int core_dummy(void) { return 1; }\n');
  process.env.SDK_CORE_PATH = core;
  const args = '-c "%SOURCE_FILE_PATH%" -o "%OBJECT_FILE_PATH%" %INCLUDE_PATHS%';
  const compileConfig = { compiler: { c: '/usr/bin/clang', cpp: '/usr/bin/clang++', ld: '/usr/bin/clang++', ar: '/usr/bin/ar' },
    args: { c: args, cpp: args, s: args, ld: '{object_files} -o "%OBJECT_FILE_PATH%"' } };
  const generator = new NinjaGenerator(new Logger());
  const build = async () => {
    const dependencies = await f.analyze();
    assert(dependencies.some(d => d.name === 'Support'), 'library included only through a local header must be discovered');
    const users = dependencies.find(d => d.name === USER_SKETCH_DEPENDENCY_NAME)!;
    assert(users.includes!.includes(sentinel));
    assert(!users.includes!.some(filename => filename.includes('not-a-unit')));
    (compileConfig as any).sketchInputsDigest = (await captureSketchSourceIdentity(f.entry)).sketchInputs.digest;
    const graphPath = await generator.generateNinjaFile({ dependencies, compileConfig, buildPath: f.build, jobs: 2 });
    const graph = await fs.readFile(graphPath, 'utf8');
    assert.deepEqual(graph.match(/^aily_sketch_inputs_digest = [a-f0-9]{64}$/gm), [`aily_sketch_inputs_digest = ${(compileConfig as any).sketchInputsDigest}`]);
    const result = spawnSync(path.resolve(__dirname, '../dist/ninja/ninja'), ['-f', graphPath, 'entry.elf'], { cwd: f.build, encoding: 'utf8' });
    assert.ifError(result.error);
    return { result, graph, dependencies };
  };
  const failed = await build();
  assert.notEqual(failed.result.status, 0);
  assert.match(failed.result.stdout + failed.result.stderr, /USER_CPP_STANDALONE_MUST_COMPILE/);
  await fs.writeFile(sentinel, 'int standalone_sentinel() { return 1; }\n');
  const passed = await build();
  assert.equal(passed.result.status, 0, passed.result.stdout + passed.result.stderr);
  assert.equal(spawnSync(path.join(f.build, 'entry.elf')).status, 0);
  for (const relative of ['helper.cpp.o', 'src/a/helper.cpp.o', 'src/a_b/thing.cpp.o', 'src/a/b_thing.cpp.o']) {
    assert(await fs.pathExists(path.join(f.build, 'sketch', USER_SKETCH_DEPENDENCY_NAME, relative)));
  }
  assert(await fs.pathExists(path.join(f.build, 'sketch/__generated_sketch__/helper.cpp.o')));
  assert.match(spawnSync('/usr/bin/nm', [path.join(f.build, 'entry.elf')], { encoding: 'utf8' }).stdout, /standalone_sentinel/);
  // Reuse the existing graph: its real compiler depfile must notice a header edit.
  await f.write('include/config.h', '#pragma once\n#define VALUE 8\n#include <Support.h>\n');
  const headerRebuild = spawnSync(path.resolve(__dirname, '../dist/ninja/ninja'), ['entry.elf'], { cwd: f.build, encoding: 'utf8' });
  assert.equal(headerRebuild.status, 0, headerRebuild.stdout + headerRebuild.stderr);
  assert.equal(spawnSync(path.join(f.build, 'entry.elf')).status, 1, 'real header edit must change helper result');
  await f.write('helper.cpp', '#include "include/config.h"\nint user() { return VALUE + support() - 1; }\n');
  const edited = await build(); assert.equal(edited.result.status, 0, edited.result.stdout + edited.result.stderr);
  assert.equal(spawnSync(path.join(f.build, 'entry.elf')).status, 0, 'edited C++ must replace its previous object');
  await fs.remove(path.join(f.source, 'src/a_b'));
  await fs.remove(sentinel);
  const dependencies = await f.analyze();
  const removedDigest = (await captureSketchSourceIdentity(f.entry)).sketchInputs.digest;
  assert.notEqual(removedDigest, (compileConfig as any).sketchInputsDigest);
  (compileConfig as any).sketchInputsDigest = removedDigest;
  const graphPath = await generator.generateNinjaFile({ dependencies, compileConfig, buildPath: f.build, jobs: 2 });
  const graph = await fs.readFile(graphPath, 'utf8');
  assert(graph.includes(`aily_sketch_inputs_digest = ${removedDigest}`));
  assert(!graph.includes('standalone.cpp')); assert(!graph.includes('src/a_b/thing.cpp'));
  const result = spawnSync(path.resolve(__dirname, '../dist/ninja/ninja'), ['-f', graphPath, 'entry.elf'], { cwd: f.build, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const symbols = spawnSync('/usr/bin/nm', [path.join(f.build, 'entry.elf')], { encoding: 'utf8' }).stdout;
  assert(!symbols.includes('standalone_sentinel')); assert(!symbols.includes('collision_one'));
});

test('content identity binds added, edited, removed headers/TUs and entry path independently of timestamps; portable record schema stays unchanged', async t => {
  const f = await fixture(t), first = await captureSketchSourceIdentity(f.entry);
  const filename = await f.write('helper.cpp', 'int helper() { return 1; }\n'), added = await captureSketchSourceIdentity(f.entry);
  assert(!sameSketchSourceIdentity(first, added));
  const stat = await fs.stat(filename); await fs.writeFile(filename, 'int helper() { return 2; }\n'); await fs.utimes(filename, stat.atime, stat.mtime);
  const edited = await captureSketchSourceIdentity(f.entry); assert(!sameSketchSourceIdentity(added, edited));
  await f.write('include/nested/value.h', '#define VALUE 1\n');
  const header = await captureSketchSourceIdentity(f.entry); assert(!sameSketchSourceIdentity(edited, header));
  assert(header.sketchInputs.files.some(file => file.path === 'include/nested/value.h'));
  assert(!sameSketchSourceIdentity(header, { ...header, entryPath: '/different/sketch/entry.cpp' }));
  await fs.remove(filename); assert(!sameSketchSourceIdentity(header, await captureSketchSourceIdentity(f.entry)));
  const recording = new BuildInputRecording({ sketchInputsDigest: header.sketchInputs.digest });
  for (const stage of ['sketch', 'libraries', 'core', 'linking']) recording.recordNinja(stage, Buffer.from('graph'));
  const record = recording.finish(); assert(!Object.hasOwn(record, 'sketchInputs'));
  const { digest, ...body } = record; assert.equal(digest, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
  assert.throws(() => normalizeSketchInputs({ ...header.sketchInputs, digest: 'f'.repeat(64) }), /digest mismatch/);
});

test('stale persisted preprocessing is refreshed before provider or pipeline work', async t => {
  const f = await fixture(t), compiler: any = new ArduinoCompiler(new Logger());
  const oldIdentity = await captureSketchSourceIdentity(f.entry);
  const observed: string[] = [];
  compiler.preprocess = async () => { assert.equal(process.env.SKETCH_PATH, f.entry); assert.equal(process.env.SKETCH_DIR_PATH, f.source); observed.push('refreshed'); return { success: false, preprocessTime: 1, error: 'controlled stop after refresh' }; };
  compiler.ninjaPipeline.compile = async () => { throw new Error('stale graph was used'); };
  for (const identity of [undefined, { ...oldIdentity, entryPath: '/old/root/entry.cpp' }, oldIdentity]) {
    if (identity === oldIdentity) await f.write('unreferenced.cpp', 'int added() { return 1; }\n');
    process.env.SKETCH_PATH = path.join(f.build, 'entry.cpp');
    process.env.SKETCH_DIR_PATH = f.build;
    const result = await compiler.compile({ sketchPath: f.entry, buildPath: f.build, board: 'synthetic:test:board',
      preprocessResult: { success: true, preprocessTime: 0, dependencies: [], sketchSourceIdentity: identity } });
    assert.equal(result.error, 'controlled stop after refresh');
  }
  assert.equal(observed.length, 3);
});

test('changed sketch content invalidates only sketch object outputs even when timestamps are restored', async t => {
  const f = await fixture(t), pipeline: any = new NinjaCompilationPipeline(new Logger());
  const object = path.join(f.build, 'sketch/__user_sketch__/helper.cpp.o');
  const cachedCore = path.join(f.build, 'core/core.c.o');
  await fs.outputFile(object, 'old object'); await fs.outputFile(cachedCore, 'core remains cacheable');
  pipeline.compileConfig = { sketchInputFingerprint: `${'a'.repeat(64)}:${'b'.repeat(64)}` };
  await pipeline.invalidateChangedSketchInputs(); assert(!await fs.pathExists(object)); assert(await fs.pathExists(cachedCore));
  await fs.outputFile(object, 'current object'); await pipeline.invalidateChangedSketchInputs(); assert(await fs.pathExists(object));
  pipeline.compileConfig.sketchInputFingerprint = `${'a'.repeat(64)}:${'c'.repeat(64)}`;
  await pipeline.invalidateChangedSketchInputs(); assert(!await fs.pathExists(object)); assert(await fs.pathExists(cachedCore));
});

test('source and header symlinks, linked directories, linked root and unsupported local includes fail closed', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external'); await fs.ensureDir(external);
  const outside = path.join(external, 'outside.cpp'); await fs.writeFile(outside, 'int outside();\n');
  for (const relative of ['escape.cpp', 'include/escape.h', 'src/linked-directory']) {
    const link = path.join(f.source, relative); await fs.ensureDir(path.dirname(link));
    await fs.symlink(relative.endsWith('directory') ? external : outside, link);
    await assert.rejects(collectUserSketchSources(f.entry), /linked/);
    await fs.remove(link);
  }
  const linkedRoot = path.join(f.root, 'linked-root'); await fs.symlink(f.source, linkedRoot);
  await assert.rejects(collectUserSketchSources(path.join(linkedRoot, 'entry.cpp')), /linked/);
  await f.write('fragment.inc', '#define VALUE 1\n');
  await f.write('entry.cpp', '#include "fragment.inc"\nint main() { return 0; }\n');
  await f.analyze();
  await f.write('data.custom', '#define VALUE 2\n');
  await f.write('entry.cpp', '#include "data.custom"\nint main() { return 0; }\n');
  await assert.rejects(f.analyze(), /outside the supported source\/header input boundary/);
});

test('an explicitly nested CLI build directory stays outside user inputs across two native builds', async t => {
  const f = await fixture(t), build = path.join(f.source, 'explicit-output');
  process.env.BUILD_PATH = build; await fs.ensureDir(build);
  await f.write('unit.cpp', 'int ordinary_unit() { return 1; }\n');
  await f.write('build/ordinary-header.h', '#define KEEP_THIS_USER_HEADER 1\n');
  const before = await captureSketchSourceIdentity(f.entry);
  assert(before.sketchInputs.files.some(file => file.path === 'build/ordinary-header.h'));
  const args = '-c "%SOURCE_FILE_PATH%" -o "%OBJECT_FILE_PATH%" %INCLUDE_PATHS%';
  const compileConfig = { compiler: { c: '/usr/bin/clang', cpp: '/usr/bin/clang++', ld: '/usr/bin/clang++', ar: '/usr/bin/ar' },
    args: { c: args, cpp: args, s: args, ld: '{object_files} -o "%OBJECT_FILE_PATH%"' } };
  process.env.SDK_CORE_PATH = path.join(f.root, 'core');
  await fs.outputFile(path.join(process.env.SDK_CORE_PATH, 'core.c'), 'int core_value(void) { return 0; }\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    const graph = await new NinjaGenerator(new Logger()).generateNinjaFile({ dependencies: await f.analyze(), compileConfig, buildPath: build, jobs: 2 });
    const result = spawnSync(path.resolve(__dirname, '../dist/ninja/ninja'), ['-f', graph, 'entry.elf'], { cwd: build, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(spawnSync(path.join(build, 'entry.elf')).status, 0);
    await fs.outputFile(path.join(build, 'include/generated.h'), `#define GENERATED ${attempt}\n`);
    assert(sameSketchSourceIdentity(before, await captureSketchSourceIdentity(f.entry)));
  }
  process.env.BUILD_PATH = f.source;
  await assert.rejects(captureSketchSourceIdentity(f.entry), /cannot equal/);
});

test('main entry retains its existing large-source budget independently of extra inputs', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.entry, ' '.repeat(4 * 1024 * 1024 + 1));
  const identity = await captureSketchSourceIdentity(f.entry);
  assert.equal(identity.sketchInputs.files.length, 0);
  await f.write('large.cpp', ' '.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(captureSketchSourceIdentity(f.entry), /bounded/);
});

test('phase hooks cannot attach unrelated directory CPP to the ordinary sketch dependency', async t => {
  const f = await fixture(t), pipeline: any = new NinjaCompilationPipeline(new Logger());
  await f.write('ordinary.cpp', 'int ordinary() { return 1; }\n');
  pipeline.dependencies = await f.analyze();
  const before = await pipeline.snapshotDependencySources();
  const unrelated = await f.write('include/hidden.cpp', '#error OUTSIDE_ARDUINO_TU_BOUNDARY\n');
  await pipeline.refreshHookGeneratedSources(before);
  assert(!pipeline.dependencies.some((dependency: any) => dependency.includes.includes(unrelated)));
  const added = await f.write('src/added.cpp', 'int added() { return 1; }\n');
  await assert.rejects(pipeline.refreshHookGeneratedSources(before), /changed in a build hook/);
  assert(!pipeline.dependencies.some((dependency: any) => dependency.includes.includes(added)));
});

test('one Compiler instance reselects its original entry on stale refresh and current preprocess reuse, with native output proof', async t => {
  const f = await fixture(t), compiler: any = new ArduinoCompiler(new Logger());
  const core = path.join(f.root, 'core'); await fs.outputFile(path.join(core, 'core.c'), 'int dummy_core(void) { return 0; }\n');
  process.env.SDK_CORE_PATH = core;
  const args = '-c "%SOURCE_FILE_PATH%" -o "%OBJECT_FILE_PATH%" %INCLUDE_PATHS%';
  const compileConfig = { compiler: { c: '/usr/bin/clang', cpp: '/usr/bin/clang++', ld: '/usr/bin/clang++', ar: '/usr/bin/ar' },
    args: { c: args, cpp: args, s: args, ld: '{object_files} -o "%OBJECT_FILE_PATH%"' } };
  let parses = 0;
  compiler.arduinoConfigParser.parseByFQBN = async () => { parses++; return { platform: {}, board: {}, fqbnParsed: { package: 'synthetic' } }; };
  compiler.compileConfigManager.parseCompileConfig = () => compileConfig;
  const actualPreprocess = compiler.preprocess.bind(compiler), saved: any[] = [];
  compiler.preprocess = async (options: any) => { const result = await actualPreprocess(options); assert(result.success, result.error); saved.push(result); return result; };
  // Use the real compiler request preparation/analyzer and actual native Ninja
  // graph; stop before firmware postprocessing because this is a host executable.
  compiler.ninjaPipeline.compile = async ({ dependencies, compileConfig }: any) => {
    const graph = await new NinjaGenerator(new Logger()).generateNinjaFile({ dependencies, compileConfig, buildPath: f.build, jobs: 2 });
    const result = spawnSync(path.resolve(__dirname, '../dist/ninja/ninja'), ['-f', graph, 'entry.elf'], { cwd: f.build, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return { success: false, error: 'native graph completed; no firmware postprocessing' };
  };
  const options = { sketchPath: f.entry, buildPath: f.build, board: 'synthetic:test:board' };
  const first = await compiler.preprocess(options);
  const run = async (preprocessResult: any, expectedExit: number) => {
    const result = await compiler.compile({ ...options, preprocessResult });
    assert.equal(result.error, 'native graph completed; no firmware postprocessing');
    assert.equal(process.env.SKETCH_PATH, path.join(f.build, 'entry.cpp'));
    assert.equal(spawnSync(path.join(f.build, 'entry.elf')).status, expectedExit);
  };
  await run(first, 0); assert.equal(parses, 1);
  await f.write('entry.cpp', 'int main() { return 3; }\n');
  await run(first, 3); assert.equal(parses, 2);
  await run(saved.at(-1), 3); assert.equal(parses, 2, 'current preprocess remains reusable after SKETCH_PATH was generated');
});
