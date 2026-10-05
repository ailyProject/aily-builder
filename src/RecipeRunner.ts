import { spawn } from 'child_process';
import {
  expandArduinoProperty,
  type ArduinoPropertySource,
  type ArduinoPropertyValue
} from './ArduinoPropertyResolver';

export { ARDUINO_PROPERTY_EXPANSION_PASSES } from './ArduinoPropertyResolver';

export type RecipePropertyValue = ArduinoPropertyValue;

export type RecipeProperties = ArduinoPropertySource;

export type RecipeCommandKind =
  | 'direct'
  | 'windows-cmd'
  | 'powershell'
  | 'posix-shell';

export type RecipeRunnerErrorCode =
  | 'RECIPE_NOT_FOUND'
  | 'INVALID_QUOTING'
  | 'EMPTY_COMMAND'
  | 'SPAWN_FAILED'
  | 'PROCESS_FAILED'
  | 'ABORTED';

export interface RecipeRunnerErrorDetails {
  code: RecipeRunnerErrorCode;
  recipeKey?: string;
  pattern?: string;
  expandedCommand?: string;
  executable?: string;
  args?: string[];
  partialArgs?: string[];
  cwd?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

/** A serializable error containing the recipe and process state at failure. */
export class RecipeRunnerError extends Error {
  readonly code: RecipeRunnerErrorCode;
  readonly details: Readonly<RecipeRunnerErrorDetails>;
  readonly cause?: unknown;

  constructor(message: string, details: RecipeRunnerErrorDetails, cause?: unknown) {
    super(message);
    this.name = 'RecipeRunnerError';
    this.code = details.code;
    this.details = Object.freeze({
      ...details,
      args: details.args ? [...details.args] : undefined,
      partialArgs: details.partialArgs ? [...details.partialArgs] : undefined
    });
    this.cause = cause;

    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, RecipeRunnerError);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      ...this.details,
      cause: this.cause instanceof Error ? this.cause.message : this.cause
    };
  }
}

export interface PreparedRecipe {
  recipeKey: string;
  pattern: string;
  expandedCommand: string;
  executable: string;
  args: string[];
  argv: string[];
  commandKind: RecipeCommandKind;
}

