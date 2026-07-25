/** Arduino `platform.txt` 使用的主机操作系统名称。 */
export type ArduinoHostOs = 'windows' | 'linux' | 'macosx';

/** 带 Arduino 主机后缀的属性键解析结果。 */
export interface ArduinoHostPropertyKey {
  baseKey: string;
  os: ArduinoHostOs;
}

/**
 * 判断指定的 Node.js 平台是否为 Windows。
 *
 * @param platform Node.js 平台名；默认使用当前进程的平台。
 */
export function isWindowsHost(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * 判断指定的 Node.js 平台是否为 macOS。
 *
 * @param platform Node.js 平台名；默认使用当前进程的平台。
 */
export function isMacOSHost(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/**
 * 将 Node.js 平台名转换为 Arduino `platform.txt` 使用的主机名称。
 * Arduino 只区分 Windows、macOS 和类 Unix/Linux 三组主机配置。
 *
 * @param platform Node.js 平台名；默认使用当前进程的平台。
 */
export function getArduinoHostOs(platform: NodeJS.Platform = process.platform): ArduinoHostOs {
  if (isWindowsHost(platform)) {
    return 'windows';
  }
  if (isMacOSHost(platform)) {
    return 'macosx';
  }
  return 'linux';
}

/**
 * 返回 PATH、LIBRARIES_PATH 等路径列表使用的主机分隔符。
 * 该值不是目录分隔符：Windows 使用分号，其他平台使用冒号。
 *
 * @param platform Node.js 平台名；默认使用当前进程的平台。
 */
export function getPathListDelimiter(platform: NodeJS.Platform = process.platform): ';' | ':' {
  return isWindowsHost(platform) ? ';' : ':';
}

/**
 * 将路径转换为适合 Map、Set 和相等比较的主机路径键。
 * 这里只处理 Windows 的大小写不敏感语义；路径解析和斜杠统一仍由调用方负责。
 *
 * @param filePath 已按调用场景完成解析或规范化的路径。
 * @param platform Node.js 平台名；默认使用当前进程的平台。
 */
export function toHostPathKey(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  return isWindowsHost(platform) ? filePath.toLowerCase() : filePath;
}

/**
 * 解析 Arduino 属性键末尾的主机后缀。
 * 仅识别 `.windows`、`.linux` 和 `.macosx`，其他键返回 `undefined`。
 *
 * @param key `platform.txt` 或 `boards.txt` 中的属性键。
 */
export function parseArduinoHostPropertyKey(key: string): ArduinoHostPropertyKey | undefined {
  const match = key.match(/\.(windows|linux|macosx)$/);
  if (!match) {
    return undefined;
  }

  const os = match[1] as ArduinoHostOs;
  return {
    baseKey: key.slice(0, -(os.length + 1)),
    os
  };
}
