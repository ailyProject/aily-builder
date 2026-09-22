import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PackageInputSelection {
  roots: Array<{ property: string; path: string }>;
  buildPath: string;
}
export interface PackageInputRecord {
  scope: 'resolved-sdk-tool-trees';
  verification: 'content-and-state-at-build-boundaries';
  roots: Array<{
    id: string; locationSha256: string;
    bindings: Array<{ property: string; requestedLocationSha256: string; resolvedLocationSha256: string }>;
    treeSha256: string; fileCount: number; directoryCount: number; sizeBytes: number;
  }>;
}
export const PACKAGE_INPUT_LIMITS = { roots: 32, files: 65536, directories: 16384, bytes: 8 * 1024 ** 3, depth: 64 } as const;
type Limits = { [K in keyof typeof PACKAGE_INPUT_LIMITS]: number };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const location = (value: string) => sha(key(value));
const state = (stat: Stats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'BUILD_PACKAGE_INPUTS_CHANGED' }); };
const propertyName = (value: string) => value === 'runtime.platform.path' || /^runtime\.tools\.[A-Za-z0-9_.@+-]{1,160}\.path$/.test(value);
function inside(root: string, value: string) {
  const relative = path.relative(root, value);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Read resolved configuration, never infer installed package content from a
 * version-looking directory name. Include all declared tool roots conservatively.
 */
export function selectPackageInputs(platform: Record<string, string>, buildPath: string): PackageInputSelection {
  const roots = Object.entries(platform || {}).filter(([property]) => propertyName(property))
    .map(([property, value]) => ({ property, path: value }));
  if (!roots.some(root => root.property === 'runtime.platform.path')) fail('Resolved SDK root is required for package evidence.');
  return { roots, buildPath };
}

async function resolveRoots(selection: PackageInputSelection, limits: Limits) {
  if (!selection.roots.length || selection.roots.length > limits.roots) fail('Package root count exceeds budget.');
  const build = await fs.realpath(selection.buildPath), names = new Set<string>();
  const bindings = [];
  for (const input of [...selection.roots].sort((a, b) => compare(a.property, b.property))) {
    if (!propertyName(input.property) || names.has(input.property) || typeof input.path !== 'string'
      || !path.isAbsolute(input.path) || /\{[^}]+\}|%[A-Za-z_][A-Za-z0-9_]*%/.test(input.path)) fail('Invalid/unresolved package root.');
    names.add(input.property);
    const requested = path.resolve(input.path), real = await fs.realpath(requested);
    if (!(await fs.stat(real)).isDirectory() || inside(real, build) || inside(build, real)) fail('Package tree overlaps build output or is not a directory.');
    bindings.push({ property: input.property, requestedLocationSha256: location(requested), resolvedLocationSha256: location(real),
      real, anchor: { requested, state: state(await fs.lstat(requested)) } });
  }
  if (!names.has('runtime.platform.path')) fail('Resolved SDK root is required for package evidence.');
  // Nested/aliased declarations share one outer tree without losing bindings.
  const unique = [...new Map(bindings.map(binding => [key(binding.real), binding.real])).values()];
  const roots = unique.filter(candidate => !unique.some(other => other !== candidate && inside(other, candidate))).sort(compare);
  return roots.map(directory => {
    const selected = bindings.filter(binding => inside(directory, binding.real));
    return { directory, bindings: selected.map(({ real: _real, anchor: _anchor, ...binding }) => binding),
      anchors: selected.map(binding => binding.anchor) };
  });
}

