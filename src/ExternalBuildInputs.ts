import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import { recipeFileInputs } from './RecipeFileInputs';

export interface ExternalInputSelection { recipes: string[]; tools: Record<string, string>; cwd: string; searchPath: string }
export interface ExternalInputRecord {
  scope: 'recipe-response-files-and-tools';
  files: Array<{ id: string; name: string; locationSha256: string; roles: string[]; sizeBytes: number; sha256: string }>;
  linkSearch?: { scope: 'explicit-link-search-trees'; roots: Array<{ requestedLocationSha256: string; locationSha256: string; present: boolean }> };
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const state = (s: import('fs').Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
const location = (value: string) => sha(process.platform === 'win32' ? value.toLowerCase() : value);
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'BUILD_INPUTS_CHANGED' }); };

// Recipe paths preserve Windows separators. GNU @files instead escape any next
// character: https://gcc.gnu.org/onlinedocs/gcc/Overall-Options.html
export function splitInputArguments(text: string, responseFile = false): string[] {
  const result: string[] = [];
  let value = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '\\' && next !== undefined && (responseFile || next === '"' || next === '\\')) {
      value += text[++i]; started = true;
    } else if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? '' : ch; started = true;
    } else if (/\s/.test(ch) && !quote) {
      if (started) result.push(value);
      value = ''; started = false;
    } else { value += ch; started = true; }
  }
  if (quote) fail('Unterminated build-input argument quote.');
  if (started) result.push(value);
  return result;
}

