import path from 'path';

const DEBUG_INFO_FLAG = /(?:^|\s)-g(?:1|2|3|gdb\d*)?(?=\s|$)/u;

function sourcePrefixMap(sourceRoot: string | undefined): string | undefined {
  if (sourceRoot === undefined) return undefined;
  if (typeof sourceRoot !== 'string' || sourceRoot.length === 0 || sourceRoot.length > 4096
    || sourceRoot.trim() !== sourceRoot || /[\u0000-\u001f\u007f=]/u.test(sourceRoot)
    || / {2}|[^\S ]/u.test(sourceRoot)
    || !path.isAbsolute(sourceRoot)) {
    throw new Error('Simulation debug requires a bounded absolute source root.');
  }
  const normalized = path.resolve(sourceRoot);
  // A Windows filename cannot contain quotes. POSIX commands need their shell
  // metacharacters escaped inside the single, quoted compiler argument.
  if (process.platform === 'win32' && normalized.includes('"')) {
    throw new Error('Simulation debug source root contains an invalid quote.');
  }
  const quoted = process.platform === 'win32' ? normalized
    : normalized.replace(/[\\"$`]/gu, value => `\\${value}`);
  // This argument lives in Ninja's command template before the host shell sees
  // it. Escape its dollar signs for Ninja, without changing compiler identity.
  return `"-fdebug-prefix-map=${quoted.replace(/\$/gu, () => '$$')}=/source"`;
}

function withSourcePrefixMap(value: string, mapping: string | undefined): string {
  return mapping === undefined || value.endsWith(mapping) ? value : `${value} ${mapping}`;
}

function withDebugFlags(
  value: unknown,
  optimization: boolean,
): unknown {
  if (typeof value !== 'string') return value;
  const flags: string[] = [];
  if (optimization && !/(?:^|\s)-Og(?=\s|$)/u.test(value)) {
    flags.push('-Og');
  }
  if (!DEBUG_INFO_FLAG.test(value)) {
    flags.push('-g3');
  }
  if (
    optimization
    && /(?:^|\s)-flto(?=\s|$)/u.test(value)
    && !/(?:^|\s)-fno-lto(?=\s|$)/u.test(value)
  ) {
    flags.push('-fno-lto');
  }
  return flags.length === 0 ? value : `${value} ${flags.join(' ')}`;
}

/**
 * Applies the engine-neutral source-debug contract to Builder's compile IR.
 * The profile is deliberately applied after loading a cached preprocess result:
 * compile intent may change while dependency discovery remains valid.
 */
export function applySimulationDebugProfile<T>(compileConfig: T, sourceRoot?: string): T {
  if (!compileConfig || typeof compileConfig !== 'object') {
    throw new Error('Simulation debug requires a valid compile configuration.');
  }
  const record = compileConfig as Record<string, unknown>;
  const args = record.args;
  if (!args || typeof args !== 'object') {
    throw new Error('Simulation debug requires compiler argument templates.');
  }
  const argumentRecord = args as Record<string, unknown>;
  if (
    typeof argumentRecord.c !== 'string'
    || typeof argumentRecord.cpp !== 'string'
  ) {
    throw new Error('Simulation debug requires C and C++ compiler arguments.');
  }
  const mapping = sourcePrefixMap(sourceRoot);
  return {
    ...record,
    args: {
      ...argumentRecord,
      c: withSourcePrefixMap(withDebugFlags(argumentRecord.c, true) as string, mapping),
      cpp: withSourcePrefixMap(withDebugFlags(argumentRecord.cpp, true) as string, mapping),
      s: withDebugFlags(argumentRecord.s, false),
    },
  } as T;
}
