import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { BuildInputRecording } from '../src/BuildInputRecording';
import { INPUT_CONTEXT_FILE, INPUT_CONTEXT_LIMIT, publishBuildInputContext, verifyBuildInputContext } from '../src/BuildInputVerification';
import { acquireBuildWorkspace, withBuildWorkspace, BUILDER_DELEGATION_ENV } from '../src/BuildWorkspace';
import { emitSimulationArtifactManifest } from '../src/ArtifactManifest';

const cli = process.env.AILY_TEST_BUILDER_CLI || path.resolve(__dirname, '../dist/main.js');
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-input-verification-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(root), /^aily-input-verification-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'), build = path.join(source, '.build'), sdk = path.join(root, 'sdk'), tools = path.join(root, 'tools');
  for (const directory of [build, sdk, tools]) await fs.mkdir(directory, { recursive: true });
  const sketch = path.join(source, 'sketch.ino'), header = path.join(sdk, 'sdk.h'), executable = path.join(tools, 'compiler.exe');
  const response = path.join(build, 'build.opt');
  await fs.writeFile(sketch, 'void setup() {}'); await fs.writeFile(header, '#define VALUE 1');
  await fs.writeFile(executable, 'this is deliberately not an executable'); await fs.writeFile(response, '-DPHASE=initial');
  const selection = { roots: [source], exclude: [build], configuration: { board: 'test:core:board' },
    external: { recipes: [`"${executable}" @"${response}"`], tools: { cpp: executable }, cwd: build, searchPath: '' } };
  const packages = { roots: [{ property: 'runtime.platform.path', path: sdk }, { property: 'runtime.tools.cc.path', path: tools }], buildPath: build };
  const recording = await BuildInputRecording.open(() => selection, () => packages);
  assert.throws(() => recording.getVerificationContext(), /Final SDK/);
  for (const phase of ['sketch', 'libraries', 'core', 'link', 'objcopy']) {
    await fs.writeFile(response, `-DPHASE=${phase}`);
    await (await recording.beginPhase(phase)).confirm();
  }
  const record = await recording.finish(); await recording.confirmFinal();
  const context = recording.getVerificationContext(), digest = await publishBuildInputContext(context);
  const filename = path.join(build, INPUT_CONTEXT_FILE);
  return { root, source, build, sdk, tools, sketch, header, executable, response, selection, packages, recording, record, context, digest, filename };
}

test('private resolution context checks final inputs without replaying phase hooks or running tools', async t => {
  const f = await fixture(t), original = await fs.readFile(f.filename);
  const proof = await verifyBuildInputContext(f.build, f.digest, f.record.digest);
  assert.equal(proof.status, 'inputs-current'); assert.equal(proof.currentProjectAcceptance, false);
  assert.equal(proof.scope, 'prepared-dependency-trees-and-sdk-tools');
  assert.equal((await fs.readFile(f.response, 'utf8')), '-DPHASE=objcopy');
  assert.deepEqual(await fs.readFile(f.filename), original);
  assert.equal(JSON.stringify(proof).includes(f.root), false);
  await assert.rejects(fs.stat(path.join(f.build, 'aily-workspace.lock')), { code: 'ENOENT' });
  // Returned values are detached, not mutable aliases into the recording.
  f.context.selection.roots.length = 0;
  assert.equal(f.recording.getVerificationContext().selection.roots.length, 1);
});

for (const change of ['sdk', 'tool', 'source', 'response', 'addition', 'deletion', 'restored-mtime', 'restored-bytes']) {
  test(`consumption refuses ${change} changes`, async t => {
    const f = await fixture(t);
    if (change === 'sdk') await fs.writeFile(f.header, '#define VALUE 2');
    if (change === 'tool') await fs.writeFile(f.executable, 'changed');
    if (change === 'source') await fs.writeFile(f.sketch, 'void setup() { changed(); }');
    if (change === 'response') await fs.writeFile(f.response, '-DPHASE=changed');
    if (change === 'addition') await fs.writeFile(path.join(f.sdk, 'new.h'), 'added');
    if (change === 'deletion') await fs.unlink(f.header);
    if (change.startsWith('restored')) {
      const before = await fs.stat(f.header), bytes = await fs.readFile(f.header);
      await fs.writeFile(f.header, '#define VALUE 2');
      if (change === 'restored-bytes') await fs.writeFile(f.header, bytes);
      await fs.utimes(f.header, before.atime, before.mtime);
    }
    await assert.rejects(verifyBuildInputContext(f.build, f.digest, f.record.digest),
      (error: any) => ['BUILD_INPUTS_CHANGED', 'BUILD_PACKAGE_INPUTS_CHANGED'].includes(error.code));
    await assert.rejects(fs.stat(path.join(f.build, 'aily-workspace.lock')), { code: 'ENOENT' });
  });
}

test('context bytes and expected Artifact input identity are both required', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyBuildInputContext(f.build, f.digest, 'a'.repeat(64)), /match this build/);
  await assert.rejects(verifyBuildInputContext(f.build, '', f.record.digest), /hashes are required/);
  await fs.appendFile(f.filename, ' ');
  await assert.rejects(verifyBuildInputContext(f.build, f.digest, f.record.digest), /differs from the observed build/);
});

