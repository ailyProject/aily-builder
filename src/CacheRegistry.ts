import fs from 'fs-extra';
import path from 'path';
import type { Dirent, Stats } from 'fs';
import { Logger } from './utils/Logger';
import { CacheManager } from './CacheManager';
import { LibraryIndexCache } from './LibraryIndexCache';
import { ArchiveCloudCacheManager } from './ArchiveCloudCacheManager';

export type CacheClearMode = 'all' | 'unused-30' | 'unused-7';

export interface CacheBucketStats {
  id: string;
  name: string;
  description: string;
  directory: string;
  exists: boolean;
  entries: number;
  files: number;
  directories: number;
  totalSize: number;
  totalSizeFormatted: string;
  oldestLastUsedAt?: string;
  newestLastUsedAt?: string;
}

export interface CacheStatsReport {
  generatedAt: string;
  buckets: CacheBucketStats[];
  total: {
    entries: number;
    files: number;
    directories: number;
    totalSize: number;
    totalSizeFormatted: string;
  };
}

export interface CacheClearReport {
  mode: CacheClearMode;
  dryRun: boolean;
  cutoffDays?: number;
  cutoffAt?: string;
  buckets: CacheBucketClearResult[];
  total: {
    deletedFiles: number;
    deletedDirectories: number;
    bytesFreed: number;
    bytesFreedFormatted: string;
  };
}

export interface CacheBucketClearResult {
  id: string;
  name: string;
  directory: string;
  deletedFiles: number;
  deletedDirectories: number;
  bytesFreed: number;
  bytesFreedFormatted: string;
}

interface CacheBucketDefinition {
  id: string;
  name: string;
  description: string;
  directory: string;
  kind: 'object' | 'library-index' | 'archive-cloud';
}

interface CacheFileRecord {
  path: string;
  relativePath: string;
  name: string;
  stat: Stats;
  size: number;
  lastUsedMs: number;
}

interface CacheDirectoryScan {
  files: CacheFileRecord[];
  directories: string[];
}

interface DeletionUnit {
  paths: string[];
  fileCount: number;
  bytes: number;
  lastUsedMs: number;
}

export class CacheRegistry {
  private buckets: CacheBucketDefinition[];

  constructor(private logger: Logger) {
    this.buckets = this.createBuckets();
  }

  async getStats(): Promise<CacheStatsReport> {
    const buckets = await Promise.all(this.buckets.map(bucket => this.getBucketStats(bucket)));
    const totalSize = buckets.reduce((sum, bucket) => sum + bucket.totalSize, 0);

    return {
      generatedAt: new Date().toISOString(),
      buckets,
      total: {
        entries: buckets.reduce((sum, bucket) => sum + bucket.entries, 0),
        files: buckets.reduce((sum, bucket) => sum + bucket.files, 0),
        directories: buckets.reduce((sum, bucket) => sum + bucket.directories, 0),
        totalSize,
        totalSizeFormatted: this.formatFileSize(totalSize)
      }
    };
  }

  async clear(mode: CacheClearMode, dryRun = false): Promise<CacheClearReport> {
    const cutoffDays = mode === 'unused-30' ? 30 : mode === 'unused-7' ? 7 : undefined;
    const cutoffMs = cutoffDays === undefined
      ? undefined
      : Date.now() - cutoffDays * 24 * 60 * 60 * 1000;

    const buckets: CacheBucketClearResult[] = [];
    for (const bucket of this.buckets) {
      buckets.push(await this.clearBucket(bucket, mode, dryRun, cutoffMs));
    }

    const bytesFreed = buckets.reduce((sum, bucket) => sum + bucket.bytesFreed, 0);

    return {
      mode,
      dryRun,
      cutoffDays,
      cutoffAt: cutoffMs === undefined ? undefined : new Date(cutoffMs).toISOString(),
      buckets,
      total: {
        deletedFiles: buckets.reduce((sum, bucket) => sum + bucket.deletedFiles, 0),
        deletedDirectories: buckets.reduce((sum, bucket) => sum + bucket.deletedDirectories, 0),
        bytesFreed,
        bytesFreedFormatted: this.formatFileSize(bytesFreed)
      }
    };
  }

  formatSize(bytes: number): string {
    return this.formatFileSize(bytes);
  }

  private createBuckets(): CacheBucketDefinition[] {
    const objectCache = new CacheManager(this.logger);
    const libraryIndexCache = new LibraryIndexCache(this.logger);
    const archiveCloudCache = new ArchiveCloudCacheManager(this.logger);

    return [
      {
        id: 'object',
        name: 'Object cache',
        description: 'Compiled .o artifacts restored across builds.',
        directory: objectCache.getCacheDir(),
        kind: 'object'
      },
      {
        id: 'library-index',
        name: 'Library index cache',
        description: 'Dependency analyzer source and macro indexes.',
        directory: libraryIndexCache.getCacheDir(),
        kind: 'library-index'
      },
      {
        id: 'archive-cloud',
        name: 'Archive cloud cache',
        description: 'Reusable core and library .a archives.',
        directory: archiveCloudCache.getCacheDir(),
        kind: 'archive-cloud'
      }
    ];
  }

