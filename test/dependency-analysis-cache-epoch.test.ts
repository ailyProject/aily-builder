import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArchiveCloudCacheManager } from '../src/ArchiveCloudCacheManager';
import { DEPENDENCY_ANALYZER_VERSION } from '../src/LibraryIndexCache';
import { Logger } from '../src/utils/Logger';

test('library archives from an unbound analysis epoch cannot satisfy a new analysis key', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-analysis-epoch-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-analysis-epoch-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'library.cpp'), archive = path.join(root, 'library.a');
  await fs.writeFile(source, 'int value() { return 1; }\n');
  await fs.writeFile(archive, 'old-analysis-archive');
  const manager = Object.assign(Object.create(ArchiveCloudCacheManager.prototype), {
    logger: new Logger(), cacheDir: path.join(root, 'cache'), fileHashCache: new Map(),
    createCompileSignature: () => ['unchanged-compile-args'],
    createBoardSignature: () => ({}), createToolchainSignature: async () => ({}),
    createSdkSignature: async () => ({}), collectSourceFiles: async () => [source],
    collectResponseFiles: async () => [], collectProjectConfigFiles: async () => [],
  });
  const target = { dependency: { name: 'Feature', type: 'library', path: root, includes: [source] },
    dependencyName: 'Feature', dependencyType: 'library', archiveName: 'Feature.a' };
  const inputs = await manager.computeInputs(target, [target.dependency], {});
  assert.equal(inputs.builder.dependencyAnalysis, DEPENDENCY_ANALYZER_VERSION);
  const oldInputs = structuredClone(inputs);
  delete oldInputs.builder.dependencyAnalysis;
  const oldKey = manager.computeKey(oldInputs), currentKey = manager.computeKey(inputs);
  assert.notEqual(oldKey, currentKey);
  await manager.writeEntryFromFile(target, oldInputs, oldKey, archive, 'local-build');
  assert.equal(await manager.restoreLocal(target, currentKey, path.join(root, 'output', 'Feature.a')), null);
  assert.equal(await fs.readFile(path.join(manager.getEntryDir(oldKey), 'Feature.a'), 'utf8'), 'old-analysis-archive');

  const coreTarget = { ...target, dependencyType: 'core' };
  const coreInputs = await manager.computeInputs(coreTarget, [target.dependency], {});
  assert.equal(Object.hasOwn(coreInputs.builder, 'dependencyAnalysis'), false,
    'Unaffected native core archives keep their existing cache contract');
});
