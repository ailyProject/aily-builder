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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-library-fragments-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryPath = path.join(root, 'library', 'src');
  await fs.mkdir(libraryPath, { recursive: true });
  let timestamp = Date.UTC(2024, 0, 1);
  return {
    root,
    libraryPath,
    dependency: { name: 'FragmentFixture', path: libraryPath, type: 'library', includes: [] } as Dependency,
    async write(relativePath: string, content: string) {
      const filePath = path.join(libraryPath, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
      timestamp += 2000;
      const time = new Date(timestamp);
      await fs.utimes(filePath, time, time);
      return filePath;
    },
  };
}

// Keep constructors from creating caches in the user's profile; the actual
// analysis and cache implementations run against disposable fixture data.
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

function macros(enabled = true): Map<string, MacroDefinition> {
  return new Map([['ACTIVE', { name: 'ACTIVE', value: enabled ? '1' : '0', isDefined: true }]]);
}

for (const enabled of [true, false]) {
  test(`compiled TU follows nested inc dependencies only in its active branch (${enabled})`, async t => {
    const f = await fixture(t);
    const source = await f.write('main.cpp', '#if ACTIVE\n#include "private/impl.inc"\n#else\n#include <Fallback.h>\n#endif\nvoid entry() {}\n');
    await f.write('private/impl.inc', '#include "nested/leaf.inc"\n');
    await f.write('private/nested/leaf.inc', '#include <External.h>\n#include "../impl.inc"\n');
    await f.write('private/unused.inc', '#include <Unused.h>\n');

    const result = await analyzer().buildLibraryIndex(f.dependency, macros(enabled));
    assert.deepEqual(result.sourceFiles, [source]);
    assert.deepEqual(result.includeFiles, [enabled ? 'External.h' : 'Fallback.h']);
  });
}

test('cpp through nested inc excludes the included cpp without compiling inc as a TU', async t => {
  const f = await fixture(t);
  const source = await f.write('main.cpp', '#include "private/impl.inc"\nvoid entry() {}\n');
  await f.write('private/impl.inc', '#include "nested/leaf.inc"\n');
  await f.write('private/nested/leaf.inc', '#include "../fragment.cpp"\n');
  const fragment = await f.write('private/fragment.cpp', 'int fragment_function() { return 1; }\n');
  const standalone = await f.write('standalone.cpp', 'void standalone_function() {}\n');

  const result = await analyzer().buildLibraryIndex(f.dependency, new Map());
  assert.deepEqual(result.sourceFiles, [source, standalone].sort());
  assert.equal(result.sourceFiles.includes(fragment), false);
  assert.equal(result.sourceFiles.some((file: string) => file.endsWith('.inc')), false);
});

test('explicit cpp fragment inclusion retains the existing duplicate-definition guard', async t => {
  const f = await fixture(t);
  const source = await f.write('main.cpp', '#include "private/fragment.cpp"\nvoid entry() {}\n');
  await f.write('private/fragment.cpp', 'int fragment_function() { return 1; }\n');

  const result = await analyzer().buildLibraryIndex(f.dependency, new Map());
  assert.deepEqual(result.sourceFiles, [source]);
});

test('library index invalidates on inc-only edits, additions and deletions', async t => {
  const f = await fixture(t);
  await f.write('main.cpp', '#include "private/impl.inc"\nvoid entry() {}\n');
  await f.write('private/impl.inc', '#include <ExternalA.h>\n');
  const cache = indexCache(f.root);
  const dependencyAnalyzer = analyzer();
  let builds = 0;
  const read = () => cache.getOrCreate(f.dependency.name, f.libraryPath, new Map(), async () => {
    builds++;
    return dependencyAnalyzer.buildLibraryIndex(f.dependency, new Map());
  });

  const initial = await read();
  assert.equal(initial.cacheHit, false);
  assert.equal((await read()).cacheHit, true);
  assert.equal(builds, 1);

  await f.write('private/impl.inc', '#include <ExternalB.h>\n');
  const edited = await read();
  assert.equal(edited.cacheHit, false);
  assert.notEqual(edited.sourceHash, initial.sourceHash);
  assert.deepEqual(edited.includeFiles, ['ExternalB.h']);
  assert.equal((await read()).cacheHit, true);

  const extra = await f.write('private/unused.inc', '#include <Unused.h>\n');
  const added = await read();
  assert.equal(added.cacheHit, false);
  assert.notEqual(added.sourceHash, edited.sourceHash);
  assert.deepEqual(added.includeFiles, ['ExternalB.h']);

  // Avoid returning to an already indexed content set, which can legitimately
  // reuse a content-addressed result even after path metadata changes.
  await f.write('private/impl.inc', '#include <ExternalC.h>\n');
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

test('archive source hash and key include inc while eligibility counts only compiled sources', async t => {
  const f = await fixture(t);
  const source = await f.write('main.cpp', '#include "private/impl.inc"\nvoid entry() {}\n');
  const largeContent = `// ${'a'.repeat(310 * 1024)}\n`;
  const implementation = await f.write('private/impl.inc', largeContent);
  const dependency = { ...f.dependency, includes: [source] };
  const target = { dependency, dependencyName: dependency.name, dependencyType: 'library', archiveName: `${dependency.name}.a` };
  const config = {
    compiler: {},
    args: {},
    arduino: { platform: { 'build.fqbn': 'fixture:fixture:fixture' } },
    cacheIdentity: { sdkIdentity: 'fixture-sdk', toolPackages: ['fixture-tools'] },
  };
  const manager = archiveCache(f.root);
  manager.collectProjectConfigFiles = async () => [];
  const eligibility = await manager.getLibraryArchiveEligibility({ ...dependency, includes: [source, implementation] });
  assert.deepEqual(eligibility, { eligible: false, sourceFileCount: 1, sourceFileSize: (await fs.stat(source)).size });
  const first = await manager.computeInputs(target, [dependency], config);
  assert.equal(manager.computeKey(first), manager.computeKey(await manager.computeInputs(target, [dependency], config)));

  await f.write('private/impl.inc', largeContent.replace('aaa', 'bbb'));
  const changed = await manager.computeInputs(target, [dependency], config);
  assert.notEqual(first.sources.sourceHash, changed.sources.sourceHash);
  assert.notEqual(manager.computeKey(first), manager.computeKey(changed));
  assert.deepEqual({ ...first, sources: undefined }, { ...changed, sources: undefined });
  assert.equal(manager.computeKey(changed), manager.computeKey(await manager.computeInputs(target, [dependency], config)));
});

test('conditional thin TU keeps its included inc implementation', async t => {
  const f = await fixture(t);
  const source = await f.write('platform/ThinPort.cpp', '#if ACTIVE\n#include "../private/implementation.inc"\n#endif\n');
  await f.write('private/implementation.inc', 'int platform_value() { return 42; }\n');

  const result = await analyzer().buildLibraryIndex(f.dependency, macros());
  assert.deepEqual(result.sourceFiles, [source]);
  assert.equal(result.sourceFiles.some((file: string) => file.endsWith('.inc')), false);
});
