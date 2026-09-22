const DEBUG_INFO_FLAG = /(?:^|\s)-g(?:1|2|3|gdb\d*)?(?=\s|$)/u;

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
export function applySimulationDebugProfile<T>(compileConfig: T): T {
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
  return {
    ...record,
    args: {
      ...argumentRecord,
      c: withDebugFlags(argumentRecord.c, true),
      cpp: withDebugFlags(argumentRecord.cpp, true),
      s: withDebugFlags(argumentRecord.s, false),
    },
  } as T;
}
