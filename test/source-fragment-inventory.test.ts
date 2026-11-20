import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { LibraryIndexCache } from '../src/LibraryIndexCache';
import { SourceFragmentInventory } from '../src/SourceFragmentInventory';
import { Logger } from '../src/utils/Logger';
import { toHostPathKey } from '../src/utils/HostPlatform';

class QuietLogger extends Logger {
  readonly messages: string[] = [];
  debug(message: string): void { this.messages.push(message); }
  info(): void {} verbose(): void {} warn(): void {} error(): void {}
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-fragment-inventory-')));
  const library = path.join(root, 'library', 'src'), external = path.join(root, 'external');
  await fs.mkdir(library, { recursive: true }); await fs.mkdir(external);
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-fragment-inventory-'));
    // New owned link only: unlink the leaf, never recursively enter its target.
    const alias = path.join(library, 'alias');
    const aliasStat = await fs.lstat(alias).catch(() => undefined);
    if (aliasStat?.isSymbolicLink()) await fs.unlink(alias);
    await fs.rm(root, { recursive: true, force: true });
  });
  const logger = new QuietLogger();
  const dependency = { name: 'FragmentInventoryFixture', type: 'library', path: library, includes: [] };
  const cache: any = Object.assign(Object.create(LibraryIndexCache.prototype), { logger, cacheDir: path.join(root, 'cache') });
  const write = async (relative: string, contents: string, outside = false) => {
    const file = path.join(outside ? external : library, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents); return file;
  };
  const make = (search?: any) => {
    const calls: Array<{ from: string; include: string; next: boolean }> = [];
    const a: any = Object.assign(Object.create(DependencyAnalyzer.prototype), {
      logger, libraryIndexCache: cache, libraryMap: new Map(), platformHeaderRoots: [external],
      platformContextKey: 'fragment-inventory-fixture', compilerSearch: search === null ? {} : { c: search || { sourceDirectory: true, quote: [], bracket: [external, library], system: [] }, cpp: search || { sourceDirectory: true, quote: [], bracket: [external, library], system: [] } },
      compilerDependencyDirectories: [], selectedLibraryPaths: [], projectAndLibraryRoots: [library],
      headerExistence: new Map(), headerLookups: new WeakMap(),
    });
    const resolver = a.libraryHeaderResolver;
    a.libraryHeaderResolver = function (...args: any[]) {
      const resolve = resolver.apply(this, args);
      return (...parameters: any[]) => { calls.push({ from: args[0].file, include: parameters[0], next: !!parameters[2] }); return resolve(...parameters); };
    };
    return { a, calls };
  };
  const signature = (result: any) => ({ sources: result.sourceFiles, includes: result.includeFiles,
    macros: [...result.macroDefinitions].map(([name, value]: any) => [name, value]).sort(([left], [right]) => left.localeCompare(right)) });
  const run = async (unfiltered: boolean, search?: any) => {
    const { a, calls } = make(search), original = SourceFragmentInventory.prototype.mayContribute;
    if (unfiltered) SourceFragmentInventory.prototype.mayContribute = () => true;
    try {
      const result = await a.buildLibraryIndex(dependency, new Map());
      return { result, calls, signature: signature(result) };
    } finally { SourceFragmentInventory.prototype.mayContribute = original; }
  };
  return { root, library, external, logger, dependency, cache, make, write, run, signature };
}

test('inactive foreign and missing literal fragments skip probes only when no candidate can affect the source inventory', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#if 0\n#include <foreign.cpp>\n#include <missing.c>\n#endif\nint entry() { return 1; }\n');
  await f.write('foreign.cpp', '#define FOREIGN_ONLY 9\nint foreign() { return 9; }\n', true);
  const before = await f.run(true), after = await f.run(false);
  assert.deepEqual(after.signature, before.signature); assert.deepEqual(after.result.sourceFiles, [main]);
  assert.equal(before.calls.filter(call => ['foreign.cpp', 'missing.c'].includes(call.include)).length, 2);
  assert.equal(after.calls.filter(call => ['foreign.cpp', 'missing.c'].includes(call.include)).length, 0);
  assert.ok(before.result.headerInputs.length > after.result.headerInputs.length);
});

