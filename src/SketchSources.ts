import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { constants } from 'fs';

export const USER_SKETCH_DEPENDENCY_NAME = '__user_sketch__';
export const SKETCH_SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.S', '.s']);
export const SKETCH_HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx', '.inc']);
export interface SketchInputs {
  schemaVersion: 1;
  scope: 'arduino-sketch-inputs';
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  digest: string;
}
export interface SketchSourceIdentity { entryPath: string; entrySha256: string; sketchInputs: SketchInputs; }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const state = (stat: any) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const safeRelative = (value: string) => value.length <= 512 && value.split('/').length <= 64 && !/[\\\x00-\x1f\x7f:]/.test(value);
const fail = (message: string): never => { throw new Error(`Unsafe or invalid sketch inputs: ${message}`); };

/** Do not follow source links: a copied sketch is a closed compilation boundary. */
export async function readSketchInput(filename: string, maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail('source is not a bounded regular file');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await fs.fstat(handle);
    if (!stat.isFile() || stat.ino !== before.ino || (before.dev && stat.dev !== before.dev) || stat.size !== before.size
      || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs || stat.size > maxBytes) fail('source is not a bounded regular file');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await fs.read(handle, bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await fs.fstat(handle);
    if (size !== stat.size || state(after) !== state(stat) || state(await fs.lstat(filename)) !== state(before)) fail('source changed while reading');
    return bytes.subarray(0, size);
  } finally { await fs.close(handle); }
}

/** Arduino compiles direct files plus src/**; other directories are not units. */
export async function collectSketchFiles(sourceRoot: string, states?: Map<string, string>): Promise<string[]> {
  const root = path.resolve(sourceRoot);
  const configuredBuild = process.env['BUILD_PATH'] ? path.resolve(process.env['BUILD_PATH']) : undefined;
  if (configuredBuild === root) fail('build output directory cannot equal the sketch source root');
  const buildRelative = configuredBuild ? path.relative(root, configuredBuild) : undefined;
  const excludedBuild = buildRelative && buildRelative !== '..' && !buildRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(buildRelative) ? configuredBuild : undefined;
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) fail('sketch root is linked');
  const files: string[] = [];
  let entries = 0, directories = 0;
  const visit = async (directory: string, translationUnits: boolean): Promise<void> => {
    const before = await fs.lstat(directory);
    for (const name of (await fs.readdir(directory)).sort(compare)) {
      if (++entries > 16384) fail('too many source entries');
      const filename = path.join(directory, name);
      if (filename === excludedBuild) continue;
      const relative = path.relative(root, filename).replace(/\\/g, '/');
      if (!safeRelative(relative)) fail('source path exceeds budget or contains unsupported characters');
      const stat = await fs.lstat(filename);
      const eligible = (translationUnits || directory === root) && SKETCH_SOURCE_EXTENSIONS.has(path.extname(name)) || SKETCH_HEADER_EXTENSIONS.has(path.extname(name));
      if (stat.isSymbolicLink()) {
        fail(`linked source or directory: ${path.relative(root, filename)}`);
      }
      if (stat.isDirectory()) {
        if (++directories > 4096) fail('too many source directories');
        if (path.relative(root, filename).length > 512 || path.relative(root, filename).split(path.sep).length > 64) fail('source directory path exceeds budget');
        await visit(filename, translationUnits || (directory === root && name === 'src'));
      } else if (eligible) {
        if (!stat.isFile()) fail('source is not a regular file');
        files.push(filename);
        states?.set(filename, state(stat));
        if (path.relative(root, filename).length > 512 || path.relative(root, filename).split(path.sep).length > 64) fail('source path exceeds budget');
        if (files.length > 4096) fail('too many source files');
      }
    }
    const after = await fs.lstat(directory);
    if (state(before) !== state(after)) fail('source directory changed during capture');
    states?.set(directory, state(after));
  };
  await visit(root, false);
  return files.sort((a, b) => compare(path.relative(root, a).replace(/\\/g, '/'), path.relative(root, b).replace(/\\/g, '/')));
}

export async function collectUserSketchSources(sketchPath = process.env['SKETCH_PATH']): Promise<string[]> {
  if (!sketchPath) return [];
  const entry = path.resolve(sketchPath);
  return (await collectSketchFiles(path.dirname(entry))).filter(filename => filename !== entry && SKETCH_SOURCE_EXTENSIONS.has(path.extname(filename)));
}

export async function captureSketchSourceIdentity(sketchPath: string): Promise<SketchSourceIdentity> {
  const entry = path.resolve(sketchPath), root = path.dirname(entry);
  const files: SketchInputs['files'] = [];
  let total = 0;
  const states = new Map<string, string>();
  for (const filename of await collectSketchFiles(root, states)) {
    if (filename === entry) continue;
    const bytes = await readSketchInput(filename);
    total += bytes.length;
    if (total > 16 * 1024 * 1024) fail('source inventory exceeds size budget');
    files.push({ path: path.relative(root, filename).replace(/\\/g, '/'), sizeBytes: bytes.length, sha256: hash(bytes) });
  }
  const entrySha256 = hash(await readSketchInput(entry, 128 * 1024 * 1024));
  for (const [filename, expected] of states) {
    if (state(await fs.lstat(filename)) !== expected) fail('source tree changed during capture');
  }
  const body = { schemaVersion: 1 as const, scope: 'arduino-sketch-inputs' as const, files };
  return { entryPath: entry, entrySha256, sketchInputs: { ...body, digest: hash(JSON.stringify(body)) } };
}

export function sameSketchSourceIdentity(left: SketchSourceIdentity | undefined, right: SketchSourceIdentity): boolean {
  return !!left && left.entryPath === right.entryPath && left.entrySha256 === right.entrySha256 && JSON.stringify(left.sketchInputs) === JSON.stringify(right.sketchInputs);
}

export function normalizeSketchInputs(value: SketchInputs): SketchInputs {
  if (!value || value.schemaVersion !== 1 || value.scope !== 'arduino-sketch-inputs' || !Array.isArray(value.files)
    || value.files.length > 4096 || Object.keys(value).some(key => !['schemaVersion', 'scope', 'files', 'digest'].includes(key))) fail('invalid inventory');
  const files = value.files.map(file => {
    if (!file || Object.keys(file).some(key => !['path', 'sizeBytes', 'sha256'].includes(key)) || typeof file.path !== 'string'
      || !file.path || file.path.length > 512 || file.path.split('/').length > 64 || /[\\\x00-\x1f\x7f:]/.test(file.path) || path.posix.isAbsolute(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || (SKETCH_SOURCE_EXTENSIONS.has(path.posix.extname(file.path)) && file.path.includes('/') && !file.path.startsWith('src/'))
      || (!SKETCH_SOURCE_EXTENSIONS.has(path.posix.extname(file.path)) && !SKETCH_HEADER_EXTENSIONS.has(path.posix.extname(file.path)))
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 4 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('invalid inventory file');
    return { path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 };
  });
  if (files.some((file, i) => i > 0 && compare(files[i - 1].path, file.path) >= 0)
    || files.reduce((sum, file) => sum + file.sizeBytes, 0) > 16 * 1024 * 1024) fail('invalid inventory ordering or size');
  const body = { schemaVersion: 1 as const, scope: 'arduino-sketch-inputs' as const, files };
  if (value.digest !== hash(JSON.stringify(body))) fail('inventory digest mismatch');
  return { ...body, digest: value.digest };
}
