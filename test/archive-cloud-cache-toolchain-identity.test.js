const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArchiveCloudCacheManager } = require('../dist/src/ArchiveCloudCacheManager.js');
const { Logger } = require('../dist/src/utils/Logger.js');

test('archive cache toolchain identity includes host and compiler binary content', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-builder-archive-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const previousCacheDir = process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR;
  process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR = cacheDir;
  t.after(() => {
    if (previousCacheDir === undefined) {
      delete process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR;
    } else {
      process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR = previousCacheDir;
    }
  });

  const manager = new ArchiveCloudCacheManager(new Logger());
  const signature = await manager.createToolchainSignature({
    compiler: {
      c: process.execPath,
      cpp: process.execPath,
      ar: process.execPath
    }
  });
  const executable = fs.readFileSync(process.execPath);
  const expectedSha256 = crypto.createHash('sha256').update(executable).digest('hex');

  assert.deepEqual(signature.host, {
    platform: process.platform,
    arch: process.arch
  });
  assert.deepEqual(signature.cBinary, {
    sha256: expectedSha256,
    size: executable.length
  });
  assert.deepEqual(signature.cppBinary, signature.cBinary);
  assert.deepEqual(signature.arBinary, signature.cBinary);
});

test('archive cache binary identity changes when executable content changes', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-builder-archive-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const previousCacheDir = process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR;
  process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR = cacheDir;
  t.after(() => {
    if (previousCacheDir === undefined) {
      delete process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR;
    } else {
      process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR = previousCacheDir;
    }
  });

  const firstPath = path.join(cacheDir, 'compiler-a');
  const secondPath = path.join(cacheDir, 'compiler-b');
  fs.writeFileSync(firstPath, 'compiler-a');
  fs.writeFileSync(secondPath, 'compiler-b');

  const manager = new ArchiveCloudCacheManager(new Logger());
  const first = await manager.getCommandBinarySignature(firstPath);
  const second = await manager.getCommandBinarySignature(secondPath);

  assert.notEqual(first.sha256, second.sha256);
  assert.equal(first.size, second.size);
});

test('archive cache artifacts are isolated from build outputs', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-builder-archive-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const previousCacheDir = process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR;
  process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR = cacheDir;
  t.after(() => {
    if (previousCacheDir === undefined) {
      delete process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR;
    } else {
      process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR = previousCacheDir;
    }
  });

  const manager = new ArchiveCloudCacheManager(new Logger());
  const sourcePath = path.join(cacheDir, 'source-core.a');
  const buildPath = path.join(cacheDir, 'build', 'core.a');
  const inputs = {
    schema: 'test-inputs',
    target: { kind: 'core', name: 'core', archiveName: 'core.a' },
    builder: { keyVersion: 'test' },
    board: {},
    toolchain: {},
    sdk: {},
    compile: {},
    sources: {}
  };
  const target = {
    dependencyName: 'core',
    dependencyType: 'core',
    archiveName: 'core.a'
  };
  const key = manager.computeKey(inputs);

  fs.writeFileSync(sourcePath, 'original-archive');
  await manager.writeEntryFromFile(target, inputs, key, sourcePath, 'local-build');
  fs.writeFileSync(sourcePath, 'changed-source');

  const cacheArchivePath = path.join(manager.getEntryDir(key), 'core.a');
  assert.equal(fs.readFileSync(cacheArchivePath, 'utf8'), 'original-archive');

  const hit = await manager.restoreLocal(target, key, buildPath);
  assert.ok(hit);
  fs.writeFileSync(buildPath, 'changed-build');
  assert.equal(fs.readFileSync(cacheArchivePath, 'utf8'), 'original-archive');
});
