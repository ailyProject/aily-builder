import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import { captureExternalBuildInputs, type ExternalInputSelection, type ExternalInputRecord } from './ExternalBuildInputs';
import type { PackageInputRecord } from './PackageBuildInputs';

export interface BuildInputRecord {
  schemaVersion: 1;
  kind: 'aily-build-input-record';
  scope: 'prepared-dependency-trees';
  configurationSha256: string;
  roots: Array<{ id: string; locationSha256: string; files: Array<{ path: string; sizeBytes: number; sha256: string }> }>;
  external?: ExternalInputRecord;
  packages?: PackageInputRecord;
  phases?: Array<{ phase: 'sketch' | 'libraries' | 'core' | 'link' | 'objcopy'; external: ExternalInputRecord }>;
  digest: string;
}
export interface BuildInputSelection { roots: string[]; exclude: string[]; configuration: unknown; external?: ExternalInputSelection; packages?: PackageInputRecord }
export interface BuildInputSnapshot { record: BuildInputRecord; fileStates: string[] }
const MAX_FILES = 4096;
const MAX_BYTES = 256 * 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'BUILD_INPUTS_CHANGED' });
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function state(stat: import('fs').Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

/** Hash prepared trees plus explicit recipe response files and tool executables.
 * This is partial build provenance, NOT complete current-project freshness:
 * implicit SDK headers/archives, executable dependencies, hooks and host authority
 * still require a complete snapshot/lease contract.
 */
export async function captureBuildInputs(selection: BuildInputSelection): Promise<BuildInputSnapshot> {
  const excluded = await Promise.all(selection.exclude.map(value => fs.realpath(value)));
  const paths = [...new Set(await Promise.all(selection.roots.map(value => fs.realpath(value))))].sort();
  if (!paths.length || paths.length > 128) fail('Build input roots must contain 1–128 directories.');
  const roots: BuildInputRecord['roots'] = [];
  const fileStates: string[] = [];
  let bytes = 0, count = 0;
  for (const [index, root] of paths.entries()) {
    if (!(await fs.stat(root)).isDirectory() || excluded.some(value => inside(value, root))) fail('Invalid build input root.');
    const files: BuildInputRecord['roots'][number]['files'] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64) fail('Build input tree exceeds depth limit.');
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const filename = path.join(directory, entry.name);
        if (excluded.some(value => inside(value, filename))) continue;
        const real = await fs.realpath(filename);
        if (!inside(root, real) || entry.isSymbolicLink()) fail('Build input symlink/junction requires an explicit root; implicit traversal refused.');
        if (entry.isDirectory()) { await visit(filename, depth + 1); continue; }
        const before = await fs.stat(filename);
        const relative = path.relative(root, filename).split(path.sep).join('/');
        if (!before.isFile() || relative.length > 512) fail('Invalid build input file.');
        if (++count > MAX_FILES || (bytes += before.size) > MAX_BYTES) fail('Build inputs exceed bounded capture budget.');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(filename)) hash.update(chunk);
        const after = await fs.stat(filename);
        if (state(before) !== state(after)) fail('Build input changed while hashing.');
        files.push({ path: relative, sizeBytes: after.size, sha256: hash.digest('hex') });
        fileStates.push(`${index}/${relative}:${state(after)}`);
      }
    };
    await visit(root, 0);
    roots.push({ id: `root-${index}`, locationSha256: digest(process.platform === 'win32' ? root.toLowerCase() : root), files });
  }
  const external = selection.external ? await captureExternalBuildInputs(selection.external) : undefined;
  if (external) fileStates.push(...external.states);
  const body = { schemaVersion: 1 as const, kind: 'aily-build-input-record' as const,
    scope: 'prepared-dependency-trees' as const, configurationSha256: digest(JSON.stringify(stable(selection.configuration))), roots,
    ...(external ? { external: external.record } : {}), ...(selection.packages ? { packages: selection.packages } : {}) };
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 1024 * 1024) fail('Build input record exceeds the 1 MiB manifest budget.');
  return { record: { ...body, digest: digest(encoded) }, fileStates };
}

export async function confirmBuildInputs(before: BuildInputSnapshot, selection: BuildInputSelection): Promise<BuildInputRecord> {
  const after = await captureBuildInputs(selection);
  if (before.record.digest !== after.record.digest || JSON.stringify(before.fileStates) !== JSON.stringify(after.fileStates)) {
    fail('Build inputs changed during compilation; discard this build and compile again.');
  }
  return after.record;
}
