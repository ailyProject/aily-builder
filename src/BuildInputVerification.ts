import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { confirmBuildInputs, type BuildInputRecord, type BuildInputSelection, type BuildInputSnapshot } from './BuildInputRecord';
import { confirmPackageInputs, confirmPackageInputState, type PackageInputSelection, type PackageInputSnapshot } from './PackageBuildInputs';
import { withBuildWorkspace } from './BuildWorkspace';

export const INPUT_CONTEXT_FILE = 'aily-build-input-context.json';
export const INPUT_CONTEXT_LIMIT = 4 * 1024 * 1024;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'BUILD_INPUT_CONTEXT_INVALID' }); };
const hashValue = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Private, bounded resolution data. Never include this in Artifact.files or
 * trust its self-reported hash: the host must bind the bytes to a build it saw. */
export interface BuildInputContext {
  schemaVersion: 1;
  kind: 'aily-build-input-context';
  buildPath: string;
  preparedInputsDigest: string;
  selection: BuildInputSelection;
  snapshot: BuildInputSnapshot;
  phases: NonNullable<BuildInputRecord['phases']>;
  packages: { selection: PackageInputSelection; snapshot: PackageInputSnapshot };
}

function validate(context: BuildInputContext, buildPath: string, inputsDigest: string): void {
  if (context?.schemaVersion !== 1 || context.kind !== 'aily-build-input-context'
    || typeof context.buildPath !== 'string' || key(context.buildPath) !== key(buildPath)
    || context.preparedInputsDigest !== inputsDigest || !hashValue(inputsDigest)
    || context.packages?.selection?.buildPath !== context.buildPath
    || !Array.isArray(context.selection?.roots) || !context.selection.roots.length || context.selection.roots.length > 128
    || !context.selection.roots.every(value => typeof value === 'string' && path.isAbsolute(value))
    || !Array.isArray(context.selection.exclude) || context.selection.exclude.length !== 1
    || typeof context.selection.exclude[0] !== 'string'
    || key(context.selection.exclude[0]) !== key(buildPath)
    // Prepared files + external files + link directory/root states.
    || !Array.isArray(context.snapshot?.fileStates) || context.snapshot.fileStates.length > 8192
    || context.snapshot.record?.schemaVersion !== 1 || context.snapshot.record.kind !== 'aily-build-input-record'
    || !Array.isArray(context.packages?.snapshot?.states) || context.packages.snapshot.states.length > 32
    || context.packages.snapshot.record?.scope !== 'resolved-sdk-tool-trees'
    || JSON.stringify(context.selection.packages) !== JSON.stringify(context.packages.snapshot.record)
    || JSON.stringify(context.snapshot.record?.packages) !== JSON.stringify(context.packages.snapshot.record)
    || !Array.isArray(context.phases) || context.phases.some(phase => !phase)
    || JSON.stringify(context.phases.map(phase => phase.phase)) !== JSON.stringify(['sketch', 'libraries', 'core', 'link', 'objcopy'])) {
    fail('Input context does not match this build/record.');
  }
  const { digest, ...body } = context.snapshot.record;
  if (digest !== sha(JSON.stringify(body)) || sha(JSON.stringify({ ...body, phases: context.phases })) !== inputsDigest) {
    fail('Input context has inconsistent final/phase identities.');
  }
}

/** Called only after recording and final checks, while the compile owner lives.
 * The whole build directory is already excluded from the input tree. */
export async function publishBuildInputContext(context: BuildInputContext): Promise<string> {
  validate(context, await fs.realpath(context.buildPath), context.preparedInputsDigest);
  const bytes = Buffer.from(JSON.stringify(context));
  if (bytes.length > INPUT_CONTEXT_LIMIT) fail('Private input context exceeds 4 MiB.');
  const filename = path.join(context.buildPath, INPUT_CONTEXT_FILE), temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return sha(bytes);
}

async function readContext(buildPath: string, contextSha256: string, inputsDigest: string): Promise<BuildInputContext> {
  if (!hashValue(contextSha256) || !hashValue(inputsDigest)) fail('Expected context and input hashes are required.');
  const filename = path.join(buildPath, INPUT_CONTEXT_FILE), stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > INPUT_CONTEXT_LIMIT) fail('Unsafe/oversized input context.');
  const handle = await fs.open(filename, 'r');
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    // Some Windows Node versions return dev=0 for lstat, unlike fstat.
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino
      || (stat.dev !== 0 && opened.dev !== stat.dev) || opened.size !== stat.size) fail('Input context changed while opening.');
    // A concurrent growing file cannot allocate an unbounded readFile buffer.
    bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size || sha(bytes.subarray(0, size)) !== contextSha256) fail('Input context differs from the observed build.');
    bytes = bytes.subarray(0, size);
  } finally { await handle.close(); }
  const context = JSON.parse(bytes.toString('utf8'));
  validate(context, buildPath, inputsDigest);
  return context;
}

/** No recipe/hook/compiler execution; reuse the producer's exact checkers.
 * The caller owns the AppData read lease and supervises this bounded process.
 * This CLI/API result alone is NOT host authority or project acceptance. */
export async function verifyBuildInputContext(buildPath: string, contextSha256: string, inputsDigest: string) {
  return withBuildWorkspace(buildPath, 'verify', async () => {
    const directory = await fs.realpath(buildPath);
    const context = await readContext(directory, contextSha256, inputsDigest);
    await confirmBuildInputs(context.snapshot, context.selection);
    await confirmPackageInputs(context.packages.snapshot, context.packages.selection);
    // Cover changes to the early-read dependency/response files during SDK IO.
    await confirmBuildInputs(context.snapshot, context.selection);
    await confirmPackageInputState(context.packages.snapshot, context.packages.selection);
    await readContext(directory, contextSha256, inputsDigest);
    return { schemaVersion: 1, kind: 'aily-build-input-verification', status: 'inputs-current',
      scope: 'prepared-dependency-trees-and-sdk-tools', contextSha256, preparedInputsDigest: inputsDigest,
      currentProjectAcceptance: false } as const;
  });
}
