/**
 * LibraryIndexCache stores the expensive Arduino library scan results.
 *
 * Path state keeps only cheap fingerprints and per-file hashes. Source indexes
 * are keyed by library content hash, so identical libraries in different
 * project directories reuse the same analysis result without cache migration.
 */
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { Logger } from './utils/Logger';
import type { MacroDefinition } from './utils/PreprocessorExpression';
import { getAilyBuilderCacheDirectory } from './utils/CacheDirectory';
import { toHostPathKey } from './utils/HostPlatform';
import { LIBRARY_FINGERPRINT_FILE_GLOBS } from './utils/LibraryFilePatterns';
import { readFileObservation } from './FileObservation';
import { captureMacroOrigins, restoreMacroOrigins, sameMacroDefinition } from './MacroSourceOrigins';
import type { MacroSourceReference, RestoredMacroOrigins } from './MacroSourceOrigins';
import { librarySourceIndexPath, isSourceIndexUsable, type CachedMacroIndex, type CachedSourceIndex } from './LibrarySourceIndex';
import { PreprocessInputChangedError } from './DirectiveTapeSnapshot';
import { publishAtomicJsonCache } from './AtomicJsonCache';

const SCHEMA_VERSION = 7;
export const DEPENDENCY_ANALYZER_VERSION = 'dependency-library-layout-v8';
export const LIBRARY_HEADER_INPUTS_SCHEME = 'checked-header-paths-v2' as const;
const ANALYZER_VERSION = DEPENDENCY_ANALYZER_VERSION;
const STAT_CONCURRENCY = 32;

interface FileSnapshot {
  relPath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  identity: string;
  contentHash?: string;
}

interface CachedFileSnapshot {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  contentHash: string;
}

interface RestoredMacroIndex extends RestoredMacroOrigins { headerInputs?: LibraryHeaderInputs }

interface CachedPathState {
  schemaVersion: number;
  analyzerVersion: string;
  libraryName: string;
  libraryPath: string;
  fastFingerprint: string;
  sourceHash: string;
  files: Record<string, CachedFileSnapshot>;
  updatedAt: string;
}

export interface LibraryIndexBuildResult {
  sourceFiles: string[];
  includeFiles: string[];
  macroDefinitions?: Map<string, MacroDefinition>;
  macroOrigins?: Map<string, MacroSourceReference>;
  headerInputs?: LibraryHeaderInputs;
}

export type LibraryHeaderInputs = Array<[file: string, identity: string | null]>;

export function dependencyInputIdentity(file: string): string | undefined {
  return readFileObservation(file).identity;
}

export function headerInputsCurrent(inputs?: LibraryHeaderInputs): boolean {
  return inputs === undefined || (Array.isArray(inputs) && inputs.every(entry => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return false;
    const observation = readFileObservation(entry[0]);
    return observation.state !== 'unavailable' && (observation.identity ?? null) === entry[1];
  }));
}

export interface LibraryIndexValidationOptions {
  /** Facts used to select the layout/context, independent of parsed C/C++ inputs. */
  requiredInputs?: readonly (readonly [file: string, identity: string | null])[];
}

function inputKey(file: string): string { return toHostPathKey(path.resolve(file)); }

function mergeHeaderInputs(inputs: LibraryHeaderInputs | undefined,
  required: LibraryIndexValidationOptions['requiredInputs']): LibraryHeaderInputs | undefined {
  if (!required?.length) return inputs;
  const merged = new Map<string, [string, string | null]>();
  for (const [file, identity] of [...(inputs || []), ...required]) {
    const key = inputKey(file), previous = merged.get(key);
    if (previous && previous[1] !== identity) throw new PreprocessInputChangedError(file, 'conflicting-required-input');
    merged.set(key, [file, identity]);
  }
  return [...merged.values()];
}

function containsRequiredInputs(inputs: LibraryHeaderInputs | undefined,
  required: LibraryIndexValidationOptions['requiredInputs']): boolean {
  if (!required?.length) return true;
  if (!inputs) return false;
  const recorded = new Map<string, string | null>();
  for (const [file, identity] of inputs) {
    const key = inputKey(file);
    if (recorded.has(key) && recorded.get(key) !== identity) return false;
    recorded.set(key, identity);
  }
  return required.every(([file, identity]) => recorded.has(inputKey(file)) && recorded.get(inputKey(file)) === identity);
}