export interface RecipeExecutionResult extends PreparedRecipe {
  cwd: string;
  exitCode: number;
  signal: null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RecipeRunOptions {
  cwd?: string;
  /** Environment overrides. An undefined value removes an inherited variable. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to true. */
  inheritEnvironment?: boolean;
  signal?: AbortSignal;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  windowsHide?: boolean;
}

export interface RecipeRunnerOptions extends RecipeRunOptions {}

function normalizeProperties(properties: RecipeProperties): Map<string, string> {
  const normalized = new Map<string, string>();
  const entries = properties instanceof Map
    ? properties.entries()
    : Object.entries(properties);

  for (const [key, value] of entries) {
    normalized.set(key, value == null ? '' : String(value));
  }
  return normalized;
}

/**
 * Arduino CLI-compatible recipe discovery.
 *
 * Extended keys are preferred over the exact key and sorted lexicographically.
 * The exact key is used only when no non-empty extended key exists.
 */
export function findRecipes(
  properties: RecipeProperties,
  prefix: string,
  suffix: string
): string[] {
  const normalized = normalizeProperties(properties);
  const exactKey = prefix + suffix;
  const recipes: string[] = [];

  for (const [key, value] of normalized) {
    if (
      key !== exactKey &&
      key.startsWith(prefix) &&
      key.endsWith(suffix) &&
      value !== ''
    ) {
      recipes.push(key);
    }
  }

  if (recipes.length === 0 && (normalized.get(exactKey) ?? '') !== '') {
    recipes.push(exactKey);
  }

  return recipes.sort();
}

/** Expand `{property}` markers recursively, matching Arduino CLI's ten passes. */
export function expandRecipeProperties(
  input: string,
  properties: RecipeProperties
): string {
  return expandArduinoProperty(input, properties);
}

/**
 * Split a command exactly like Arduino's SplitQuotedString(command, `"'`, false).
 *
 * This is intentionally not a shell parser: quoting is recognized only when the
 * quote is the first character of an argument, and quote escaping is unsupported.
 * Recipes needing a shell must explicitly invoke one, for example:
 * `cmd.exe /c "..."`, `powershell -Command "..."`, or `bash -c "..."`.
 */
export function splitQuotedArguments(input: string): string[] {
  const result: string[] = [];
  const quoteCharacters = new Set(['"', "'"]);
  let activeQuote = '';
  let quotedArgument = '';

  for (let current of input.split(' ')) {
    if (activeQuote === '') {
      const first = Array.from(current)[0] ?? '';
      if (!quoteCharacters.has(first)) {
        if (current.trim().length > 0) {
          result.push(current);
        }
        continue;
      }

      activeQuote = first;
      current = current.slice(first.length);
      quotedArgument = '';
    }

    const runes = Array.from(current);
    const last = runes[runes.length - 1] ?? '';
    if (last !== activeQuote) {
      quotedArgument += current + ' ';
      continue;
    }

    quotedArgument += current.slice(0, current.length - activeQuote.length);
    if (quotedArgument.trim().length > 0) {
      result.push(quotedArgument);
    }
    activeQuote = '';
  }

  if (activeQuote !== '') {
    throw new RecipeRunnerError(
      `Invalid quoting: no closing ${JSON.stringify(activeQuote)} character found`,
      {
        code: 'INVALID_QUOTING',
        expandedCommand: input,
        partialArgs: result
      }
    );
  }

  return result;
}

function executableBaseName(executable: string): string {
  const normalized = executable.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

export function detectRecipeCommandKind(
  executable: string,
  args: readonly string[]
): RecipeCommandKind {
  const baseName = executableBaseName(executable);
  const normalizedArgs = args.map(arg => arg.toLowerCase());

  if (
    (baseName === 'cmd' || baseName === 'cmd.exe') &&
    normalizedArgs.some(arg => arg === '/c' || arg === '/k')
  ) {
    return 'windows-cmd';
  }

  if (
    ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(baseName) &&
    normalizedArgs.some(arg =>
      ['-command', '-c', '-commandwithargs', '-encodedcommand'].includes(arg)
    )
  ) {
    return 'powershell';
  }

  if (
    ['bash', 'bash.exe', 'sh', 'sh.exe'].includes(baseName) &&
    normalizedArgs.includes('-c')
  ) {
    return 'posix-shell';
  }

  return 'direct';
}

interface SpawnInvocation {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

interface WindowsCmdPayload {
  switchArgumentIndex: number;
  payload: string;
}

function getEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

/**
 * Locate the command string following cmd.exe's /c or /k switch without
 * tokenizing that payload. Quotes inside the payload are syntax for cmd.exe
 * itself and must survive until cmd parses them.
 */
function findWindowsCmdPayload(command: string): WindowsCmdPayload | undefined {
  let offset = 0;
  let tokenIndex = 0;

  while (offset < command.length) {
    while (offset < command.length && /\s/.test(command[offset])) {
      offset++;
    }
    if (offset >= command.length) {
      return undefined;
    }

    const tokenStart = offset;
    const quote = command[offset] === '"' || command[offset] === "'"
      ? command[offset++]
      : '';

    if (quote) {
      while (offset < command.length && command[offset] !== quote) {
        offset++;
      }
      if (offset < command.length) {
        offset++;
      }
    } else {
      while (offset < command.length && !/\s/.test(command[offset])) {
        offset++;
      }
    }

    const rawToken = command.slice(tokenStart, offset);
    const token = quote && rawToken.endsWith(quote)
      ? rawToken.slice(1, -1)
      : rawToken;

    // The first token is the cmd executable; subsequent token positions map
    // directly to PreparedRecipe.args.
    if (tokenIndex > 0 && (token.toLowerCase() === '/c' || token.toLowerCase() === '/k')) {
      const payload = command.slice(offset).trimStart();
      if (payload.length === 0) {
        return undefined;
      }
      return {
        switchArgumentIndex: tokenIndex - 1,
        payload
      };
    }

    tokenIndex++;
  }

  return undefined;
}

function prepareSpawnInvocation(
  prepared: PreparedRecipe,
  env: NodeJS.ProcessEnv
): SpawnInvocation {
  if (process.platform !== 'win32') {
    return { executable: prepared.executable, args: prepared.args };
  }

  const executableName = executableBaseName(prepared.executable);
  if (executableName.endsWith('.bat') || executableName.endsWith('.cmd')) {
    // CreateProcess cannot execute batch files directly; Node reports EINVAL
    // when spawn() is used with shell:false. Route only batch recipes through
    // the Windows command processor while leaving native executables direct.
    const commandProcessor = getEnvironmentValue(env, 'ComSpec')
      || getEnvironmentValue(process.env, 'ComSpec')
      || 'cmd.exe';
    return {
      executable: commandProcessor,
      args: ['/d', '/s', '/c', `"${prepared.expandedCommand}"`],
      windowsVerbatimArguments: true
    };
  }

  if (prepared.commandKind !== 'windows-cmd') {
    return { executable: prepared.executable, args: prepared.args };
  }

  const command = findWindowsCmdPayload(prepared.expandedCommand);
  if (!command) {
    return { executable: prepared.executable, args: prepared.args };
  }

  // Node normally quotes Windows arguments only when they contain whitespace.
  // That loses explicit recipe quotes around paths such as `project_+_name`;
  // cmd.exe's COPY then interprets `+` as its file-concatenation operator.
  // Pass one verbatim, outer-quoted payload so cmd receives all inner quotes,
  // redirections, parentheses and chaining operators unchanged.
  return {
    executable: prepared.executable,
    args: [
      ...prepared.args.slice(0, command.switchArgumentIndex + 1),
      `"${command.payload}"`
    ],
    windowsVerbatimArguments: true
  };
}

function mergeEnvironment(
  inheritEnvironment: boolean,
  ...overrides: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = inheritEnvironment ? { ...process.env } : {};

  for (const override of overrides) {
    if (!override) {
      continue;
    }
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) {
        delete result[key];
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

/** Executes dynamically discovered Arduino recipes serially and fail-fast. */
export class RecipeRunner {
  private properties: Map<string, string>;
  private readonly defaults: RecipeRunnerOptions;

  constructor(properties: RecipeProperties, options: RecipeRunnerOptions = {}) {
    this.properties = normalizeProperties(properties);
    this.defaults = { ...options, env: options.env ? { ...options.env } : undefined };
  }

  replaceProperties(properties: RecipeProperties): void {
    this.properties = normalizeProperties(properties);
  }

  mergeProperties(properties: RecipeProperties): void {
    for (const [key, value] of normalizeProperties(properties)) {
      this.properties.set(key, value);
    }
  }

  setProperty(key: string, value: RecipePropertyValue): void {
    this.properties.set(key, value == null ? '' : String(value));
  }

  getProperties(): ReadonlyMap<string, string> {
    return new Map(this.properties);
  }

  findRecipes(prefix: string, suffix: string): string[] {
    return findRecipes(this.properties, prefix, suffix);
  }

  expand(input: string): string {
    return expandRecipeProperties(input, this.properties);
  }

  prepareRecipe(recipeKey: string): PreparedRecipe {
    const pattern = this.properties.get(recipeKey) ?? '';
    if (pattern === '') {
      throw new RecipeRunnerError(`Recipe pattern is missing: ${recipeKey}`, {
        code: 'RECIPE_NOT_FOUND',
        recipeKey,
        pattern
      });
    }

    const expandedCommand = this.expand(pattern);
    let argv: string[];
    try {
      argv = splitQuotedArguments(expandedCommand);
    } catch (error) {
      if (error instanceof RecipeRunnerError) {
        throw new RecipeRunnerError(
          `Unable to parse recipe ${recipeKey}: ${error.message}`,
          {
            ...error.details,
            code: 'INVALID_QUOTING',
            recipeKey,
            pattern,
            expandedCommand
          },
          error
        );
      }
      throw error;
    }

    if (argv.length === 0) {
      throw new RecipeRunnerError(`Recipe expanded to an empty command: ${recipeKey}`, {
        code: 'EMPTY_COMMAND',
        recipeKey,
        pattern,
        expandedCommand
      });
    }

    const [executable, ...args] = argv;
    return {
      recipeKey,
      pattern,
      expandedCommand,
      executable,
      args,
      argv,
      commandKind: detectRecipeCommandKind(executable, args)
    };
  }

  async runRecipe(
    recipeKey: string,
    options: RecipeRunOptions = {}
  ): Promise<RecipeExecutionResult> {
    const prepared = this.prepareRecipe(recipeKey);
    const cwd = options.cwd ?? this.defaults.cwd ?? process.cwd();
    const inheritEnvironment =
      options.inheritEnvironment ??
      this.defaults.inheritEnvironment ??
      true;
    const env = mergeEnvironment(
      inheritEnvironment,
      this.defaults.env,
      options.env
    );
    const signal = options.signal ?? this.defaults.signal;
    const stdoutTarget = options.stdout ?? this.defaults.stdout;
    const stderrTarget = options.stderr ?? this.defaults.stderr;
    const windowsHide = options.windowsHide ?? this.defaults.windowsHide ?? true;
    const invocation = prepareSpawnInvocation(prepared, env);

    if (signal?.aborted) {
      throw new RecipeRunnerError(`Recipe execution was aborted: ${recipeKey}`, {
        code: 'ABORTED',
        recipeKey,
        pattern: prepared.pattern,
        expandedCommand: prepared.expandedCommand,
        executable: prepared.executable,
        args: prepared.args,
        cwd,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: ''
      });
    }

    const startedAt = process.hrtime.bigint();

    return await new Promise<RecipeExecutionResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(invocation.executable, invocation.args, {
          cwd,
          env,
          shell: false,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          windowsHide,
          signal,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        reject(new RecipeRunnerError(
          `Unable to start recipe ${recipeKey}: ${cause.message}`,
          {
            code: 'SPAWN_FAILED',
            recipeKey,
            pattern: prepared.pattern,
            expandedCommand: prepared.expandedCommand,
            executable: prepared.executable,
            args: prepared.args,
            cwd,
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: ''
          },
          cause
        ));
        return;
      }

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutChunks.push(buffer);
        stdoutTarget?.write(buffer);
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrChunks.push(buffer);
        stderrTarget?.write(buffer);
      });

      child.once('error', error => {
        if (settled) {
          return;
        }
        settled = true;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const aborted = signal?.aborted || (error as NodeJS.ErrnoException).name === 'AbortError';

        reject(new RecipeRunnerError(
          aborted
            ? `Recipe execution was aborted: ${recipeKey}`
            : `Unable to start recipe ${recipeKey}: ${error.message}`,
          {
            code: aborted ? 'ABORTED' : 'SPAWN_FAILED',
            recipeKey,
            pattern: prepared.pattern,
            expandedCommand: prepared.expandedCommand,
            executable: prepared.executable,
            args: prepared.args,
            cwd,
            exitCode: null,
            signal: null,
            stdout,
            stderr
          },
          error
        ));
      });

      child.once('close', (exitCode, closeSignal) => {
        if (settled) {
          return;
        }
        settled = true;

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        if (exitCode === 0 && closeSignal === null) {
          resolve({
            ...prepared,
            cwd,
            exitCode: 0,
            signal: null,
            stdout,
            stderr,
            durationMs
          });
          return;
        }

        reject(new RecipeRunnerError(
          `Recipe ${recipeKey} failed${exitCode == null ? '' : ` with exit code ${exitCode}`}`,
          {
            code: signal?.aborted ? 'ABORTED' : 'PROCESS_FAILED',
            recipeKey,
            pattern: prepared.pattern,
            expandedCommand: prepared.expandedCommand,
            executable: prepared.executable,
            args: prepared.args,
            cwd,
            exitCode,
            signal: closeSignal,
            stdout,
            stderr
          }
        ));
      });
    });
  }

  async runRecipes(
    prefix: string,
    suffix: string,
    options: RecipeRunOptions = {}
  ): Promise<RecipeExecutionResult[]> {
    const results: RecipeExecutionResult[] = [];

    // Deliberately sequential: Arduino hooks can depend on prior hook side effects.
    for (const recipeKey of this.findRecipes(prefix, suffix)) {
      results.push(await this.runRecipe(recipeKey, options));
    }

    return results;
  }

  /** Arduino CLI-style short alias. */
  async run(
    prefix: string,
    suffix: string,
    options: RecipeRunOptions = {}
  ): Promise<RecipeExecutionResult[]> {
    return await this.runRecipes(prefix, suffix, options);
  }
}
