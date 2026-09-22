import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const BUILDER_DELEGATION_ENV = 'AILY_BUILDER_WORKSPACE';
export const WORKSPACE_MARKER = 'aily-workspace.lock';
export const BUILDER_MARKER = 'aily-builder.lock';
type Operation = 'compile' | 'preprocess' | 'clean' | 'verify';
const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
const exists = (filename: string) => {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const fault = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code });
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

function readRecord(filename: string) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) {
    throw fault('BUILD_WORKSPACE_INVALID', 'Unsafe owner record.');
  }
  const bytes = fs.readFileSync(filename, 'utf8');
  let record: any;
  try { record = JSON.parse(bytes); } catch { throw fault('BUILD_WORKSPACE_INVALID', 'Incomplete owner record.'); }
  if (record?.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1
    || !/^[a-f0-9-]{36}$/.test(record.token) || !['compile', 'preprocess', 'publish', 'clean', 'verify'].includes(record.operation)) {
    throw fault('BUILD_WORKSPACE_INVALID', 'Invalid owner record.');
  }
  return { record, stat, bytes };
}

function openDirectory(buildPath: string) {
  const requested = path.resolve(buildPath);
  fs.mkdirSync(requested, { recursive: true });
  if (fs.lstatSync(requested).isSymbolicLink()) throw fault('BUILD_WORKSPACE_INVALID', 'Build directory must not be a symlink/junction.');
  const directory = fs.realpathSync(requested), identity = fs.lstatSync(directory);
  const check = () => {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(identity, current)
      || canonical(fs.realpathSync(requested)) !== canonical(directory)) {
      throw fault('BUILD_WORKSPACE_CHANGED', 'Build directory changed.');
    }
  };
  check();
  return { directory, check };
}

/** Same cooperative protocol as the host, not an OS lock or authentication.
 * A dead owner is never stolen: compiler descendants may still be writing.
 */
