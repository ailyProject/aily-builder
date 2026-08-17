import fs from 'fs';
import path from 'path';
import {
  ArduinoHostOs,
  getArduinoHostOs,
  parseArduinoHostPropertyKey
} from './utils/HostPlatform';

/** Arduino 配置文件中属性键和值的集合。 */
export type ArduinoProperties = Record<string, string>;

/** 用于决定是否保留某个原始属性键的过滤器。 */
export type ArduinoPropertyKeyFilter = (key: string) => boolean;

/**
 * 计算 Arduino 配置文件对应的本地覆盖文件路径。
 *
 * `platform.txt` 会映射为 `platform.local.txt`；没有扩展名的路径会追加
 * `.local`。本函数只处理路径字符串，不访问文件系统，也不修改输入。
 *
 * @param configPath 基础配置文件路径。
 * @returns 与基础配置文件位于同一目录的本地覆盖文件路径。
 */
export function getArduinoLocalOverridePath(configPath: string): string {
  const extension = path.extname(configPath);
  if (!extension) {
    return `${configPath}.local`;
  }
  return `${configPath.slice(0, -extension.length)}.local${extension}`;
}

/**
 * 返回 Arduino 配置文件的加载层，顺序同时也是属性覆盖顺序。
 *
 * 基础文件始终位于第一层；仅当对应的 `.local` 文件存在时才将其作为
 * 第二层返回。因此本函数会同步检查本地覆盖文件，但不会读取或修改文件。
 *
 * @param configPath 基础配置文件路径。
 * @returns 按“基础文件、可选本地覆盖文件”排列的路径数组。
 */
export function getArduinoPropertyLayerPaths(configPath: string): string[] {
  const layerPaths = [configPath];
  const localPath = getArduinoLocalOverridePath(configPath);
  if (fs.existsSync(localPath)) {
    layerPaths.push(localPath);
  }
  return layerPaths;
}

/**
 * 同步读取并解析单个 Arduino 属性文件层。
 *
 * 空行、以 `#` 开头的注释和不含 `=` 的行会被忽略；键和值会去除首尾
 * 空白，值只在第一个 `=` 处分割，空值保留为空字符串。`keyFilter` 针对
 * 文件中的原始键执行。匹配当前主机的 `.windows`、`.linux` 或 `.macosx`
 * 属性在保留后缀键的同时写入基础键；文件中后出现的赋值覆盖先出现的赋值。
 * 本函数只读取文件，不修改调用方对象或进程环境。
 *
 * @param configPath 要读取的单层配置文件路径。
 * @param keyFilter 可选的原始属性键过滤器；返回 `false` 的键不会参与解析或提升。
 * @param runtimeOs 当前 Arduino 主机名称；默认根据 Node.js 运行平台确定。
 * @returns 该文件层解析出的属性集合。
 */
export function parseArduinoPropertyLayer(
  configPath: string,
  keyFilter?: ArduinoPropertyKeyFilter,
  runtimeOs: ArduinoHostOs = getArduinoHostOs()
): ArduinoProperties {
  const properties: ArduinoProperties = {};
  const content = fs.readFileSync(configPath, 'utf8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.substring(0, equalIndex).trim();
    if (!key || (keyFilter && !keyFilter(key))) {
      continue;
    }

    const value = trimmed.substring(equalIndex + 1).trim();
    properties[key] = value;

    const hostProperty = parseArduinoHostPropertyKey(key);
    if (hostProperty?.os === runtimeOs) {
      properties[hostProperty.baseKey] = value;
    }
  }

  return properties;
}

/**
 * 同步加载 Arduino 基础属性文件及其可选的本地覆盖文件。
 *
 * 每层内部按文件行序覆盖，层与层之间严格按“基础文件、`.local` 文件”
 * 覆盖。主机后缀属性的提升和 `keyFilter` 规则与
 * {@link parseArduinoPropertyLayer} 相同。本函数读取已返回的配置层，不写入
 * 文件、不修改调用方对象或进程环境；基础文件不存在时读取操作会抛出错误。
 *
 * @param configPath 基础配置文件路径。
 * @param keyFilter 可选的原始属性键过滤器。
 * @param runtimeOs 当前 Arduino 主机名称；默认根据 Node.js 运行平台确定。
 * @returns 合并完成的全新属性集合。
 */
export function loadArduinoProperties(
  configPath: string,
  keyFilter?: ArduinoPropertyKeyFilter,
  runtimeOs: ArduinoHostOs = getArduinoHostOs()
): ArduinoProperties {
  const properties: ArduinoProperties = {};
  for (const layerPath of getArduinoPropertyLayerPaths(configPath)) {
    Object.assign(
      properties,
      parseArduinoPropertyLayer(layerPath, keyFilter, runtimeOs)
    );
  }
  return properties;
}
