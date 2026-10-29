import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { TestContext } from 'node:test';
import { DependencyAnalyzer, Dependency, MacroDefinition } from '../src/DependencyAnalyzer';
import { LibraryIndexCache } from '../src/LibraryIndexCache';
import { ArchiveCloudCacheManager } from '../src/ArchiveCloudCacheManager';
import { Logger } from '../src/utils/Logger';

class QuietLogger extends Logger {
  debug(): void {}
  info(): void {}
  verbose(): void {}
  warn(): void {}
  error(): void {}
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-library-ipp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryPath = path.join(root, 'library', 'src');
  await fs.mkdir(libraryPath, { recursive: true });
  let timestamp = Date.UTC(2024, 0, 1);
  return {
    root,
    libraryPath,
    dependency: { name: 'IppFixture', path: libraryPath, type: 'library', includes: [] } as Dependency,
    async write(relativePath: string, text: string) {
      const filePath = path.join(libraryPath, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, text);
      // Explicitly advance metadata for equal-sized edits on coarse file systems.
      timestamp += 2000;
      const time = new Date(timestamp);
      await fs.utimes(filePath, time, time);
      return filePath;
    },
  };
}

// Bypass constructors that create caches in the real user's profile. Methods
// under test remain the production implementations; each cache stays in fixture.root.
function analyzer(): any {
  return Object.assign(Object.create(DependencyAnalyzer.prototype), {
    logger: new QuietLogger(),
    libraryMap: new Map(),
    platformHeaderRoots: [],
  });
}

function indexCache(root: string): LibraryIndexCache {
  return Object.assign(Object.create(LibraryIndexCache.prototype), {
    logger: new QuietLogger(),
    cacheDir: path.join(root, 'index-cache'),
  });
}

function archiveCache(root: string): any {
  return Object.assign(Object.create(ArchiveCloudCacheManager.prototype), {
    logger: new QuietLogger(),
    cacheDir: path.join(root, 'archive-cache'),
    remoteDisabledForRun: true,
    compilerVersionCache: new Map(),
    commandBinarySignatureCache: new Map(),
    fileHashCache: new Map(),
  });
}

function macros(enabled: boolean): Map<string, MacroDefinition> {
  return new Map([['USE_IPP', { name: 'USE_IPP', value: enabled ? '1' : '0', isDefined: true }]]);
}

for (const enabled of [true, false]) {
  test(`public header follows nested ipp only in the active branch (${enabled})`, async t => {
    const f = await fixture(t);
    await f.write('Public.h', '#if USE_IPP\n#include "private/impl.ipp"\n#else\n#include <Fallback.h>\n#endif\n');
    await f.write('private/impl.ipp', '#include "nested/codec.ipp"\n');
    await f.write('private/nested/codec.ipp', '#include <External.h>\n#include "../impl.ipp"\n');
    await f.write('private/unused.ipp', '#include <Unused.h>\n');

    const result = await analyzer().buildLibraryIndex(f.dependency, macros(enabled), ['Public.h']);
    assert.deepEqual(result.includeFiles, [enabled ? 'External.h' : 'Fallback.h']);
    assert.deepEqual(result.sourceFiles, []);
  });
}

test('cpp through ipp does not independently compile the included cpp fragment', async t => {
  const f = await fixture(t);
  const main = await f.write('main.cpp', '#include "private/impl.ipp"\nvoid main_function() {}\n');
  await f.write('private/impl.ipp', '#include "fragment.cpp"\n');
  const fragment = await f.write('private/fragment.cpp', 'void fragment_function() {}\n');
  const standalone = await f.write('standalone.cpp', 'void standalone_function() {}\n');

  const result = await analyzer().buildLibraryIndex(f.dependency, new Map());
  assert.deepEqual(result.sourceFiles, [main, standalone].sort());
  assert.equal(result.sourceFiles.includes(fragment), false);
  assert.equal(result.sourceFiles.some((file: string) => file.endsWith('.ipp')), false);
});

test('library index hits unchanged input and invalidates on ipp edit, addition and deletion', async t => {
  const f = await fixture(t);
  await f.write('Public.h', '#include "private/impl.ipp"\n');
  await f.write('private/impl.ipp', '#include <ExternalA.h>\n');
  const cache = indexCache(f.root);
  const dependencyAnalyzer = analyzer();
  let builds = 0;
  const read = () => cache.getOrCreate(f.dependency.name, f.libraryPath, new Map(), async () => {
    builds++;
    return dependencyAnalyzer.buildLibraryIndex(f.dependency, new Map(), ['Public.h']);
  });

  const initial = await read();
  assert.equal(initial.cacheHit, false);
  assert.deepEqual(initial.includeFiles, ['ExternalA.h']);
  assert.equal((await read()).cacheHit, true);
  assert.equal(builds, 1);

  await f.write('private/impl.ipp', '#include <ExternalB.h>\n');
  const edited = await read();
  assert.equal(edited.cacheHit, false);
  assert.notEqual(edited.sourceHash, initial.sourceHash);
  assert.deepEqual(edited.includeFiles, ['ExternalB.h']);
  assert.equal((await read()).cacheHit, true);

  const extra = await f.write('private/extra.ipp', '#include <Unused.h>\n');
  const added = await read();
  assert.equal(added.cacheHit, false);
  assert.notEqual(added.sourceHash, edited.sourceHash);
  assert.deepEqual(added.includeFiles, ['ExternalB.h']);

  // Do not delete back to an already indexed content set: that is a legitimate
  // cross-snapshot source-cache hit, rather than a stale path fingerprint.
  await f.write('private/impl.ipp', '#include <ExternalC.h>\n');
  const beforeDelete = await read();
  assert.equal(beforeDelete.cacheHit, false);
  await fs.unlink(extra);
  const deleted = await read();
  assert.equal(deleted.cacheHit, false);
  assert.notEqual(deleted.sourceHash, beforeDelete.sourceHash);
  assert.deepEqual(deleted.includeFiles, ['ExternalC.h']);
  assert.equal((await read()).cacheHit, true);
  assert.equal(builds, 5);
});

