import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibraryIndexCache, dependencyInputIdentity, type LibraryIndexBuildResult } from '../src/LibraryIndexCache';
import { DirectiveTapeSnapshot } from '../src/DirectiveTapeSnapshot';
import type { MacroSourceReference } from '../src/MacroSourceOrigins';
import { analyzeDirectiveTapeWithDefines, type MacroDefinition } from '../src/utils/AnalyzeFile';

const macro = (value: string): Map<string, MacroDefinition> => new Map([
  ['MODE', { name: 'MODE', isDefined: true, value }]
]);

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-index-storage-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-index-storage-'));
    await fs.remove(root);
  });
  const library = path.join(root, '库 空格'), main = path.join(library, 'main.cpp');
  const header = path.join(library, 'Config.h'), external = path.join(root, 'External.h');
  const missing = path.join(root, 'Optional.h'), cacheDir = path.join(root, 'cache');
  const secret = 'storage-fixture-private-value';
  await fs.ensureDir(library);
  await fs.writeFile(main, 'int fixture() { return 1; }\n');
  await fs.writeFile(external, '#define EXTERNAL_VALUE 1\n');
  await fs.writeFile(header, [
    `#define STORED_VALUE "${secret}"`, '#define WRAP(x) ((x) + 3)',
    '#if MODE == 1', '#include <Left.h>', '#else', '#include <Right.h>', '#endif', ''
  ].join('\n'));
  const messages: string[] = [];
  const logger = { debug(message: string) { messages.push(message); }, info() {}, warn() {}, error() {}, verbose() {} };
  const makeCache = (): any => Object.assign(Object.create(LibraryIndexCache.prototype), { logger, cacheDir });
  const cache = makeCache(); let builds = 0;
  const build = async (incoming: Map<string, MacroDefinition>, gate?: () => Promise<void>): Promise<LibraryIndexBuildResult> => {
    builds++; await gate?.();
    const snapshot = new DirectiveTapeSnapshot(), definitions = new Map(incoming);
    const origins = new Map<string, MacroSourceReference>(), includeFiles: string[] = [];
    for (const file of [external, header, main]) {
      const captured = snapshot.read(file);
      const result = analyzeDirectiveTapeWithDefines(captured.tape, definitions, {
        onMacroChange: (definition, event) => origins.set(definition.name, {
          file, identity: captured.identity, directiveIndex: event.directiveIndex,
          sourceOffset: event.location.offset, kind: event.kind
        })
      });
      includeFiles.push(...result.includes);
    }
    snapshot.verifyLoaded();
    return { sourceFiles: [main], includeFiles, macroDefinitions: definitions, macroOrigins: origins,
      headerInputs: [[main, dependencyInputIdentity(main)!], [header, dependencyInputIdentity(header)!],
        [external, dependencyInputIdentity(external)!], [missing, dependencyInputIdentity(missing) ?? null]] };
  };
  const read = (base = macro('1'), using = cache, gate?: () => Promise<void>) =>
    using.getOrCreate('StorageFixture', library, base, () => build(base, gate));
  const lookup = async (base = macro('1'), using = cache) => {
    const miss = new Error('The regular lookup requires a rebuild');
    try {
      return await using.getOrCreate('StorageFixture', library, base, async () => { throw miss; });
    } catch (error) {
      if (error === miss) return undefined;
      throw error;
    }
  };
  const filename = (sourceHash: string, base = macro('1')) => cache.getSourceIndexPath(sourceHash, cache.createMacroKey(base, '')) as string;
  return { root, library, main, header, external, missing, secret, cache, messages, makeCache, read, lookup, filename, builds: () => builds };
}

