import fs from 'fs-extra';
import path from 'path';

const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'BUILD_INPUTS_CHANGED' }); };
const unresolved = (value: string) => /%[A-Z_]+%|\$\{|\{[\w.]+\}/.test(value);

/** Collect explicit GNU link search boundaries, not an emulation of the linker.
 * Inventory whole -L trees (including unused candidates) so a new/shadow library
 * changes identity too. Never infer implicit compiler paths or parse linker-script
 * programs as though they were a complete dependency graph.
 * https://sourceware.org/binutils/docs/ld/Options.html
 */
export async function recipeFileInputs(recipes: string[][], cwd: string): Promise<{ directories: string[]; scripts: string[] }> {
  const directories = new Map<string, string>(), scripts = new Set<string>();
  for (const tokens of recipes) {
    const search: string[] = [], requested: Array<{ name: string; search: string[] }> = [];
    let sysroot: string | undefined;
    const read = (index: number) => {
      const value = tokens[index];
      if (!value || value.startsWith('-') || unresolved(value)) fail('Missing or unresolved explicit linker input.');
      return value;
    };
    // GNU sysroot applies to the command regardless of option position.
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--sysroot') sysroot = path.resolve(cwd, read(++i));
      else if (tokens[i].startsWith('--sysroot=')) sysroot = path.resolve(cwd, readValue(tokens[i].slice(10)));
    }
    const resolve = (value: string) => {
      value = readValue(value);
      if (value.startsWith('=') || value.startsWith('$SYSROOT')) {
        if (!sysroot) fail('Sysroot-relative linker input requires an explicit --sysroot.');
        return path.resolve(sysroot!, value.replace(/^(=|\$SYSROOT)[\\/]*/, ''));
      }
      return path.resolve(cwd, value);
    };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      let directory: string | undefined, script: string | undefined;
      if (token === '-L' || token === '--library-path' || token === '-library-path') directory = read(++i);
      else if (token.startsWith('--library-path=') || token.startsWith('-library-path=')) directory = token.slice(token.indexOf('=') + 1);
      else if (token.startsWith('-L')) directory = token.slice(2);
      // -Ttext/-Tdata/-Tbss and segment variants are addresses, not script names.
      else if (/^-T(?:text(?:-segment)?|data|bss|rodata-segment)(?:=|$)/.test(token)) {
        if (!token.includes('=')) i++;
      } else if (token === '-T' || token === '--script' || token === '-script') script = read(++i);
      else if (token.startsWith('--script=') || token.startsWith('-script=')) script = token.slice(token.indexOf('=') + 1);
      else if (token.startsWith('-T')) script = token.slice(2);
      if (directory !== undefined) {
        const resolved = resolve(directory);
        directories.set(process.platform === 'win32' ? resolved.toLowerCase() : resolved, resolved); search.push(resolved);
        if (directories.size > 32) fail('Explicit link search roots exceed 32.');
      }
      if (script !== undefined) requested.push({ name: readValue(script), search: [...search] });
    }
    for (const request of requested) {
      // -T uses cwd, then preceding -L options. Recording does not guess a
      // toolchain's compiled-in search path when neither can locate the script.
      const candidates = [resolve(request.name), ...request.search.map(root => path.resolve(root, request.name))];
      let found: string | undefined;
      for (const candidate of candidates) {
        const stat = await fs.stat(candidate).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (stat?.isFile()) { found = candidate; break; }
      }
      if (!found) fail(`Cannot resolve explicit linker script "${request.name.slice(0, 160)}" from cwd or preceding -L paths; recorded builds do not infer toolchain defaults.`);
      scripts.add(found!);
      if (scripts.size > 128) fail('Explicit linker scripts exceed 128.');
    }
  }
  return { directories: [...directories.values()].sort(), scripts: [...scripts].sort() };
}

function readValue(value: string): string {
  if (!value || unresolved(value) || /[\x00\r\n]/.test(value)) fail('Missing or unresolved explicit linker input.');
  return value;
}
