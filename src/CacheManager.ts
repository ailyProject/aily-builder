import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { Logger } from './utils/Logger';

export interface CacheStats {
    totalFiles: number;
    totalSize: number;
    totalSizeFormatted: string;
    cacheDir: string;
}

export interface CacheKey {
    command: string;
    args: string[];
    sourceFile: string;
}

export class CacheManager {
    private cacheDir: string;
    private logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
        // 使用用户的AppData\Local\aily-cli\cache作为缓存目录
        this.cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'aily-cli', 'cache');
        fs.ensureDirSync(this.cacheDir)
    }

    /**
     * 生成缓存键的MD5值
     */
    private generateCacheKey(cacheKey: CacheKey): string {
        // 将命令、参数和源文件路径合并成字符串
        const keyString = `${cacheKey.command}|${cacheKey.args.join('|')}|${cacheKey.sourceFile}`;

        // 计算MD5哈希值
        const hash = createHash('md5').update(keyString).digest('hex');
        return hash;
    }

    /**
     * 获取缓存文件路径（优化版：使用分层目录）
     */
    private getCacheFilePath(cacheKey: CacheKey): string {
        const hash = this.generateCacheKey(cacheKey);
        // 使用前两位字符创建子目录，将文件分散存储
        const subDir = hash.substring(0, 2);
        const cacheDir = path.join(this.cacheDir, subDir);
        return path.join(cacheDir, `${hash}.o`);
    }

    /**
     * 获取缓存元数据文件路径（优化版：使用分层目录）
     */
    private getCacheMetaPath(cacheKey: CacheKey): string {
        const hash = this.generateCacheKey(cacheKey);
        const subDir = hash.substring(0, 2);
        const cacheDir = path.join(this.cacheDir, subDir);
        return path.join(cacheDir, `${hash}.meta.json`);
    }

    /**
     * 检查是否存在缓存文件
     */
    async hasCache(cacheKey: CacheKey): Promise<boolean> {
        try {
            const cacheFilePath = this.getCacheFilePath(cacheKey);
            const metaFilePath = this.getCacheMetaPath(cacheKey);

            // 检查缓存文件和元数据文件是否都存在
            const [cacheExists, metaExists] = await Promise.all([
                fs.pathExists(cacheFilePath),
                fs.pathExists(metaFilePath)
            ]);

            if (!cacheExists || !metaExists) {
                return false;
            }

            // 检查源文件是否比缓存文件新
            try {
                const [sourceStat, cacheStat] = await Promise.all([
                    fs.stat(cacheKey.sourceFile),
                    fs.stat(cacheFilePath)
                ]);

                // 如果源文件比缓存文件新，则缓存无效
                if (sourceStat.mtime > cacheStat.mtime) {
                    this.logger.debug(`Cache invalid: source file is newer than cache for ${path.basename(cacheKey.sourceFile)}`);
                    return false;
                }
            } catch (error) {
                this.logger.debug(`Error checking file timestamps: ${error}`);
                return false;
            }

            return true;
        } catch (error) {
            this.logger.debug(`Error checking cache: ${error instanceof Error ? error.message : error}`);
            return false;
        }
    }

    /**
     * 从缓存中提取对象文件
     */
    async extractFromCache(cacheKey: CacheKey, targetPath: string): Promise<boolean> {
        try {
            const cacheFilePath = this.getCacheFilePath(cacheKey);

            if (!await this.hasCache(cacheKey)) {
                return false;
            }

            // 确保目标目录存在
            await fs.ensureDir(path.dirname(targetPath));

            // 复制缓存文件到目标路径
            await fs.copy(cacheFilePath, targetPath);

            this.logger.debug(`Extracted from cache: ${path.basename(targetPath)}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to extract from cache: ${error instanceof Error ? error.message : error}`);
            return false;
        }
    }

    /**
     * 将编译好的对象文件存储到缓存
     */
    async storeToCache(cacheKey: CacheKey, objectFilePath: string): Promise<void> {
        try {
            const cacheFilePath = this.getCacheFilePath(cacheKey);
            const metaFilePath = this.getCacheMetaPath(cacheKey);

            // 确保子目录存在
            await fs.ensureDir(path.dirname(cacheFilePath));

            // 检查对象文件是否存在
            if (!await fs.pathExists(objectFilePath)) {
                throw new Error(`Object file does not exist: ${objectFilePath}`);
            }

            // 复制对象文件到缓存
            await fs.copy(objectFilePath, cacheFilePath);

            // 创建元数据文件
            const metadata = {
                sourceFile: cacheKey.sourceFile,
                command: cacheKey.command,
                args: cacheKey.args,
                cachedAt: new Date().toISOString(),
                objectFileSize: (await fs.stat(objectFilePath)).size
            };

            await fs.writeJSON(metaFilePath, metadata, { spaces: 2 });

            this.logger.debug(`Stored to cache: ${path.basename(objectFilePath)}`);
        } catch (error) {
            this.logger.error(`Failed to store to cache: ${error instanceof Error ? error.message : error}`);
            throw error;
        }
    }

    /**
     * 统计缓存使用情况（优化版：支持分层目录）
     */
    async getCacheStats(): Promise<CacheStats> {
        try {
            let totalFiles = 0;
            let totalSize = 0;

            // 遍历所有子目录
            const getAllFiles = async (dir: string): Promise<void> => {
                const items = await fs.readdir(dir, { withFileTypes: true });

                for (const item of items) {
                    const itemPath = path.join(dir, item.name);

                    if (item.isDirectory()) {
                        await getAllFiles(itemPath);
                    } else if (item.name.endsWith('.o')) {
                        try {
                            const stat = await fs.stat(itemPath);
                            totalSize += stat.size;
                            totalFiles++;
                        } catch (error) {
                            this.logger.debug(`Cannot access file ${itemPath}: ${error}`);
                        }
                    }
                }
            };

            await getAllFiles(this.cacheDir);

            return {
                totalFiles,
                totalSize,
                totalSizeFormatted: this.formatFileSize(totalSize),
                cacheDir: this.cacheDir
            };
        } catch (error) {
            this.logger.error(`Failed to get cache stats: ${error instanceof Error ? error.message : error}`);
            return {
                totalFiles: 0,
                totalSize: 0,
                totalSizeFormatted: '0 B',
                cacheDir: this.cacheDir
            };
        }
    }

    /**
     * 清除缓存（优化版：支持分层目录）
     */
    async clearCache(options?: { olderThanDays?: number; pattern?: string }): Promise<void> {
        try {
            let deletedCount = 0;

            // 遍历所有子目录和文件
            const deleteFiles = async (dir: string): Promise<void> => {
                const items = await fs.readdir(dir, { withFileTypes: true });

                for (const item of items) {
                    const itemPath = path.join(dir, item.name);

                    if (item.isDirectory()) {
                        await deleteFiles(itemPath);
                        // 检查子目录是否为空，如果为空则删除
                        try {
                            const subItems = await fs.readdir(itemPath);
                            if (subItems.length === 0) {
                                await fs.rmdir(itemPath);
                                this.logger.debug(`Removed empty cache directory: ${item.name}`);
                            }
                        } catch (error) {
                            this.logger.debug(`Failed to check/remove directory ${item.name}: ${error}`);
                        }
                    } else {
                        try {
                            // 应用过滤条件
                            let shouldDelete = true;

                            // 按模式过滤
                            if (options?.pattern && !item.name.includes(options.pattern)) {
                                shouldDelete = false;
                            }

                            // 按时间过滤
                            if (options?.olderThanDays && shouldDelete) {
                                const stat = await fs.stat(itemPath);
                                const daysDiff = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24);
                                if (daysDiff < options.olderThanDays) {
                                    shouldDelete = false;
                                }
                            }

                            if (shouldDelete) {
                                await fs.remove(itemPath);
                                deletedCount++;
                                this.logger.debug(`Deleted cache file: ${item.name}`);
                            }
                        } catch (error) {
                            this.logger.debug(`Failed to delete file ${item.name}: ${error}`);
                        }
                    }
                }
            };

            await deleteFiles(this.cacheDir);

            this.logger.info(`Cache cleanup completed. Deleted ${deletedCount} files.`);
        } catch (error) {
            this.logger.error(`Failed to clear cache: ${error instanceof Error ? error.message : error}`);
            throw error;
        }
    }

    /**
     * 清除所有缓存文件
     */
    async clearAllCache(): Promise<void> {
        await this.clearCache();
    }

    /**
     * 缓存维护：检查缓存大小并自动清理
     */
    async maintainCache(): Promise<void> {
        try {
            const stats = await this.getCacheStats();
            const maxFiles = 50000; // 最大文件数量
            const maxSizeMB = 1000; // 最大缓存大小 1GB

            this.logger.debug(`Current cache stats: ${stats.totalFiles} files, ${stats.totalSizeFormatted}`);

            if (stats.totalFiles > maxFiles || stats.totalSize > maxSizeMB * 1024 * 1024) {
                this.logger.info(`Cache size limit exceeded (${stats.totalFiles} files, ${stats.totalSizeFormatted}), performing cleanup...`);

                // 清理超过30天的缓存
                await this.clearCache({ olderThanDays: 30 });

                // 再次检查，如果还是超过限制，清理超过7天的缓存
                const newStats = await this.getCacheStats();
                if (newStats.totalFiles > maxFiles || newStats.totalSize > maxSizeMB * 1024 * 1024) {
                    this.logger.info('Still over limit after 30-day cleanup, cleaning 7-day old cache...');
                    await this.clearCache({ olderThanDays: 7 });
                }

                const finalStats = await this.getCacheStats();
                this.logger.info(`Cache cleanup finished: ${finalStats.totalFiles} files, ${finalStats.totalSizeFormatted}`);
            }
        } catch (error) {
            this.logger.error(`Failed to maintain cache: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * 格式化文件大小
     */
    private formatFileSize(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }

    /**
     * 获取缓存目录路径
     */
    getCacheDir(): string {
        return this.cacheDir;
    }
}