test('library index rejects path and source results from an obsolete analyzer', async t => {
  const f = await fixture(t);
  await f.write('Public.h', '#include <External.h>\n');
  const cache = indexCache(f.root);
  const dependencyAnalyzer = analyzer();
  let builds = 0;
  const read = () => cache.getOrCreate(f.dependency.name, f.libraryPath, new Map(), async () => {
    builds++;
    return dependencyAnalyzer.buildLibraryIndex(f.dependency, new Map(), ['Public.h']);
  });
  const initial = await read();
  const internal = cache as any;
  const cachePaths = [
    internal.getPathStatePath(internal.normalizePath(f.libraryPath)),
    internal.getSourceIndexPath(initial.sourceHash),
  ];
  for (const cachePath of cachePaths) {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    cached.analyzerVersion = `${cached.analyzerVersion}-obsolete-fixture`;
    if (cached.macroIndexes) {
      for (const index of Object.values(cached.macroIndexes) as any[]) index.includeFiles = ['Stale.h'];
      assert.equal(internal.isSourceIndexUsable(cached, initial.sourceHash), false);
    } else {
      assert.equal(internal.isPathStateUsable(cached, internal.normalizePath(f.libraryPath)), false);
    }
    await fs.writeFile(cachePath, JSON.stringify(cached));
  }

  const rebuilt = await read();
  assert.equal(rebuilt.cacheHit, false);
  assert.equal(builds, 2);
  assert.deepEqual(rebuilt.includeFiles, ['External.h']);
  assert.equal((await read()).cacheHit, true);
});

test('archive key includes ipp content but ipp does not count as compilable source', async t => {
  const f = await fixture(t);
  const source = await f.write('main.cpp', '#include "private/impl.ipp"\nvoid ordinary_function() {}\n');
  await f.write('Public.h', 'void ordinary_function();\n');
  const largeImplementation = `// ${'a'.repeat(310 * 1024)}\n`;
  const implementation = await f.write('private/impl.ipp', largeImplementation);
  const dependency = { ...f.dependency, includes: [source] };
  const target = {
    dependency,
    dependencyName: dependency.name,
    dependencyType: 'library',
    archiveName: `${dependency.name}.a`,
  };
  const manager = archiveCache(f.root);
  const config = {
    compiler: {},
    args: {},
    arduino: { platform: { 'build.fqbn': 'fixture:fixture:fixture' } },
    cacheIdentity: { sdkIdentity: 'fixture-sdk', toolPackages: ['fixture-tools'] },
  };
  // No real project config, SDK or compiler is required to exercise the complete
  // source-input/key path. Do not allow process.cwd() to add unrelated files.
  manager.collectProjectConfigFiles = async () => [];

  const eligibility = await manager.getLibraryArchiveEligibility(dependency);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.sourceFileCount, 1);
  assert.equal(eligibility.sourceFileSize, (await fs.stat(source)).size);
  const withFragment = await manager.getLibraryArchiveEligibility({ ...dependency, includes: [source, implementation] });
  assert.deepEqual(withFragment, eligibility);
  const first = await manager.computeInputs(target, [dependency], config);
  const unchanged = await manager.computeInputs(target, [dependency], config);
  assert.equal(manager.computeKey(first), manager.computeKey(unchanged));

  await f.write('private/impl.ipp', largeImplementation.replace('aaa', 'bbb'));
  const changed = await manager.computeInputs(target, [dependency], config);
  assert.notEqual(first.sources.sourceHash, changed.sources.sourceHash);
  assert.notEqual(manager.computeKey(first), manager.computeKey(changed));
  assert.deepEqual({ ...first, sources: undefined }, { ...changed, sources: undefined });
  assert.equal(
    manager.computeKey(changed),
    manager.computeKey(await manager.computeInputs(target, [dependency], config)),
  );
});

test('analysis contexts keep their own source lists on cache hits', async t => {
  const f = await fixture(t);
  const first = await f.write('first.cpp', 'void first() {}\n');
  const second = await f.write('second.cpp', 'void second() {}\n');
  const cache = indexCache(f.root);
  const read = (context: string, source: string) => cache.getOrCreate(
    f.dependency.name, f.libraryPath, new Map(),
    async () => ({ sourceFiles: [source], includeFiles: [] }), context,
  );
  assert.deepEqual((await read('first-entry', first)).sourceFiles, [first]);
  assert.deepEqual((await read('second-entry', second)).sourceFiles, [second]);
  const cached = await read('first-entry', first);
  assert.equal(cached.cacheHit, true);
  assert.deepEqual(cached.sourceFiles, [first]);
});

test('a damaged context entry is a cache miss rather than an analysis failure', async t => {
  const f = await fixture(t);
  await f.write('Public.h', '// cache fixture\n');
  const cache = indexCache(f.root);
  let builds = 0;
  const read = () => cache.getOrCreate(f.dependency.name, f.libraryPath, new Map(), async () => {
    builds++;
    return { sourceFiles: [], includeFiles: ['Expected.h'] };
  });
  const initial = await read();
  const cachePath = (cache as any).getSourceIndexPath(initial.sourceHash);
  const damaged = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  damaged.macroIndexes = { broken: null };
  await fs.writeFile(cachePath, JSON.stringify(damaged));
  const rebuilt = await read();
  assert.equal(rebuilt.cacheHit, false);
  assert.equal(builds, 2);
  assert.deepEqual(rebuilt.includeFiles, ['Expected.h']);
});
