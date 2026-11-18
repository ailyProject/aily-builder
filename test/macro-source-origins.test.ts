import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibraryIndexCache, dependencyInputIdentity, type LibraryIndexBuildResult } from '../src/LibraryIndexCache';
import { DirectiveTapeSnapshot } from '../src/DirectiveTapeSnapshot';
import { captureMacroOrigins, restoreMacroOrigins, type MacroSourceReference } from '../src/MacroSourceOrigins';
import { analyzeDirectiveTapeWithDefines, type MacroDefinition } from '../src/utils/AnalyzeFile';
import { Logger } from '../src/utils/Logger';

class QuietLogger extends Logger {
  messages: string[] = [];
  debug(message: string): void { this.messages.push(message); }
  info(): void {} verbose(): void {} warn(): void {} error(): void {}
}

async function fixture(t: TestContext, source: string, external = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-macro-origins-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-macro-origins-'));
    await fs.remove(root);
  });
  const library = path.join(root, '库 空格'), main = path.join(library, 'main.cpp');
  const header = path.join(external ? root : library, 'Config.h');
  await fs.ensureDir(library);
  await fs.writeFile(main, 'int value() { return 1; }\n');
  await fs.writeFile(header, source);
  const logger = new QuietLogger();
  const cache = Object.assign(Object.create(LibraryIndexCache.prototype), { logger, cacheDir: path.join(root, 'cache') });
  let builds = 0;
  const base = new Map<string, MacroDefinition>();
  const builder = async (): Promise<LibraryIndexBuildResult> => {
    builds++;
    const snapshot = new DirectiveTapeSnapshot(), definitions = new Map(base), origins = new Map<string, MacroSourceReference>();
    for (const file of [header, main]) {
      const loaded = snapshot.read(file);
      analyzeDirectiveTapeWithDefines(loaded.tape, definitions, { onMacroChange: (definition, event) => {
        origins.set(definition.name, { file, identity: loaded.identity, directiveIndex: event.directiveIndex,
          sourceOffset: event.location.offset, kind: event.kind });
      } });
    }
    snapshot.verifyLoaded();
    return { sourceFiles: [main], includeFiles: [], macroDefinitions: definitions, macroOrigins: origins,
      headerInputs: [header, main].map(file => [file, dependencyInputIdentity(file)!]) };
  };
  return { root, library, main, header, base, cache, logger, builder, builds: () => builds,
    read: () => cache.getOrCreate('Generic', library, base, builder) };
}

test('changed protocol, secret, alias, function and undef macros persist only source references and restore exact values', async t => {
  const secret = 'private-value-never-persist-71f4';
  const f = await fixture(t, [
    '#define MAX_SSID_LEN 32', `#define WIFI_PASSWORD "${secret}"`, `#define ORDINARY_ALIAS "${secret}"`,
    '#define CONCAT(first, ...) first ## __VA_ARGS__', '#define REMOVED 1', '#undef REMOVED', ''
  ].join('\n'));
  const first = await f.read(), second = await f.read();
  assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true); assert.equal(f.builds(), 1);
  assert.deepEqual(second.macroDefinitions, first.macroDefinitions);
  assert.equal(second.macroDefinitions!.get('MAX_SSID_LEN')!.value, '32');
  assert.equal(second.macroDefinitions!.get('REMOVED')!.isDefined, false);
  assert.equal(second.macroDefinitions!.get('CONCAT')!.functionLike, true);
  assert.equal(second.macroDefinitions!.get('CONCAT')!.variadic, true);
  const disk = JSON.stringify(await f.cache.readJSONCache(f.cache.getSourceIndexPath(first.sourceHash, f.cache.createMacroKey(f.base, ''))));
  assert.ok(disk.includes('macroOrigins')); assert.ok(!disk.includes('macroDeltas'));
  for (const forbidden of [secret, '__VA_ARGS__', 'parameters', 'functionLike', '"value"']) assert.ok(!disk.includes(forbidden), forbidden);
  assert.ok(!f.logger.messages.join('\n').includes(secret));
});

test('a selected definition keeps its own source reference across multiple translation-unit candidates', async t => {
  const f = await fixture(t, '#define VALUE 1\n'), other = path.join(f.library, 'other.h');
  await fs.writeFile(other, '#define VALUE 2\n');
  const snapshots = new DirectiveTapeSnapshot(), variants: Array<{ macro: MacroDefinition; ref: MacroSourceReference }> = [];
  for (const file of [f.header, other]) {
    const loaded = snapshots.read(file), defs = new Map<string, MacroDefinition>();
    analyzeDirectiveTapeWithDefines(loaded.tape, defs, { onMacroChange: (macro, event) => variants.push({ macro,
      ref: { file, identity: loaded.identity, directiveIndex: event.directiveIndex, sourceOffset: event.location.offset, kind: event.kind } }) });
  }
  const selected = variants[0], final = new Map([['VALUE', selected.macro]]);
  const origins = captureMacroOrigins(new Map(), final, new Map([['VALUE', selected.ref]]))!;
  const restored = restoreMacroOrigins(origins, new Map(), new Set([f.header, other]))!;
  assert.equal(restored.macros.get('VALUE')!.value, '1');
  assert.equal(restored.origins.get('VALUE')!.file, f.header);
});

