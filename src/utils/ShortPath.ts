import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// 缓存：长路径 → junction 路径
const shortPathCache = new Map<string, string>();

// 已创建的 junction 列表，用于清理
const createdJunctions: string[] = [];

// junction 基础目录（纯 ASCII 路径）
const JUNCTION_BASE = 'C:\\.aily-builder';

// junction 自增编号
let junctionCounter = 0;

// 匹配 Windows 绝对路径
const WIN_ABS_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|*?]*/g;

/**
 * 判断字符串是否包含非 ASCII 字符
 */
function hasNonAscii(str: string): boolean {
  return /[^\x00-\x7F]/.test(str);
}

// ──────────────────────────────────────────────
// NTFS Junction
// ──────────────────────────────────────────────

/**
 * 初始化 junction 基础目录
 */
function initJunctionBase(): void {
  try {
    fs.ensureDirSync(JUNCTION_BASE);
  } catch {
    // 如果无法创建基础目录，junction 策略将不可用
  }
}

/**
 * 为一个含非 ASCII 字符的前缀路径创建 junction 映射。
 * 返回 junction 路径或 null。
 */
function createJunctionForPrefix(targetPath: string): string | null {
  const cacheKey = 'junction:' + targetPath.toLowerCase();
  if (shortPathCache.has(cacheKey)) {
    return shortPathCache.get(cacheKey)!;
  }

  // 懒初始化：首次创建 junction 时才创建基础目录
  initJunctionBase();

  try {
    const junctionPath = path.join(JUNCTION_BASE, String(junctionCounter++));

    if (fs.existsSync(junctionPath)) {
      try {
        fs.removeSync(junctionPath);
      } catch {
        // ignore
      }
    }

    execSync(`cmd.exe /d /c "mklink /J "${junctionPath}" "${targetPath}""`, {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore'
    });

    if (fs.existsSync(junctionPath)) {
      shortPathCache.set(cacheKey, junctionPath);
      createdJunctions.push(junctionPath);
      return junctionPath;
    }
  } catch {
    // junction 创建失败
  }
  return null;
}

/**
 * 清理所有已创建的 junction，并删除 JUNCTION_BASE 目录
 */
function cleanupJunctions(): void {
  for (const jp of createdJunctions) {
    try {
      execSync(`cmd.exe /d /c "rmdir "${jp}" 2>nul"`, {
        windowsHide: true,
        timeout: 3000,
        stdio: 'ignore'
      });
    } catch {
      // ignore
    }
  }
  createdJunctions.length = 0;

  // 删除 junction 基础目录
  try {
    if (fs.existsSync(JUNCTION_BASE)) {
      fs.removeSync(JUNCTION_BASE);
    }
  } catch {
    // ignore
  }
}

// ──────────────────────────────────────────────
// 核心转换逻辑
// ──────────────────────────────────────────────

/**
 * 将含非 ASCII 字符的路径转换为纯 ASCII 路径。
 * 只替换包含非 ASCII 段的前缀部分，保留后缀中原始的斜杠方向和尾部斜杠。
 */
function resolveAsciiPath(longPath: string): string {
  if (shortPathCache.has(longPath)) {
    return shortPathCache.get(longPath)!;
  }

  // 按 / 和 \ 分割以找出含非 ASCII 的段
  const parts = longPath.split(/[\\/]/);

  let lastNonAsciiIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (hasNonAscii(parts[i])) {
      lastNonAsciiIdx = i;
    }
  }

  if (lastNonAsciiIdx === -1) {
    shortPathCache.set(longPath, longPath);
    return longPath;
  }

  // 计算原始字符串中前缀结束的字符偏移位置
  let charOffset = 0;
  for (let i = 0; i <= lastNonAsciiIdx; i++) {
    if (i > 0) charOffset += 1; // 分隔符（/ 或 \）占 1 个字符
    charOffset += parts[i].length;
  }

  // 用反斜杠拼接前缀（Windows API 和 mklink 需要反斜杠）
  const nonAsciiPrefix = parts.slice(0, lastNonAsciiIdx + 1).join('\\');
  // 从原始字符串截取后缀——保留原始的分隔符方向和尾部斜杠
  const originalSuffix = longPath.substring(charOffset);

  const asciiPrefix = createJunctionForPrefix(nonAsciiPrefix);

  const result = asciiPrefix ? (asciiPrefix + originalSuffix) : longPath;
  shortPathCache.set(longPath, result);
  return result;
}

// ──────────────────────────────────────────────
// 导出 API
// ──────────────────────────────────────────────

/**
 * 初始化短路径系统。在 Windows 上调用。
 * 清理旧缓存和遗留 junction。
 */
export function initShortPath(): void {
  shortPathCache.clear();
  junctionCounter = 0;

  // 清理上次可能遗留的 junction
  cleanupJunctions();

  // 注册进程退出时清理 junction
  process.once('exit', cleanupJunctions);
}

/**
 * 将输入字符串中所有包含非 ASCII 字符的 Windows 绝对路径替换为纯 ASCII 路径。
 * 非 Windows 平台或不含非 ASCII 字符时直接返回原字符串。
 */
export function sanitizeNonAsciiPaths(input: string): string {
  if (os.platform() !== 'win32') {
    return input;
  }
  if (!hasNonAscii(input)) {
    return input;
  }

  return input.replace(WIN_ABS_PATH_RE, (match) => {
    if (!hasNonAscii(match)) {
      return match;
    }
    return resolveAsciiPath(match);
  });
}

/**
 * 深度遍历对象/数组，将所有字符串值中的非 ASCII 路径替换为纯 ASCII 路径。
 * 返回一个新对象（不修改原对象）。
 */
export function sanitizeObjectPaths<T>(obj: T): T {
  if (os.platform() !== 'win32') {
    return obj;
  }
  return deepSanitize(obj, new WeakSet()) as T;
}

function deepSanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeNonAsciiPaths(value);
  }
  if (typeof value !== 'object') {
    return value;
  }
  // 防止循环引用
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map(item => deepSanitize(item, seen));
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = deepSanitize((value as Record<string, unknown>)[key], seen);
  }
  return result;
}
