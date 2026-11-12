import fs from 'fs';
import path from 'path';
import { toHostPathKey } from './utils/HostPlatform';

const injectedIncludes = '%INCLUDE_PATHS%';

export interface CompilerHeaderSearch {
  sourceDirectory: boolean;
  quote: string[];
  bracket: string[];
  system: string[];
}

/** The recipe is a command line. A GCC response file additionally uses a
 * backslash to escape the next character in either kind of quote. */
function splitArguments(input: string, responseFile = false): string[] {
  const args: string[] = [];
  let word = '';
  let quote = '';
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '\\' && next && (responseFile || next === '"' ||
      (process.platform !== 'win32' && quote !== "'" && /[\s'\\]/.test(next)))) {
      word += next;
      index++;
    } else if (char === quote) {
      quote = '';
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && /\s/.test(char)) {
      if (word) args.push(word);
      word = '';
    } else {
      word += char;
    }
  }
  if (word) args.push(word);
  return args;
}

function expandResponseArguments(command: string, cwd: string): string[] {
  const active = new Set<string>();
  const responses = new Map<string, string[]>();
  function* expand(args: string[]): Generator<string> {
    for (const arg of args) {
      if (!arg.startsWith('@') || arg.length === 1) {
        yield arg;
        continue;
      }
      // GCC resolves even nested @files against the compiler working directory.
      const file = path.resolve(cwd, arg.slice(1));
      const key = toHostPathKey(file);
      if (active.has(key)) continue;
      if (!responses.has(key)) {
        let contents: string;
        try {
          contents = fs.readFileSync(file, 'utf8');
        } catch {
          // The compiler still owns diagnostics for missing response files.
          responses.set(key, []);
        }
        if (contents !== undefined) responses.set(key, splitArguments(contents, true));
      }
      active.add(key);
      yield* expand(responses.get(key)!);
      active.delete(key);
    }
  }
  return [...expand(splitArguments(command))];
}

function uniquePaths(directories: string[]): string[] {
  const seen = new Set<string>();
  return directories.filter(directory => {
    const key = toHostPathKey(directory);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Model the explicit GCC header search chains, independent of SDK or library
 * ownership. The Ninja dependency includes are inserted at the recipe marker. */
export function readCompilerHeaderSearch(command: string, cwd: string): CompilerHeaderSearch {
  const args = expandResponseArguments(command, cwd);
  const quote: string[] = [];
  const user: string[] = [];
  const system: string[] = [];
  const after: string[] = [];
  let sourceDirectory = true;
  let prefix: string | undefined;
  let sysroot: string | undefined;
  let headerSysroot: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === injectedIncludes) {
      user.push(injectedIncludes);
      continue;
    }
    if (arg === '-I-') {
      quote.push(...user.splice(0));
      sourceDirectory = false;
      continue;
    }
    const option = /^(?:-iwithprefixbefore|-iwithprefix|-iprefix|-iquote|-isystem|-idirafter|-isysroot|--sysroot(?==|$)|-I)/.exec(arg)?.[0];
    if (!option) continue;
    const value = arg.slice(option.length) || args[++index];
    if (!value) continue;
    switch (option) {
      case '-iprefix': prefix = value; break;
      case '--sysroot': sysroot = value.replace(/^=/, ''); break;
      case '-isysroot': headerSysroot = value; break;
      case '-iquote': quote.push(value); break;
      case '-I': user.push(value); break;
      case '-isystem': system.push(value); break;
      case '-idirafter': after.push(value); break;
      case '-iwithprefixbefore':
      case '-iwithprefix':
        if (prefix !== undefined) (option === '-iwithprefixbefore' ? user : after).push(prefix + value);
        break;
    }
  }

  const resolve = (directory: string): string => {
    if (directory === injectedIncludes) return directory;
    const rooted = /^(?:=|\$SYSROOT)/.exec(directory);
    if (rooted) return path.resolve(cwd, headerSysroot || sysroot || path.parse(cwd).root,
      directory.slice(rooted[0].length).replace(/^[\\/]+/, ''));
    return path.resolve(cwd, directory);
  };
  const systemPaths = uniquePaths([...system, ...after].map(resolve));
  const systemKeys = new Set(systemPaths.map(directory => toHostPathKey(directory)));
  return {
    sourceDirectory,
    quote: uniquePaths(quote.map(resolve)),
    bracket: uniquePaths(user.map(resolve).filter(directory => !systemKeys.has(toHostPathKey(directory)))),
    system: systemPaths
  };
}

export function compilerIncludeDirectories(
  search: CompilerHeaderSearch,
  quoted: boolean,
  sourceDirectory: string,
  dependencyDirectories: string[]
): string[] {
  const quoteDirectories = quoted
    ? [...(search.sourceDirectory ? [sourceDirectory] : []), ...search.quote]
    : [];
  const system = new Set(search.system.map(directory => toHostPathKey(directory)));
  const userDependencies = dependencyDirectories.filter(directory => !system.has(toHostPathKey(directory)));
  return uniquePaths([
    ...quoteDirectories.flatMap(directory => directory === injectedIncludes ? dependencyDirectories : [directory]),
    ...search.bracket.flatMap(directory => directory === injectedIncludes ? userDependencies : [directory]),
    ...search.system
  ]);
}