function assertRequiredInputsCurrent(required: LibraryHeaderInputs | undefined): void {
  if (!headerInputsCurrent(required)) throw new PreprocessInputChangedError(required?.[0]?.[0] || '', 'layout-input-changed');
}

interface PreparedLibraryIndexLookup {
  startedAt: number;
  normalizedLibraryPath: string;
  pathStatePath: string;
  macroKey: string;
  files: FileSnapshot[];
  fastFingerprint: string;
  sourceHash: string;
  fileRecords: Record<string, CachedFileSnapshot>;
  result?: LibraryIndexResult;
}

export interface LibraryIndexResult extends LibraryIndexBuildResult {
  cacheHit: boolean;
  fastFingerprint: string;
  sourceHash: string;
}

export class LibraryIndexCache {
  private cacheDir: string;

  constructor(private logger: Logger) {
    this.cacheDir = this.getDefaultCacheDir();
    fs.ensureDirSync(this.cacheDir);
  }

  async getOrCreate(
    libraryName: string,
    libraryPath: string,
    macroDefinitions: Map<string, MacroDefinition>,
    builder: (sourceHash: string) => Promise<LibraryIndexBuildResult>,
    analysisContext: string = '',
    options: LibraryIndexValidationOptions = {}
  ): Promise<LibraryIndexResult> {
    const requiredInputs = mergeHeaderInputs(undefined, options.requiredInputs);
    const lookup = await this.lookupIndex(libraryName, libraryPath, macroDefinitions, analysisContext, requiredInputs);
    if (lookup.result) return lookup.result;
    return this.rebuildAndStore(
      libraryName, libraryPath, lookup.normalizedLibraryPath, lookup.pathStatePath,
      macroDefinitions, lookup.macroKey, builder, lookup.files.length,
      lookup.fastFingerprint, lookup.sourceHash, lookup.fileRecords, lookup.startedAt, requiredInputs
    );
  }

  private async lookupIndex(
    libraryName: string,
    libraryPath: string,
    macroDefinitions: Map<string, MacroDefinition>,
    analysisContext: string,
    requiredInputs?: LibraryHeaderInputs
  ): Promise<PreparedLibraryIndexLookup> {
    assertRequiredInputsCurrent(requiredInputs);
    const startedAt = Date.now();
    const normalizedLibraryPath = this.normalizePath(libraryPath);
    const pathStatePath = this.getPathStatePath(normalizedLibraryPath);
    const macroKey = this.createMacroKey(macroDefinitions, analysisContext);
    const files = await this.collectFiles(libraryPath);
    const fastFingerprint = this.createFastFingerprint(files);
    const cachedPathState = await this.readPathState(pathStatePath);
    const usablePathState = this.isPathStateUsable(cachedPathState, normalizedLibraryPath) ? cachedPathState : null;
    const pathHit = !!usablePathState && usablePathState.fastFingerprint === fastFingerprint;
    const { sourceHash, fileRecords } = pathHit
      ? { sourceHash: usablePathState.sourceHash, fileRecords: usablePathState.files }
      : await this.createSourceHash(libraryPath, files, usablePathState);
    const sourceIndex = await this.readSourceIndexForHash(sourceHash, macroKey);
    const lookup: PreparedLibraryIndexLookup = {
      startedAt, normalizedLibraryPath, pathStatePath, macroKey, files,
      fastFingerprint, sourceHash, fileRecords
    };
    const macroIndex = sourceIndex?.macroIndex;
    if (!macroIndex || !containsRequiredInputs(macroIndex.headerInputs, requiredInputs)) return lookup;
    const restored = this.restoreIndex(macroIndex, libraryPath, files, macroDefinitions);
    if (!restored) return lookup;

    if (!pathHit) {
      await this.writeCache(pathStatePath, this.createPathState(
        libraryName, normalizedLibraryPath, fastFingerprint, sourceHash, fileRecords
      ));
    }
    await this.touchCacheAccess([
      ...(pathHit ? [pathStatePath] : []), this.getSourceIndexPath(sourceHash, macroKey)
    ]);
    const currentFiles = await this.collectFiles(libraryPath);
    assertRequiredInputsCurrent(requiredInputs);
    if (!this.finalInputsCurrent(libraryPath, fastFingerprint, currentFiles, restored.headerInputs, restored)) return lookup;
    this.logger.debug(`[LIB_INDEX] ${pathHit ? 'hit' : 'source hit'} ${libraryName}: ${files.length} files, ${Date.now() - startedAt}ms`);
    lookup.result = {
      sourceFiles: this.toAbsolutePaths(libraryPath, macroIndex.sourceFiles), includeFiles: macroIndex.includeFiles,
      macroDefinitions: restored.macros, macroOrigins: restored.origins, headerInputs: restored.headerInputs,
      cacheHit: true, fastFingerprint, sourceHash
    };
    return lookup;
  }

