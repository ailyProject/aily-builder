import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { copyNinja } = createRequire(import.meta.url)('../copy-ninja.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('static package metadata emitted by TypeScript is included in the npm manifest', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('dist/package.json'));
  const emitted = JSON.parse(await readFile(path.join(root, 'dist/package.json'), 'utf8'));
  assert.deepEqual(emitted, manifest, 'CLI metadata must be the generated copy of the single package source.');
});

test('provided Ninja assets are copied byte-for-byte and included in the npm manifest', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'aily-builder-ninja-assets-'));
  try {
    await copyNinja(destination);
    for (const name of ['ninja.exe', 'ninja']) {
      assert.equal(hash(await readFile(path.join(destination, name))), hash(await readFile(path.join(root, 'ninja', name))));
    }
    if (process.platform !== 'win32') assert.ok((await stat(path.join(destination, 'ninja'))).mode & 0o111);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.ok(manifest.files.includes('dist/ninja'));
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test('missing provided Ninja fails instead of discovering or downloading another executable', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'aily-builder-missing-ninja-'));
  try { await assert.rejects(copyNinja(destination, path.join(destination, 'missing')), { code: 'ENOENT' }); }
  finally { await rm(destination, { recursive: true, force: true }); }
});

test('built Ninja resolution belongs to the package, not the working project directory', { skip: !['win32', 'darwin'].includes(process.platform) }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aily-builder-ninja-cwd-'));
  try {
    const modulePath = path.join(root, 'dist/src/NinjaCompilationPipeline.js');
    const code = `const { NinjaCompilationPipeline } = require(${JSON.stringify(modulePath)}); process.stdout.write(NinjaCompilationPipeline.prototype.getNinjaExecutablePath());`;
    const result = execFileSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result, path.join(root, 'dist/ninja', process.platform === 'win32' ? 'ninja.exe' : 'ninja'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('missing package-owned Ninja cannot fall back to a project-provided executable', { skip: !['win32', 'darwin'].includes(process.platform) }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'aily-builder-untrusted-ninja-'));
  try {
    const modulePath = path.join(root, 'dist/src/NinjaCompilationPipeline.js');
    const executable = process.platform === 'win32' ? 'ninja.exe' : 'ninja';
    const code = `const assert = require('node:assert/strict'); const fs = require(${JSON.stringify(path.join(root, 'node_modules/fs-extra'))}); const { NinjaCompilationPipeline } = require(${JSON.stringify(modulePath)}); fs.existsSync = candidate => candidate === ${JSON.stringify(path.join(cwd, 'ninja', executable))}; assert.throws(() => NinjaCompilationPipeline.prototype.getNinjaExecutablePath(), /not found/);`;
    execFileSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8', windowsHide: true });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
