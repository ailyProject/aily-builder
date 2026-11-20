import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { glob } from 'glob';
import test, { type TestContext } from 'node:test';
import { DependencyAnalyzer, type Dependency } from '../src/DependencyAnalyzer';
import { DEPENDENCY_ANALYZER_VERSION, LIBRARY_HEADER_INPUTS_SCHEME, LibraryIndexCache, dependencyInputIdentity, headerInputsCurrent, type LibraryHeaderInputs } from '../src/LibraryIndexCache';
import { Logger } from '../src/utils/Logger';

class QuietLogger extends Logger {
  readonly messages: string[] = [];
  debug(message: string): void { this.messages.push(message); }
  info(): void {}
  verbose(): void {}
  warn(): void {}
  error(): void {}
}

async function fixture(t: TestContext, optional = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-header-inputs-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-header-inputs-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const library = path.join(root, 'library', 'src');
  const primary = path.join(root, 'primary'), fallback = path.join(root, 'fallback');
  for (const directory of [library, primary, fallback]) await fs.mkdir(directory, { recursive: true });
  const source = path.join(library, 'common.cpp');
  await fs.writeFile(source, '#include "Feature.h"\nint value() { return 1; }\n');
  await fs.writeFile(path.join(library, 'Feature.h'), optional
    ? '#pragma once\n#if __has_include(<optional.h>)\n#include <optional.h>\n#endif\n'
    : '#pragma once\n#include <Shared.h>\n');
  if (!optional) await fs.writeFile(path.join(fallback, 'Shared.h'), '#define SELECTED 1\n');
  const logger = new QuietLogger();
  const cache = Object.assign(Object.create(LibraryIndexCache.prototype), { logger, cacheDir: path.join(root, 'cache') });
  const search = { sourceDirectory: true, quote: [], bracket: [primary, fallback], system: [] };
  const read = async () => {
    const analyzer = Object.assign(Object.create(DependencyAnalyzer.prototype), {
      logger, libraryIndexCache: cache, libraryMap: new Map(), platformHeaderRoots: [],
      platformContextKey: 'header-inputs-fixture', compilerSearch: { c: search, cpp: search },
      compilerDependencyDirectories: [], selectedLibraryPaths: [], projectAndLibraryRoots: [],
      headerExistence: new Map(), headerLookups: new WeakMap(),
    });
    const dependency: Dependency = { name: 'Feature', path: library, type: 'library', includes: [] };
    const index = await analyzer.applyLibraryIndex(dependency, new Map(), ['Feature.h']);
    assert.deepEqual(dependency.headerInputs, index.headerInputs);
    assert.ok(Array.isArray(dependency.headerInputs));
    return { dependency, index, inputs: dependency.headerInputs as LibraryHeaderInputs };
  };
  return { root, library, primary, fallback, source, logger, cache, read };
}

test('library lookup summaries reach Dependency on fresh, path-cache and source-cache index returns', async t => {
  const f = await fixture(t);
  const fresh = await f.read();
  assert.equal(fresh.index.cacheHit, false);
  assert.ok(fresh.inputs.some(([file, identity]) => file === path.join(f.primary, 'Shared.h') && identity === null));
  assert.ok(fresh.inputs.some(([file]) => file === path.join(f.fallback, 'Shared.h')));
  const cached = await f.read();
  assert.equal(cached.index.cacheHit, true);
  assert.deepEqual(cached.inputs, fresh.inputs);
  const changedTime = new Date(Date.now() + 2000);
  await fs.utimes(f.source, changedTime, changedTime); // Same source bytes, different path fingerprint.
  f.logger.messages.length = 0;
  const sourceCached = await f.read();
  assert.equal(sourceCached.index.cacheHit, true);
  assert.ok(f.logger.messages.some(message => message.includes('[LIB_INDEX] source hit')));
  assert.deepEqual(sourceCached.inputs, fresh.inputs.map(([file, identity]) =>
    [file, file === f.source ? dependencyInputIdentity(file) : identity]));
  assert.deepEqual(sourceCached.dependency.includes, fresh.dependency.includes);
});