test('a possible own fragment keeps full ordered resolution when an earlier external file shadows it', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#if 0\n#include <fragment.cpp>\n#endif\nint entry() { return 1; }\n');
  const own = await f.write('fragment.cpp', 'int own() { return 2; }\n');
  await f.write('fragment.cpp', 'int external() { return 3; }\n', true);
  const before = await f.run(true), after = await f.run(false);
  assert.deepEqual(after.signature, before.signature);
  assert.deepEqual(after.result.sourceFiles, [main, own].sort());
  assert.ok(after.calls.some(call => call.include === 'fragment.cpp'));
});

test('include_next retains the complete order and origin even when the inventory has a same-named source before it', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#if 0\n#include_next "fragment.cpp"\n#endif\nint entry() { return 1; }\n');
  const own = await f.write('fragment.cpp', 'int own() { return 2; }\n');
  const nested = await f.write('nested/fragment.cpp', 'int nested() { return 4; }\n');
  await f.write('fragment.cpp', 'int external() { return 3; }\n', true);
  const search = { sourceDirectory: true, quote: [], bracket: [f.external, path.dirname(nested)], system: [] };
  const before = await f.run(true, search), after = await f.run(false, search);
  assert.deepEqual(after.signature, before.signature);
  assert.deepEqual(after.result.sourceFiles, [main, own, nested].sort());
  assert.ok(after.calls.some(call => call.include === 'fragment.cpp' && call.next));
});

test('an own inactive literal still receives the historical duplicate-definition exclusion', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#if 0\n#include "fragment.cpp"\n#endif\nint entry() { return 1; }\n');
  await f.write('fragment.cpp', 'int fragment() { return 2; }\n');
  const before = await f.run(true), after = await f.run(false);
  assert.deepEqual(after.signature, before.signature); assert.deepEqual(after.result.sourceFiles, [main]);
  assert.ok(after.calls.some(call => call.include === 'fragment.cpp'));
});

test('active external literal execution and subsequent macro-controlled dependencies remain intact', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#include <external.cpp>\n#if ACTIVE_EXTERNAL\n#include <Leaf.h>\n#endif\nint entry() { return 1; }\n');
  await f.write('external.cpp', '#define ACTIVE_EXTERNAL 1\n', true);
  const before = await f.run(true), after = await f.run(false);
  assert.deepEqual(after.signature, before.signature); assert.deepEqual(after.result.sourceFiles, [main]);
  assert.equal(after.result.macroDefinitions.get('ACTIVE_EXTERNAL').value, '1');
  assert.deepEqual(after.result.includeFiles, ['Leaf.h']);
  assert.ok(after.calls.some(call => call.include === 'external.cpp'));
});

test('macro-expanded includes and active nested fragments retain execution and source exclusion', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#define BODY "parts/first.inc"\n#include BODY\nint entry() { return 1; }\n');
  await f.write('parts/first.inc', '#include "nested/second.inc"\n');
  await f.write('parts/nested/second.inc', '#include "../fragment.cpp"\n');
  await f.write('parts/fragment.cpp', '#define NESTED_FRAGMENT 7\nint nested() { return 7; }\n');
  const before = await f.run(true), after = await f.run(false);
  assert.deepEqual(after.signature, before.signature); assert.deepEqual(after.result.sourceFiles, [main]);
  assert.equal(after.result.macroDefinitions.get('NESTED_FRAGMENT').value, '7');
});

test('relative nested paths and host mixed slash forms use the same source keys as the final membership filter', async t => {
  const f = await fixture(t);
  const include = process.platform === 'win32' ? '../parts\\fragment.cpp' : '../parts/fragment.cpp';
  const main = await f.write('nested/main.cpp', `#if 0\n#include "${include}"\n#endif\nint entry() { return 1; }\n`);
  await f.write('parts/fragment.cpp', 'int fragment() { return 2; }\n');
  const before = await f.run(true), after = await f.run(false);
  assert.deepEqual(after.signature, before.signature); assert.deepEqual(after.result.sourceFiles, [main]);
  assert.ok(after.calls.some(call => call.include === include));
});

