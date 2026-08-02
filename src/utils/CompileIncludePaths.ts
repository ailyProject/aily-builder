import path from 'path';
import { toHostPathKey } from './HostPlatform';

export interface CompileIncludePathEntry {
  path: string;
}

function getIncludePathKey(includePath: string): string {
  return toHostPathKey(path.normalize(path.resolve(includePath)));
}

/** Keep the first occurrence of each include directory using host path semantics. */
export function dedupeCompileIncludePaths<T extends CompileIncludePathEntry>(entries: T[]): T[] {
  const seen = new Set<string>();
  const uniqueEntries: T[] = [];

  for (const entry of entries) {
    if (!entry.path) {
      continue;
    }

    const key = getIncludePathKey(entry.path);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueEntries.push(entry);
  }

  return uniqueEntries;
}

/**
 * Detect an include directory already supplied by a platform recipe. Arduino
 * platforms use several equivalent spellings, including "-IC:\\path",
 * -I"C:\\path" and -I "C:\\path".
 */
export function commandHasIncludePath(command: string, includePath: string): boolean {
  if (!command || !includePath) {
    return false;
  }

  const expectedKey = getIncludePathKey(includePath);
  const includePattern = /(?:^|\s)(?:"-I([^"]+)"|-I"([^"]+)"|-I\s+"([^"]+)"|-I\s*([^\s"]+))/g;
  let match: RegExpExecArray | null;

  while ((match = includePattern.exec(command)) !== null) {
    const matchedPath = match[1] || match[2] || match[3] || match[4];
    if (matchedPath && getIncludePathKey(matchedPath) === expectedKey) {
      return true;
    }
  }

  return false;
}
