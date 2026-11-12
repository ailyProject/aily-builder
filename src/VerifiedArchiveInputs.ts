import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import type { Dependency } from './DependencyAnalyzer';
import { toHostPathKey } from './utils/HostPlatform';

const MAX_INPUT_ENTRIES = 50000;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_RESPONSE_FILES = 64;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ARCHIVE_SOURCE = /\.(?:c|cc|cpp|cxx|s)$/i;
const COMPILER_WORD = /(?:[^\s"']|"(?:\\["]|[^"])*"|'[^']*')+/g;

/** Strip only a standalone driver option. Preserve literals and options passed
 * through to the preprocessor, which verified preparation rejects if unsafe. */
export function withoutUserHeaderDepfileOption(command: string): string {
  let forwarded = false;
  return command.replace(COMPILER_WORD, word => {
    const remove = !forwarded && /^(?:-MMD|"-MMD"|'-MMD')$/.test(word);
    forwarded = /^(?:-Xpreprocessor|"-Xpreprocessor"|'-Xpreprocessor')$/.test(word);
    return remove ? '' : word;
  });
}

export function usesVerifiedLocalArchiveCache(): boolean {
  return process.env.AILY_BUILDER_VERIFIED_LOCAL_ARCHIVE_CACHE === '1';
}

function pathKey(filePath: string): string {
  return toHostPathKey(path.resolve(filePath));
}

export interface VerifiedArchiveInputs {
  fingerprint: string;
  covers(filePath: string): boolean;
  pathIdentity(filePath: string): string;
  compilerPathMapFlags: string[];
  timings: { compilerMs: number; hashingMs: number; files: number; reused: number };
}

export type VerifiedInputMemo = Map<string, { stamp: string; digest: string }>;

interface ResponseFile {
  file: string;
  data: Buffer;
}

interface CompilerPathMap {
  physicalRoot: string;
  logicalRoot: string;
  prefixes: string[];
  flags: string[];
}

function forwardSlashes(filePath: string): string {
  return process.platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath;
}

function isWithinRoot(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function readCompilerPathMap(cwd: string): Promise<CompilerPathMap | undefined> {
  const setting = process.env.AILY_BUILDER_VERIFIED_ARCHIVE_PATH_MAP;
  if (setting === undefined) return undefined;
  const map = JSON.parse(setting);
  const safeRoot = (value: unknown): value is string => typeof value === 'string' &&
    path.isAbsolute(value) && path.parse(path.resolve(value)).root !== path.resolve(value) &&
    !/[\x00-\x1f"'%!=&^<>|#$\x60]/.test(value) &&
    (process.platform === 'win32' ? /^[A-Z]:[\\/]/i.test(value) : !value.includes('\\'));
  if (!safeRoot(map?.physicalRoot) || !safeRoot(map?.logicalRoot)) {
    throw new Error('Invalid verified archive path mapping');
  }
  const physicalRoot = path.resolve(map.physicalRoot);
  const logicalRoot = forwardSlashes(path.resolve(map.logicalRoot));
  if (!path.relative(physicalRoot, cwd)) throw new Error('Verified archive mapping requires a build subdirectory');
  for (const entry of [cwd, process.env.SKETCH_DIR_PATH, process.env.SKETCH_PATH]) {
    if (!entry || !isWithinRoot(physicalRoot, entry)
      || pathKey(entry) !== pathKey(await fs.realpath(entry))) {
      throw new Error('Verified archive mapping does not cover the native project paths');
    }
  }
  const prefixes = [...new Set([forwardSlashes(physicalRoot) + '/', physicalRoot + path.sep])];
  return {
    physicalRoot,
    logicalRoot,
    prefixes,
    flags: prefixes.map(prefix => '-ffile-prefix-map=' + prefix + '=' + logicalRoot + '/')
  };
}

// Split the already expanded compiler recipe for a direct process invocation.
// A recipe whose quoting we cannot interpret is ineligible for this cache.
function compilerWords(command: string): string[] {
  const tokens = command.match(COMPILER_WORD) || [];
  if (tokens.join(' ').replace(/\s+/g, ' ') !== command.trim().replace(/\s+/g, ' ')) {
    throw new Error('Unsupported compiler recipe quoting');
  }
  return tokens.map(token => token.replace(/"(?:\\["]|[^"])*"|'[^']*'/g, part =>
    part.slice(1, -1).replace(/\\"/g, '"')
  ));
}

async function expandResponses(args: string[], cwd: string, responses: Map<string, ResponseFile>): Promise<string[]> {
  const expanded: string[] = [];
  const active = new Set<string>();
  let bytes = [...responses.values()].reduce((total, entry) => total + entry.data.length, 0);

  async function visit(words: string[]): Promise<void> {
    for (const arg of words) {
      if (!arg.startsWith('@')) {
        expanded.push(arg);
        continue;
      }
      const file = path.resolve(cwd, arg.slice(1));
      const key = pathKey(file);
      if (active.has(key)) throw new Error('Recursive compiler response file');
      let response = responses.get(key);
      if (!response) {
        if (responses.size >= MAX_RESPONSE_FILES) throw new Error('Too many compiler response files');
        const stat = await fs.stat(file);
        if (!stat.isFile() || bytes + stat.size > MAX_RESPONSE_BYTES) throw new Error('Unbounded compiler response file');
        response = { file, data: await fs.readFile(file) };
        responses.set(key, response);
        bytes += response.data.length;
      }
      active.add(key);
      await visit(compilerWords(response.data.toString('utf8')));
      active.delete(key);
    }
  }

  await visit(args);
  return expanded;
}

export function archiveObjectSources(dependency: Dependency): string[] {
  return [...new Set(dependency.includes || [])].filter(source => ARCHIVE_SOURCE.test(source));
}

async function compilerSearchRoots(
  dependencies: Dependency[],
  compileConfig: any,
  cwd: string,
  responses: Map<string, ResponseFile>,
  mapping: CompilerPathMap | undefined
): Promise<{ roots: string[]; compilerArguments: string[][] }> {
  const dependencyRoots = [process.env.SKETCH_DIR_PATH, ...dependencies.map(dep => dep.path)].filter(Boolean) as string[];
  const roots = [...dependencyRoots];
  const sources = dependencies.flatMap(archiveObjectSources);
  if (process.env.SKETCH_PATH) sources.push(process.env.SKETCH_PATH);
  const recipes = [
    { key: 'c', compiler: 'c', language: 'c', needed: sources.some(source => /\.c$/i.test(source)) },
    { key: 'cpp', compiler: 'cpp', language: 'c++', needed: sources.some(source => /\.(?:cc|cpp|cxx|ino)$/i.test(source)) },
    { key: 's', compiler: 'c', language: 'assembler-with-cpp', needed: sources.some(source => /\.s$/i.test(source)) }
  ];
  const compilerArguments: string[][] = [];
  const probeSource = mapping?.prefixes.map((prefix, index) =>
    '#line 1 ' + JSON.stringify(prefix + 'aily-prefix-probe-' + index) + '\n__FILE__\n'
  ).join('');
  for (const recipe of recipes.filter(item => item.needed)) {
    const template = compileConfig?.args?.[recipe.key];
    const compiler = compileConfig?.compiler?.[recipe.compiler];
    if (typeof template !== 'string' || typeof compiler !== 'string' || !compiler) {
      throw new Error('Native compiler search paths are unavailable');
    }
    const expanded = await expandResponses(compilerWords(withoutUserHeaderDepfileOption(template)), cwd, responses);
    const conflictingMode = (arg: string) => /^(?:-M|-MM|-MMD|--write-user-dependencies)$/.test(arg);
    if (expanded.some(arg => conflictingMode(arg) ||
      (arg.startsWith('-Wp,') && arg.split(',').slice(1).some(option => conflictingMode(option) || option.startsWith('@')))
    )) {
      throw new Error('Compiler recipe contains an indirect dependency option incompatible with full archive receipts');
    }
    const args = expanded.flatMap(arg =>
      arg === '%INCLUDE_PATHS%' ? dependencyRoots.map(root => `-I${root}`) : [arg]
    );
    const probeArgs: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '-o' || /^(?:-MF|-MT|-MQ|-MJ|-x)$/.test(arg)) {
        index++;
      } else if (!/^(?:-c|-S|-E|-M(?:M?D?|D|P|G)|%SOURCE_FILE_PATH%|%OBJECT_FILE_PATH%)$/.test(arg)) {
        if (/[%{}]/.test(arg) && !arg.startsWith('-D')) throw new Error('Unexpanded compiler recipe argument');
        probeArgs.push(arg);
      }
    }
    const result = spawnSync(compiler.replace(/^"|"$/g, ''), [
      ...probeArgs, ...(mapping?.flags || []), '-E', '-v', '-x', recipe.language, '-'
    ], {
      cwd,
      input: probeSource || '',
      encoding: 'utf8',
      env: {
        ...process.env,
        LC_ALL: 'C',
        PATH: [process.env.COMPILER_PATH, process.env.ESPTOOL_PY_PATH, process.env.PATH].filter(Boolean).join(path.delimiter)
      },
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024
    });
    if (mapping) {
      const output = new Set(result.stdout?.split(/\r?\n/));
      if (result.status !== 0 || !mapping.prefixes.every((_, index) =>
        output.has(JSON.stringify(mapping.logicalRoot + '/aily-prefix-probe-' + index))
      )) {
        throw new Error('Compiler could not apply the verified archive path mapping');
      }
    }
    const search = /#include [^\r\n]+ search starts here:[\s\S]*?End of search list\./.exec(result.stderr || '');
    if (result.status !== 0 || !search) {
      const error = result.error as NodeJS.ErrnoException | undefined;
      throw new Error(`Compiler did not provide a complete ${recipe.language} include search list (${error?.code || result.status})`);
    }
    roots.push(...search[0].split(/\r?\n/).filter(line => /^\s+\S/.test(line)).map(line =>
      line.trim().replace(/ \(framework directory\)$/, '')
    ));
    compilerArguments.push(probeArgs);
  }
  return { roots, compilerArguments };
}

export async function captureVerifiedArchiveInputs(
  dependencies: Dependency[],
  compileConfig: any,
  memo: VerifiedInputMemo = new Map()
): Promise<VerifiedArchiveInputs> {
  const cwd = process.env.BUILD_PATH;
  if (!cwd) throw new Error('Build directory is unavailable');
  const responses = new Map<string, ResponseFile>();
  const compilerStarted = Date.now();
  const mapping = await readCompilerPathMap(cwd);
  const { roots, compilerArguments } = await compilerSearchRoots(dependencies, compileConfig, cwd, responses, mapping);
  const hashingStarted = Date.now();
  const fingerprint = createHash('sha256');
  const files = new Set<string>();
  const pendingFiles: Array<{ file: string; key: string }> = [];
  const directories = new Set<string>();
  const sketch = process.env.SKETCH_PATH && pathKey(process.env.SKETCH_PATH);
  let entries = 0;
  let bytes = 0;
  let reused = 0;

  function add(identity: string, content: string | Buffer): void {
    fingerprint.update(JSON.stringify([identity, content.length])).update('\0').update(content).update('\0');
  }

  function pathIdentity(filePath: string): string {
    const absolute = path.resolve(cwd, filePath);
    if (!mapping || !isWithinRoot(mapping.physicalRoot, absolute)) return forwardSlashes(absolute);
    const relative = forwardSlashes(path.relative(mapping.physicalRoot, absolute));
    return relative ? mapping.logicalRoot + '/' + relative : mapping.logicalRoot;
  }

  add('receipt-policy', 'full-gcc-deps-v2');
  add('path-policy', mapping ? 'mapped-project-paths-v1' : 'physical-paths-v1');
  add('working-directory', pathIdentity(cwd));
  for (const args of compilerArguments) {
    // Literal -D values can contain physical paths GCC's prefix map will not change.
    const recipe = args.map((arg, index) => {
      if (!mapping) return arg;
      const pathOption = /^(?:-I|-iquote|-isystem|-idirafter|-include|-imacros|-iprefix)/.exec(arg)?.[0];
      const previous = args[index - 1] || '';
      const separatedPath = /^(?:-I|-iquote|-isystem|-idirafter|-include|-imacros|-iprefix)$/.test(previous);
      if (!pathOption && !separatedPath) return arg;
      const value = arg.slice(pathOption?.length || 0);
      const prefix = mapping.prefixes.find(candidate => value.startsWith(candidate));
      return prefix ? (pathOption || '') + mapping.logicalRoot + '/' + value.slice(prefix.length) : arg;
    });
    add('native-recipe', JSON.stringify(recipe));
  }

  async function walk(directory: string): Promise<void> {
    const key = pathKey(directory);
    if (directories.has(key)) return;
    directories.add(key);
    const children = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (++entries > MAX_INPUT_ENTRIES) throw new Error('Verified archive input count exceeds limit');
      const generated = path.relative(cwd, file);
      const isDerivedOutput = !generated.startsWith('..') && !path.isAbsolute(generated)
        && (/(?:^|[\\/])\.ninja_[^\\/]+$/.test(generated) || /(?:^|[\\/])build\.ninja$|\.(?:o|o\.d|a|elf|hex|bin|map|uf2|eep)$/i.test(generated));
      if (isDerivedOutput || pathKey(file) === sketch) continue;
      if (child.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!child.isFile()) throw new Error(`Unsupported include tree entry: ${file}`);
      const key = pathKey(file);
      if (files.has(key)) continue;
      files.add(key);
      pendingFiles.push({ file, key });
    }
  }

  for (const root of roots) {
    const absolute = path.resolve(cwd, root);
    if (absolute === path.parse(absolute).root) throw new Error('Unbounded compiler search directory');
    add('search', pathIdentity(absolute));
    if (await fs.pathExists(absolute)) {
      if (mapping && isWithinRoot(mapping.physicalRoot, absolute) && pathKey(absolute) !== pathKey(await fs.realpath(absolute))) {
        throw new Error('Verified archive mapping encountered an aliased project include directory');
      }
      await walk(absolute);
    }
  }
  for (const [key, response] of responses) {
    add(`response:${pathIdentity(response.file)}`, response.data);
    files.add(key);
  }
  const stamp = (stat: Awaited<ReturnType<typeof readStat>>) =>
    `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  function readStat(file: string) {
    return fs.stat(file, { bigint: true });
  }
  for (let offset = 0; offset < pendingFiles.length; offset += 16) {
    const batch = pendingFiles.slice(offset, offset + 16);
    const stats = await Promise.all(batch.map(entry => readStat(entry.file)));
    bytes += stats.reduce((total, stat) => total + Number(stat.size), 0);
    if (bytes > MAX_INPUT_BYTES) throw new Error('Verified archive inputs exceed byte limit');
    const digests = await Promise.all(batch.map(async ({ file, key }, index) => {
      const stat = stats[index];
      const current = stamp(stat);
      if (!stat.isFile()) throw new Error(`Unexpected compile input: ${file}`);
      const cached = memo.get(key);
      if (cached?.stamp === current) {
        reused++;
        return cached.digest;
      }
      const data = await fs.readFile(file);
      if (BigInt(data.length) !== stat.size || stamp(await readStat(file)) !== current) {
        throw new Error(`Compile input changed while hashing: ${file}`);
      }
      const digest = createHash('sha256').update(data).digest('hex');
      memo.set(key, { stamp: current, digest });
      return digest;
    }));
    for (let index = 0; index < batch.length; index++) add(pathIdentity(batch[index].file), digests[index]);
  }
  return {
    fingerprint: fingerprint.digest('hex'),
    covers: file => files.has(pathKey(path.resolve(cwd, file))),
    pathIdentity,
    compilerPathMapFlags: mapping?.flags || [],
    timings: { compilerMs: hashingStarted - compilerStarted, hashingMs: Date.now() - hashingStarted, files: pendingFiles.length, reused }
  };
}

/** Ninja's dependency log is populated by the compiler's full -MD receipt. */
export function parseNinjaArchiveDependencies(output: string): Map<string, string[]> {
  const dependencies = new Map<string, string[]>();
  let target: string | undefined;
  let expected = 0;
  let paths: string[] = [];
  const commit = () => {
    if (target && expected > 0 && paths.length === expected) dependencies.set(target, paths);
  };
  for (const line of output.split(/\r?\n/)) {
    if (target && /^ {4}\S/.test(line)) {
      paths.push(line.slice(4));
      continue;
    }
    commit();
    const entry = /^(.*): #deps (\d+), .* \(VALID\)$/.exec(line);
    target = entry?.[1].replace(/\\/g, '/');
    expected = Number(entry?.[2]);
    paths = [];
  }
  commit();
  return dependencies;
}