test('a directory link alias keeps the original logical-source selection and active macro behavior', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#include "alias/fragment.cpp"\nint entry() { return ALIAS_FRAGMENT; }\n');
  await f.write('fragment.cpp', '#define ALIAS_FRAGMENT 5\nint alias_body() { return 5; }\n', true);
  await fs.symlink(f.external, path.join(f.library, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await f.run(true), after = await f.run(false);
  assert.deepEqual(after.signature, before.signature); assert.deepEqual(after.result.sourceFiles, [main]);
  assert.equal(after.result.macroDefinitions.get('ALIAS_FRAGMENT').value, '5');
});

test('unknown search contexts retain the full prepass and uncertain path conversion never authorizes skipping', async t => {
  const f = await fixture(t);
  await f.write('main.cpp', '#if 0\n#include <unknown.cpp>\n#endif\nint entry() { return 1; }\n');
  const before = await f.run(true, null), after = await f.run(false, null);
  assert.deepEqual(after.signature, before.signature);
  assert.deepEqual(after.calls, before.calls); assert.equal(after.calls.filter(call => call.include === 'unknown.cpp').length, 1);
  const inventory = new SourceFragmentInventory([], () => { throw new Error('unknown path provider'); });
  assert.equal(inventory.mayContribute('unknown.cpp'), true);
  assert.equal(inventory.mayContribute('unknown.cpp', [f.library]), true);
  assert.equal(inventory.mayContribute('bad\0.cpp', [f.library]), true);
});

test('unavailable directory metadata falls back to the original valid cached resolver decision', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#if 0\n#include <foreign.cpp>\n#endif\nint entry() { return 1; }\n');
  const external = await f.write('foreign.cpp', 'int foreign() { return 2; }\n', true);
  const search = { sourceDirectory: true, quote: [], bracket: [f.external, f.library], system: [] };
  const { a, calls } = f.make(search);
  assert.equal(a.resolveCompilerHeader({ file: main }, 'foreign.cpp', 'angle', false, search, f.library).file, external);
  Object.defineProperty(search, 'system', { get() { throw new Error('unknown search metadata'); } });
  const result = await a.buildLibraryIndex(f.dependency, new Map());
  assert.deepEqual(result.sourceFiles, [main]);
  assert.ok(calls.some(call => call.include === 'foreign.cpp'));
});

test('adding an own literal source invalidates the index inventory even though its old noncontributing lookup was skipped', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#if 0\n#include "later.cpp"\n#endif\nint entry() { return 1; }\n');
  const read = () => {
    const { a } = f.make();
    return a.applyLibraryIndex(f.dependency, new Map());
  };
  const first = await read(), cached = await read();
  assert.equal(first.cacheHit, false); assert.equal(cached.cacheHit, true);
  assert.equal(first.headerInputs.some(([file]: [string, string]) => file.endsWith('later.cpp')), false);
  await f.write('later.cpp', 'int later() { return 2; }\n');
  const changed = await read();
  assert.equal(changed.cacheHit, false); assert.notEqual(changed.sourceHash, first.sourceHash);
  assert.deepEqual(changed.sourceFiles, [main]);
  assert.ok(changed.headerInputs.some(([file, identity]: [string, string]) => toHostPathKey(file) === toHostPathKey(path.join(f.library, 'later.cpp')) && identity));
});

test('a source inventory addition during analysis still triggers the ordinary generation retry', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#if 0\n#include <foreign.cpp>\n#endif\nint entry() { return 1; }\n');
  const { a } = f.make(), scan = a.scanDirectoryRecursive;
  let changed = false;
  a.scanDirectoryRecursive = async function (...args: any[]) {
    const files = await scan.apply(this, args);
    if (!changed && args[0] === f.library) { changed = true; await f.write('standalone.cpp', 'int standalone() { return 4; }\n'); }
    return files;
  };
  const result = await a.applyLibraryIndex(f.dependency, new Map());
  assert.deepEqual(result.sourceFiles, [main, path.join(f.library, 'standalone.cpp')].sort());
  assert.equal(f.logger.messages.filter(message => message.includes('retry FragmentInventoryFixture')).length, 1);
});