/** Explicit recipe inputs only; does not claim complete transitive SDK/tool closure. */
export async function captureExternalBuildInputs(selection: ExternalInputSelection): Promise<{ record: ExternalInputRecord; states: string[] }> {
  const selected = new Map<string, { roles: Set<string>; bytes?: Buffer; initialState?: string }>();
  const active = new Set<string>();
  let responseBytes = 0, tokenCount = 0;
  const add = async (filename: string, role: string) => {
    const real = await fs.realpath(filename);
    let entry = selected.get(real);
    if (!entry) { entry = { roles: new Set() }; selected.set(real, entry); }
    entry.roles.add(role);
    if (selected.size > 1024) fail('External build-input count exceeds 1024.');
    return { real, entry };
  };
  const responses = async (tokens: string[], depth: number): Promise<string[]> => {
    if (depth > 8) fail('Nested response files exceed depth limit.');
    const expanded: string[] = [];
    for (const token of tokens.flatMap(token => token.startsWith('-Wl,') ? token.slice(4).split(',') : [token])) {
      if (++tokenCount > 100000) fail('Expanded recipe inputs exceed token budget.');
      if (token === '-Xlinker') continue;
      if (!token.startsWith('@')) { expanded.push(token); continue; }
      if (token.length < 2 || /%[A-Z_]+%|\$\{|\{[\w.]+\}/.test(token)) fail('Unresolved response-file path.');
      // GCC resolves nested @files against process cwd, not the parent @file directory.
      const { real, entry } = await add(path.resolve(selection.cwd, token.slice(1)), 'response');
      if (active.has(real)) fail('Response-file cycle.');
      if (!entry.bytes) {
        const before = await fs.stat(real);
        if (!before.isFile() || (responseBytes += before.size) > 4 * 1024 * 1024) fail('Response files exceed 4 MiB.');
        entry.bytes = await fs.readFile(real);
        entry.initialState = state(before);
        if (state(await fs.stat(real)) !== entry.initialState) fail('Response file changed while reading.');
      }
      active.add(real);
      expanded.push(...await responses(splitInputArguments(entry.bytes.toString('utf8'), true), depth + 1));
      active.delete(real);
    }
    return expanded;
  };
  const recipes: string[][] = [];
  for (const recipe of selection.recipes) recipes.push(await responses(splitInputArguments(recipe), 0));
  const linkInputs = await recipeFileInputs(recipes, selection.cwd);
  const searchRoots: NonNullable<ExternalInputRecord['linkSearch']>['roots'] = [];
  const directoryStates: Array<{ filename: string; before: string }> = [];
  const contains = (root: string, filename: string) => {
    const relative = path.relative(root, filename);
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const buildRoot = await fs.realpath(selection.cwd);
  const visited = new Set<string>();
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (visited.has(directory)) return;
    visited.add(directory);
    if (depth > 32 || visited.size > 2048) fail('Link search tree exceeds directory/depth budget.');
    const before = await fs.lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) fail('Implicit link search symlink/junction refused.');
    directoryStates.push({ filename: directory, before: state(before) });
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('Implicit link search symlink/junction refused.');
      if (entry.isDirectory()) await visit(filename, depth + 1);
      else if (entry.isFile()) await add(filename, 'link-search');
      else fail('Unsupported link search entry.');
    }
  };
  for (const requested of linkInputs.directories) {
    const real = await fs.realpath(requested).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    searchRoots.push({ requestedLocationSha256: location(requested), locationSha256: location(real || requested), present: !!real });
    if (!real) continue; // Absence is recorded; later creation changes identity.
    // A whole search tree cannot contain this build's changing outputs/evidence.
    if (contains(real, buildRoot) || contains(buildRoot, real)) fail('Explicit link search tree overlaps build outputs; recorded builds require a separate input directory.');
    await visit(real, 0);
  }
  for (const filename of linkInputs.scripts) await add(filename, 'link-script');
  for (const [role, command] of Object.entries(selection.tools).sort()) {
    if (!command) continue;
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(role)) fail('Invalid compiler role.');
    const roots = path.isAbsolute(command) || /[\\/]/.test(command) ? [path.resolve(selection.cwd, command)]
      : [...(process.platform === 'win32' ? [selection.cwd] : []), ...selection.searchPath.split(path.delimiter).filter(Boolean)]
          .map(root => path.join(root.replace(/^"|"$/g, ''), command));
    let found: string | undefined;
    for (const candidate of roots.flatMap(root => process.platform === 'win32' && !path.extname(root) ? [root + '.exe', root] : [root])) {
      if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) { found = candidate; break; }
    }
    if (!found) fail(`Cannot resolve build tool ${role}; input recording must not guess.`);
    await add(found, `tool:${role}`);
  }
  const files: ExternalInputRecord['files'] = [], states: string[] = [];
  let total = 0;
  for (const [filename, entry] of [...selected.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const before = await fs.stat(filename);
    if (!before.isFile() || (total += before.size) > 512 * 1024 * 1024) fail('External inputs exceed 512 MiB.');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    const after = await fs.stat(filename), content = digest.digest('hex');
    if (state(before) !== state(after) || (entry.initialState && entry.initialState !== state(after))
        || (entry.bytes && createHash('sha256').update(entry.bytes).digest('hex') !== content)) fail('External input changed while capturing.');
    const id = `external-${files.length}`;
    files.push({ id, name: path.basename(filename), locationSha256: location(filename),
      roles: [...entry.roles].sort(), sizeBytes: after.size, sha256: content });
    states.push(`${id}:${state(after)}`);
  }
  for (const directory of directoryStates) {
    if (state(await fs.lstat(directory.filename)) !== directory.before) fail('Link search directory changed while capturing.');
    states.push(`link-directory:${location(directory.filename)}:${directory.before}`);
  }
  for (let i = 0; i < linkInputs.directories.length; i++) {
    const real = await fs.realpath(linkInputs.directories[i]).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!!real !== searchRoots[i].present || location(real || linkInputs.directories[i]) !== searchRoots[i].locationSha256) fail('Link search root changed while capturing.');
  }
  return { record: { scope: 'recipe-response-files-and-tools', files,
    linkSearch: { scope: 'explicit-link-search-trees', roots: searchRoots } }, states };
}