test('one context record is read independently and a valid legacy aggregate is neither read nor removed', async t => {
  const f = await fixture(t), left = macro('1'), right = macro('2');
  const first = await f.read(left), second = await f.read(right);
  assert.equal(first.sourceHash, second.sourceHash);
  const leftFile = f.filename(first.sourceHash, left), rightFile = f.filename(first.sourceHash, right);
  assert.notEqual(leftFile, rightFile); assert.ok(leftFile.includes(`${path.sep}contexts-v1${path.sep}`));
  const leftRecord = await fs.readJSON(leftFile), rightBytes = await fs.readFile(rightFile);
  assert.equal(leftRecord.storageVersion, 1); assert.equal(leftRecord.schemaVersion, 7);
  assert.equal(leftRecord.sourceHash, first.sourceHash); assert.equal(leftRecord.macroKey, f.cache.createMacroKey(left, ''));
  assert.deepEqual(leftRecord.macroIndex.includeFiles, ['Left.h']); assert.equal(leftRecord.macroIndexes, undefined);
  const serialized = JSON.stringify(leftRecord);
  for (const forbidden of [f.secret, 'parameters', 'functionLike', '"value"', 'macroDeltas']) assert.ok(!serialized.includes(forbidden), forbidden);
  const namespace = path.dirname(path.dirname(path.dirname(path.dirname(leftFile))));
  const legacy = path.join(namespace, first.sourceHash.slice(0, 2), first.sourceHash+'.json');
  await fs.outputJSON(legacy, { schemaVersion: 7, analyzerVersion: leftRecord.analyzerVersion,
    libraryName: leftRecord.libraryName, sourceHash: first.sourceHash,
    macroIndexes: { [leftRecord.macroKey]: leftRecord.macroIndex } });
  const legacyBytes = await fs.readFile(legacy), reads: string[] = [];
  const originalRead = f.cache.readJSONCache.bind(f.cache);
  f.cache.readJSONCache = async (file: string) => { reads.push(file); return originalRead(file); };
  assert.deepEqual((await f.lookup(left))!.includeFiles, ['Left.h']);
  assert.ok(!reads.includes(rightFile)); assert.ok(!reads.includes(legacy));
  assert.deepEqual(await fs.readFile(rightFile), rightBytes);
  await fs.remove(leftFile); // Only this fixture's generated record, never the legacy aggregate.
  reads.length = 0;
  assert.equal(await f.lookup(left), undefined); assert.ok(!reads.includes(legacy));
  assert.equal(f.builds(), 2);
  assert.equal((await f.read(left)).cacheHit, false); assert.equal(f.builds(), 3);
  assert.deepEqual(await fs.readFile(legacy), legacyBytes);
  assert.deepEqual((await f.lookup(right))!.includeFiles, ['Right.h']);
});

test('a corrupt or differently bound context record misses without poisoning its valid neighbor', async t => {
  const f = await fixture(t), left = macro('1'), right = macro('2');
  const first = await f.read(left); await f.read(right);
  const leftFile = f.filename(first.sourceHash, left), rightFile = f.filename(first.sourceHash, right);
  const leftBytes = await fs.readFile(leftFile), leftRecord = await fs.readJSON(leftFile);
  for (const invalid of ['{"partial":', JSON.stringify(leftRecord)]) {
    await fs.writeFile(rightFile, invalid);
    assert.equal(await f.lookup(right), undefined);
    assert.deepEqual((await f.lookup(left))!.includeFiles, ['Left.h']);
    const rebuilt = await f.read(right);
    assert.equal(rebuilt.cacheHit, false); assert.deepEqual(rebuilt.includeFiles, ['Right.h']);
    assert.equal((await f.lookup(right))!.cacheHit, true);
    assert.deepEqual(await fs.readFile(leftFile), leftBytes);
  }
  assert.equal(f.builds(), 4);
});