  private async getBucketStats(bucket: CacheBucketDefinition): Promise<CacheBucketStats> {
    const exists = await fs.pathExists(bucket.directory);
    const scan = exists ? await this.scanDirectory(bucket.directory) : { files: [], directories: [] };
    const totalSize = scan.files.reduce((sum, file) => sum + file.size, 0);
    const lastUsed = scan.files.map(file => file.lastUsedMs).filter(value => Number.isFinite(value));

    return {
      id: bucket.id,
      name: bucket.name,
      description: bucket.description,
      directory: bucket.directory,
      exists,
      entries: this.countEntries(bucket, scan.files),
      files: scan.files.length,
      directories: scan.directories.length,
      totalSize,
      totalSizeFormatted: this.formatFileSize(totalSize),
      oldestLastUsedAt: lastUsed.length > 0 ? new Date(Math.min(...lastUsed)).toISOString() : undefined,
      newestLastUsedAt: lastUsed.length > 0 ? new Date(Math.max(...lastUsed)).toISOString() : undefined
    };
  }

  private async clearBucket(
    bucket: CacheBucketDefinition,
    mode: CacheClearMode,
    dryRun: boolean,
    cutoffMs?: number
  ): Promise<CacheBucketClearResult> {
    if (!await fs.pathExists(bucket.directory)) {
      return this.emptyClearResult(bucket);
    }

    this.assertSafeCacheDirectory(bucket.directory);
    const scan = await this.scanDirectory(bucket.directory);

    if (mode === 'all') {
      const bytesFreed = scan.files.reduce((sum, file) => sum + file.size, 0);
      if (!dryRun) {
        await fs.remove(bucket.directory);
        await fs.ensureDir(bucket.directory);
      }
      return {
        id: bucket.id,
        name: bucket.name,
        directory: bucket.directory,
        deletedFiles: scan.files.length,
        deletedDirectories: scan.directories.length,
        bytesFreed,
        bytesFreedFormatted: this.formatFileSize(bytesFreed)
      };
    }

    if (cutoffMs === undefined) {
      return this.emptyClearResult(bucket);
    }

    const units = this.getUnusedDeletionUnits(bucket, scan.files, cutoffMs);
    const paths = Array.from(new Set(units.flatMap(unit => unit.paths)));
    const bytesFreed = units.reduce((sum, unit) => sum + unit.bytes, 0);
    const deletedFiles = units.reduce((sum, unit) => sum + unit.fileCount, 0);
    let deletedDirectories = 0;

    if (!dryRun) {
      for (const targetPath of paths) {
        if (!this.isPathInside(targetPath, bucket.directory)) {
          throw new Error(`Refusing to delete cache path outside ${bucket.directory}: ${targetPath}`);
        }
        await fs.remove(targetPath);
      }
      deletedDirectories = await this.removeEmptyDirectories(bucket.directory);
    }

    return {
      id: bucket.id,
      name: bucket.name,
      directory: bucket.directory,
      deletedFiles,
      deletedDirectories,
      bytesFreed,
      bytesFreedFormatted: this.formatFileSize(bytesFreed)
    };
  }

  private getUnusedDeletionUnits(
    bucket: CacheBucketDefinition,
    files: CacheFileRecord[],
    cutoffMs: number
  ): DeletionUnit[] {
    if (bucket.kind === 'object') {
      return this.groupObjectCacheEntries(files).filter(unit => unit.lastUsedMs < cutoffMs);
    }
    if (bucket.kind === 'archive-cloud') {
      return this.groupArchiveCloudEntries(files).filter(unit => unit.lastUsedMs < cutoffMs);
    }

    return files
      .filter(file => file.lastUsedMs < cutoffMs)
      .map(file => ({
        paths: [file.path],
        fileCount: 1,
        bytes: file.size,
        lastUsedMs: file.lastUsedMs
      }));
  }

  private groupObjectCacheEntries(files: CacheFileRecord[]): DeletionUnit[] {
    const groups = new Map<string, DeletionUnit>();

    for (const file of files) {
      const entryId = this.getObjectCacheEntryId(file);
      if (!entryId) {
        continue;
      }
      this.addFileToDeletionGroup(groups, entryId, file);
    }

    return Array.from(groups.values());
  }

  private getObjectCacheEntryId(file: CacheFileRecord): string | null {
    if (file.name.endsWith('.meta.json')) {
      return path.join(path.dirname(file.path), file.name.slice(0, -'.meta.json'.length));
    }
    if (file.name.endsWith('.o')) {
      return path.join(path.dirname(file.path), file.name.slice(0, -'.o'.length));
    }
    return null;
  }