for (const optional of [false, true]) {
  test(`existing lookup summary invalidates ${optional ? '__has_include missing-to-present' : 'an added earlier shadow header'} without another scanner`, async t => {
    const f = await fixture(t, optional);
    const fresh = await f.read(), cached = await f.read();
    assert.equal(cached.index.cacheHit, true);
    assert.deepEqual(cached.inputs, fresh.inputs);
    assert.equal(headerInputsCurrent(fresh.inputs), true);
    const name = optional ? 'optional.h' : 'Shared.h';
    await fs.writeFile(path.join(f.primary, name), '#define SELECTED 2\n');
    assert.equal(headerInputsCurrent(fresh.inputs), false);
    const changed = await f.read();
    assert.equal(changed.index.cacheHit, false);
    assert.notDeepEqual(changed.inputs, fresh.inputs);
    assert.ok(changed.inputs.some(([file, identity]) => file === path.join(f.primary, name)
      && identity === dependencyInputIdentity(file)));
    assert.equal(headerInputsCurrent(changed.inputs), true);
    const again = await f.read();
    assert.equal(again.index.cacheHit, true);
    assert.deepEqual(again.inputs, changed.inputs);
    assert.deepEqual(changed.dependency.includes, fresh.dependency.includes);
  });
}

test('v6 lookup summaries retain exact checked missing candidates for shadow and has-include transitions', async t => {
  for (const optional of [false, true]) {
    const f = await fixture(t, optional), name = optional ? 'optional.h' : 'Shared.h';
    const missing = path.join(f.primary, name);
    const fresh = await f.read(), cached = await f.read();
    assert.equal(fresh.dependency.headerInputsScheme, LIBRARY_HEADER_INPUTS_SCHEME);
    assert.deepEqual(cached.inputs, fresh.inputs);
    assert.equal(cached.index.cacheHit, true);
    assert.ok(fresh.inputs.some(([file, identity]) => file === missing && identity === null));
    assert.equal(fresh.inputs.some(([file]) => file === f.primary), false, 'A parent directory is not the checked candidate');
    await fs.writeFile(missing, '#define SELECTED 2\n');
    assert.equal(headerInputsCurrent(fresh.inputs), false);
    const changed = await f.read();
    assert.equal(changed.index.cacheHit, false);
    assert.ok(changed.inputs.some(([file, identity]) => file === missing && identity === dependencyInputIdentity(missing)));
    assert.equal(changed.dependency.headerInputsScheme, LIBRARY_HEADER_INPUTS_SCHEME);
  }
});

test('v6 exact lookup summaries ignore unrelated derived archives and objects in a searched directory', async t => {
  const f = await fixture(t), fresh = await f.read();
  await fs.writeFile(path.join(f.primary, 'temporary.a'), 'derived archive');
  await fs.writeFile(path.join(f.primary, 'temporary.o'), 'derived object');
  assert.equal(headerInputsCurrent(fresh.inputs), true);
  const cached = await f.read();
  assert.equal(cached.index.cacheHit, true);
  assert.deepEqual(cached.inputs, fresh.inputs);
  assert.equal(cached.dependency.headerInputsScheme, LIBRARY_HEADER_INPUTS_SCHEME);
});

test('current analyzer rejects v5 directory and v6 unbound-tape indexes instead of relabeling their proofs', async t => {
 for (const oldVersion of [5, 6]) {
  const f = await fixture(t), fresh = await f.read();
  assert.equal(DEPENDENCY_ANALYZER_VERSION, 'dependency-library-layout-v8');
  const [sourceIndexPath] = await glob(`sources/**/${fresh.index.sourceHash}/*.json`, { cwd: f.cache.getCacheDir(), absolute: true });
  assert.ok(sourceIndexPath);
  const pathStatePath = f.cache.getPathStatePath(f.cache.normalizePath(f.library));
  for (const filename of [sourceIndexPath, pathStatePath]) {
    assert.ok(filename.startsWith(path.join(f.root, 'cache') + path.sep));
    const old = JSON.parse(await fs.readFile(filename, 'utf8'));
    old.schemaVersion = oldVersion;
    old.analyzerVersion = `dependency-directive-tape-v${oldVersion}`;
    if (oldVersion === 5 && old.macroIndex) old.macroIndex.headerInputs = [[f.primary, dependencyInputIdentity(f.primary)]];
    await fs.writeFile(filename, JSON.stringify(old));
  }
  const rebuilt = await f.read();
  assert.equal(rebuilt.index.cacheHit, false);
  assert.ok(rebuilt.inputs.some(([file, identity]) => file === path.join(f.primary, 'Shared.h') && identity === null));
  assert.equal(rebuilt.inputs.some(([file]) => file === f.primary), false);
  assert.equal(rebuilt.dependency.headerInputsScheme, LIBRARY_HEADER_INPUTS_SCHEME);
  assert.equal((await f.read()).index.cacheHit, true);
 }
});
