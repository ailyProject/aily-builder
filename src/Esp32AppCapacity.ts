import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { expandRecipeProperties, splitQuotedArguments } from './RecipeRunner';
import { resolveArduinoUploadCommand } from './ArduinoUploadCommand';

export interface Esp32Partition {
  name: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

export interface Esp32AppCapacity {
  imageFile: string;
  partitionFile: string;
  imageBytes: number;
  maxBytes: number;
  target: Esp32Partition;
  targetMode: 'fixed' | 'ota';
  warnings: string[];
}

interface Esp32CapacityConfig {
  platform: Readonly<Record<string, string>>;
  board?: Readonly<Record<string, string>>;
  fqbnParsed?: { platform?: string };
}

/** Read the SDK's final table, not CSV syntax or menu size estimates. */
export function parseEsp32Partitions(bytes: Buffer): Esp32Partition[] {
  if (!bytes.length || bytes.length % 32 !== 0 || bytes.length > 0x1000) {
    throw new Error('Invalid ESP32 partition table length');
  }
  const partitions: Esp32Partition[] = [];
  for (let at = 0; at < bytes.length; at += 32) {
    const record = bytes.subarray(at, at + 32);
    const magic = record.readUInt16LE(0);
    if (magic === 0xffff || magic === 0xebeb) {
      if (magic === 0xebeb) {
        const expected = createHash('md5').update(bytes.subarray(0, at)).digest();
        if (!record.subarray(2, 16).every(value => value === 0xff)
          || !record.subarray(16).equals(expected)) {
          throw new Error('Invalid ESP32 partition table MD5');
        }
      }
      const padding = magic === 0xffff ? at : at + 32;
      if (!bytes.subarray(padding).every(value => value === 0xff) || !partitions.length) {
        throw new Error('Invalid ESP32 partition table terminator');
      }
      return partitions;
    }
    if (magic !== 0x50aa) throw new Error(`Invalid ESP32 partition record at byte ${at}`);
    const partition: Esp32Partition = {
      type: record[2], subtype: record[3], offset: record.readUInt32LE(4), size: record.readUInt32LE(8),
      name: record.subarray(12, 28).toString('utf8').replace(/\0.*/, '')
    };
    if (partition.type === 0 && (!partition.size || partition.offset + partition.size > 0x100000000)) {
      throw new Error(`Invalid ESP32 APP partition size: ${partition.name}`);
    }
    partitions.push(partition);
  }
  throw new Error('ESP32 partition table is missing its terminator');
}

/** Match the real upload destination; neither the largest nor smallest slot is necessarily it. */
export function selectEsp32AppPartition(partitions: Esp32Partition[], offset: number): Esp32Partition {
  const targets = partitions.filter(partition => partition.type === 0 && partition.offset === offset);
  if (targets.length !== 1) {
    throw new Error(`No unique ESP32 APP partition starts at upload offset 0x${offset.toString(16)}`);
  }
  return targets[0];
}

function samePath(left: string, right: string, cwd: string): boolean {
  const normalize = (file: string) => {
    const absolute = path.resolve(cwd, file);
    // Windows short-path junctions and original Unicode paths name the same output.
    let canonical = absolute;
    try { canonical = fs.realpathSync.native(absolute); } catch { /* missing output is diagnosed below */ }
    return canonical.replace(/\\/g, '/');
  };
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function uploadOffset(command: string, imageFile: string, buildPath: string): number | undefined {
  const args = splitQuotedArguments(command);
  const offsets = new Set<number>();
  let hasImage = false;
  for (let index = 1; index < args.length; index++) {
    if (!args[index].toLowerCase().endsWith('.bin') || !samePath(args[index], imageFile, buildPath)) continue;
    hasImage = true;
    if (/^(?:0x[0-9a-f]+|\d+)$/i.test(args[index - 1])) {
      offsets.add(Number(args[index - 1]));
    }
  }
  if (!hasImage || offsets.size > 1) {
    throw new Error('Cannot identify one ESP32 APP upload offset from the selected upload recipe');
  }
  return [...offsets][0];
}

export async function readEsp32AppCapacity(
  arduinoConfig: Esp32CapacityConfig,
  buildPath: string,
  finalOutputPath?: string,
  uploadCommand?: string
): Promise<Esp32AppCapacity | undefined> {
  const platform = arduinoConfig?.platform || {};
  const isEsp32 = String(platform['build.arch'] || '').toUpperCase() === 'ESP32'
    || /^esp32(?:[a-z0-9]+)?$/i.test(String(platform['build.mcu'] || ''))
    || arduinoConfig?.fqbnParsed?.platform === 'esp32';
  // No filesystem reads or partition assumptions for AVR/STM32/other platforms.
  if (!isEsp32) return undefined;

  const name = platform['build.project_name'] || 'sketch';
  const pattern = platform['recipe.objcopy.partitions.bin.pattern'];
  const tableArgs = pattern ? splitQuotedArguments(expandRecipeProperties(pattern, platform)) : [];
  const partitionFile = path.resolve(buildPath, tableArgs.length
    ? tableArgs[tableArgs.length - 1] : `${name}.partitions.bin`);
  const imageFile = finalOutputPath?.toLowerCase().endsWith('.bin') && !/\.merged\.bin$/i.test(finalOutputPath)
    ? path.resolve(buildPath, finalOutputPath) : path.resolve(buildPath, `${name}.bin`);
  const command = uploadCommand || resolveArduinoUploadCommand({ board: arduinoConfig.board || {}, platform })?.command;
  if (!command) throw new Error('ESP32 APP capacity requires the selected upload recipe');
  const offset = uploadOffset(command, imageFile, buildPath);
  const partitions = parseEsp32Partitions(await fs.readFile(partitionFile));
  let target: Esp32Partition;
  const targetMode = offset === undefined ? 'ota' : 'fixed';
  if (offset !== undefined) {
    target = selectEsp32AppPartition(partitions, offset);
  } else {
    // DFU/ArduinoOTA pick the next OTA slot on the device, not a host address.
    // Require the image to fit every candidate OTA slot, excluding recovery/test APPs.
    const tool = String(arduinoConfig.board?.['upload.tool.default'] || arduinoConfig.board?.['upload.tool'] || '').split(':').pop();
    const runtimeOta = ['dfu-util', 'esp_ota'].includes(tool)
      || splitQuotedArguments(command).some(arg => /(?:^|[/\\])(?:dfu-util|espota)(?:\.exe|\.py)?$/i.test(arg));
    const slots = partitions.filter(partition => partition.type === 0 && partition.subtype >= 0x10 && partition.subtype <= 0x1f);
    if (!runtimeOta || !slots.length) throw new Error('Cannot identify an ESP32 APP upload offset or runtime OTA slots');
    target = slots.reduce((smallest, slot) => slot.size < smallest.size ? slot : smallest);
  }
  const image = await fs.stat(imageFile);
  if (!image.isFile() || !image.size) throw new Error(`Missing or empty ESP32 APP image: ${imageFile}`);

  // Other slots may intentionally hold a different factory/test image. Do not
  // reject this upload on their behalf; warn about unusable future OTA slots.
  const smallerOta = partitions.filter(partition => partition.type === 0
    && partition.subtype >= 0x10 && partition.subtype <= 0x1f
    && partition.offset !== target.offset && partition.size < image.size);
  const warnings = smallerOta.length ? [
    `This image does not fit OTA partition(s) ${smallerOta.map(partition => `${partition.name} (${partition.size} bytes)`).join(', ')}; subsequent OTA slot rotation is not guaranteed.`
  ] : [];
  return { imageFile, partitionFile, imageBytes: image.size, maxBytes: target.size, target, targetMode, warnings };
}
