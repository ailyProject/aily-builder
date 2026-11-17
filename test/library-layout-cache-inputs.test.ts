import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { TestContext } from 'node:test';
import { LibraryIndexCache, type LibraryHeaderInputs } from '../src/LibraryIndexCache';
import { readFileObservation } from '../src/FileObservation';
import { Logger } from '../src/utils/Logger';
import { isPreprocessInputChanged } from '../src/DirectiveTapeSnapshot';
class QuietLogger extends Logger { debug(): void {} info(): void {} verbose(): void {} warn(): void {} error(): void {} }
async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'aily-layout-proof-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('aily-layout-proof-')); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true }); });
  const library = path.join(root, 'Package', 'src'), metadata = path.join(root, 'Package', 'library.properties');
  await fs.mkdir(library, { recursive: true }); const source = path.join(library, 'main.cpp'); await fs.writeFile(source, 'void test_unit() {}\n');
  const cache: any = Object.assign(Object.create(LibraryIndexCache.prototype), { logger: new QuietLogger(), cacheDir: path.join(root, 'cache') });
  let builds = 0;
  const build = async () => { builds++; return { sourceFiles: [source], includeFiles: [], macroDefinitions: new Map(), headerInputs: [[source, readFileObservation(source).identity!]] }; };
  const read = (requiredInputs?: LibraryHeaderInputs, builder = build) => cache.getOrCreate('Package', library, new Map(), builder, 'layout-contract', { requiredInputs });
  return { root, library, metadata, source, cache, build, read, builds: () => builds,
    facts: (): LibraryHeaderInputs => [[metadata, readFileObservation(metadata).identity ?? null]],
  };
}
test('a cache hit cannot fabricate missing layout metadata proof', async t => {
  const f = await fixture(t); await fs.writeFile(f.metadata, 'name=Package\n');
  assert.equal((await f.read()).cacheHit, false);
  const required = f.facts(), rebuilt = await f.read(required);
  assert.equal(rebuilt.cacheHit, false); assert.equal(f.builds(), 2);
  assert.ok(rebuilt.headerInputs.some(([p, id]: [string, string]) => p === f.metadata && id === required[0][1]));
  assert.equal((await f.read(required)).cacheHit, true); assert.equal(f.builds(), 2);
});
test('speculative cache reads decline a record without mandatory metadata facts', async t => {
  const f = await fixture(t); await fs.writeFile(f.metadata, 'name=Package\n'); await f.read();
  assert.equal(await f.cache.tryGetCached('Package', f.library, new Map(), 'layout-contract', { requiredInputs: f.facts() }), undefined);
  assert.equal(f.builds(), 1);
});
for (const existing of [true, false]) test(`mandatory ${existing ? 'present' : 'missing'} metadata changes during publication retain final input rejection`, async t => {
  const f = await fixture(t); if (existing) await fs.writeFile(f.metadata, 'name=Package\n');
  const facts = f.facts(), original = f.cache.writeCache.bind(f.cache); let changed = false;
  f.cache.writeCache = async (...args: any[]) => { await original(...args); if (!changed) { changed = true; await fs.writeFile(f.metadata, 'name=Other\nversion=2.0.0\n'); } };
  await assert.rejects(f.read(facts), isPreprocessInputChanged); assert.equal(changed, true);
});
test('contradictory metadata and parsed-file facts are rejected instead of overwritten', async t => {
  const f = await fixture(t); await fs.writeFile(f.metadata, 'name=Package\n'); const facts = f.facts();
  await assert.rejects(f.read(facts, async () => ({ ...(await f.build()), headerInputs: [[f.metadata, 'old-conflicting-identity']] })),
    isPreprocessInputChanged);
});