  private async rebuildAndStore(
    libraryName: string,
    libraryPath: string,
    normalizedLibraryPath: string,
    pathStatePath: string,
    macroDefinitions: Map<string, MacroDefinition>,
    macroKey: string,
    builder: (sourceHash: string) => Promise<LibraryIndexBuildResult>,
    fileCount: number,
    fastFingerprint: string,
    sourceHash: string,
    fileRecords: Record<string, CachedFileSnapshot>,
    startedAt: number,
    requiredInputs?: LibraryHeaderInputs
  ): Promise<LibraryIndexResult> {
    assertRequiredInputsCurrent(requiredInputs);
    this.logger.debug(`[LIB_INDEX] rebuild ${libraryName}: ${fileCount} files`);
    const built = await builder(sourceHash);
    const headerInputs = mergeHeaderInputs(built.headerInputs, requiredInputs);
    const sourceFiles = this.toRelativePaths(libraryPath, built.sourceFiles);

    const nextPathState = this.createPathState(
      libraryName,
      normalizedLibraryPath,
      fastFingerprint,
      sourceHash,
      fileRecords
    );

    const finalMacroDefinitions = built.macroDefinitions || macroDefinitions;
    const macroOrigins = captureMacroOrigins(macroDefinitions, finalMacroDefinitions, built.macroOrigins);
    const restored = macroOrigins && restoreMacroOrigins(macroOrigins, macroDefinitions,
      new Set(Object.keys(fileRecords).map(file => path.resolve(libraryPath, file))), headerInputs, libraryPath);
    const completeOrigins = !!restored && new Set([...restored.macros.keys(), ...finalMacroDefinitions.keys()]).size === finalMacroDefinitions.size
      && [...finalMacroDefinitions].every(([name, definition]) => sameMacroDefinition(definition, restored.macros.get(name)));
    const macroIndex: CachedMacroIndex | null = macroOrigins && completeOrigins ? {
        sourceFiles, includeFiles: [...new Set(built.includeFiles)], libraryPath: path.resolve(libraryPath), macroOrigins,
        headerInputs, builtAt: new Date().toISOString()
      } : null;
    const nextSourceIndex = this.createSourceIndex(libraryName, sourceHash, macroKey, macroIndex);

    // Bind the selected structure to the content hash before publishing it.
    // A post-write guard alone would leave a mismatched entry under the old
    // sourceHash even though this request correctly refused to return it.
    this.assertLibraryFingerprint(libraryPath, fastFingerprint, await this.collectFiles(libraryPath));
    assertRequiredInputsCurrent(requiredInputs);
    await Promise.all([
      this.writeCache(pathStatePath, nextPathState),
      this.writeCache(this.getSourceIndexPath(sourceHash, macroKey), nextSourceIndex)
    ]);
    const currentFiles = await this.collectFiles(libraryPath);
    assertRequiredInputsCurrent(requiredInputs);
    if (!this.finalInputsCurrent(libraryPath, fastFingerprint, currentFiles, headerInputs, restored || undefined))
      throw new PreprocessInputChangedError(libraryPath, 'header-inputs-changed-after-analysis');
    this.logger.debug(!completeOrigins
      ? `[LIB_INDEX] skipped macro cache ${libraryName}: incomplete macro source references, ${Date.now() - startedAt}ms`
      : `[LIB_INDEX] stored ${libraryName}: sources=${built.sourceFiles.length}, includes=${built.includeFiles.length}, ${Date.now() - startedAt}ms`);
    return {
      // Ninja's archive member order must agree with cache-hit builds.
      sourceFiles: this.toAbsolutePaths(libraryPath, sourceFiles),
      includeFiles: built.includeFiles,
      macroDefinitions: built.macroDefinitions || macroDefinitions,
      macroOrigins: built.macroOrigins,
      headerInputs,
      cacheHit: false,
      fastFingerprint,
      sourceHash
    };
  }

