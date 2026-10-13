import path from 'path';
import fs from 'fs-extra';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { splitQuotedArguments, expandRecipeProperties } from './RecipeRunner';
import type { Dependency } from './DependencyAnalyzer';
import { collectArduinoSketchSources, readArduinoSketch } from './ArduinoSketchSources';

const run = promisify(execFile);

/** Decode GCC Makefile dependencies, including escaped spaces and Windows paths. */
export function parseCompilerDependencies(output: string): string[] {
  const body = output.replace(/\\\r?\n/g, ' ').replace(/^aily-deps:\s*/, '');
  const result: string[] = [];
  let token = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\' && /[\s\\#]/.test(body[i + 1] || '')) token += body[++i];
    else if (/\s/.test(char)) { if (token) result.push(token); token = ''; }
    else token += char;
  }
  if (token) result.push(token);
  return result;
}

/** Native sketches use the target compiler for conditional includes (e.g. Marlin MB/ENABLED macros). */
export async function resolveArduinoSketchLibraries(
  platform: Record<string, string>, entry: string, libraries: Map<string, Dependency>,
  sourceFiles: (root: string) => Promise<string[]>,
  additionalSources: string[] = [],
): Promise<Dependency[]> {
  const root = path.dirname(entry);
  const generated = path.join(process.env['BUILD_PATH']!, 'arduino-dependencies.cpp');
  await fs.ensureDir(path.dirname(generated));
  await fs.writeFile(generated, '#include <Arduino.h>\n' + await readArduinoSketch(entry));
  const pending = [generated, ...await collectArduinoSketchSources(entry), ...additionalSources];
  const selected = new Map<string, Dependency>();
  const includePaths = new Set([root, process.env['SDK_CORE_PATH'], process.env['SDK_VARIANT_PATH']].filter(Boolean) as string[]);
  const scanned = new Set<string>();

  while (pending.length) {
    const source = pending.shift()!;
    if (scanned.has(source)) continue;
    const extension = path.extname(source);
    const recipe = extension === '.c' ? 'recipe.c.o.pattern'
      : /\.[sS]$/.test(extension) ? 'recipe.S.o.pattern' : 'recipe.cpp.o.pattern';
    const pattern = platform[recipe].replace(/%INCLUDE_PATHS%/g, '')
      .replace(/%SOURCE_FILE_PATH%/g, source.replace(/\\/g, '/'))
      .replace(/%OBJECT_FILE_PATH%/g, '__unused__');
    const command = splitQuotedArguments(expandRecipeProperties(pattern, {
      ...platform, includes: '', source_file: source, object_file: '__unused__',
    }));
    const executable = command.shift()!;
    const args: string[] = [];
    for (let i = 0; i < command.length; i++) {
      if (['-o', '-MF', '-MT', '-MQ'].includes(command[i])) { i++; continue; }
      if (['-c', '-MMD', '-MD', '-MP'].includes(command[i])) continue;
      args.push(command[i]);
    }
    args.push('-E', '-M', '-MG', '-MT', 'aily-deps', ...[...includePaths].map(dir => `-I${dir}`));
    let stdout = '';
    let failure: any;
    try { ({ stdout } = await run(executable, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true })); }
    catch (error) { failure = error; stdout = String((error as any).stdout || ''); }
    let added = false;
    for (const filename of parseCompilerDependencies(stdout)) {
      if (path.isAbsolute(filename) || fs.existsSync(path.resolve(root, filename))) continue;
      const library = libraries.get(filename);
      if (!library || selected.has(library.name)) continue;
      const dependency = { ...library, includes: await sourceFiles(library.path) };
      selected.set(library.name, dependency);
      includePaths.add(library.path);
      pending.push(...dependency.includes);
      added = true;
    }
    if (added) { pending.unshift(source); continue; }
    if (failure) throw new Error(`Arduino dependency preprocessing failed for ${source}:\n${failure.stderr || failure.message}`);
    const missing = parseCompilerDependencies(stdout).filter(filename =>
      !path.isAbsolute(filename) && !fs.existsSync(path.resolve(root, filename)));
    if (missing.length) throw new Error(`Arduino library/header not found: ${missing.join(', ')}`);
    scanned.add(source);
  }
  return [...selected.values()];
}
