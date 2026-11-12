import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWindowsHost } from './utils/HostPlatform';

const SYSTEM_CODE_PAGES: Readonly<Record<string, string>> = {
  '874': 'windows-874',
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '54936': 'gb18030',
};
const PROBE_PREFIX = 'aily_';
const PROBE_CHARACTERS = 'éЖ国漢あ한กΩİאعĄĐ';

export interface WindowsGccDepfile {
  encoding: string;
  c: boolean;
  cpp: boolean;
}

function absoluteWindowsPath(candidate: string | undefined): string | undefined {
  const unquoted = candidate?.replace(/^"(.*)"$/, '$1');
  if (unquoted && path.isAbsolute(unquoted) && path.parse(unquoted).root.length > 1) return unquoted;
}

function readSystemEncoding(): string | undefined {
  const root = absoluteWindowsPath(process.env.SystemRoot);
  if (!root) return;
  const systemDirectory = path.join(root, 'System32');
  const result = spawnSync(path.join(systemDirectory, 'reg.exe'), [
    'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP',
  ], { cwd: systemDirectory, encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const codePage = result.stdout?.match(/\bACP\s+REG_SZ\s+(\d+)/i)?.[1];
  if (codePage && /^125[0-8]$/.test(codePage)) return 'windows-' + codePage;
  return SYSTEM_CODE_PAGES[codePage];
}

export function resolveWindowsGccProbe(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const unquoted = command?.replace(/^"(.*)"$/, '$1');
  if (!/(?:^|[-/\\])(?:gcc|g\+\+)(?:\.exe)?$/i.test(unquoted)) return;
  const name = /\.exe$/i.test(unquoted) ? unquoted : unquoted + '.exe';
  const absolute = absoluteWindowsPath(name);
  if (absolute) return absolute;
  if (path.basename(name) !== name || !isWindowsHost()) return;

  const compilerDirectory = absoluteWindowsPath(env.COMPILER_PATH);
  if (compilerDirectory) {
    const selected = path.join(compilerDirectory, name);
    try {
      if (fs.statSync(selected).isFile()) return selected;
    } catch { /* Fall back to the explicit PATH entries. */ }
  }

  // Only inspect explicit absolute PATH entries. Do not introduce the
  // implicit current-directory search performed by Windows process creation.
  const projectDirectory = fs.realpathSync.native(process.cwd());
  for (const entry of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const directory = absoluteWindowsPath(entry);
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      const relative = path.relative(projectDirectory, fs.realpathSync.native(candidate));
      if ((path.isAbsolute(relative) || relative.startsWith('..' + path.sep))
        && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* PATH entries do not have to exist. */ }
  }
}

function emitsAnsiDependencies(
  command: string, language: 'c' | 'c++', encoding: string, env: NodeJS.ProcessEnv,
): boolean {
  const executable = resolveWindowsGccProbe(command, env);
  if (!executable) return false;

  // The -MT spelling reaches the same dependency writer as the file names.
  // Include characters across the legacy Windows code pages in one probe.
  const target = PROBE_PREFIX + PROBE_CHARACTERS;
  const result = spawnSync(executable, ['-M', '-MT', target, '-x', language, '-'], {
    cwd: path.dirname(executable), input: '', env, windowsHide: true, timeout: 3000,
  });
  const bytes = result.stdout;
  if (result.status !== 0 || !bytes?.length || bytes.includes(Buffer.from(target))) return false;
  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return decoded.startsWith(PROBE_PREFIX)
      && [...decoded.slice(PROBE_PREFIX.length)].some(character => PROBE_CHARACTERS.includes(character));
  } catch {
    return false;
  }
}

export function detectWindowsGccDepfile(
  ninjaPath: string,
  compilers: { c: string; cpp: string },
  env: NodeJS.ProcessEnv,
): WindowsGccDepfile | undefined {
  if (!isWindowsHost()) return;
  const encoding = readSystemEncoding();
  if (!encoding) return;
  const ninja = spawnSync(ninjaPath, ['-t', 'wincodepage'], {
    encoding: 'utf8', env, windowsHide: true, timeout: 3000,
  });
  if (ninja.status !== 0 || ninja.stdout.trim() !== 'Build file encoding: UTF-8') return;

  const c = emitsAnsiDependencies(compilers.c, 'c', encoding, env);
  const cpp = emitsAnsiDependencies(compilers.cpp, 'c++', encoding, env);
  if (c || cpp) return { encoding, c, cpp };
}

export function wrapWindowsGccDepfileCommand(command: string, encoding: string): string {
  const quote = (value: string) => '"' + value.replace(/\$/g, () => '$$') + '"';
  const runner = path.join(__dirname, 'windows-gcc-depfile-runner.js');
  return [quote(process.execPath), quote(runner), encoding, '"$out.d"', command].join(' ');
}