  private groupArchiveCloudEntries(files: CacheFileRecord[]): DeletionUnit[] {
    const groups = new Map<string, DeletionUnit>();

    for (const file of files) {
      const parts = file.relativePath.split('/');
      let entryId: string | null = null;

      if (parts[0] === 'v1' && parts.length >= 4) {
        entryId = parts.slice(0, 4).join('/');
      } else if (parts[0] === '.tmp' && parts.length >= 2) {
        entryId = parts.slice(0, 2).join('/');
      }

      if (!entryId) {
        continue;
      }
      this.addFileToDeletionGroup(groups, entryId, file);
    }

    return Array.from(groups.values());
  }

  private addFileToDeletionGroup(groups: Map<string, DeletionUnit>, entryId: string, file: CacheFileRecord): void {
    const group = groups.get(entryId) || {
      paths: [],
      fileCount: 0,
      bytes: 0,
      lastUsedMs: 0
    };

    group.paths.push(file.path);
    group.fileCount++;
    group.bytes += file.size;
    group.lastUsedMs = Math.max(group.lastUsedMs, file.lastUsedMs);
    groups.set(entryId, group);
  }

  private countEntries(bucket: CacheBucketDefinition, files: CacheFileRecord[]): number {
    if (bucket.kind === 'object') {
      return files.filter(file => file.name.endsWith('.o')).length;
    }
    if (bucket.kind === 'archive-cloud') {
      return files.filter(file => file.name === 'manifest.json' && file.relativePath.startsWith('v1/')).length;
    }
    if (bucket.kind === 'library-index') {
      return files.filter(file => file.name.endsWith('.json')).length;
    }
    return files.length;
  }

  private async scanDirectory(rootDir: string): Promise<CacheDirectoryScan> {
    const files: CacheFileRecord[] = [];
    const directories: string[] = [];
    const pending = [rootDir];

    while (pending.length > 0) {
      const currentDir = pending.pop()!;
      let items: Dirent[];

      try {
        items = await fs.readdir(currentDir, { withFileTypes: true });
      } catch (error) {
        this.logger.debug(`Cannot read cache directory ${currentDir}: ${error}`);
        continue;
      }

      for (const item of items) {
        const itemPath = path.join(currentDir, item.name);

        if (item.isDirectory()) {
          directories.push(itemPath);
          pending.push(itemPath);
          continue;
        }

        try {
          const stat = await fs.stat(itemPath);
          if (!stat.isFile()) {
            continue;
          }

          files.push({
            path: itemPath,
            relativePath: path.relative(rootDir, itemPath).replace(/\\/g, '/'),
            name: item.name,
            stat,
            size: stat.size,
            lastUsedMs: Math.max(stat.atimeMs || 0, stat.mtimeMs || 0)
          });
        } catch (error) {
          this.logger.debug(`Cannot stat cache file ${itemPath}: ${error}`);
        }
      }
    }

    return { files, directories };
  }

  private async removeEmptyDirectories(rootDir: string): Promise<number> {
    const scan = await this.scanDirectory(rootDir);
    const directories = scan.directories.sort((a, b) => b.length - a.length);
    let removed = 0;

    for (const dir of directories) {
      try {
        const items = await fs.readdir(dir);
        if (items.length === 0) {
          await fs.rmdir(dir);
          removed++;
        }
      } catch (error) {
        this.logger.debug(`Cannot remove cache directory ${dir}: ${error}`);
      }
    }

    return removed;
  }

  private assertSafeCacheDirectory(directory: string): void {
    const resolved = path.resolve(directory);
    const parsed = path.parse(resolved);
    if (resolved === parsed.root) {
      throw new Error(`Refusing to clear filesystem root: ${resolved}`);
    }

    const normalized = resolved.replace(/\\/g, '/').toLowerCase();
    const baseName = path.basename(resolved).toLowerCase();
    if (!normalized.includes('/aily-builder/') && !baseName.includes('cache')) {
      throw new Error(`Refusing to clear non-cache directory: ${resolved}`);
    }
  }

  private isPathInside(targetPath: string, rootDir: string): boolean {
    const relative = path.relative(path.resolve(rootDir), path.resolve(targetPath));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private emptyClearResult(bucket: CacheBucketDefinition): CacheBucketClearResult {
    return {
      id: bucket.id,
      name: bucket.name,
      directory: bucket.directory,
      deletedFiles: 0,
      deletedDirectories: 0,
      bytesFreed: 0,
      bytesFreedFormatted: this.formatFileSize(0)
    };
  }

  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let index = 0;

    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index++;
    }

    return `${size.toFixed(1)} ${units[index]}`;
  }
}