export function acquireBuildWorkspace(buildPath: string, operation: Operation) {
  if (!['compile', 'preprocess', 'clean', 'verify'].includes(operation)) throw fault('BUILD_WORKSPACE_INVALID', 'Invalid Builder operation.');
  const workspace = openDirectory(buildPath);
  const ownerPath = path.join(workspace.directory, WORKSPACE_MARKER);
  const childPath = path.join(workspace.directory, BUILDER_MARKER);
  let parent: ReturnType<typeof readRecord> | undefined;
  let issuer: number | undefined;
  const delegation = process.env[BUILDER_DELEGATION_ENV];
  if (delegation !== undefined) {
    let grant: any;
    try { grant = JSON.parse(delegation); } catch { throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Invalid Builder delegation.'); }
    parent = readRecord(ownerPath);
    if (operation === 'clean' || grant?.schemaVersion !== 1 || grant.operation !== operation
      || typeof grant.directory !== 'string' || canonical(grant.directory) !== canonical(workspace.directory)
      || grant.token !== parent.record.token
      || !(parent.record.operation === operation || (parent.record.operation === 'compile' && operation === 'preprocess'))
      || !Number.isSafeInteger(grant.issuerPid) || grant.issuerPid < 1 || !alive(grant.issuerPid) || !alive(parent.record.pid)) {
      throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Builder delegation does not match the live workspace and operation.');
    }
    issuer = grant.issuerPid;
  }
  const filename = parent ? childPath : ownerPath;
  let descriptor: number;
  try { descriptor = fs.openSync(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous: any;
    try { previous = readRecord(filename).record; } catch { /* Invalid markers are also exclusive. */ }
    throw fault(previous && !alive(previous.pid) ? 'BUILD_WORKSPACE_RECOVERY_REQUIRED' : 'BUILD_WORKSPACE_BUSY',
      'Build output is owned by another operation. Do not remove its marker until its entire process tree is confirmed stopped.');
  }
  const record = { schemaVersion: 1, pid: process.pid, token: randomUUID(), operation, startedAt: new Date().toISOString(),
    ...(parent ? { ownerToken: parent.record.token, supervisor: parent.record.supervisor } : {}) };
  try { fs.writeFileSync(descriptor, JSON.stringify(record)); } finally { fs.closeSync(descriptor); }
  const owner = readRecord(filename);
  let released = false;
  const assertOwned = () => {
    workspace.check();
    if (released) throw fault('BUILD_WORKSPACE_CHANGED', 'Workspace was already released.');
    const current = readRecord(filename);
    if (!sameFile(owner.stat, current.stat) || owner.bytes !== current.bytes) throw fault('BUILD_WORKSPACE_CHANGED', 'Owner record changed.');
    if (parent) {
      const currentParent = readRecord(ownerPath);
      if (!sameFile(parent.stat, currentParent.stat) || parent.bytes !== currentParent.bytes || !alive(parent.record.pid) || !alive(issuer!)) {
        throw fault('BUILD_WORKSPACE_CHANGED', 'Delegating host changed or exited.');
      }
    } else if (exists(childPath)) {
      throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', 'A delegated Builder marker remains; verified process-tree cleanup is required.');
    }
  };
  try { assertOwned(); }
  catch (error) {
    // Only our newly-created primary marker may be rolled back; never remove a
    // lingering child marker or another owner's record.
    if (!parent && fs.readFileSync(filename, 'utf8') === owner.bytes) fs.unlinkSync(filename);
    throw error;
  }
  return {
    directory: workspace.directory,
    operation,
    assertOwned,
    release: () => { if (released) return; assertOwned(); fs.unlinkSync(filename); released = true; },
  };
}

type Lease = ReturnType<typeof acquireBuildWorkspace>;
const active = new AsyncLocalStorage<Lease>();
let processLease: Lease | undefined;

export function assertBuildOutputPath(buildPath: string, configuredPath = process.env.BUILD_PATH): void {
  if (configuredPath && canonical(fs.realpathSync(configuredPath)) !== canonical(fs.realpathSync(buildPath))) {
    throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Configured BUILD_PATH is outside the owned build directory.');
  }
}

export async function withBuildOutputPath<T>(buildPath: string, action: () => Promise<T>): Promise<T> {
  assertBuildOutputPath(buildPath);
  const previous = process.env.BUILD_PATH;
  process.env.BUILD_PATH = path.resolve(buildPath);
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.BUILD_PATH; else process.env.BUILD_PATH = previous; }
}

/** CLI scope includes log/result writes. Public compiler APIs share that scope;
 * compile's internal preprocess is reentrant, unrelated calls are not.
 */
export async function withBuildWorkspace<T>(buildPath: string, operation: Operation, action: () => Promise<T>): Promise<T> {
  const current = active.getStore();
  if (current) {
    if (canonical(fs.realpathSync(buildPath)) !== canonical(current.directory)
      || !(current.operation === operation || (current.operation === 'compile' && operation === 'preprocess'))) {
      throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Nested build changed workspace or operation.');
    }
    current.assertOwned();
    return action();
  }
  // The legacy compiler uses process.env for recipe expansion. Separate CLI
  // processes may build different directories concurrently; in-process callers
  // must not interleave those global environments.
  if (processLease) throw fault('BUILD_WORKSPACE_BUSY', 'Another build in this process owns the compiler environment.');
  const lease = acquireBuildWorkspace(buildPath, operation);
  processLease = lease;
  try {
    // Direct writers invalidate old success tickets even if this invocation
    // fails early. Host delegation already invalidates before preparing input.
    if (!process.env[BUILDER_DELEGATION_ENV] && ['compile', 'preprocess'].includes(operation)) {
      for (const name of ['aily-artifact-manifest.json', 'aily-build-delivery.json', 'aily-build-input-context.json']) {
        fs.rmSync(path.join(lease.directory, name), { force: true });
      }
    }
    return await active.run(lease, action);
  } finally {
    try { lease.release(); } finally { processLease = undefined; }
  }
}

/** Keep the directory and owner alive until cleanup finishes. Removing the
 * directory would create a window in which a second writer could acquire it.
 */
export async function cleanBuildWorkspace(buildPath: string): Promise<void> {
  await withBuildWorkspace(buildPath, 'clean', async () => {
    const lease = active.getStore()!;
    for (const name of fs.readdirSync(lease.directory)) {
      lease.assertOwned();
      if (name !== WORKSPACE_MARKER) fs.rmSync(path.join(lease.directory, name), { recursive: true, force: true });
    }
  });
}
