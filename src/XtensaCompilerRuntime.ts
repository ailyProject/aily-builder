import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { reportToolLoadFailure, type ToolLoadFailure } from './ToolLoadFailure';
import { isWindowsHost } from './utils/HostPlatform';

interface CompilerExecutables {
  c?: string;
  cpp?: string;
  ld?: string;
}

type XtensaConfig = ToolLoadFailure & { executable: string; resource: string };

function windowsXtensaConfigs(compiler: CompilerExecutables): XtensaConfig[] {
  if (!isWindowsHost()) return [];
  const configs = new Map<string, XtensaConfig>();
  for (const executable of [compiler.cpp, compiler.c, compiler.ld]) {
    if (!executable || !path.isAbsolute(executable)) continue;
    const wrapper = /^xtensa-([a-z\d]+)-elf-(gcc|g\+\+)\.exe$/i.exec(path.basename(executable));
    if (!wrapper || wrapper[1].toLowerCase() === 'esp') continue;
    const bin = path.dirname(executable);
    // Legacy Xtensa GCC builds use a chip-specific driver without the
    // shared driver or a dynamic configuration library.
    const sharedDriver = path.join(bin, `xtensa-esp-elf-${wrapper[2]}.exe`);
    if (!isExistingFile(sharedDriver)) continue;
    const resource = path.resolve(bin, '..', 'lib', `xtensa_${wrapper[1].toLowerCase()}.so`);
    if (!configs.has(resource.toLowerCase())) {
      configs.set(resource.toLowerCase(), {
        version: 1,
        code: 'TOOL_LOAD_XTENSA_CONFIG',
        stage: 'compile',
        executable,
        resource
      });
    }
  }
  return [...configs.values()];
}

function isExistingFile(filePath: string): boolean {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

export function requireWindowsXtensaConfig(compiler: CompilerExecutables): void {
  for (const failure of windowsXtensaConfigs(compiler)) {
    try {
      requirePortableExecutable(failure.resource);
    } catch (error) {
      reportToolLoadFailure(failure);
      throw new Error(`Cannot use Xtensa compiler configuration ${failure.resource}: ${error.message}`);
    }
  }
}

function requirePortableExecutable(resource: string): void {
  const fd = openSync(resource, 'r');
  try {
    const header = Buffer.alloc(64);
    const signature = Buffer.alloc(4);
    if (readSync(fd, header, 0, header.length, 0) !== header.length
      || header.readUInt16LE(0) !== 0x5a4d
      || readSync(fd, signature, 0, signature.length, header.readUInt32LE(60)) !== signature.length
      || signature.readUInt32LE(0) !== 0x00004550) {
      throw new Error('invalid Windows executable format');
    }
  } finally {
    closeSync(fd);
  }
}

export function reportWindowsXtensaConfigFailure(
  output: string,
  compiler: CompilerExecutables
): void {
  const nativeError = /^[^\r\n]*\bcc1(?:plus)?(?:\.exe)?: fatal error: ['"]?XTENSA_GNU_CONFIG['"]? is defined but could not be loaded:/im;
  if (!isWindowsHost() || !nativeError.test(output)) return;
  const configs = windowsXtensaConfigs(compiler);
  reportToolLoadFailure(configs.length === 1 ? configs[0] : {
    version: 1,
    code: 'TOOL_LOAD_XTENSA_CONFIG',
    stage: 'compile'
  });
}