  private async touchCacheAccess(cachePaths: string[]): Promise<void> {
    const now = new Date();
    await Promise.all(cachePaths.map(async (cachePath) => {
      try {
        if (await fs.pathExists(cachePath)) {
          await fs.utimes(cachePath, now, now);
        }
      } catch (error) {
        this.logger.debug(`[LIB_INDEX] failed to update cache access time ${cachePath}: ${error instanceof Error ? error.message : error}`);
      }
    }));
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  private getDefaultCacheDir(): string {
    return getAilyBuilderCacheDirectory('library-index-cache-v5');
  }

  private async collectFiles(libraryPath: string): Promise<FileSnapshot[]> {
    const files = await glob(LIBRARY_FINGERPRINT_FILE_GLOBS, {
      cwd: libraryPath,
      absolute: true,
      nodir: true,
      ignore: ['**/examples/**', '**/extras/**']
    });

    const uniqueFiles = Array.from(new Map(
      files.map(filePath => [this.toRelativePath(libraryPath, filePath), filePath])
    ).entries())
      .map(([relPath, filePath]) => ({ relPath, filePath }))
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
    const snapshots = new Array<FileSnapshot>(uniqueFiles.length);

    await this.mapLimit(uniqueFiles, STAT_CONCURRENCY, async ({ relPath, filePath }, index) => {
      const stat = await fs.stat(filePath);
      snapshots[index] = {
        relPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      };
    });

    return snapshots;
  }

  private createFastFingerprint(files: FileSnapshot[]): string {
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(file.relPath);
      hash.update('|');
      hash.update(String(file.size));
      hash.update('|');
      hash.update(String(Math.round(file.mtimeMs * 1000)));
      hash.update('|');
      hash.update(String(Math.round(file.ctimeMs * 1000)));
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  private async createSourceHash(
    libraryPath: string,
    files: FileSnapshot[],
    cached: CachedPathState | null
  ): Promise<{ sourceHash: string; fileRecords: Record<string, CachedFileSnapshot> }> {
    const fileRecords: Record<string, CachedFileSnapshot> = {};

    await this.mapLimit(files, 12, async (file) => {
      const cachedFile = cached?.files?.[file.relPath];
      const canReuseHash = cachedFile &&
        cachedFile.size === file.size &&
        cachedFile.mtimeMs === file.mtimeMs &&
        cachedFile.ctimeMs === file.ctimeMs &&
        cachedFile.contentHash;

      const contentHash = canReuseHash
        ? cachedFile.contentHash
        : await this.hashFile(path.resolve(libraryPath, file.relPath));

      fileRecords[file.relPath] = {
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        contentHash
      };
    });

    const sourceHash = createHash('sha256');
    for (const relPath of Object.keys(fileRecords).sort()) {
      sourceHash.update(relPath);
      sourceHash.update('|');
      sourceHash.update(fileRecords[relPath].contentHash);
      sourceHash.update('\n');
    }

    return {
      sourceHash: sourceHash.digest('hex'),
      fileRecords
    };
  }

  private async hashFile(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }

  private async mapLimit<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const currentIndex = index++;
        await worker(items[currentIndex], currentIndex);
      }
    });
    await Promise.all(workers);
  }

  private createMacroKey(
    macroDefinitions: Map<string, MacroDefinition>,
    analysisContext: string
  ): string {
    const entries = [...macroDefinitions].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, macro]) => [
        name, macro.isDefined, [macro.value !== undefined, macro.value === undefined ? null : macro.value],
        !!macro.functionLike, macro.parameters || [], !!macro.variadic
      ]);
    // Values participate only in this in-memory digest. Tagged structural
    // encoding avoids sentinel, separator and defined-state collisions.
    return createHash('sha256').update(JSON.stringify([
      'macro-context-v2', analysisContext, entries
    ])).digest('hex');
  }

  private restoreIndex(index: CachedMacroIndex | undefined, libraryPath: string, files: FileSnapshot[],
    base: Map<string, MacroDefinition>): RestoredMacroIndex | undefined {
    if (!index || index.libraryPath !== path.resolve(libraryPath)) return undefined;
    // The matching sourceHash proves current library bytes; metadata-only changes
    // can rebind own files. External positive and exact missing inputs keep their
    // original identities and must pass the final fresh validation unchanged.
    const own = new Map(files.map(file => [path.resolve(libraryPath, file.relPath), file.identity]));
    const headerInputs = index.headerInputs?.map(([file, identity]): [string, string | null] =>
      [file, identity !== null && own.has(path.resolve(file)) ? own.get(path.resolve(file))! : identity]);
    const macroOrigins = { ...index.macroOrigins, files: index.macroOrigins.files.map(file =>
      own.has(path.resolve(file.path)) ? { ...file, identity: own.get(path.resolve(file.path))! } : file) };
    const restored = restoreMacroOrigins(macroOrigins, base, new Set(own.keys()), headerInputs, libraryPath);
    return restored && { ...restored, headerInputs };
  }

  /** Called after all cache I/O and the final inventory collection, with no further await before return. */
  private finalInputsCurrent(libraryPath: string, expectedFingerprint: string, currentFiles: FileSnapshot[],
    headers: LibraryHeaderInputs | undefined, origins?: RestoredMacroOrigins): boolean {
    this.assertLibraryFingerprint(libraryPath, expectedFingerprint, currentFiles);
    const headersCurrent = headerInputsCurrent(headers);
    origins?.verifyCurrent();
    return headersCurrent;
  }

  private assertLibraryFingerprint(libraryPath: string, expectedFingerprint: string, currentFiles: FileSnapshot[]): void {
    if (this.createFastFingerprint(currentFiles) !== expectedFingerprint)
      throw new PreprocessInputChangedError(libraryPath, 'library-files-changed-during-analysis');
  }

  private getPathStatePath(normalizedLibraryPath: string): string {
    const key = createHash('sha256')
      .update(ANALYZER_VERSION)
      .update('|path|')
      .update(normalizedLibraryPath)
      .digest('hex');
    return path.join(this.cacheDir, 'paths', key.substring(0, 2), `${key}.json`);
  }

  private getSourceIndexPath(sourceHash: string, macroKey: string): string {
    return librarySourceIndexPath(this.cacheDir, ANALYZER_VERSION, sourceHash, macroKey);
  }

  private async readPathState(cachePath: string): Promise<CachedPathState | null> {
    return this.readJSONCache<CachedPathState>(cachePath);
  }

  private async readSourceIndexForHash(sourceHash: string, macroKey: string): Promise<CachedSourceIndex | null> {
    const sourceIndex = await this.readJSONCache<CachedSourceIndex>(this.getSourceIndexPath(sourceHash, macroKey));
    return isSourceIndexUsable(sourceIndex, SCHEMA_VERSION, ANALYZER_VERSION, sourceHash, macroKey) ? sourceIndex : null;
  }

  private async readJSONCache<T>(cachePath: string): Promise<T | null> {
    try {
      if (!await fs.pathExists(cachePath)) {
        return null;
      }
      return await fs.readJSON(cachePath);
    } catch (error) {
      this.logger.debug(`[LIB_INDEX] failed to read cache ${cachePath}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  private async writeCache(cachePath: string, cache: CachedPathState | CachedSourceIndex): Promise<void> {
    try {
      await publishAtomicJsonCache(cachePath, cache);
    } catch (error) {
      this.logger.debug(`[LIB_INDEX] failed to write cache ${cachePath}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private isPathStateUsable(cache: CachedPathState | null, normalizedLibraryPath: string): cache is CachedPathState {
    return !!cache &&
      cache.schemaVersion === SCHEMA_VERSION &&
      cache.analyzerVersion === ANALYZER_VERSION &&
      cache.libraryPath === normalizedLibraryPath &&
      typeof cache.libraryPath === 'string' &&
      typeof cache.sourceHash === 'string' &&
      !!cache.files;
  }

  private createPathState(
    libraryName: string,
    normalizedLibraryPath: string,
    fastFingerprint: string,
    sourceHash: string,
    files: Record<string, CachedFileSnapshot>
  ): CachedPathState {
    return {
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      libraryName,
      libraryPath: normalizedLibraryPath,
      fastFingerprint,
      sourceHash,
      files,
      updatedAt: new Date().toISOString()
    };
  }

  private createSourceIndex(
    libraryName: string,
    sourceHash: string,
    macroKey: string,
    macroIndex: CachedMacroIndex | null
  ): CachedSourceIndex {
    return {
      storageVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      libraryName,
      sourceHash,
      macroKey,
      macroIndex,
      updatedAt: new Date().toISOString()
    };
  }

  private normalizePath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    return toHostPathKey(resolved);
  }

  private toRelativePath(rootPath: string, filePath: string): string {
    return path.relative(rootPath, filePath).replace(/\\/g, '/');
  }

  private toRelativePaths(rootPath: string, files: string[]): string[] {
    return [...new Set(files.map(file => this.toRelativePath(rootPath, file)))].sort();
  }

  private toAbsolutePaths(rootPath: string, files: string[]): string[] {
    return files.map(file => path.resolve(rootPath, file));
  }
}