test('malformed private selections and phase shapes fail with an actionable context error', async t => {
  const f = await fixture(t);
  for (const mutate of [
    (value: any) => { value.phases = {}; },
    (value: any) => { value.phases[0] = null; },
    (value: any) => { value.selection.exclude = [null]; },
    (value: any) => { delete value.snapshot.record; },
    (value: any) => { delete value.packages.snapshot.record; },
  ]) {
    const context = f.recording.getVerificationContext(); mutate(context);
    const bytes = JSON.stringify(context); await fs.writeFile(f.filename, bytes);
    await assert.rejects(verifyBuildInputContext(f.build, sha(bytes), f.record.digest), { code: 'BUILD_INPUT_CONTEXT_INVALID' });
  }
});

test('invalid phase digest, copied context, oversized and linked contexts are rejected', async t => {
  const f = await fixture(t), original = await fs.readFile(f.filename);
  const bad = JSON.parse(original.toString()); bad.phases[0].external.files.length = 0;
  const changed = JSON.stringify(bad); await fs.writeFile(f.filename, changed);
  await assert.rejects(verifyBuildInputContext(f.build, sha(changed), f.record.digest), /inconsistent/);
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, INPUT_CONTEXT_FILE), original);
  await assert.rejects(verifyBuildInputContext(other, f.digest, f.record.digest), /match this build/);
  await fs.writeFile(f.filename, Buffer.alloc(INPUT_CONTEXT_LIMIT + 1));
  await assert.rejects(verifyBuildInputContext(f.build, f.digest, f.record.digest), /oversized/);
  await fs.unlink(f.filename);
  await fs.link(path.join(other, INPUT_CONTEXT_FILE), f.filename);
  await assert.rejects(verifyBuildInputContext(f.build, f.digest, f.record.digest), /Unsafe/);
});

test('private file stays out of Artifact inventory and does not contaminate a second recording', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.build, 'sketch.hex'), ':00000001FF');
  const artifact = await emitSimulationArtifactManifest({ buildPath: f.build, sketchPath: f.sketch,
    board: 'arduino:avr:uno', manifestPath: path.join(f.build, 'aily-artifact-manifest.json'), buildInputs: f.record });
  assert.equal(artifact.files.some(file => file.path === INPUT_CONTEXT_FILE), false);
  assert.equal(JSON.stringify(artifact).includes('runtime.platform.path'), false);
  await f.recording.confirmFinal();
  const second = await BuildInputRecording.open(() => f.selection, () => f.packages);
  for (const phase of ['sketch', 'libraries', 'core', 'link', 'objcopy']) await (await second.beginPhase(phase)).confirm();
  await second.finish(); await second.confirmFinal();
  assert.equal(second.getVerificationContext().snapshot.record.digest, f.context.snapshot.record.digest);
});

test('CLI check is JSON-only, preserves artifacts and cannot coexist with a writer', async t => {
  const f = await fixture(t);
  for (const name of ['aily-artifact-manifest.json', 'aily-build-delivery.json']) await fs.writeFile(path.join(f.build, name), 'preserve');
  const invoke = () => spawnSync(process.execPath, [cli, 'verify-build-inputs', '--build-path', f.build,
    '--context-sha256', f.digest, '--inputs-digest', f.record.digest], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const success = invoke(); assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).status, 'inputs-current'); assert.equal(success.stderr, '');
  const owner = acquireBuildWorkspace(f.build, 'compile');
  try { const blocked = invoke(); assert.equal(blocked.status, 1); assert.equal(JSON.parse(blocked.stderr).code, 'BUILD_WORKSPACE_BUSY'); }
  finally { owner.release(); }
  for (const name of ['aily-artifact-manifest.json', 'aily-build-delivery.json']) assert.equal(await fs.readFile(path.join(f.build, name), 'utf8'), 'preserve');
});

test('verify scope cannot be upgraded to compile/preprocess and accepts only matching delegation', async t => {
  const f = await fixture(t);
  await withBuildWorkspace(f.build, 'verify', async () => {
    for (const operation of ['compile', 'preprocess', 'clean'] as const) {
      await assert.rejects(withBuildWorkspace(f.build, operation, async () => {}), /OWNER_MISMATCH/);
    }
  });
  const owner = acquireBuildWorkspace(f.build, 'verify');
  const record = JSON.parse(await fs.readFile(path.join(f.build, 'aily-workspace.lock'), 'utf8'));
  const previous = process.env[BUILDER_DELEGATION_ENV];
  process.env[BUILDER_DELEGATION_ENV] = JSON.stringify({ schemaVersion: 1, directory: f.build,
    token: record.token, operation: 'verify', issuerPid: process.pid });
  try {
    assert.throws(() => acquireBuildWorkspace(f.build, 'compile'), /OWNER_MISMATCH/);
    const child = acquireBuildWorkspace(f.build, 'verify'); child.release();
  } finally { if (previous === undefined) delete process.env[BUILDER_DELEGATION_ENV]; else process.env[BUILDER_DELEGATION_ENV] = previous; owner.release(); }
});
