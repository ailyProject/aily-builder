import path from 'path';
import { createHash } from 'crypto';
import { isCachedMacroOrigins, type CachedMacroOrigins } from './MacroSourceOrigins';
import type { LibraryHeaderInputs } from './LibraryIndexCache';

export interface CachedMacroIndex {
  sourceFiles: string[];
  includeFiles: string[];
  libraryPath: string;
  macroOrigins: CachedMacroOrigins;
  headerInputs?: LibraryHeaderInputs;
  builtAt: string;
}

/** Each file owns one analysis context; writers never merge unrelated contexts. */
export interface CachedSourceIndex {
  storageVersion: 1;
  schemaVersion: number;
  analyzerVersion: string;
  libraryName: string;
  sourceHash: string;
  macroKey: string;
  macroIndex: CachedMacroIndex | null;
  updatedAt: string;
}

export function librarySourceIndexPath(cacheDir: string, analyzerVersion: string,
  sourceHash: string, macroKey: string): string {
  const namespace = createHash('sha256').update(analyzerVersion).digest('hex').substring(0, 16);
  return path.join(cacheDir, 'sources', namespace, 'contexts-v1', sourceHash.substring(0, 2), sourceHash, `${macroKey}.json`);
}

export function isSourceIndexUsable(cache: CachedSourceIndex | null, schemaVersion: number,
  analyzerVersion: string, sourceHash: string, macroKey: string): cache is CachedSourceIndex {
  if (!cache || cache.storageVersion !== 1 || cache.schemaVersion !== schemaVersion
    || cache.analyzerVersion !== analyzerVersion || cache.sourceHash !== sourceHash || cache.macroKey !== macroKey) return false;
  const index = cache.macroIndex;
  return !!index && typeof index === 'object'
    && Array.isArray(index.sourceFiles) && index.sourceFiles.every(file => typeof file === 'string')
    && Array.isArray(index.includeFiles) && index.includeFiles.every(file => typeof file === 'string')
    && typeof index.libraryPath === 'string' && path.isAbsolute(index.libraryPath)
    && !Object.prototype.hasOwnProperty.call(index, 'macroDeltas') && isCachedMacroOrigins(index.macroOrigins)
    && (index.headerInputs === undefined || (Array.isArray(index.headerInputs) && index.headerInputs.every(entry =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
      && (entry[1] === null || typeof entry[1] === 'string'))));
}