test('an atomic same-size record replacement with preserved mtime cannot return the previous payload', async t => {
  const f = await fixture(t), first = await f.read(), file = f.filename(first.sourceHash);
  f.cache.touchCacheAccess = async () => {}; // Isolate replacement identity from access-time maintenance.
  const fixedTime = new Date('2026-01-02T03:04:05.000Z');
  await fs.utimes(file, fixedTime, fixedTime);
  assert.equal((await f.lookup())!.cacheHit, true);
  const before = await fs.stat(file), bytes = await fs.readFile(file), record = JSON.parse(bytes.toString('utf8'));
  const wrongKey = (record.macroKey[0] === '0' ? '1' : '0')+record.macroKey.slice(1);
  const replacement = bytes.toString('utf8').replace(/("macroKey"\s*:\s*")[a-f0-9]+("\s*[,}])/, (_match, prefix, suffix) => prefix+wrongKey+suffix);
  assert.notEqual(replacement, bytes.toString('utf8')); assert.equal(Buffer.byteLength(replacement), bytes.length);
  const temporary = file+'.owned-replacement';
  await fs.writeFile(temporary, replacement); await fs.utimes(temporary, fixedTime, fixedTime); await fs.rename(temporary, file);
  const after = await fs.stat(file);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await f.lookup(), undefined); assert.equal(f.builds(), 1);
  assert.equal((await f.read()).cacheHit, false); assert.equal((await f.lookup())!.cacheHit, true);
  assert.equal(f.builds(), 2);
});

test('context storage hits retain external, exact-missing and post-await own-source validation', async t => {
  const f = await fixture(t); await f.read();
  assert.equal((await f.lookup())!.macroDefinitions!.get('EXTERNAL_VALUE')!.value, '1');
  await fs.writeFile(f.external, '#define EXTERNAL_VALUE 2\n');
  assert.equal(await f.lookup(), undefined); assert.equal(f.builds(), 1);
  const rebuilt = await f.read(); assert.equal(rebuilt.cacheHit, false);
  assert.equal(rebuilt.macroDefinitions!.get('EXTERNAL_VALUE')!.value, '2');
  await fs.writeFile(f.missing, '#define APPEARED 1\n');
  assert.equal(await f.lookup(), undefined); assert.equal(f.builds(), 2);
  await fs.remove(f.missing);
  assert.equal((await f.lookup())!.cacheHit, true);
  const touch = f.cache.touchCacheAccess.bind(f.cache);
  f.cache.touchCacheAccess = async (files: string[]) => { await touch(files); await fs.writeFile(f.main, 'int fixture() { return 2; }\n'); };
  await assert.rejects(f.lookup(), (error: any) => error.code === 'PREPROCESS_INPUTS_CHANGED');
  assert.equal(f.builds(), 2);
});

test('concurrent contexts and same-context writers publish complete independent records at one clock tick', async t => {
  const f = await fixture(t), left = macro('1'), right = macro('2');
  const gate = () => { let arrived = 0, release!: () => void; const both = new Promise<void>(resolve => { release = resolve; }); return async () => { if (++arrived === 2) release(); await both; }; };
  const sharedGate = gate();
  const originalNow = Date.now; Date.now = () => 1790000000000;
  let results: any[];
  try { results = await Promise.all([f.read(left, f.cache, sharedGate), f.read(right, f.makeCache(), sharedGate)]); }
  finally { Date.now = originalNow; }
  assert.equal(results![0].sourceHash, results![1].sourceHash);
  assert.deepEqual((await f.lookup(left))!.includeFiles, ['Left.h']); assert.deepEqual((await f.lookup(right))!.includeFiles, ['Right.h']);
  const sameGate = gate(); Date.now = () => 1790000000000;
  try { await Promise.all([f.read(macro('3'), f.makeCache(), sameGate), f.read(macro('3'), f.makeCache(), sameGate)]); }
  finally { Date.now = originalNow; }
  assert.equal((await f.lookup(macro('3')))!.cacheHit, true);
  assert.deepEqual((await f.lookup(left))!.includeFiles, ['Left.h']);
  assert.deepEqual((await f.lookup(right))!.includeFiles, ['Right.h']);
  const failures = f.messages.filter(message => message.includes('failed to write cache'));
  assert.deepEqual(failures, []);
});
