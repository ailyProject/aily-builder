import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { acquireBuildWorkspace, withBuildWorkspace, cleanBuildWorkspace, BUILDER_DELEGATION_ENV } from '../src/BuildWorkspace';
import { ArduinoCompiler } from '../src/ArduinoCompiler';
import { Logger } from '../src/utils/Logger';

const cli = path.resolve(__dirname, '../dist/main.js');
const leaseModule = path.resolve(__dirname, '../dist/src/BuildWorkspace.js');
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-builder-owner-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^aily-builder-owner-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const build = path.join(root, '.build'); fs.mkdirSync(build);
  return { root, build, marker: path.join(build, 'aily-workspace.lock'), child: path.join(build, 'aily-builder.lock') };
}
function invoke(args: string[], env = process.env) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}
function delegate(t: any, f: ReturnType<typeof fixture>, operation = 'compile') {
  const previous = process.env[BUILDER_DELEGATION_ENV];
  t.after(() => { if (previous === undefined) delete process.env[BUILDER_DELEGATION_ENV]; else process.env[BUILDER_DELEGATION_ENV] = previous; });
  const owner = { schemaVersion: 1, pid: process.pid, token: randomUUID(), operation };
  fs.writeFileSync(f.marker, JSON.stringify(owner));
  process.env[BUILDER_DELEGATION_ENV] = JSON.stringify({ schemaVersion: 1, directory: fs.realpathSync(f.build),
    token: owner.token, operation, issuerPid: process.pid });
  return owner;
}

test('public compile/preprocess/clean and their CLI refuse an existing owner before writing', async t => {
  const f = fixture(t), owner = acquireBuildWorkspace(f.build, 'compile');
  const sentinels = ['aily-builder.log', 'aily-preprocess.log', 'aily-artifact-manifest.json', 'aily-build-delivery.json', 'firmware.elf'];
  for (const name of sentinels) fs.writeFileSync(path.join(f.build, name), 'preserve');
  const bytes = fs.readFileSync(f.marker);
  const compiler = new ArduinoCompiler(new Logger());
  const options = { buildPath: f.build, sketchPath: path.join(f.root, 'missing.ino'), board: 'test:test:test' };
  for (const method of ['compile', 'preprocess'] as const) {
    await assert.rejects(compiler[method](options), /BUILD_WORKSPACE_BUSY/);
    const result = invoke([method, options.sketchPath, '--build-path', f.build, '--log-file']);
    assert.equal(result.status, 1, result.stdout); assert.match(result.stderr, /BUILD_WORKSPACE_BUSY/);
  }
  await assert.rejects(compiler.clean(f.build), /BUILD_WORKSPACE_BUSY/);
  const result = invoke(['clean', f.build]);
  assert.equal(result.status, 1); assert.match(result.stderr, /BUILD_WORKSPACE_BUSY/);
  for (const name of sentinels) assert.equal(fs.readFileSync(path.join(f.build, name), 'utf8'), 'preserve');
  assert.deepEqual(fs.readFileSync(f.marker), bytes); owner.release();
});

