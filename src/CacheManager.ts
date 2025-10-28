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
    hardLinksUsed?: number;
    copiesUsed?: number;
}

export interface CacheKey {
    command: string;
    args: string[];
    sourceFile: string;
}

export class CacheManager {
    private cacheDir: string;
    private logger: Logger;
    private hardLinksUsed: number = 0;
    private copiesUsed: number = 0;

    constructor(logger: Logger) {
        this.logger = logger;
        if (os.platform() === 'win32') {
            // 使用用户的AppData\Local\aily-builder\cache作为缓存目录
            this.cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'aily-builder', 'cache');
        } else if (os.platform() === 'darwin') {
            // 使用用户的Library/Caches/aily-builder/cache作为缓存目录
            this.cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'aily-builder', 'cache');
        } else {
            // 对于其他平台，使用用户的主目录下的.aily-builder/cache作为缓存目录
            this.cacheDir = path.join(os.homedir(), '.aily-builder', 'cache');
        }

        // 确保缓存目录存在
        fs.ensureDirSync(this.cacheDir);
        
        this.logger.debug(`Cache directory: ${this.cacheDir}`);
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
     * 从缓存中提取对象文件（优化：使用硬链接或软链接代替复制）
     */
    async extractFromCache(cacheKey: CacheKey, targetPath: string): Promise<boolean> {
        try {
            const cacheFilePath = this.getCacheFilePath(cacheKey);

            if (!await this.hasCache(cacheKey)) {
                return false;
            }

            // 确保目标目录存在
            await fs.ensureDir(path.dirname(targetPath));

            // 如果目标文件已存在，先删除
            if (await fs.pathExists(targetPath)) {
                await fs.remove(targetPath);
            }

            // 尝试使用硬链接（最快）
            try {
                await fs.link(cacheFilePath, targetPath);
                this.hardLinksUsed++;
                this.logger.debug(`Extracted from cache via hard link: ${path.basename(targetPath)}`);
                return true;
            } catch (hardLinkError) {
                // 硬链接失败，回退到复制模式
                this.logger.debug(`Hard link failed (${hardLinkError instanceof Error ? hardLinkError.message : hardLinkError}), falling back to copy...`);
                
                try {
                    await fs.copy(cacheFilePath, targetPath);
                    this.copiesUsed++;
                    this.logger.debug(`Extracted from cache via copy: ${path.basename(targetPath)}`);
                    return true;
                } catch (copyError) {
                    this.logger.error(`Failed to copy from cache: ${copyError instanceof Error ? copyError.message : copyError}`);
                    return false;
                }
            }
        } catch (error) {
            this.logger.error(`Failed to extract from cache: ${error instanceof Error ? error.message : error}`);
            return false;
        }
    }

    /**
     * 将编译好的对象文件存储到缓存（优化：使用硬链接或软链接代替复制）
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

            // 如果缓存文件已存在，先删除
            if (await fs.pathExists(cacheFilePath)) {
                await fs.remove(cacheFilePath);
            }

            // 尝试使用硬链接（最快，节省空间）
            try {
                await fs.link(objectFilePath, cacheFilePath);
                this.hardLinksUsed++;
                this.logger.debug(`Stored to cache via hard link: ${path.basename(objectFilePath)}`);
            } catch (hardLinkError) {
                // 硬链接失败，回退到复制模式
                this.logger.debug(`Hard link failed (${hardLinkError instanceof Error ? hardLinkError.message : hardLinkError}), falling back to copy...`);
                
                try {
                    await fs.copy(objectFilePath, cacheFilePath);
                    this.copiesUsed++;
                    this.logger.debug(`Stored to cache via copy: ${path.basename(objectFilePath)}`);
                } catch (copyError) {
                    throw new Error(`Failed to store to cache via copy: ${copyError instanceof Error ? copyError.message : copyError}`);
                }
            }

            // 创建元数据文件
            const metadata = {
                sourceFile: cacheKey.sourceFile,
                command: cacheKey.command,
                args: cacheKey.args,
                cachedAt: new Date().toISOString(),
                objectFileSize: (await fs.stat(objectFilePath)).size
            };

            await fs.writeJSON(metaFilePath, metadata, { spaces: 2 });

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
                cacheDir: this.cacheDir,
                hardLinksUsed: this.hardLinksUsed,
                copiesUsed: this.copiesUsed
            };
        } catch (error) {
            this.logger.error(`Failed to get cache stats: ${error instanceof Error ? error.message : error}`);
            return {
                totalFiles: 0,
                totalSize: 0,
                totalSizeFormatted: '0 B',
                cacheDir: this.cacheDir,
                hardLinksUsed: this.hardLinksUsed,
                copiesUsed: this.copiesUsed
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
     * 获取上次缓存维护时间戳文件路径
     */
    private getLastMaintenanceFilePath(): string {
        return path.join(this.cacheDir, '.last_maintenance');
    }

    /**
     * 获取上次缓存维护时间
     */
    private async getLastMaintenanceTime(): Promise<Date | null> {
        try {
            const filePath = this.getLastMaintenanceFilePath();
            if (!await fs.pathExists(filePath)) {
                return null;
            }
            const timestamp = await fs.readFile(filePath, 'utf-8');
            return new Date(parseInt(timestamp));
        } catch (error) {
            this.logger.debug(`Failed to read last maintenance time: ${error}`);
            return null;
        }
    }

    /**
     * 更新上次缓存维护时间
     */
    private async updateLastMaintenanceTime(): Promise<void> {
        try {
            const filePath = this.getLastMaintenanceFilePath();
            await fs.writeFile(filePath, Date.now().toString());
        } catch (error) {
            this.logger.debug(`Failed to update last maintenance time: ${error}`);
        }
    }

    /**
     * 缓存维护：检查缓存大小并自动清理
     */
    async maintainCache(): Promise<void> {
        try {
            // 检查是否需要进行缓存维护
            const lastMaintenanceTime = await this.getLastMaintenanceTime();
            const now = new Date();
            const daysSinceLastMaintenance = lastMaintenanceTime 
                ? (now.getTime() - lastMaintenanceTime.getTime()) / (1000 * 60 * 60 * 24)
                : Infinity; // 如果没有记录，则认为需要维护

            if (daysSinceLastMaintenance < 30) {
                this.logger.debug(`Cache maintenance skipped: last maintenance was ${daysSinceLastMaintenance.toFixed(1)} days ago (< 30 days)`);
                return;
            }

            this.logger.debug(`Performing cache maintenance: last maintenance was ${lastMaintenanceTime ? daysSinceLastMaintenance.toFixed(1) + ' days ago' : 'never'}`);

            const stats = await this.getCacheStats();
            const maxFiles = 50000; // 最大文件数量
            const maxSizeMB = 1000; // 最大缓存大小 1GB

            this.logger.debug(`Current cache stats: ${stats.totalFiles} files, ${stats.totalSizeFormatted}`);

            let cleanupPerformed = false;

            if (stats.totalFiles > maxFiles || stats.totalSize > maxSizeMB * 1024 * 1024) {
                this.logger.info(`Cache size limit exceeded (${stats.totalFiles} files, ${stats.totalSizeFormatted}), performing cleanup...`);

                // 清理超过30天的缓存
                await this.clearCache({ olderThanDays: 30 });
                cleanupPerformed = true;

                // 再次检查，如果还是超过限制，清理超过7天的缓存
                const newStats = await this.getCacheStats();
                if (newStats.totalFiles > maxFiles || newStats.totalSize > maxSizeMB * 1024 * 1024) {
                    this.logger.info('Still over limit after 30-day cleanup, cleaning 7-day old cache...');
                    await this.clearCache({ olderThanDays: 7 });
                }

                const finalStats = await this.getCacheStats();
                this.logger.info(`Cache cleanup finished: ${finalStats.totalFiles} files, ${finalStats.totalSizeFormatted}`);
            } else {
                this.logger.debug('Cache size within limits, no cleanup needed');
            }

            // 更新维护时间戳（无论是否执行了清理）
            await this.updateLastMaintenanceTime();
            
            if (cleanupPerformed) {
                this.logger.info('Cache maintenance completed with cleanup');
            } else {
                this.logger.debug('Cache maintenance completed without cleanup');
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

    /**
     * 重置性能计数器
     */
    resetPerformanceCounters(): void {
        this.hardLinksUsed = 0;
        this.copiesUsed = 0;
    }

    /**
     * 获取性能统计信息
     */
    getPerformanceStats(): { 
        hardLinksUsed: number; 
        copiesUsed: number; 
        linkSuccessRate: number;
        totalOperations: number;
    } {
        const total = this.hardLinksUsed + this.copiesUsed;
        const linkSuccessRate = total > 0 ? (this.hardLinksUsed / total) * 100 : 0;
        
        return {
            hardLinksUsed: this.hardLinksUsed,
            copiesUsed: this.copiesUsed,
            linkSuccessRate: parseFloat(linkSuccessRate.toFixed(1)),
            totalOperations: total
        };
    }
}
