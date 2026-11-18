import path from 'path';
import { DirectiveTapeSnapshot } from './DirectiveTapeSnapshot';
import { readFileObservation } from './FileObservation';
import { macroDefinitionAt } from './utils/PreprocessorDirectiveExecutor';
import { PreprocessorDirectiveOpcode } from './utils/PreprocessorDirectiveScanner';
import type { MacroDefinition } from './utils/PreprocessorExpression';

/** Source provenance only. Replacement text never belongs in this record. */
export interface MacroSourceReference {
  file: string;
  identity: string;
  directiveIndex: number;
  sourceOffset: number;
  kind: 'define' | 'undef';
}
export interface CachedMacroOrigins {
  version: 1;
  files: Array<{ path: string; identity: string }>;
  macros: Record<string, { file: number; directiveIndex: number; sourceOffset: number; kind: 'define' | 'undef' }>;
}
export interface RestoredMacroOrigins {
  macros: Map<string, MacroDefinition>;
  origins: Map<string, MacroSourceReference>;
  verifyCurrent(): void;
}

export function sameMacroDefinition(left: MacroDefinition | undefined, right: MacroDefinition | undefined): boolean {
  return !!left && !!right && left.name === right.name && left.value === right.value && left.isDefined === right.isDefined
    && !!left.functionLike === !!right.functionLike && !!left.variadic === !!right.variadic
    && JSON.stringify(left.parameters || []) === JSON.stringify(right.parameters || []);
}
const validName = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const validPosition = (value: number) => Number.isSafeInteger(value) && value >= 0;
const onlyKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function isCachedMacroOrigins(value: unknown): value is CachedMacroOrigins {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as CachedMacroOrigins;
  return onlyKeys(record, ['version', 'files', 'macros']) && record.version === 1 && Array.isArray(record.files)
    && record.files.every(file => !!file && typeof file === 'object' && onlyKeys(file, ['path', 'identity'])
      && typeof file.path === 'string' && path.isAbsolute(file.path) && !file.path.includes('\0') && typeof file.identity === 'string' && !!file.identity)
    && !!record.macros && typeof record.macros === 'object' && !Array.isArray(record.macros)
    && Object.entries(record.macros).every(([name, ref]) => validName(name) && !!ref && typeof ref === 'object'
      && onlyKeys(ref, ['file', 'directiveIndex', 'sourceOffset', 'kind']) && validPosition(ref.file) && ref.file < record.files.length
      && validPosition(ref.directiveIndex) && validPosition(ref.sourceOffset) && ['define', 'undef'].includes(ref.kind));
}

export function captureMacroOrigins(base: Map<string, MacroDefinition>, final: Map<string, MacroDefinition>,
  origins?: Map<string, MacroSourceReference>): CachedMacroOrigins | undefined {
  const files: CachedMacroOrigins['files'] = [], indexes = new Map<string, number>();
  const macros: CachedMacroOrigins['macros'] = Object.create(null);
  for (const name of new Set([...base.keys(), ...final.keys()])) {
    if (sameMacroDefinition(base.get(name), final.get(name))) continue;
    const definition = final.get(name), reference = origins?.get(name);
    if (!definition || definition.name !== name || !validName(name) || !reference || !path.isAbsolute(reference.file)
      || reference.file.includes('\0') || !reference.identity || !validPosition(reference.directiveIndex)
      || !validPosition(reference.sourceOffset) || !['define', 'undef'].includes(reference.kind)) return undefined;
    const file = path.resolve(reference.file), key = JSON.stringify([file, reference.identity]);
    let index = indexes.get(key);
    if (index === undefined) { index = files.length; indexes.set(key, index); files.push({ path: file, identity: reference.identity }); }
    macros[name] = { file: index, directiveIndex: reference.directiveIndex, sourceOffset: reference.sourceOffset, kind: reference.kind };
  }
  return { version: 1, files, macros };
}

/** Restore only from the currently validated source generation, one read/scan per file. */
export function restoreMacroOrigins(value: CachedMacroOrigins, base: Map<string, MacroDefinition>, allowedFiles: ReadonlySet<string>,
  headerInputs?: ReadonlyArray<readonly [string, string | null]>, libraryPath?: string): RestoredMacroOrigins | undefined {
  if (!isCachedMacroOrigins(value)) return undefined;
  const headers = new Map((headerInputs || []).map(([file, identity]) => [path.resolve(file), identity]));
  const sources = new DirectiveTapeSnapshot(), macros = new Map(base), origins = new Map<string, MacroSourceReference>();
  const loaded = new Map<number, ReturnType<DirectiveTapeSnapshot['read']>>();
  for (const [name, reference] of Object.entries(value.macros)) {
    if (!validName(name) || !reference || !validPosition(reference.file) || !validPosition(reference.directiveIndex)
      || !validPosition(reference.sourceOffset) || !['define', 'undef'].includes(reference.kind)) return undefined;
    const file = value.files[reference.file];
    if (!file || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.includes('\0')
      || typeof file.identity !== 'string' || !file.identity) return undefined;
    const exact = path.resolve(file.path);
    const relative = libraryPath === undefined ? undefined : path.relative(libraryPath, exact);
    if (relative !== undefined && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !allowedFiles.has(exact)) return undefined;
    if (!allowedFiles.has(exact) && headers.get(exact) !== file.identity) return undefined;
    let source = loaded.get(reference.file);
    if (!source) {
      const before = readFileObservation(exact);
      // A persisted origin may simply be obsolete. Only a change during the
      // current read/validation is retryable; old entries are ordinary misses.
      if (before.state !== 'present' || !before.isFile || before.identity !== file.identity) return undefined;
      source = sources.read(exact, before); loaded.set(reference.file, source);
    }
    const opcode = source.tape.opcodes[reference.directiveIndex];
    if (source.tape.sourceOffsets[reference.directiveIndex] !== reference.sourceOffset
      || opcode !== (reference.kind === 'define' ? PreprocessorDirectiveOpcode.Define : PreprocessorDirectiveOpcode.Undef)) return undefined;
    const definition = macroDefinitionAt(source.tape, reference.directiveIndex);
    if (!definition || definition.name !== name) return undefined;
    macros.set(name, definition);
    origins.set(name, { file: exact, identity: file.identity, directiveIndex: reference.directiveIndex,
      sourceOffset: reference.sourceOffset, kind: reference.kind });
  }
  return { macros, origins, verifyCurrent: () => sources.verifyLoaded() };
}