interface Entry { relative: string; type: 'file' | 'directory'; size: number; state: string }
interface Budget { files: number; directories: number; bytes: number }
async function inventory(directory: string, budget: Budget, limits: Limits): Promise<Entry[]> {
  const entries: Entry[] = [];
  const pending = [{ relative: '', depth: 0 }];
  let cursor = 0;
  while (cursor < pending.length) {
    const batch = pending.slice(cursor, cursor + 32); cursor += batch.length;
    const results = await Promise.allSettled(batch.map(async item => {
      if (item.depth > limits.depth) fail('Package tree exceeds depth budget.');
      const filename = path.join(directory, item.relative), stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) fail('Implicit package symlink/junction is unsupported; declare a resolved root.');
      if (!stat.isDirectory() && !stat.isFile()) fail('Unsupported package input type.');
      const entry: Entry = { relative: item.relative, type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? stat.size : 0, state: state(stat) };
      return { item, entry, children: stat.isDirectory() ? (await fs.readdir(filename)).sort(compare) : [] };
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    for (const result of results as PromiseFulfilledResult<any>[]) {
      const { item, entry, children } = result.value;
      if (entry.type === 'directory') {
        if (++budget.directories > limits.directories) fail('Package directory count exceeds budget.');
      } else if (++budget.files > limits.files || (budget.bytes += entry.size) > limits.bytes) fail('Package file/byte count exceeds budget.');
      entries.push(entry);
      const seen = new Set<string>();
      for (const child of children) {
        if (seen.has(child.toLowerCase()) || /[\\/:\x00-\x1f]/.test(child)) fail('Package paths are not portable/unambiguous.');
        seen.add(child.toLowerCase());
        const relative = item.relative ? `${item.relative}/${child}` : child;
        if (relative.length > 1024) fail('Package relative path exceeds budget.');
        pending.push({ relative, depth: item.depth + 1 });
        if (pending.length > limits.files + limits.directories) fail('Package entry count exceeds budget.');
      }
    }
  }
  return entries.sort((a, b) => compare(a.relative, b.relative));
}
const emptyBudget = (): Budget => ({ files: 0, directories: 0, bytes: 0 });
const inventoryDigest = (entries: Entry[]) => sha(JSON.stringify(entries));

async function hashTree(directory: string, entries: Entry[]): Promise<string> {
  const rows = new Array<string>(entries.length);
  let next = 0;
  // Small bounded I/O concurrency; no whole-file buffers or giant file tables
  // in the emitted evidence. Results retain deterministic traversal order.
  const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++, entry = entries[index];
      if (entry.type === 'directory') { rows[index] = JSON.stringify(['directory', entry.relative]); continue; }
      const filename = path.join(directory, entry.relative), hash = createHash('sha256');
      if (state(await fs.lstat(filename)) !== entry.state) fail(`Package input changed before hashing: ${entry.relative}`);
      let size = 0;
      for await (const bytes of createReadStream(filename, { highWaterMark: 1024 * 1024 })) {
        if ((size += bytes.length) > entry.size) fail('Package file grew beyond its captured size.');
        hash.update(bytes);
      }
      if (size !== entry.size) fail('Package file size changed while hashing.');
      if (state(await fs.lstat(filename)) !== entry.state) fail(`Package input changed while hashing: ${entry.relative}`);
      rows[index] = JSON.stringify(['file', entry.relative, entry.size, hash.digest('hex')]);
    }
  });
  const results = await Promise.allSettled(workers);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return sha(rows.join('\n'));
}

export interface PackageInputSnapshot { record: PackageInputRecord; states: string[]; bindings: string }
export async function capturePackageInputs(selection: PackageInputSelection, limits: Limits = PACKAGE_INPUT_LIMITS): Promise<PackageInputSnapshot> {
  const resolved = await resolveRoots(selection, limits), budget = emptyBudget();
  const roots: PackageInputRecord['roots'] = [], states: string[] = [];
  for (const [index, root] of resolved.entries()) {
    const entries = await inventory(root.directory, budget, limits);
    const treeSha256 = await hashTree(root.directory, entries);
    states.push(inventoryDigest(entries));
    roots.push({ id: `package-${index}`, locationSha256: location(root.directory), bindings: root.bindings,
      treeSha256, fileCount: entries.filter(entry => entry.type === 'file').length,
      directoryCount: entries.filter(entry => entry.type === 'directory').length,
      sizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0) });
  }
  const snapshot: PackageInputSnapshot = { record: { scope: 'resolved-sdk-tool-trees',
    verification: 'content-and-state-at-build-boundaries', roots }, states, bindings: JSON.stringify(resolved) };
  // Covers an early file changing while later files/roots were being read.
  await confirmPackageInputState(snapshot, selection, limits);
  return snapshot;
}

export async function confirmPackageInputState(before: PackageInputSnapshot, selection: PackageInputSelection, limits: Limits = PACKAGE_INPUT_LIMITS): Promise<void> {
  const resolved = await resolveRoots(selection, limits), budget = emptyBudget();
  if (JSON.stringify(resolved) !== before.bindings) fail('Resolved package root/alias bindings changed.');
  for (const [index, root] of resolved.entries()) {
    if (inventoryDigest(await inventory(root.directory, budget, limits)) !== before.states[index]) {
      fail(`Package files/directories changed during this build: ${root.bindings.map(binding => binding.property).join(', ')}. Wait for SDK/tool writes to finish, then rebuild.`);
    }
  }
}

export async function confirmPackageInputs(before: PackageInputSnapshot, selection: PackageInputSelection, limits: Limits = PACKAGE_INPUT_LIMITS): Promise<void> {
  // Metadata is an early rejection, never a persistent content-hash cache.
  await confirmPackageInputState(before, selection, limits);
  const after = await capturePackageInputs(selection, limits);
  if (JSON.stringify(before.record) !== JSON.stringify(after.record) || JSON.stringify(before.states) !== JSON.stringify(after.states)
    || before.bindings !== after.bindings) fail('Package contents changed during this build.');
}
