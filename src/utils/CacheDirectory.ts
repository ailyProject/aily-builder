import os from 'os';
import path from 'path';
import { isMacOSHost, isWindowsHost } from './HostPlatform';

/**
 * 返回 aily-builder 标准缓存桶的跨平台目录。
 * Windows 使用 AppData/Local，macOS 使用 Library/Caches，其他平台使用 ~/.cache。
 *
 * @param bucketName aily-builder 根目录下的缓存桶名称。
 * @param platform Node.js 平台名；默认使用当前进程的平台。
 * @param homeDirectory 用户主目录；参数化后便于测试且不依赖真实账户。
 */
export function getAilyBuilderCacheDirectory(
  bucketName: string,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir()
): string {
  if (isWindowsHost(platform)) {
    return path.join(homeDirectory, 'AppData', 'Local', 'aily-builder', bucketName);
  }
  if (isMacOSHost(platform)) {
    return path.join(homeDirectory, 'Library', 'Caches', 'aily-builder', bucketName);
  }
  return path.join(homeDirectory, '.cache', 'aily-builder', bucketName);
}
