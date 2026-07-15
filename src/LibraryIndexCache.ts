/**
 * LibraryIndexCache stores the expensive Arduino library scan results.
 *
 * Path state keeps only cheap fingerprints and per-file hashes. Source indexes
 * are keyed by library content hash, so identical libraries in different
 * project directories reuse the same analysis result without cache migration.
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { Logger } from './utils/Logger';
import type { MacroDefinition } from './utils/PreprocessorExpression';

const SCHEMA_VERSION = 3;
export const DEPENDENCY_ANALYZER_VERSION = 'dependency-directive-tape-v2';
const ANALYZER_VERSION = DEPENDENCY_ANALYZER_VERSION;
const STAT_CONCURRENCY = 32;

interface FileSnapshot {
  relPath: string;
  size: number;
  mtimeMs: number;
  contentHash?: string;
}

interface CachedFileSnapshot {
  size: number;
  mtimeMs: number;
  contentHash: string;
}

interface CachedMacroIndex {
  includeFiles: string[];
  macroDeltas: Record<string, CachedMacroDefinition>;
  builtAt: string;
}

interface CachedMacroDefinition {
  value?: string;
  isDefined: boolean;
  functionLike?: boolean;
  parameters?: string[];
  variadic?: boolean;
}

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

interface CachedSourceIndex {
  schemaVersion: number;
  analyzerVersion: string;
  libraryName: string;
  sourceHash: string;
  sourceFiles: string[];
  macroIndexes: Record<string, CachedMacroIndex>;
  updatedAt: string;
}

export interface LibraryIndexBuildResult {
  sourceFiles: string[];
  includeFiles: string[];
  macroDefinitions?: Map<string, MacroDefinition>;
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
    builder: () => Promise<LibraryIndexBuildResult>,
    analysisContext: string = ''
  ): Promise<LibraryIndexResult> {
    const startedAt = Date.now();
    const normalizedLibraryPath = this.normalizePath(libraryPath);
    const pathStatePath = this.getPathStatePath(normalizedLibraryPath);
    const macroKey = this.createMacroKey(macroDefinitions, analysisContext);
    const files = await this.collectFiles(libraryPath);
    const fastFingerprint = this.createFastFingerprint(files);
    const cachedPathState = await this.readPathState(pathStatePath);

    if (this.isPathStateUsable(cachedPathState, normalizedLibraryPath) && cachedPathState.fastFingerprint === fastFingerprint) {
      const sourceIndex = await this.readSourceIndexForHash(cachedPathState.sourceHash);
      const macroIndex = sourceIndex?.macroIndexes?.[macroKey];
      if (sourceIndex && macroIndex) {
        await this.touchCacheAccess([
          pathStatePath,
          this.getSourceIndexPath(cachedPathState.sourceHash)
        ]);
        this.logger.debug(`[LIB_INDEX] hit ${libraryName}: ${files.length} files, ${Date.now() - startedAt}ms`);
        return {
          sourceFiles: this.toAbsolutePaths(libraryPath, sourceIndex.sourceFiles),
          includeFiles: macroIndex.includeFiles,
          macroDefinitions: this.applyMacroDeltas(macroDefinitions, macroIndex.macroDeltas),
          cacheHit: true,
          fastFingerprint,
          sourceHash: cachedPathState.sourceHash
        };
      }

      return this.rebuildAndStore(
        libraryName,
        libraryPath,
        normalizedLibraryPath,
        pathStatePath,
        macroDefinitions,
        macroKey,
        builder,
        files.length,
        fastFingerprint,
        cachedPathState.sourceHash,
        cachedPathState.files,
        sourceIndex,
        startedAt
      );
    }

    const reusablePathState = this.isPathStateUsable(cachedPathState, normalizedLibraryPath)
      ? cachedPathState
      : null;
    const { sourceHash, fileRecords } = await this.createSourceHash(libraryPath, files, reusablePathState);
    const sourceIndex = await this.readSourceIndexForHash(sourceHash);
    const macroIndex = sourceIndex?.macroIndexes?.[macroKey];

    if (sourceIndex && macroIndex) {
      await this.writeCache(pathStatePath, this.createPathState(
        libraryName,
        normalizedLibraryPath,
        fastFingerprint,
        sourceHash,
        fileRecords
      ));
      await this.touchCacheAccess([this.getSourceIndexPath(sourceHash)]);
      this.logger.debug(`[LIB_INDEX] source hit ${libraryName}: ${files.length} files, ${Date.now() - startedAt}ms`);
      return {
        sourceFiles: this.toAbsolutePaths(libraryPath, sourceIndex.sourceFiles),
        includeFiles: macroIndex.includeFiles,
        macroDefinitions: this.applyMacroDeltas(macroDefinitions, macroIndex.macroDeltas),
        cacheHit: true,
        fastFingerprint,
        sourceHash
      };
    }

    return this.rebuildAndStore(
      libraryName,
      libraryPath,
      normalizedLibraryPath,
      pathStatePath,
      macroDefinitions,
      macroKey,
      builder,
      files.length,
      fastFingerprint,
      sourceHash,
      fileRecords,
      sourceIndex,
      startedAt
    );
  }

  private async rebuildAndStore(
    libraryName: string,
    libraryPath: string,
    normalizedLibraryPath: string,
    pathStatePath: string,
    macroDefinitions: Map<string, MacroDefinition>,
    macroKey: string,
    builder: () => Promise<LibraryIndexBuildResult>,
    fileCount: number,
    fastFingerprint: string,
    sourceHash: string,
    fileRecords: Record<string, CachedFileSnapshot>,
    sourceIndex: CachedSourceIndex | null,
    startedAt: number
  ): Promise<LibraryIndexResult> {
    this.logger.debug(`[LIB_INDEX] rebuild ${libraryName}: ${fileCount} files`);
    const built = await builder();
    const sourceFiles = this.toRelativePaths(libraryPath, built.sourceFiles);

    const nextPathState = this.createPathState(
      libraryName,
      normalizedLibraryPath,
      fastFingerprint,
      sourceHash,
      fileRecords
    );

    const nextSourceIndex = this.createSourceIndex(
      libraryName,
      sourceHash,
      sourceFiles,
      sourceIndex?.macroIndexes || {}
    );
    const finalMacroDefinitions = built.macroDefinitions || macroDefinitions;
    const hasSensitiveDelta = this.hasSensitiveMacroDelta(macroDefinitions, finalMacroDefinitions);
    if (!hasSensitiveDelta) {
      nextSourceIndex.macroIndexes[macroKey] = this.createMacroIndex(
        built.includeFiles,
        macroDefinitions,
        finalMacroDefinitions
      );
    }

    await Promise.all([
      this.writeCache(pathStatePath, nextPathState),
      this.writeCache(this.getSourceIndexPath(sourceHash), nextSourceIndex)
    ]);

    this.logger.debug(hasSensitiveDelta
      ? `[LIB_INDEX] skipped macro cache ${libraryName}: sensitive macro state changed, ${Date.now() - startedAt}ms`
      : `[LIB_INDEX] stored ${libraryName}: sources=${built.sourceFiles.length}, includes=${built.includeFiles.length}, ${Date.now() - startedAt}ms`);
    return {
      sourceFiles: built.sourceFiles,
      includeFiles: built.includeFiles,
      macroDefinitions: built.macroDefinitions || macroDefinitions,
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
    if (os.platform() === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Local', 'aily-builder', 'library-index-cache-v5');
    }
    if (os.platform() === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Caches', 'aily-builder', 'library-index-cache-v5');
    }
    return path.join(os.homedir(), '.cache', 'aily-builder', 'library-index-cache-v5');
  }

  private async collectFiles(libraryPath: string): Promise<FileSnapshot[]> {
    const files = await glob(['**/*.{h,hpp,hh,c,cpp,S,s}', 'library.properties'], {
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
        mtimeMs: stat.mtimeMs
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
        cachedFile.contentHash;

      const contentHash = canReuseHash
        ? cachedFile.contentHash
        : await this.hashFile(path.resolve(libraryPath, file.relPath));

      fileRecords[file.relPath] = {
        size: file.size,
        mtimeMs: file.mtimeMs,
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
    const hash = createHash('sha256');
    hash.update(`analysis-context=${analysisContext}\n`);
    const entries = Array.from(macroDefinitions.entries())
      .map(([name, macro]) => `${name}=${this.getMacroCacheKeyValue(macro)}|${this.getMacroShapeKey(macro)}`)
      .sort();

    for (const entry of entries) {
      hash.update(entry);
      hash.update('\n');
    }

    return hash.digest('hex');
  }

  private getMacroCacheKeyValue(macro: MacroDefinition): string {
    if (!macro.isDefined) {
      return '<undefined>';
    }
    return macro.value ?? '1';
  }

  private getMacroShapeKey(macro: MacroDefinition): string {
    if (!macro.functionLike) {
      return 'object';
    }
    return `function(${(macro.parameters || []).join(',')})${macro.variadic ? ':variadic' : ''}`;
  }

  private macroDefinitionsEqual(left: MacroDefinition, right: MacroDefinition): boolean {
    return left.value === right.value
      && left.isDefined === right.isDefined
      && !!left.functionLike === !!right.functionLike
      && !!left.variadic === !!right.variadic
      && JSON.stringify(left.parameters || []) === JSON.stringify(right.parameters || []);
  }

  private hasSensitiveMacroDelta(
    baseMacros: Map<string, MacroDefinition>,
    finalMacros: Map<string, MacroDefinition>
  ): boolean {
    const names = new Set([...baseMacros.keys(), ...finalMacros.keys()]);
    for (const name of names) {
      if (!this.isSensitiveMacroName(name)) continue;
      const baseMacro = baseMacros.get(name);
      const finalMacro = finalMacros.get(name);
      if (!baseMacro || !finalMacro || !this.macroDefinitionsEqual(baseMacro, finalMacro)) {
        this.logger.debug(`[LIB_INDEX] sensitive macro state changed: ${name}`);
        return true;
      }
    }
    return false;
  }

  private serializeMacroDeltas(
    baseMacros: Map<string, MacroDefinition>,
    finalMacros: Map<string, MacroDefinition>
  ): Record<string, CachedMacroDefinition> {
    const result: Record<string, CachedMacroDefinition> = {};
    for (const [name, macro] of finalMacros) {
      if (this.isSensitiveMacroName(name)) {
        continue;
      }
      const baseMacro = baseMacros.get(name);
      if (baseMacro && this.macroDefinitionsEqual(baseMacro, macro)) {
        continue;
      }
      result[name] = {
        value: macro.value,
        isDefined: macro.isDefined,
        functionLike: macro.functionLike,
        parameters: macro.parameters,
        variadic: macro.variadic
      };
    }
    return result;
  }

  private createMacroIndex(
    includeFiles: string[],
    baseMacros: Map<string, MacroDefinition>,
    finalMacros: Map<string, MacroDefinition>
  ): CachedMacroIndex {
    return {
      includeFiles: [...new Set(includeFiles)],
      macroDeltas: this.serializeMacroDeltas(baseMacros, finalMacros),
      builtAt: new Date().toISOString()
    };
  }

  private isSensitiveMacroName(name: string): boolean {
    if (/(?:_H|_HH|_HPP)_?$/i.test(name)) {
      return false;
    }
    return /(?:^|_)(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|SSID)(?:$|_)/i.test(name);
  }

  private applyMacroDeltas(
    baseMacros: Map<string, MacroDefinition>,
    macroDeltas: Record<string, CachedMacroDefinition> | undefined
  ): Map<string, MacroDefinition> {
    const result = new Map<string, MacroDefinition>(baseMacros);
    for (const [name, macro] of Object.entries(macroDeltas || {})) {
      result.set(name, {
        name,
        value: macro.value,
        isDefined: macro.isDefined,
        functionLike: macro.functionLike,
        parameters: macro.parameters,
        variadic: macro.variadic
      });
    }
    return result;
  }

  private getPathStatePath(normalizedLibraryPath: string): string {
    const key = createHash('sha256')
      .update(ANALYZER_VERSION)
      .update('|path|')
      .update(normalizedLibraryPath)
      .digest('hex');
    return path.join(this.cacheDir, 'paths', key.substring(0, 2), `${key}.json`);
  }

  private getSourceIndexPath(sourceHash: string): string {
    const analyzerNamespace = createHash('sha256')
      .update(ANALYZER_VERSION)
      .digest('hex')
      .substring(0, 16);
    return path.join(
      this.cacheDir,
      'sources',
      analyzerNamespace,
      sourceHash.substring(0, 2),
      `${sourceHash}.json`
    );
  }

  private async readPathState(cachePath: string): Promise<CachedPathState | null> {
    return this.readJSONCache<CachedPathState>(cachePath);
  }

  private async readSourceIndexForHash(sourceHash: string): Promise<CachedSourceIndex | null> {
    const sourceIndex = await this.readJSONCache<CachedSourceIndex>(this.getSourceIndexPath(sourceHash));
    return this.isSourceIndexUsable(sourceIndex, sourceHash) ? sourceIndex : null;
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
      await fs.ensureDir(path.dirname(cachePath));
      const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeJSON(tmpPath, cache);
      await fs.move(tmpPath, cachePath, { overwrite: true });
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

  private isSourceIndexUsable(cache: CachedSourceIndex | null, sourceHash: string): cache is CachedSourceIndex {
    return !!cache &&
      cache.schemaVersion === SCHEMA_VERSION &&
      cache.analyzerVersion === ANALYZER_VERSION &&
      cache.sourceHash === sourceHash &&
      Array.isArray(cache.sourceFiles) &&
      !!cache.macroIndexes;
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
    sourceFiles: string[],
    macroIndexes: Record<string, CachedMacroIndex>
  ): CachedSourceIndex {
    return {
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      libraryName,
      sourceHash,
      sourceFiles,
      macroIndexes: { ...macroIndexes },
      updatedAt: new Date().toISOString()
    };
  }

  private normalizePath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
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
