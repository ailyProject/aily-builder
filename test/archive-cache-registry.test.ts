import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARCHIVE_CACHE_LAYOUTS } from '../src/ArchiveCloudCacheManager';
import { CacheRegistry } from '../src/CacheRegistry';

test('archive cache stats and unused cleanup handle all supported layouts as complete entries', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-archive-registry-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const registry: CacheRegistry = Object.create(CacheRegistry.prototype);
  Object.assign(registry, {
    logger: { debug() {} },
    buckets: [{ id: 'archive-cloud', name: 'Archive cache', directory, kind: 'archive-cloud' }]
  });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const layout of ARCHIVE_CACHE_LAYOUTS) {
    for (const key of ['ab'.repeat(32), 'cd'.repeat(32)]) {
      const entry = path.join(directory, layout, key.slice(0, 2), key.slice(2, 4), key);
      await fs.mkdir(entry, { recursive: true });
      for (const file of ['manifest.json', 'inputs.json', 'core.a']) {
        const target = path.join(entry, file);
        await fs.writeFile(target, 'fixture');
        if (key.startsWith('ab')) await fs.utimes(target, old, old);
      }
    }
  }

  assert.equal((await registry.getStats()).total.entries, ARCHIVE_CACHE_LAYOUTS.length * 2);
  const dryRun = await registry.clear('unused-7', true);
  assert.equal(dryRun.total.deletedFiles, ARCHIVE_CACHE_LAYOUTS.length * 3);
  assert.equal((await registry.getStats()).total.entries, ARCHIVE_CACHE_LAYOUTS.length * 2);
  assert.equal((await registry.clear('unused-7')).total.deletedFiles, ARCHIVE_CACHE_LAYOUTS.length * 3);
  assert.equal((await registry.getStats()).total.entries, ARCHIVE_CACHE_LAYOUTS.length);
});
