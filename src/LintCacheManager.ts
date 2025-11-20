import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { Logger } from './utils/Logger';

export interface LintCacheKey {
  operation: 'dependency' | 'compiler' | 'config';
  board: string;
  sdkPath: string;
  toolsPath: string;
  librariesPath: string;
  buildProperties: string;
  boardOptions: string;
  sourceFile: string;
  fileContentHash?: string; // 文件内容哈希，用于检测文件变化
  mode?: string;
}

export class LintCacheManager {
  private cacheDir: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    // 使用专门的lint缓存目录，根据操作系统选择合适的路径
    this.cacheDir = path.join(
      os.platform() === 'win32' 
        ? path.join(os.homedir(), 'AppData', 'Local')
        : path.join(os.homedir(), 'Library'),
      'aily-builder', 
      'lint-cache'
    );
    fs.ensureDirSync(this.cacheDir);
    
    this.logger.debug(`Lint cache directory: ${this.cacheDir}`);
  }

  /**
   * 生成缓存键的MD5值
   */
  private generateCacheKey(cacheKey: LintCacheKey): string {
    const keyString = `${cacheKey.operation}|${cacheKey.board}|${cacheKey.sdkPath}|${cacheKey.toolsPath}|${cacheKey.librariesPath}|${cacheKey.buildProperties}|${cacheKey.boardOptions}|${cacheKey.sourceFile}|${cacheKey.mode || ''}`;
    const hash = createHash('md5').update(keyString).digest('hex');
    return hash;
  }

  /**
   * 获取缓存文件路径
   */
  private getCacheFilePath(cacheKey: LintCacheKey): string {
    const hash = this.generateCacheKey(cacheKey);
    const subDir = hash.substring(0, 2);
    const cacheDir = path.join(this.cacheDir, cacheKey.operation, subDir);
    return path.join(cacheDir, `${hash}.json`);
  }

  /**
   * 检查缓存是否有效
   */
  async hasValidCache(cacheKey: LintCacheKey): Promise<boolean> {
    try {
      const cacheFilePath = this.getCacheFilePath(cacheKey);
      
      if (!await fs.pathExists(cacheFilePath)) {
        return false;
      }

      // 检查源文件是否比缓存文件新
      try {
        const [sourceStat, cacheStat] = await Promise.all([
          fs.stat(cacheKey.sourceFile),
          fs.stat(cacheFilePath)
        ]);

        if (sourceStat.mtime > cacheStat.mtime) {
          this.logger.debug(`Lint cache invalid: source file is newer for ${path.basename(cacheKey.sourceFile)}`);
          return false;
        }
      } catch (error) {
        this.logger.debug(`Error checking file timestamps: ${error}`);
        return false;
      }

      // 对于编译器缓存，检查是否过期（5分钟）
      if (cacheKey.operation === 'compiler') {
        try {
          const cacheData = await fs.readJSON(cacheFilePath);
          const cacheAge = Date.now() - (cacheData.cachedAt || 0);
          if (cacheAge > 5 * 60 * 1000) { // 5分钟过期
            this.logger.debug(`Compiler cache expired for ${path.basename(cacheKey.sourceFile)}`);
            return false;
          }
        } catch (error) {
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logger.debug(`Error checking lint cache: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /**
   * 存储到缓存
   */
  async storeToCache(cacheKey: LintCacheKey, data: any): Promise<void> {
    try {
      const cacheFilePath = this.getCacheFilePath(cacheKey);
      
      // 确保目录存在
      await fs.ensureDir(path.dirname(cacheFilePath));

      // 添加缓存时间戳
      const cacheData = {
        ...data,
        cachedAt: Date.now()
      };

      // 直接写入JSON文件
      await fs.writeJSON(cacheFilePath, cacheData, { spaces: 2 });
      
      this.logger.debug(`Stored ${cacheKey.operation} cache for ${path.basename(cacheKey.sourceFile)}`);
    } catch (error) {
      this.logger.debug(`Failed to store ${cacheKey.operation} cache: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 从缓存中获取数据
   */
  async getFromCache(cacheKey: LintCacheKey): Promise<any | null> {
    try {
      if (!await this.hasValidCache(cacheKey)) {
        return null;
      }

      const cacheFilePath = this.getCacheFilePath(cacheKey);
      const cacheData = await fs.readJSON(cacheFilePath);
      
      this.logger.debug(`Retrieved ${cacheKey.operation} cache for ${path.basename(cacheKey.sourceFile)}`);
      
      // 移除内部时间戳
      delete cacheData.cachedAt;
      
      return cacheData;
    } catch (error) {
      this.logger.debug(`Failed to retrieve ${cacheKey.operation} cache: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 清除指定类型的缓存
   */
  async clearCache(operation?: 'dependency' | 'compiler' | 'config'): Promise<void> {
    try {
      if (operation) {
        const operationDir = path.join(this.cacheDir, operation);
        if (await fs.pathExists(operationDir)) {
          await fs.remove(operationDir);
          this.logger.info(`Cleared ${operation} lint cache`);
        }
      } else {
        if (await fs.pathExists(this.cacheDir)) {
          await fs.remove(this.cacheDir);
          fs.ensureDirSync(this.cacheDir);
          this.logger.info('Cleared all lint cache');
        }
      }
    } catch (error) {
      this.logger.error(`Failed to clear lint cache: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 获取缓存统计信息
   */
  async getCacheStats(): Promise<{
    dependency: { files: number; size: number };
    compiler: { files: number; size: number };
    config: { files: number; size: number };
    total: { files: number; size: number; sizeFormatted: string };
  }> {
    const stats = {
      dependency: { files: 0, size: 0 },
      compiler: { files: 0, size: 0 },
      config: { files: 0, size: 0 },
      total: { files: 0, size: 0, sizeFormatted: '0 B' }
    };

    try {
      for (const operation of ['dependency', 'compiler', 'config'] as const) {
        const operationDir = path.join(this.cacheDir, operation);
        if (await fs.pathExists(operationDir)) {
          const files = await this.getFilesRecursively(operationDir);
          for (const file of files) {
            if (file.endsWith('.json')) {
              try {
                const stat = await fs.stat(file);
                stats[operation].files++;
                stats[operation].size += stat.size;
                stats.total.files++;
                stats.total.size += stat.size;
              } catch (error) {
                // 忽略无法访问的文件
              }
            }
          }
        }
      }

      stats.total.sizeFormatted = this.formatFileSize(stats.total.size);
    } catch (error) {
      this.logger.debug(`Failed to get lint cache stats: ${error}`);
    }

    return stats;
  }

  /**
   * 递归获取目录下的所有文件
   */
  private async getFilesRecursively(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      
      for (const item of items) {
        const itemPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          files.push(...await this.getFilesRecursively(itemPath));
        } else {
          files.push(itemPath);
        }
      }
    } catch (error) {
      // 忽略访问错误
    }
    
    return files;
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}