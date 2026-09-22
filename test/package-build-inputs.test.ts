import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectPackageInputs, capturePackageInputs, confirmPackageInputs, confirmPackageInputState, PACKAGE_INPUT_LIMITS } from '../src/PackageBuildInputs';
import { BuildInputRecording } from '../src/BuildInputRecording';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-package-inputs-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(root), /^aily-package-inputs-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const sdk = path.join(root, 'sdk'), tools = path.join(root, 'tools'), build = path.join(root, 'build'), source = path.join(root, 'source');
  for (const directory of [sdk, tools, build, source]) await fs.mkdir(directory);
  await fs.mkdir(path.join(sdk, 'include')); await fs.writeFile(path.join(sdk, 'include/driver.h'), 'version one');
  await fs.writeFile(path.join(tools, 'compiler.exe'), 'compiler bytes');
  await fs.writeFile(path.join(source, 'main.cpp'), 'void loop(){}');
  const platform = { 'runtime.platform.path': sdk, 'runtime.tools.vendor.path': tools };
  const select = () => selectPackageInputs(platform, build);
  return { root, sdk, tools, build, source, platform, select };
}

test('resolved configuration selects unversioned SDK/tools; evidence is compact and stable', async t => {
  const f = await fixture(t);
  const before = await capturePackageInputs(f.select());
  const reversed = { ...f.select(), roots: f.select().roots.reverse() };
  await confirmPackageInputs(before, reversed);
  const text = JSON.stringify(before.record);
  assert.equal(before.record.roots.length, 2);
  assert.equal(before.record.roots.reduce((n, root) => n + root.fileCount, 0), 2);
  assert.ok(text.length < 2048);
  assert.equal(text.includes(f.root), false); assert.equal(text.includes('driver.h'), false);
  await fs.writeFile(path.join(f.build, 'aily-build-inputs.json'), 'derived evidence');
  await confirmPackageInputs(before, f.select());
  assert.throws(() => selectPackageInputs({}, f.build), /SDK root/);
});

for (const change of ['content', 'addition', 'deletion', 'empty-directory', 'same-size-restored-mtime', 'temporary-restored-content']) {
  test(`package input check rejects ${change} without relying on a version label`, async t => {
    const f = await fixture(t), file = path.join(f.sdk, 'include/driver.h');
    const before = await capturePackageInputs(f.select()), stat = await fs.stat(file);
    if (change === 'addition') await fs.writeFile(path.join(f.tools, 'helper.dll'), 'new dependency');
    else if (change === 'deletion') await fs.unlink(file);
    else if (change === 'empty-directory') await fs.mkdir(path.join(f.sdk, 'empty'));
    else {
      await fs.writeFile(file, 'version two');
      if (change === 'temporary-restored-content') await fs.writeFile(file, 'version one');
      if (change !== 'content') await fs.utimes(file, stat.atime, stat.mtime);
    }
    await assert.rejects(confirmPackageInputs(before, f.select()), { code: 'BUILD_PACKAGE_INPUTS_CHANGED' });
  });
}

test('explicit aliases and nested declared roots deduplicate without losing their bindings', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'sdk-alias');
  await fs.symlink(f.sdk, alias, 'junction');
  f.platform['runtime.tools.inside.path'] = path.join(f.sdk, 'include');
  f.platform['runtime.platform.path'] = alias;
  const before = await capturePackageInputs(f.select());
  assert.equal(before.record.roots.length, 2);
  assert.equal(before.record.roots.reduce((n, root) => n + root.bindings.length, 0), 3);
  const other = path.join(f.root, 'other-sdk'); await fs.cp(f.sdk, other, { recursive: true });
  await fs.unlink(alias); await fs.symlink(other, alias, 'junction');
  await assert.rejects(confirmPackageInputState(before, f.select()), /bindings changed/);
});

test('package capture refuses output overlap, implicit links and missing/unresolved roots', async t => {
  const f = await fixture(t);
  await assert.rejects(capturePackageInputs({ ...f.select(), roots: [{ property: 'runtime.platform.path', path: f.root }] }), /overlaps/);
  await fs.symlink(f.tools, path.join(f.sdk, 'outside'), 'junction');
  await assert.rejects(capturePackageInputs(f.select()), /symlink\/junction/);
  await fs.unlink(path.join(f.sdk, 'outside'));
  for (const value of ['relative', '{runtime.missing.path}']) {
    await assert.rejects(capturePackageInputs({ ...f.select(), roots: [{ property: 'runtime.platform.path', path: value }] }), /unresolved/);
  }
  await assert.rejects(capturePackageInputs({ ...f.select(), roots: [{ property: 'runtime.platform.path', path: path.join(f.root, 'missing') }] }), { code: 'ENOENT' });
});

test('recreating a root alias back to its original target still invalidates the build', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias');
  await fs.symlink(f.sdk, alias, 'junction'); f.platform['runtime.platform.path'] = alias;
  const before = await capturePackageInputs(f.select());
  await new Promise(resolve => setTimeout(resolve, 15));
  await fs.unlink(alias); await fs.symlink(f.sdk, alias, 'junction');
  await assert.rejects(confirmPackageInputState(before, f.select()), /bindings changed/);
});

test('package budget limits fail instead of truncating file/root/directory/byte/depth coverage', async t => {
  const f = await fixture(t);
  for (const patch of [{ roots: 1 }, { files: 1 }, { directories: 1 }, { bytes: 1 }, { depth: 0 }]) {
    await assert.rejects(capturePackageInputs(f.select(), { ...PACKAGE_INPUT_LIMITS, ...patch }), /budget/);
  }
});

async function runPhases(recording: BuildInputRecording) {
  for (const name of ['sketch', 'libraries', 'core', 'link', 'objcopy']) await (await recording.beginPhase(name)).confirm();
}

test('phase recording binds one compact package record and rejects publication-time edits', async t => {
  const f = await fixture(t), select = () => ({ roots: [f.source], exclude: [f.build], configuration: { board: 'fixture' } });
  const recording = await BuildInputRecording.open(select, f.select);
  await runPhases(recording);
  const result = await recording.finish();
  assert.equal(result.packages?.roots.length, 2);
  assert.ok(result.phases?.every(phase => !Object.hasOwn(phase, 'packages')));
  await recording.confirmFinal();
  await fs.writeFile(path.join(f.sdk, 'include/driver.h'), 'changed after finish');
  await assert.rejects(recording.confirmFinal(), { code: 'BUILD_PACKAGE_INPUTS_CHANGED' });
});

test('SDK edit during a phase prevents successful final evidence even if sources did not change', async t => {
  const f = await fixture(t), select = () => ({ roots: [f.source], exclude: [f.build], configuration: {} });
  const recording = await BuildInputRecording.open(select, f.select);
  const first = await recording.beginPhase('sketch');
  await fs.writeFile(path.join(f.tools, 'compiler.exe'), 'other compiler');
  await first.confirm();
  for (const name of ['libraries', 'core', 'link', 'objcopy']) await (await recording.beginPhase(name)).confirm();
  await assert.rejects(recording.finish(), { code: 'BUILD_PACKAGE_INPUTS_CHANGED' });
});
