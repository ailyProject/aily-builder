import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recipeFileInputs } from '../src/RecipeFileInputs';
import { captureExternalBuildInputs } from '../src/ExternalBuildInputs';
import { captureBuildInputs, confirmBuildInputs, BuildInputSelection } from '../src/BuildInputRecord';
import { BuildInputRecording } from '../src/BuildInputRecording';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-link-inputs-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('aily-link-inputs-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const sdk = path.join(root, 'sdk libraries'), build = path.join(root, 'build'), source = path.join(root, 'source');
  for (const dir of [sdk, build, source]) await fs.mkdir(dir);
  await fs.writeFile(path.join(source, 'sketch.cpp'), 'void setup() {}');
  await fs.writeFile(path.join(sdk, 'libdevice.a'), 'archive');
  await fs.writeFile(path.join(sdk, 'memory.ld'), 'MEMORY {}');
  await fs.writeFile(path.join(build, 'link.rsp'), `-L"${sdk.replace(/\\/g, '/')}" -Wl,-T,memory.ld -ldevice`);
  const external = { cwd: build, recipes: ['@link.rsp'], tools: {}, searchPath: '' };
  const selection: BuildInputSelection = { roots: [source], exclude: [build], external, configuration: {} };
  return { root, sdk, build, source, external, selection };
}

test('inventories explicit link trees and scripts from nested response and forwarding syntax', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.build, 'outer.rsp'), '@link.rsp @link.rsp');
  f.external.recipes = ['-Wl,@outer.rsp -Xlinker -L -Xlinker "' + f.sdk + '"'];
  const { record } = await captureExternalBuildInputs(f.external);
  assert.equal(record.linkSearch?.roots.length, 1);
  assert.deepEqual(record.files.find(file => file.name === 'memory.ld')?.roles, ['link-script', 'link-search']);
  assert.deepEqual(record.files.find(file => file.name === 'libdevice.a')?.roles, ['link-search']);
  assert.equal(record.files.length, 4, 'Repeated responses preserve position without duplicate evidence.');
  assert.equal(JSON.stringify(record).includes(f.root), false);
});

test('GNU option forms and explicit sysroot retain only input directories/scripts', async t => {
  const f = await fixture(t);
  const result = await recipeFileInputs([[`--sysroot=${f.root}`, '--library-path', '=sdk libraries', '--script=memory.ld',
    '-Ttext=0x1000', '-Tdata', '0x2000', '-Tbss=0x3000', '-Ttext-segment=0x4000', '-o', 'ignored.bin']], f.build);
  assert.deepEqual(result, { directories: [f.sdk], scripts: [path.join(f.sdk, 'memory.ld')] });
  const joined = await recipeFileInputs([[`-L${f.sdk}`, '-Tmemory.ld']], f.build);
  assert.deepEqual(joined, result);
  await assert.rejects(recipeFileInputs([['-L=lib']], f.build), /explicit --sysroot/);
  await assert.rejects(recipeFileInputs([['-L%SDK_PATH%']], f.build), /unresolved/);
  await assert.rejects(recipeFileInputs([['-L']], f.build), /unresolved/);
});

test('script resolution uses cwd then preceding search directories, not following flags', async t => {
  const f = await fixture(t);
  await assert.rejects(recipeFileInputs([['-Tmemory.ld', `-L${f.sdk}`]], f.build), /Cannot resolve/);
  await fs.writeFile(path.join(f.build, 'memory.ld'), 'cwd script');
  const inputs = await recipeFileInputs([[`-L${f.sdk}`, '-Tmemory.ld']], f.build);
  assert.deepEqual(inputs.scripts, [path.join(f.build, 'memory.ld')]);
  assert.equal((await captureExternalBuildInputs(f.external)).record.files.filter(file => file.roles.includes('link-script')).length, 1);
});

