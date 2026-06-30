/**
 * LibraryIndexCache stores the expensive Arduino library scan results.
 *
 * It first checks a cheap directory fingerprint based on relative path, size,
 * and mtime. When that changes, it reuses per-file content hashes where
 * possible and rebuilds only the affected library index data.
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { Logger } from './utils/Logger';
import type { MacroDefinition } from './DependencyAnalyzer';

const SCHEMA_VERSION = 1;
const ANALYZER_VERSION = 'library-index-cache-v4';

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
}

interface CachedLibraryIndex {
  schemaVersion: number;
  analyzerVersion: string;
  libraryName: string;
  libraryPath: string;
  fastFingerprint: string;
  sourceHash: string;
  files: Record<string, CachedFileSnapshot>;
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
    builder: () => Promise<LibraryIndexBuildResult>
  ): Promise<LibraryIndexResult> {
    const startedAt = Date.now();
    const normalizedLibraryPath = this.normalizePath(libraryPath);
    const cachePath = this.getCachePath(normalizedLibraryPath);
    const macroKey = this.createMacroKey(macroDefinitions);
    const files = await this.collectFiles(libraryPath);
    const fastFingerprint = this.createFastFingerprint(files);
    const cached = await this.readCache(cachePath);

    if (this.isCacheUsable(cached, normalizedLibraryPath) && cached.fastFingerprint === fastFingerprint) {
      const macroIndex = cached.macroIndexes?.[macroKey];
      if (cached.sourceFiles && macroIndex) {
        this.logger.debug(`[LIB_INDEX] hit ${libraryName}: ${files.length} files, ${Date.now() - startedAt}ms`);
        return {
          sourceFiles: this.toAbsolutePaths(libraryPath, cached.sourceFiles),
          includeFiles: macroIndex.includeFiles,
          macroDefinitions: this.applyMacroDeltas(macroDefinitions, macroIndex.macroDeltas),
          cacheHit: true,
          fastFingerprint,
          sourceHash: cached.sourceHash
        };
      }
    }

    const { sourceHash, fileRecords } = await this.createSourceHash(libraryPath, files, cached);
    const canReuseContent = this.isCacheUsable(cached, normalizedLibraryPath) && cached.sourceHash === sourceHash;

    if (canReuseContent) {
      const macroIndex = cached.macroIndexes?.[macroKey];
      if (cached.sourceFiles && macroIndex) {
        await this.writeCache(cachePath, {
          ...cached,
          fastFingerprint,
          files: fileRecords,
          updatedAt: new Date().toISOString()
        });
        this.logger.debug(`[LIB_INDEX] content hit ${libraryName}: ${files.length} files, ${Date.now() - startedAt}ms`);
        return {
          sourceFiles: this.toAbsolutePaths(libraryPath, cached.sourceFiles),
          includeFiles: macroIndex.includeFiles,
          macroDefinitions: this.applyMacroDeltas(macroDefinitions, macroIndex.macroDeltas),
          cacheHit: true,
          fastFingerprint,
          sourceHash
        };
      }
    }

    this.logger.debug(`[LIB_INDEX] rebuild ${libraryName}: ${files.length} files`);
    const built = await builder();
    const sourceFiles = this.toRelativePaths(libraryPath, built.sourceFiles);
    const nextCache: CachedLibraryIndex = {
      schemaVersion: SCHEMA_VERSION,
      analyzerVersion: ANALYZER_VERSION,
      libraryName,
      libraryPath: normalizedLibraryPath,
      fastFingerprint,
      sourceHash,
      files: fileRecords,
      sourceFiles,
      macroIndexes: canReuseContent && cached?.macroIndexes ? { ...cached.macroIndexes } : {},
      updatedAt: new Date().toISOString()
    };

    nextCache.macroIndexes[macroKey] = {
      includeFiles: [...new Set(built.includeFiles)],
      macroDeltas: this.serializeMacroDeltas(macroDefinitions, built.macroDefinitions || macroDefinitions),
      builtAt: new Date().toISOString()
    };

    await this.writeCache(cachePath, nextCache);

    this.logger.debug(`[LIB_INDEX] stored ${libraryName}: sources=${built.sourceFiles.length}, includes=${built.includeFiles.length}, ${Date.now() - startedAt}ms`);
    return {
      sourceFiles: built.sourceFiles,
      includeFiles: built.includeFiles,
      macroDefinitions: built.macroDefinitions || macroDefinitions,
      cacheHit: false,
      fastFingerprint,
      sourceHash
    };
  }

  private getDefaultCacheDir(): string {
    if (os.platform() === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Local', 'aily-builder', 'library-index-cache');
    }
    if (os.platform() === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Caches', 'aily-builder', 'library-index-cache');
    }
    return path.join(os.homedir(), '.cache', 'aily-builder', 'library-index-cache');
  }

  private async collectFiles(libraryPath: string): Promise<FileSnapshot[]> {
    const files = await glob(['**/*.{h,hpp,hh,c,cpp,S,s}', 'library.properties'], {
      cwd: libraryPath,
      absolute: true,
      nodir: true,
      ignore: ['**/examples/**', '**/extras/**']
    });

    const uniqueFiles = [...new Set(files)].sort((a, b) => this.toRelativePath(libraryPath, a).localeCompare(this.toRelativePath(libraryPath, b)));
    const snapshots: FileSnapshot[] = [];

    for (const filePath of uniqueFiles) {
      const stat = await fs.stat(filePath);
      snapshots.push({
        relPath: this.toRelativePath(libraryPath, filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }

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
    cached: CachedLibraryIndex | null
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

  private async mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = items[index++];
        await worker(current);
      }
    });
    await Promise.all(workers);
  }

  private createMacroKey(macroDefinitions: Map<string, MacroDefinition>): string {
    const hash = createHash('sha256');
    const entries = Array.from(macroDefinitions.entries())
      .map(([name, macro]) => `${name}=${macro.isDefined ? macro.value ?? '1' : '<undefined>'}`)
      .sort();

    for (const entry of entries) {
      hash.update(entry);
      hash.update('\n');
    }

    return hash.digest('hex');
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
      if (baseMacro && baseMacro.value === macro.value && baseMacro.isDefined === macro.isDefined) {
        continue;
      }
      result[name] = {
        value: macro.value,
        isDefined: macro.isDefined
      };
    }
    return result;
  }

  private isSensitiveMacroName(name: string): boolean {
    return /(PASSWORD|PASS|SECRET|TOKEN|API[_-]?KEY|PRIVATE|CREDENTIAL|SSID|WIFI)/i.test(name);
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
        isDefined: macro.isDefined
      });
    }
    return result;
  }

  private getCachePath(normalizedLibraryPath: string): string {
    const key = createHash('sha256')
      .update(ANALYZER_VERSION)
      .update('|')
      .update(normalizedLibraryPath)
      .digest('hex');
    return path.join(this.cacheDir, key.substring(0, 2), `${key}.json`);
  }

  private async readCache(cachePath: string): Promise<CachedLibraryIndex | null> {
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

  private async writeCache(cachePath: string, cache: CachedLibraryIndex): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(cachePath));
      const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeJSON(tmpPath, cache);
      await fs.move(tmpPath, cachePath, { overwrite: true });
    } catch (error) {
      this.logger.debug(`[LIB_INDEX] failed to write cache ${cachePath}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private isCacheUsable(cache: CachedLibraryIndex | null, normalizedLibraryPath: string): cache is CachedLibraryIndex {
    return !!cache &&
      cache.schemaVersion === SCHEMA_VERSION &&
      cache.analyzerVersion === ANALYZER_VERSION &&
      cache.libraryPath === normalizedLibraryPath &&
      !!cache.files &&
      !!cache.macroIndexes;
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
