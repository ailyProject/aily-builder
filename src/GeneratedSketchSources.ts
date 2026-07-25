import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import { toHostPathKey } from './utils/HostPlatform';

export const GENERATED_SKETCH_DEPENDENCY_NAME = '__generated_sketch__';

const GENERATED_SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.S',
  '.s'
]);

export function getGeneratedSketchSourceRoot(buildPath = process.env['BUILD_PATH']): string | null {
  if (!buildPath) {
    return null;
  }

  return path.resolve(buildPath, 'sketch');
}

/**
 * Collect source files emitted by platform prebuild hooks into {build.path}/sketch.
 * Arduino sketch semantics compile direct files plus files below sketch/src;
 * unrelated subdirectories are intentionally ignored. The list is deterministic
 * so persisted preprocess results remain stable.
 */
export async function collectGeneratedSketchSources(buildPath = process.env['BUILD_PATH']): Promise<string[]> {
  const sourceRoot = getGeneratedSketchSourceRoot(buildPath);
  if (!sourceRoot || !await fs.pathExists(sourceRoot)) {
    return [];
  }

  const candidates = await glob(['*', 'src/**/*'], {
    cwd: sourceRoot,
    absolute: true,
    nodir: true,
    dot: true,
    follow: false
  });
  const uniqueSources = new Map<string, string>();

  for (const candidate of candidates) {
    if (!GENERATED_SOURCE_EXTENSIONS.has(path.extname(candidate))) {
      continue;
    }

    const resolvedPath = path.resolve(candidate);
    const relativePath = path.relative(sourceRoot, resolvedPath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      continue;
    }

    const key = toHostPathKey(resolvedPath);
    uniqueSources.set(key, resolvedPath);
  }

  return Array.from(uniqueSources.values()).sort((left, right) => {
    const leftRelative = path.relative(sourceRoot, left).replace(/\\/g, '/');
    const rightRelative = path.relative(sourceRoot, right).replace(/\\/g, '/');
    return leftRelative.localeCompare(rightRelative, 'en');
  });
}