for (const change of ['archive', 'script', 'added-candidate', 'deleted-candidate', 'nested-input']) {
  test(`detects ${change} even when the response file did not change`, async t => {
    const f = await fixture(t), before = await captureBuildInputs(f.selection);
    if (change === 'archive') await fs.writeFile(path.join(f.sdk, 'libdevice.a'), 'changed');
    if (change === 'script') await fs.writeFile(path.join(f.sdk, 'memory.ld'), 'MEMORY { changed }');
    if (change === 'added-candidate') await fs.writeFile(path.join(f.sdk, 'libdevice.so'), 'higher priority candidate');
    if (change === 'deleted-candidate') await fs.unlink(path.join(f.sdk, 'libdevice.a'));
    if (change === 'nested-input') {
      await fs.mkdir(path.join(f.sdk, 'custom'));
      await fs.writeFile(path.join(f.sdk, 'custom/without-extension'), 'script INCLUDE target');
    }
    await assert.rejects(confirmBuildInputs(before, f.selection), { code: 'BUILD_INPUTS_CHANGED' });
  });
}

test('missing search roots are represented and later creation invalidates identity', async t => {
  const f = await fixture(t), missing = path.join(f.root, 'not-installed');
  f.external.recipes.push(`-L"${missing}"`);
  const before = await captureBuildInputs(f.selection);
  assert.ok(before.record.external?.linkSearch?.roots.some(root => !root.present));
  await fs.mkdir(missing);
  await assert.rejects(confirmBuildInputs(before, f.selection), { code: 'BUILD_INPUTS_CHANGED' });
});

test('SDK link inputs cannot be edited between phases or during a phase', async t => {
  const f = await fixture(t), recording = await BuildInputRecording.open(() => f.selection);
  const phase = await recording.beginPhase('sketch');
  await phase.confirm();
  await fs.writeFile(path.join(f.sdk, 'libdevice.a'), 'edited by hook');
  await assert.rejects(recording.beginPhase('libraries'), /SDK link inputs changed/);
  const second = await BuildInputRecording.open(() => f.selection);
  const active = await second.beginPhase('sketch');
  await fs.writeFile(path.join(f.sdk, 'memory.ld'), 'changed in action');
  await assert.rejects(active.confirm(), /changed during compilation/);
});

test('explicit root aliases are bound; implicit nested links and build-tree overlap fail closed', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias');
  await fs.symlink(f.sdk, alias, 'junction');
  f.external.recipes = [`-L"${alias}"`];
  const before = await captureBuildInputs(f.selection);
  const replacement = path.join(f.root, 'replacement');
  await fs.cp(f.sdk, replacement, { recursive: true });
  await fs.unlink(alias); await fs.symlink(replacement, alias, 'junction');
  await assert.rejects(confirmBuildInputs(before, f.selection), /changed during compilation/);
  await fs.symlink(f.source, path.join(replacement, 'escape'), 'junction');
  await assert.rejects(captureBuildInputs(f.selection), /symlink\/junction/);
  await assert.rejects(captureExternalBuildInputs({ ...f.external, recipes: [`-L"${f.build}"`] }), /overlaps build outputs/);
  await assert.rejects(captureExternalBuildInputs({ ...f.external, recipes: [`-L"${f.root}"`] }), /overlaps build outputs/);
});

test('link search capture is stable across generated evidence and repeated builds', async t => {
  const f = await fixture(t), before = await captureBuildInputs(f.selection);
  await fs.writeFile(path.join(f.build, 'aily-build-inputs.json'), JSON.stringify(before.record));
  await fs.writeFile(path.join(f.build, 'generated.a'), 'generated output');
  assert.equal((await confirmBuildInputs(before, f.selection)).digest, before.record.digest);
  const recording = await BuildInputRecording.open(() => f.selection);
  for (const name of ['sketch', 'libraries', 'core', 'link', 'objcopy']) await (await recording.beginPhase(name)).confirm();
  assert.equal((await recording.finish()).phases?.length, 5);
  await recording.confirmFinal();
});

test('search trees fail on bounded file/root budgets instead of truncating', async t => {
  const f = await fixture(t);
  await assert.rejects(recipeFileInputs([Array.from({ length: 33 }, (_, n) => `-Ldir-${n}`)], f.build), /exceed 32/);
  await Promise.all(Array.from({ length: 1025 }, (_, n) => fs.writeFile(path.join(f.sdk, `${n}.a`), '')));
  await assert.rejects(captureExternalBuildInputs(f.external), /exceeds 1024/);
});

test('Windows case aliases do not create duplicate search identities', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const record = await captureExternalBuildInputs({ ...f.external, recipes: [`-L"${f.sdk}" -L"${f.sdk.toUpperCase()}"`] });
  assert.equal(record.record.linkSearch?.roots.length, 1);
  assert.equal(record.record.files.length, 2);
});