test('normal CLI failure releases the lease and revokes previous successful tickets', t => {
  const f = fixture(t);
  for (const operation of ['compile', 'preprocess']) {
    for (const name of ['aily-artifact-manifest.json', 'aily-build-delivery.json']) fs.writeFileSync(path.join(f.build, name), 'old');
    const result = invoke([operation, path.join(f.root, 'missing.ino'), '--build-path', f.build, '--log-file']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(fs.existsSync(path.join(f.build, 'aily-artifact-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(f.build, 'aily-build-delivery.json')), false);
  }
});

test('clean empties contents while preserving the directory identity and only then releases', async t => {
  const f = fixture(t), before = fs.statSync(f.build);
  fs.mkdirSync(path.join(f.build, 'nested')); fs.writeFileSync(path.join(f.build, 'nested/a'), 'old');
  await cleanBuildWorkspace(f.build);
  assert.equal(fs.statSync(f.build).ino, before.ino);
  assert.deepEqual(fs.readdirSync(f.build), []);
  assert.equal(invoke(['clean', f.build]).status, 0);
});

test('internal preprocess reuses compile scope; unrelated calls remain exclusive', async t => {
  const f = fixture(t);
  await withBuildWorkspace(f.build, 'compile', async () => {
    const bytes = fs.readFileSync(f.marker);
    await withBuildWorkspace(f.build, 'preprocess', async () => assert.deepEqual(fs.readFileSync(f.marker), bytes));
    await assert.rejects(withBuildWorkspace(f.build, 'clean', async () => {}), /OWNER_MISMATCH/);
    assert.throws(() => acquireBuildWorkspace(f.build, 'compile'), /BUSY/);
  });
  assert.equal(fs.existsSync(f.marker), false);
});

test('delegated Builder owns one child phase, not the host owner', t => {
  const f = fixture(t), parent = delegate(t, f), parentBytes = fs.readFileSync(f.marker);
  const lease = acquireBuildWorkspace(f.build, 'compile');
  assert.equal(JSON.parse(fs.readFileSync(f.child, 'utf8')).ownerToken, parent.token);
  assert.throws(() => acquireBuildWorkspace(f.build, 'compile'), /BUSY/);
  assert.throws(() => acquireBuildWorkspace(f.build, 'clean'), /OWNER_MISMATCH/);
  lease.release(); assert.equal(fs.existsSync(f.child), false);
  assert.deepEqual(fs.readFileSync(f.marker), parentBytes);
});

test('delegation binds workspace, operation, live owner and issuer; it cannot redirect', t => {
  const f = fixture(t); delegate(t, f);
  const grant = JSON.parse(process.env[BUILDER_DELEGATION_ENV]!);
  for (const patch of [{ token: randomUUID() }, { operation: 'preprocess' }, { directory: f.root }, { issuerPid: -1 }]) {
    process.env[BUILDER_DELEGATION_ENV] = JSON.stringify({ ...grant, ...patch });
    assert.throws(() => acquireBuildWorkspace(f.build, 'compile'), /OWNER_MISMATCH/);
    assert.equal(fs.existsSync(f.child), false);
  }
});

test('changed owner prevents delegated release and leaves evidence for verified cleanup', t => {
  const f = fixture(t); delegate(t, f);
  const lease = acquireBuildWorkspace(f.build, 'compile');
  const bytes = fs.readFileSync(f.marker); fs.writeFileSync(f.marker, bytes.toString().replace('compile', 'preprocess'));
  assert.throws(lease.release, /BUILD_WORKSPACE_CHANGED/);
  assert.ok(fs.existsSync(f.child)); fs.writeFileSync(f.marker, bytes); lease.release();
});

test('dead primary and orphan child records are never automatically reclaimed', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).acquireBuildWorkspace(process.argv[2],"compile");', leaseModule, f.build],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const bytes = fs.readFileSync(f.marker);
  assert.throws(() => acquireBuildWorkspace(f.build, 'compile'), /RECOVERY_REQUIRED/);
  assert.deepEqual(fs.readFileSync(f.marker), bytes);
  fs.unlinkSync(f.marker); fs.writeFileSync(f.child, 'incomplete');
  assert.throws(() => acquireBuildWorkspace(f.build, 'compile'), /RECOVERY_REQUIRED/);
  assert.equal(fs.readFileSync(f.child, 'utf8'), 'incomplete'); assert.equal(fs.existsSync(f.marker), false);
});

test('links and malformed owner records cannot bypass exclusivity', t => {
  const f = fixture(t), target = path.join(f.root, 'target'); fs.writeFileSync(target, 'keep');
  fs.linkSync(target, f.marker); assert.throws(() => acquireBuildWorkspace(f.build, 'compile'), /BUSY/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep'); fs.unlinkSync(f.marker);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.build, alias, 'junction');
  assert.throws(() => acquireBuildWorkspace(alias, 'compile'), /symlink\/junction/);
});

test('real competing Builder processes acquire exactly one owner', async t => {
  const f = fixture(t);
  const code = 'try{const l=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],"compile");process.send("acquired");process.once("message",()=>{l.release();process.exit(0)});}catch(e){process.send(e.code);process.exit(0)}';
  const children = Array.from({ length: 5 }, () => spawn(process.execPath, ['-e', code, leaseModule, f.build],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const closed = children.map(child => once(child, 'close'));
  const results = await Promise.all(children.map(child => once(child, 'message').then(([message]) => message)));
  assert.equal(results.filter(value => value === 'acquired').length, 1);
  assert.equal(results.filter(value => value === 'BUILD_WORKSPACE_BUSY').length, 4);
  children[results.indexOf('acquired')].send('release'); await Promise.all(closed);
  assert.equal(fs.existsSync(f.marker), false);
});

test('saved preprocessing environment cannot redirect CLI build output', t => {
  const f = fixture(t), other = path.join(f.root, 'other'); fs.mkdirSync(other);
  const cache = path.join(f.root, 'preprocess.json');
  fs.writeFileSync(cache, JSON.stringify({ success: true, envVars: { BUILD_PATH: other } }));
  const result = invoke(['compile', path.join(f.root, 'missing.ino'), '--build-path', f.build, '--preprocess-result', cache]);
  assert.equal(result.status, 1); assert.match(result.stderr, /BUILD_WORKSPACE_OWNER_MISMATCH/);
  assert.deepEqual(fs.readdirSync(other), []); assert.equal(fs.existsSync(f.marker), false);
});

test('preprocess failure waits for its outstanding sibling before releasing workspace', async t => {
  const f = fixture(t), compiler = new ArduinoCompiler(new Logger()) as any;
  let finish: (value: any[]) => void;
  const pending = new Promise<any[]>(resolve => { finish = resolve; });
  compiler.validateSketch = async () => {};
  compiler.analyzer.extractMacrosFromSketch = async () => [];
  compiler.arduinoConfigParser.parseByFQBN = async () => ({});
  compiler.runGlobalPrebuild = async () => {};
  compiler.compileConfigManager.parseCompileConfig = async () => { throw new Error('expected config failure'); };
  compiler.analyzer.preprocess = async () => pending;
  let finished = false;
  const result = compiler.preprocess({ buildPath: f.build, sketchPath: 'fixture.ino', board: 'test:test:test' })
    .then((value: any) => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.ok(fs.existsSync(f.marker));
  assert.throws(() => acquireBuildWorkspace(f.build, 'clean'), /BUSY/);
  finish!([]); assert.equal((await result).success, false);
  assert.equal(fs.existsSync(f.marker), false);
});

test('independent in-process builds cannot interleave global recipe environments', async t => {
  const f = fixture(t), other = path.join(f.root, 'other');
  let finish: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const first = withBuildWorkspace(f.build, 'compile', () => pending);
  await assert.rejects(withBuildWorkspace(other, 'compile', async () => {}), /BUILD_WORKSPACE_BUSY/);
  assert.equal(fs.existsSync(other), false);
  finish!(); await first;
  await withBuildWorkspace(other, 'compile', async () => {});
});

test('public API refuses an ambient BUILD_PATH outside its lease', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const previous = process.env.BUILD_PATH; process.env.BUILD_PATH = outside;
  try {
    const compiler = new ArduinoCompiler(new Logger());
    for (const method of ['compile', 'preprocess'] as const) {
      await assert.rejects(compiler[method]({ buildPath: f.build, sketchPath: 'missing.ino', board: 'test:test:test' }), /OWNER_MISMATCH/);
      assert.equal(fs.existsSync(f.marker), false); assert.deepEqual(fs.readdirSync(outside), []);
    }
  } finally { if (previous === undefined) delete process.env.BUILD_PATH; else process.env.BUILD_PATH = previous; }
});

test('public API binds an absent output environment for the operation and restores it', async t => {
  const f = fixture(t), compiler = new ArduinoCompiler(new Logger()) as any;
  const previous = process.env.BUILD_PATH; delete process.env.BUILD_PATH;
  compiler.preprocessInternal = async () => {
    assert.equal(process.env.BUILD_PATH, f.build);
    return { success: true, preprocessTime: 0 };
  };
  try {
    assert.equal((await compiler.preprocess({ buildPath: f.build, sketchPath: 'test.ino', board: 'test:test:test' })).success, true);
    assert.equal(process.env.BUILD_PATH, undefined);
  } finally { if (previous !== undefined) process.env.BUILD_PATH = previous; }
});