test('obsolete external source references cause a safe rebuild, not perpetual retry of the same index', async t => {
  const f = await fixture(t, '#define TOKEN "old"\n', true);
  await f.read(); assert.equal((await f.read()).cacheHit, true);
  await fs.writeFile(f.header, '#define TOKEN "new-value"\n');
  const changed = await f.read();
  assert.equal(changed.cacheHit, false); assert.equal(changed.macroDefinitions!.get('TOKEN')!.value, '"new-value"');
  assert.equal((await f.read()).cacheHit, true); assert.equal(f.builds(), 2);
});

test('cache access cannot return a macro source changed while the cache was touched', async t => {
  const f = await fixture(t, '#define VALUE 1\n', true);
  await f.read();
  const touch = f.cache.touchCacheAccess.bind(f.cache); let changed = false;
  f.cache.touchCacheAccess = async (paths: string[]) => {
    await touch(paths);
    if (!changed) { changed = true; await fs.writeFile(f.header, '#define VALUE 2\n'); }
  };
  await assert.rejects(f.read(), (error: any) => error.code === 'PREPROCESS_INPUTS_CHANGED');
  const fresh = await f.read();
  assert.equal(fresh.macroDefinitions!.get('VALUE')!.value, '2');
  assert.equal((await f.read()).cacheHit, true);
});

test('new library sources appearing during cache write reject the old source inventory', async t => {
  const f = await fixture(t, '#define VALUE 1\n');
  const write = f.cache.writeCache.bind(f.cache); let changed = false;
  f.cache.writeCache = async (file: string, value: unknown) => {
    await write(file, value);
    if (!changed && file.includes(`${path.sep}sources${path.sep}`)) {
      changed = true; await fs.writeFile(path.join(f.library, 'new.cpp'), 'int another() { return 2; }\n');
    }
  };
  await assert.rejects(f.read(), (error: any) => error.code === 'PREPROCESS_INPUTS_CHANGED');
  assert.equal((await f.read()).cacheHit, false);
  assert.equal((await f.read()).cacheHit, true);
});

test('manual builders without complete origins remain usable but never persist incomplete deltas', async t => {
  const f = await fixture(t, '');
  const build = async () => ({ sourceFiles: [f.main], includeFiles: [],
    macroDefinitions: new Map([['SECRET_ALIAS', { name: 'SECRET_ALIAS', isDefined: true, value: 'private-unproven' }]]) });
  for (let n = 0; n < 2; n++) {
    const result = await f.cache.getOrCreate('Generic', f.library, f.base, build);
    assert.equal(result.cacheHit, false);
    const disk = JSON.stringify(await f.cache.readJSONCache(f.cache.getSourceIndexPath(result.sourceHash, f.cache.createMacroKey(f.base, ''))));
    assert.ok(!disk.includes('private-unproven'));
  }
});

test('source-hit rebinds metadata-only own changes while source inventory proof rejects content changed with preserved mtime', async t => {
  const f = await fixture(t, '#define VALUE 1\n');
  const first = await f.read(), old = await fs.stat(f.header);
  const later = new Date(old.mtimeMs + 3000); await fs.utimes(f.header, later, later);
  const touched = await f.read();
  assert.equal(touched.cacheHit, true); assert.equal(touched.sourceHash, first.sourceHash);
  assert.equal(touched.headerInputs!.find(([file]: [string, string]) => file === f.header)![1], dependencyInputIdentity(f.header));
  await fs.writeFile(f.header, '#define VALUE 2\n'); await fs.utimes(f.header, later, later);
  const changed = await f.read();
  assert.equal(changed.cacheHit, false); assert.notEqual(changed.sourceHash, first.sourceHash);
  assert.equal(changed.macroDefinitions!.get('VALUE')!.value, '2');
});

test('different library roots cannot borrow old own-file header proofs on a shared source hash', async t => {
  const f = await fixture(t, '#define VALUE 1\n');
  const first = await f.read(), other = path.join(f.root, 'other-library');
  await fs.copy(f.library, other);
  let builds = 0;
  const result = await f.cache.getOrCreate('Generic', other, f.base, async () => {
    builds++; return { sourceFiles: [path.join(other, 'main.cpp')], includeFiles: [] };
  });
  assert.equal(result.sourceHash, first.sourceHash); assert.equal(result.cacheHit, false); assert.equal(builds, 1);
});

test('an own-source generation changed before analysis cannot publish its structure under the previous source hash', async t => {
  const original = '#define VALUE 1\n', replacement = '#define VALUE 2\n';
  const f = await fixture(t, original);
  let oldHash = '';
  await assert.rejects(f.cache.getOrCreate('Generic', f.library, f.base, async (sourceHash: string) => {
    oldHash = sourceHash;
    await fs.writeFile(f.header, replacement);
    const built = await f.builder();
    return { ...built, includeFiles: ['only-generation-B.h'] };
  }), (error: any) => error.code === 'PREPROCESS_INPUTS_CHANGED');
  assert.equal(await fs.pathExists(f.cache.getSourceIndexPath(oldHash, f.cache.createMacroKey(f.base, ''))), false);
  await fs.writeFile(f.header, original);
  const fresh = await f.read();
  assert.equal(fresh.sourceHash, oldHash); assert.equal(fresh.cacheHit, false);
  assert.deepEqual(fresh.includeFiles, []); assert.equal(fresh.macroDefinitions!.get('VALUE')!.value, '1');
  const cached = await f.read(); assert.equal(cached.cacheHit, true); assert.deepEqual(cached.includeFiles, []);
});
