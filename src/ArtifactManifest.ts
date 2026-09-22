import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import type { BuildInputRecord } from './BuildInputRecord';

export type ArtifactFileRole =
  | 'application'
  | 'merged-flash'
  | 'bootloader'
  | 'partitions'
  | 'ota-data-initializer'
  | 'elf'
  | 'map'
  | 'source-map'
  | 'debug-source'
  | 'memory-map'
  | 'debug-instrumentation'
  | 'build-inputs'
  | 'hex'
  | 'uf2'
  | 'archive';

export interface ArtifactFile {
  role: ArtifactFileRole;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export type Esp32FlashSegmentRole =
  | 'bootloader'
  | 'partition-table'
  | 'ota-data-initializer'
  | 'application';

export interface Esp32FlashLayout {
  schemaVersion: 1;
  kind: 'aily-esp32-flash-layout';
  target: {
    architecture: 'esp32';
    boardId: string;
    mcu: string;
  };
  device: {
    sizeBytes: number;
    mode: 'dio' | 'qio' | 'dout' | 'qout';
    bootMode: 'dio' | 'qio' | 'dout' | 'qout';
    frequencyHz: number;
    source: 'resolved-board-properties';
  };
  segments: Array<{
    role: Esp32FlashSegmentRole;
    offsetBytes: number;
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

export interface Esp32BuildEnvironment {
  schemaVersion: 1;
  arduinoCore: {
    name: 'arduino-esp32';
    version: string;
    source: 'platform.version';
  };
  espIdf: {
    name: 'esp-idf';
    version: string;
    source: 'esp32-arduino-libs/esp_idf_version.h';
  };
  toolchain: {
    name: 'esp-x32' | 'esp-rv32';
    version: string;
    source: 'toolVersions.esp-x32' | 'toolVersions.esp-rv32';
  };
}

export interface ArtifactGraphProvenance {
  schemaVersion: 1;
  kind: 'aily-scene-graph-provenance';
  graphSemanticRevision: string;
  sourceDocumentSchemaVersion?: 1 | 2;
  gpioDirections?: Record<string, 'input' | 'output'>;
  gpioPulls?: Record<string, 'up' | 'down'>;
}

export interface DebugInstrumentationManifest {
  schemaVersion: 1;
  kind: 'aily-debug-instrumentation';
  abi: {
    name: 'aily.freertos-object-registry';
    version: 1;
    symbol: 'ailyFreeRtosDebugObjectRegistryV1';
    capabilities: ['freertos.objects'];
  };
  compatibility: {
    architecture: string;
    mcu?: string;
    framework: 'arduino';
    rtos: 'freertos';
  };
}

export interface SimulationArtifactManifest {
  schemaVersion: 1;
  kind: 'aily-build-artifact';
  artifactId: string;
  target: {
    fqbn: string;
    architecture: string;
    boardId: string;
    mcu?: string;
  };
  build: {
    builtAt: string;
    source: {
      path: string;
      sizeBytes: number;
      sha256: string;
    };
    toolVersions: Record<string, string>;
    inputs?: {
      schemaVersion: 1;
      kind: 'aily-build-input-reference';
      scope: 'prepared-dependency-trees';
      path: string;
      digest: string;
    };
    environment?: Esp32BuildEnvironment;
    graph?: ArtifactGraphProvenance;
  };
  files: ArtifactFile[];
  primaryFile: string;
  flash?: {
    format: 'merged';
    imagePath: string;
    imageSizeBytes: number;
    sdkConfiguredSizeBytes?: number;
    layout?: Esp32FlashLayout;
  };
  debug?: {
    elfPath?: string;
    mapPath?: string;
    sourceMapPath?: string;
    sourceSnapshotPath?: string;
    memoryMapPath?: string;
    instrumentationPath?: string;
  };
}

export type DebugMemoryRegionAttributes = 'r' | 'rw' | 'rx' | 'rwx';

export interface DebugMemoryMapContract {
  schemaVersion: 1;
  kind: 'aily-debug-memory-map';
  target: SimulationArtifactManifest['target'];
  sources: {
    elf: Pick<ArtifactFile, 'path' | 'sizeBytes' | 'sha256'>;
    linkerMap: Pick<ArtifactFile, 'path' | 'sizeBytes' | 'sha256'>;
  };
  regions: Array<{
    id: string;
    label: string;
    startAddress: string;
    endAddress: string;
    attributes: DebugMemoryRegionAttributes;
  }>;
}

export interface EmitArtifactManifestOptions {
  buildPath: string;
  sketchPath: string;
  board: string;
  /** Resolved physical board variant when the FQBN uses a menu-selected board family. */
  boardId?: string;
  mcu?: string;
  toolVersions?: Record<string, string>;
  platformProperties?: Record<string, string>;
  sdkPath?: string;
  graphSemanticRevision?: string;
  sourceDocumentSchemaVersion?: 1 | 2;
  gpioDirections?: Record<string, 'input' | 'output'>;
  gpioPulls?: Record<string, 'up' | 'down'>;
  primaryOutputPath?: string;
  manifestPath: string;
  buildInputs?: BuildInputRecord;
}

const ARTIFACT_FILE_NAMES = [
  /^aily-build-inputs\.json$/i,
  /^aily-block-source-map\.json$/i,
  /^aily-debug-source\.txt$/i,
  /^aily-debug-memory-map\.json$/i,
  /^aily-debug-instrumentation\.json$/i,
  /^aily-boot-app0\.bin$/i,
  /\.elf$/i,
  /\.map$/i,
  /\.hex$/i,
  /\.uf2$/i,
  /\.zip$/i,
  /\.bin$/i,
];

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function assertInside(rootPath: string, candidatePath: string, label: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the build directory.`);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function classifyArtifact(fileName: string): ArtifactFileRole | null {
  const lowerName = fileName.toLowerCase();
  if (lowerName === 'aily-build-inputs.json') return 'build-inputs';
  if (lowerName === 'aily-block-source-map.json') return 'source-map';
  if (lowerName === 'aily-debug-source.txt') return 'debug-source';
  if (lowerName === 'aily-debug-memory-map.json') return 'memory-map';
  if (lowerName === 'aily-debug-instrumentation.json') {
    return 'debug-instrumentation';
  }
  if (lowerName === 'aily-boot-app0.bin') return 'ota-data-initializer';
  if (lowerName.endsWith('.merged.bin')) return 'merged-flash';
  if (lowerName.endsWith('.bootloader.bin') || lowerName === 'bootloader.bin') return 'bootloader';
  if (lowerName.endsWith('.partitions.bin') || lowerName === 'partitions.bin') return 'partitions';
  if (lowerName.endsWith('.elf')) return 'elf';
  if (lowerName.endsWith('.map')) return 'map';
  if (lowerName.endsWith('.hex')) return 'hex';
  if (lowerName.endsWith('.uf2')) return 'uf2';
  if (lowerName.endsWith('.zip')) return 'archive';
  if (lowerName.endsWith('.bin')) return 'application';
  return null;
}

async function validateBlockSourceMap(
  sourceMapPath: string,
  sketchPath: string,
  sketchSizeBytes: number,
  sketchSha256: string,
): Promise<void> {
  const sourceMapStat = await fs.stat(sourceMapPath);
  if (sourceMapStat.size > 10 * 1024 * 1024) {
    throw new Error('Blockly source map exceeds the 10 MiB build limit.');
  }
  const value: unknown = await fs.readJson(sourceMapPath);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Blockly source map must be a JSON object.');
  }
  const sourceMap = value as Record<string, unknown>;
  if (
    sourceMap.schemaVersion !== 1
    || sourceMap.kind !== 'aily-block-source-map'
  ) {
    throw new Error('Blockly source map schema is unsupported.');
  }
  const source = sourceMap.source;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('Blockly source map source metadata is missing.');
  }
  const sourceMetadata = source as Record<string, unknown>;
  if (
    sourceMetadata.path !== path.basename(sketchPath)
    || sourceMetadata.sizeBytes !== sketchSizeBytes
    || sourceMetadata.sha256 !== sketchSha256
  ) {
    throw new Error(
      'Blockly source map does not match the exact sketch being compiled.',
    );
  }
  if (
    !Array.isArray(sourceMap.mappings)
    || sourceMap.mappings.length > 100_000
  ) {
    throw new Error('Blockly source map mappings are invalid.');
  }
  const blockIds = new Set<string>();
  for (const rawMapping of sourceMap.mappings) {
    if (
      typeof rawMapping !== 'object'
      || rawMapping === null
      || Array.isArray(rawMapping)
    ) {
      throw new Error('Blockly source map contains an invalid mapping.');
    }
    const mapping = rawMapping as Record<string, unknown>;
    if (
      typeof mapping.blockId !== 'string'
      || mapping.blockId.length < 1
      || mapping.blockId.length > 256
      || blockIds.has(mapping.blockId)
      || !Array.isArray(mapping.ranges)
      || mapping.ranges.length < 1
      || mapping.ranges.length > 1_024
    ) {
      throw new Error('Blockly source map contains an invalid block mapping.');
    }
    if (
      mapping.executionRole !== undefined
      && mapping.executionRole !== 'statement'
      && mapping.executionRole !== 'value'
    ) {
      throw new Error(
        'Blockly source map contains an invalid execution role.',
      );
    }
    blockIds.add(mapping.blockId);
    const allRanges = validateBlockSourceRangeList(
      mapping.ranges,
      false,
      'ranges',
    );
    for (const field of ['executableRanges', 'supportRanges'] as const) {
      if (mapping[field] === undefined) continue;
      const classifiedRanges = validateBlockSourceRangeList(
        mapping[field],
        true,
        field,
      );
      for (const range of classifiedRanges) {
        if (!allRanges.some((owner) => (
          range.startLine >= owner.startLine
          && range.endLine <= owner.endLine
        ))) {
          throw new Error(
            `Blockly source map ${field} must be contained in ranges.`,
          );
        }
      }
    }
  }
}

function validateBlockSourceRangeList(
  value: unknown,
  allowEmpty: boolean,
  field: string,
): Array<{ startLine: number; endLine: number }> {
  if (
    !Array.isArray(value)
    || (!allowEmpty && value.length < 1)
    || value.length > 1_024
  ) {
    throw new Error(`Blockly source map contains invalid ${field}.`);
  }
  return value.map((rawRange) => {
    if (
      typeof rawRange !== 'object'
      || rawRange === null
      || Array.isArray(rawRange)
    ) {
      throw new Error('Blockly source map contains an invalid line range.');
    }
    const range = rawRange as Record<string, unknown>;
    if (
      !Number.isSafeInteger(range.startLine)
      || !Number.isSafeInteger(range.endLine)
      || (range.startLine as number) < 1
      || (range.endLine as number) < (range.startLine as number)
    ) {
      throw new Error('Blockly source map contains an invalid line range.');
    }
    return {
      startLine: range.startLine as number,
      endLine: range.endLine as number,
    };
  });
}

function parseGnuLinkerMemoryRegions(
  linkerMap: string,
): DebugMemoryMapContract['regions'] | null {
  const lines = linkerMap.split(/\r?\n/);
  const memoryConfigurationIndex = lines.findIndex(
    (line) => line.trim() === 'Memory Configuration',
  );
  if (memoryConfigurationIndex < 0) return null;

  const parsed: Array<{
    name: string;
    start: bigint;
    end: bigint;
    attributes: DebugMemoryRegionAttributes;
  }> = [];
  const seenRanges = new Set<string>();
  for (
    let index = memoryConfigurationIndex + 1;
    index < lines.length;
    index += 1
  ) {
    const line = lines[index];
    if (line.trim() === 'Linker script and memory map') break;
    const match = /^\s*(\S+)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)(?:\s+([rwx]+))?\s*$/
      .exec(line);
    if (!match || match[1] === '*default*') continue;
    const rawAttributes = match[4] ?? '';
    if (!rawAttributes.includes('r')) continue;
    const start = BigInt(match[2]);
    const length = BigInt(match[3]);
    const end = start + length;
    if (
      length <= 0n
      || start < 0n
      || start > 0xffff_ffffn
      || end > 0xffff_ffffn
    ) continue;
    const rangeKey = `${start.toString(16)}:${end.toString(16)}`;
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);
    parsed.push({
      name: match[1],
      start,
      end,
      attributes: canonicalMemoryAttributes(rawAttributes),
    });
  }

  if (parsed.length === 0) return null;
  if (parsed.length > 64) {
    throw new Error('GNU linker map exposes more than 64 readable regions.');
  }

  parsed.sort((left, right) => (
    left.start < right.start
      ? -1
      : left.start > right.start
        ? 1
        : left.end < right.end
          ? -1
          : left.end > right.end
            ? 1
            : left.name.localeCompare(right.name)
  ));
  const usedIds = new Set<string>();
  return parsed.map((region) => ({
    id: uniqueMemoryRegionId(region.name, usedIds),
    label: region.name.slice(0, 128),
    startAddress: formatDebugAddress(region.start),
    endAddress: formatDebugAddress(region.end),
    attributes: region.attributes,
  }));
}

function canonicalMemoryAttributes(
  attributes: string,
): DebugMemoryRegionAttributes {
  return `r${attributes.includes('w') ? 'w' : ''}${
    attributes.includes('x') ? 'x' : ''
  }` as DebugMemoryRegionAttributes;
}

function uniqueMemoryRegionId(name: string, usedIds: Set<string>): string {
  const aliases: Array<[RegExp, string]> = [
    [/^drom/i, 'drom'],
    [/^dram/i, 'dram'],
    [/^iram0_0/i, 'iram'],
    [/^iram0_2/i, 'irom'],
    [/^rtc_slow/i, 'rtc-slow'],
    [/^rtc_iram/i, 'rtc-fast'],
    [/^rtc_reserved/i, 'rtc-reserved'],
  ];
  const alias = aliases.find(([pattern]) => pattern.test(name))?.[1];
  const normalized = (
    alias
    ?? name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  ).slice(0, 56);
  const base = /^[a-z]/.test(normalized)
    ? normalized
    : `region-${normalized || 'memory'}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base.slice(0, 60)}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function formatDebugAddress(address: bigint): string {
  return `0x${address.toString(16).padStart(8, '0')}`;
}

async function emitDebugMemoryMap(
  buildRoot: string,
  target: SimulationArtifactManifest['target'],
  elf: ArtifactFile,
  linkerMap: ArtifactFile,
): Promise<string | null> {
  const linkerMapContents = await fs.readFile(
    path.join(buildRoot, linkerMap.path),
    'utf8',
  );
  const regions = parseGnuLinkerMemoryRegions(linkerMapContents);
  if (regions === null) return null;

  const contract: DebugMemoryMapContract = {
    schemaVersion: 1,
    kind: 'aily-debug-memory-map',
    target,
    sources: {
      elf: {
        path: elf.path,
        sizeBytes: elf.sizeBytes,
        sha256: elf.sha256,
      },
      linkerMap: {
        path: linkerMap.path,
        sizeBytes: linkerMap.sizeBytes,
        sha256: linkerMap.sha256,
      },
    },
    regions,
  };
  const relativePath = 'aily-debug-memory-map.json';
  const outputPath = path.join(buildRoot, relativePath);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.writeJson(temporaryPath, contract, { spaces: 2 });
  await fs.rename(temporaryPath, outputPath);
  return relativePath;
}

async function inspectFile(
  buildRoot: string,
  filePath: string,
  role: ArtifactFileRole,
): Promise<ArtifactFile> {
  const resolvedPath = await fs.realpath(filePath);
  assertInside(buildRoot, resolvedPath, 'Artifact file');
  const fileStat = await fs.stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new Error(`Artifact is not a regular file: ${resolvedPath}`);
  }
  return {
    role,
    path: normalizeRelativePath(path.relative(buildRoot, resolvedPath)),
    sizeBytes: fileStat.size,
    sha256: await hashFile(resolvedPath),
  };
}

async function collectArtifactFiles(buildRoot: string): Promise<ArtifactFile[]> {
  const entries = await fs.readdir(buildRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && ARTIFACT_FILE_NAMES.some((pattern) => pattern.test(entry.name)))
    .map((entry) => ({
      name: entry.name,
      role: classifyArtifact(entry.name),
    }))
    .filter((entry): entry is { name: string; role: ArtifactFileRole } => entry.role !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  return Promise.all(
    candidates.map(({ name, role }) => inspectFile(buildRoot, path.join(buildRoot, name), role)),
  );
}

function parseTarget(
  board: string,
  mcu?: string,
  resolvedBoardId?: string,
): SimulationArtifactManifest['target'] {
  const [packageName = '', architecture = '', fqbnBoardId = ''] = board.split(':');
  if (!packageName || !architecture || !fqbnBoardId) {
    throw new Error(`Invalid board FQBN for artifact manifest: ${board}`);
  }
  const boardId = resolvedBoardId?.trim() || fqbnBoardId;
  return {
    fqbn: board,
    architecture,
    boardId,
    ...(mcu ? { mcu } : {}),
  };
}

function choosePrimaryFile(
  buildRoot: string,
  files: ArtifactFile[],
  primaryOutputPath?: string,
): string {
  if (primaryOutputPath) {
    const resolvedOutput = path.resolve(primaryOutputPath);
    assertInside(buildRoot, resolvedOutput, 'Primary output');
    const relativeOutput = normalizeRelativePath(path.relative(buildRoot, resolvedOutput));
    if (files.some((file) => file.path === relativeOutput)) return relativeOutput;
  }

  const preferredRoles: ArtifactFileRole[] = [
    'merged-flash',
    'application',
    'hex',
    'uf2',
    'archive',
    'elf',
  ];
  for (const role of preferredRoles) {
    const match = files.find((file) => file.role === role);
    if (match) return match.path;
  }
  throw new Error('No primary firmware artifact was produced.');
}

function stableToolVersions(toolVersions: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(toolVersions)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createArtifactId(
  target: SimulationArtifactManifest['target'],
  sourceSha256: string,
  files: ArtifactFile[],
  flashLayout?: Esp32FlashLayout,
  buildEnvironment?: Esp32BuildEnvironment,
  graphProvenance?: ArtifactGraphProvenance,
  buildInputs?: BuildInputRecord,
): string {
  const hash = createHash('sha256');
  hash.update(target.fqbn);
  hash.update('\0');
  hash.update(sourceSha256);
  for (const file of files) {
    hash.update('\0');
    hash.update(file.role);
    hash.update('\0');
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
  }
  if (flashLayout) {
    hash.update('\0esp32-flash-layout\0');
    hash.update(JSON.stringify(flashLayout));
  }
  if (buildEnvironment) {
    hash.update('\0esp32-build-environment\0');
    hash.update(JSON.stringify(buildEnvironment));
  }
  if (graphProvenance) {
    hash.update('\0scene-graph-provenance\0');
    hash.update(JSON.stringify(graphProvenance));
  }
  if (buildInputs) hash.update(`\0build-inputs\0${buildInputs.digest}`);
  return hash.digest('hex');
}

function parseStorageSize(value: string | undefined, label: string): number {
  const match = value?.trim().match(/^([1-9]\d*)(KB|MB)$/i);
  if (!match) throw new Error(`${label} must use an integer KB or MB value.`);
  const amount = Number(match[1]);
  const multiplier = match[2].toUpperCase() === 'MB' ? 1024 * 1024 : 1024;
  const sizeBytes = amount * multiplier;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`${label} exceeds the supported integer range.`);
  }
  return sizeBytes;
}

function parseFrequencyHz(value: string | undefined, label: string): number {
  const match = value?.trim().match(/^([1-9]\d*)(k|m)?(?:hz)?$/i);
  if (!match) throw new Error(`${label} must be an integer Hz, kHz, or MHz value.`);
  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  const frequencyHz = amount * multiplier;
  if (!Number.isSafeInteger(frequencyHz) || frequencyHz <= 0) {
    throw new Error(`${label} exceeds the supported integer range.`);
  }
  return frequencyHz;
}

function parseOffset(value: string, label: string): number {
  if (!/^(?:0x[a-f0-9]+|[0-9]+)$/i.test(value)) {
    throw new Error(`${label} is not an integer flash offset.`);
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`${label} exceeds the supported integer range.`);
  }
  return offset;
}

function classifyEsp32MergeInput(filePath: string): Esp32FlashSegmentRole | null {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.endsWith('.bootloader.bin')) return 'bootloader';
  if (normalized.endsWith('.partitions.bin')) return 'partition-table';
  if (
    normalized === 'boot_app0.bin'
    || normalized.endsWith('/boot_app0.bin')
  ) {
    return 'ota-data-initializer';
  }
  if (normalized.endsWith('.bin')) return 'application';
  return null;
}

function parseEsp32MergeOffsets(
  platformProperties: Record<string, string>,
): Map<Esp32FlashSegmentRole, number> {
  const mergeCommand = platformProperties[
    'recipe.hooks.objcopy.postobjcopy.3.pattern_args'
  ] || platformProperties['recipe.hooks.objcopy.postobjcopy.3.pattern'];
  if (!mergeCommand || !/\bmerge(?:-|_)bin\b/i.test(mergeCommand)) {
    throw new Error(
      'ESP32 Artifact requires the resolved esptool merge-bin/merge_bin recipe.',
    );
  }
  const offsets = new Map<Esp32FlashSegmentRole, number>();
  const pairs = mergeCommand.matchAll(
    /(?:^|\s)(0x[a-f0-9]+|[0-9]+)\s+"([^"]+\.bin)"/gi,
  );
  for (const pair of pairs) {
    const role = classifyEsp32MergeInput(pair[2]);
    if (!role) continue;
    if (offsets.has(role)) {
      throw new Error(`ESP32 merge recipe contains duplicate ${role} segments.`);
    }
    offsets.set(role, parseOffset(pair[1], `ESP32 ${role} offset`));
  }
  const required: Esp32FlashSegmentRole[] = [
    'bootloader',
    'partition-table',
    'ota-data-initializer',
    'application',
  ];
  for (const role of required) {
    if (!offsets.has(role)) {
      throw new Error(`ESP32 merge recipe is missing the ${role} segment.`);
    }
  }
  return offsets;
}

async function copyEsp32BootApp0(
  buildRoot: string,
  sdkPath: string | undefined,
): Promise<void> {
  if (!sdkPath) throw new Error('ESP32 Artifact requires the resolved Arduino SDK path.');
  const sourcePath = path.resolve(sdkPath, 'tools', 'partitions', 'boot_app0.bin');
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile()) {
    throw new Error('ESP32 Artifact boot_app0.bin is missing from the Arduino SDK.');
  }
  await fs.copyFile(sourcePath, path.join(buildRoot, 'aily-boot-app0.bin'));
}

async function readEspIdfVersion(
  platformProperties: Record<string, string>,
  mcu: string,
): Promise<string> {
  const librariesPath = platformProperties['runtime.tools.esp32-arduino-libs.path'];
  if (!librariesPath) {
    throw new Error('ESP32 Artifact requires the resolved esp32-arduino-libs path.');
  }
  const headerPath = path.resolve(
    librariesPath,
    mcu,
    'include',
    'esp_common',
    'include',
    'esp_idf_version.h',
  );
  const header = await fs.readFile(headerPath, 'utf8').catch(() => null);
  if (header === null) {
    throw new Error('ESP32 Artifact cannot read esp_idf_version.h.');
  }
  const values = ['MAJOR', 'MINOR', 'PATCH'].map((part) => {
    const match = header.match(
      new RegExp(`^#define\\s+ESP_IDF_VERSION_${part}\\s+([0-9]+)\\s*$`, 'm'),
    );
    if (!match) throw new Error(`ESP32 Artifact cannot resolve ESP-IDF ${part}.`);
    return match[1];
  });
  return values.join('.');
}

async function createEsp32BuildEnvironment(
  target: SimulationArtifactManifest['target'],
  platformProperties: Record<string, string>,
  toolVersions: Record<string, string> = {},
): Promise<Esp32BuildEnvironment> {
  const arduinoCoreVersion = platformProperties['version']?.trim();
  if (!arduinoCoreVersion) {
    throw new Error('ESP32 Artifact requires platform.version for Arduino Core.');
  }
  if (!target.mcu) throw new Error('ESP32 Artifact requires a concrete MCU.');
  const toolchains = (['esp-x32', 'esp-rv32'] as const)
    .map((name) => ({ name, version: toolVersions[name]?.trim() }))
    .filter((toolchain): toolchain is {
      name: 'esp-x32' | 'esp-rv32';
      version: string;
    } => Boolean(toolchain.version));
  if (toolchains.length !== 1) {
    throw new Error(
      'ESP32 Artifact requires exactly one compiler toolchain in toolVersions: esp-x32 or esp-rv32.',
    );
  }
  const [toolchain] = toolchains;
  return {
    schemaVersion: 1,
    arduinoCore: {
      name: 'arduino-esp32',
      version: arduinoCoreVersion,
      source: 'platform.version',
    },
    espIdf: {
      name: 'esp-idf',
      version: await readEspIdfVersion(platformProperties, target.mcu),
      source: 'esp32-arduino-libs/esp_idf_version.h',
    },
    toolchain: {
      name: toolchain.name,
      version: toolchain.version,
      source: `toolVersions.${toolchain.name}`,
    },
  };
}

async function hashFileRange(
  filePath: string,
  offsetBytes: number,
  sizeBytes: number,
): Promise<string> {
  const hash = createHash('sha256');
  if (sizeBytes === 0) return hash.digest('hex');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, {
      start: offsetBytes,
      end: offsetBytes + sizeBytes - 1,
    });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function createEsp32FlashLayout(
  buildRoot: string,
  target: SimulationArtifactManifest['target'],
  files: ArtifactFile[],
  platformProperties: Record<string, string>,
  mergedFlash: ArtifactFile,
): Promise<Esp32FlashLayout> {
  if (!target.mcu) throw new Error('ESP32 flash layout requires a concrete MCU.');
  const mode = platformProperties['build.flash_mode']?.trim().toLowerCase();
  if (!['dio', 'qio', 'dout', 'qout'].includes(mode ?? '')) {
    throw new Error('ESP32 Artifact has an unsupported build.flash_mode.');
  }
  const bootMode = (
    platformProperties['build.boot'] || platformProperties['build.flash_mode']
  )?.trim().toLowerCase();
  if (!['dio', 'qio', 'dout', 'qout'].includes(bootMode ?? '')) {
    throw new Error('ESP32 Artifact has an unsupported build.boot.');
  }
  const deviceSizeBytes = parseStorageSize(
    platformProperties['build.flash_size'],
    'ESP32 build.flash_size',
  );
  const frequencyHz = parseFrequencyHz(
    platformProperties['build.img_freq'] || platformProperties['build.flash_freq'],
    'ESP32 build flash frequency',
  );
  if (mergedFlash.sizeBytes > deviceSizeBytes) {
    throw new Error('ESP32 merged image exceeds the resolved flash device size.');
  }
  const offsets = parseEsp32MergeOffsets(platformProperties);
  const fileRoles: Record<Esp32FlashSegmentRole, ArtifactFileRole> = {
    bootloader: 'bootloader',
    'partition-table': 'partitions',
    'ota-data-initializer': 'ota-data-initializer',
    application: 'application',
  };
  const segments = [...offsets.entries()].map(([role, offsetBytes]) => {
    const descriptor = files.find((file) => file.role === fileRoles[role]);
    if (!descriptor) throw new Error(`ESP32 Artifact is missing the ${role} file.`);
    return {
      role,
      offsetBytes,
      path: descriptor.path,
      sizeBytes: descriptor.sizeBytes,
      sha256: descriptor.sha256,
    };
  }).sort((left, right) => left.offsetBytes - right.offsetBytes);

  for (const [index, segment] of segments.entries()) {
    const endOffset = segment.offsetBytes + segment.sizeBytes;
    if (!Number.isSafeInteger(endOffset) || endOffset > deviceSizeBytes) {
      throw new Error(`ESP32 ${segment.role} segment exceeds the flash device.`);
    }
    const next = segments[index + 1];
    if (next && endOffset > next.offsetBytes) {
      throw new Error(
        `ESP32 ${segment.role} segment overlaps ${next.role}.`,
      );
    }
    const mergedSegmentHash = await hashFileRange(
      path.join(buildRoot, mergedFlash.path),
      segment.offsetBytes,
      segment.sizeBytes,
    );
    if (mergedSegmentHash !== segment.sha256) {
      throw new Error(
        `ESP32 merged image does not contain the declared ${segment.role} segment.`,
      );
    }
  }
  return {
    schemaVersion: 1,
    kind: 'aily-esp32-flash-layout',
    target: {
      architecture: 'esp32',
      boardId: target.boardId,
      mcu: target.mcu,
    },
    device: {
      sizeBytes: deviceSizeBytes,
      mode: mode as Esp32FlashLayout['device']['mode'],
      bootMode: bootMode as Esp32FlashLayout['device']['bootMode'],
      frequencyHz,
      source: 'resolved-board-properties',
    },
    segments,
  };
}

async function emitDebugInstrumentationManifest(
  buildRoot: string,
  target: SimulationArtifactManifest['target'],
  linkerMap: ArtifactFile | undefined,
): Promise<string | null> {
  const outputName = 'aily-debug-instrumentation.json';
  const outputPath = path.join(buildRoot, outputName);
  await fs.remove(outputPath);
  if (!linkerMap) return null;
  const linkerMapPath = path.join(buildRoot, linkerMap.path);
  const linkerMapStat = await fs.stat(linkerMapPath);
  if (!linkerMapStat.isFile() || linkerMapStat.size > 64 * 1024 * 1024) {
    throw new Error(
      'Linker map is not a bounded regular file for debug instrumentation detection.',
    );
  }
  const linkerMapText = await fs.readFile(linkerMapPath, 'utf8');
  if (!/\bailyFreeRtosDebugObjectRegistryV1\b/.test(linkerMapText)) {
    return null;
  }
  const manifest: DebugInstrumentationManifest = {
    schemaVersion: 1,
    kind: 'aily-debug-instrumentation',
    abi: {
      name: 'aily.freertos-object-registry',
      version: 1,
      symbol: 'ailyFreeRtosDebugObjectRegistryV1',
      capabilities: ['freertos.objects'],
    },
    compatibility: {
      architecture: target.architecture,
      ...(target.mcu === undefined ? {} : { mcu: target.mcu }),
      framework: 'arduino',
      rtos: 'freertos',
    },
  };
  await fs.writeJson(outputPath, manifest, { spaces: 2 });
  return outputName;
}

export async function emitSimulationArtifactManifest(
  options: EmitArtifactManifestOptions,
): Promise<SimulationArtifactManifest> {
  const buildRoot = await fs.realpath(options.buildPath);
  const manifestPath = path.resolve(options.manifestPath);
  assertInside(buildRoot, manifestPath, 'Artifact manifest');
  const target = parseTarget(options.board, options.mcu, options.boardId);
  if (
    options.graphSemanticRevision !== undefined
    && !/^[a-f0-9]{64}$/.test(options.graphSemanticRevision)
  ) {
    throw new Error('Graph semantic revision must be a lowercase SHA-256 value.');
  }
  if (
    options.sourceDocumentSchemaVersion !== undefined
    && options.sourceDocumentSchemaVersion !== 1
    && options.sourceDocumentSchemaVersion !== 2
  ) {
    throw new Error('Scene document schema version must be 1 or 2.');
  }
  if (
    options.sourceDocumentSchemaVersion !== undefined
    && options.graphSemanticRevision === undefined
  ) {
    throw new Error(
      'Scene document schema version requires a graph semantic revision.',
    );
  }
  if (options.gpioDirections !== undefined && options.graphSemanticRevision === undefined) {
    throw new Error('GPIO directions require a graph semantic revision.');
  }
  if (options.gpioPulls !== undefined && options.graphSemanticRevision === undefined) {
    throw new Error('GPIO pulls require a graph semantic revision.');
  }
  const gpioDirectionEntries = options.gpioDirections === undefined
    ? []
    : Object.entries(options.gpioDirections);
  if (gpioDirectionEntries.length > 256) {
    throw new Error('GPIO directions exceed 256 entries.');
  }
  for (const [endpoint, direction] of gpioDirectionEntries) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(endpoint)
      || (direction !== 'input' && direction !== 'output')
    ) {
      throw new Error(`GPIO direction ${endpoint} is invalid.`);
    }
  }
  const gpioPullEntries = options.gpioPulls === undefined
    ? []
    : Object.entries(options.gpioPulls);
  if (gpioPullEntries.length > 256) {
    throw new Error('GPIO pulls exceed 256 entries.');
  }
  for (const [endpoint, pull] of gpioPullEntries) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(endpoint)
      || (pull !== 'up' && pull !== 'down')
    ) {
      throw new Error(`GPIO pull ${endpoint} is invalid.`);
    }
  }
  const graphProvenance = options.graphSemanticRevision === undefined
    ? undefined
    : {
        schemaVersion: 1 as const,
        kind: 'aily-scene-graph-provenance' as const,
        graphSemanticRevision: options.graphSemanticRevision,
        ...(options.sourceDocumentSchemaVersion === undefined
          ? {}
          : {
              sourceDocumentSchemaVersion:
                options.sourceDocumentSchemaVersion,
            }),
        ...(gpioDirectionEntries.length === 0
          ? {}
          : {
              gpioDirections: Object.fromEntries(
                gpioDirectionEntries.sort(([left], [right]) => left.localeCompare(right)),
              ),
            }),
        ...(gpioPullEntries.length === 0
          ? {}
          : {
              gpioPulls: Object.fromEntries(
                gpioPullEntries.sort(([left], [right]) => left.localeCompare(right)),
              ),
            }),
      };

  const sketchPath = await fs.realpath(options.sketchPath);
  const sketchStat = await fs.stat(sketchPath);
  if (!sketchStat.isFile()) {
    throw new Error(`Sketch is not a regular file: ${sketchPath}`);
  }

  const generatedMemoryMapPath = path.join(
    buildRoot,
    'aily-debug-memory-map.json',
  );
  const sourceSnapshotPath = path.join(
    buildRoot,
    'aily-debug-source.txt',
  );
  const instrumentationManifestPath = path.join(
    buildRoot,
    'aily-debug-instrumentation.json',
  );
  const bootApp0ArtifactPath = path.join(buildRoot, 'aily-boot-app0.bin');
  const buildInputsPath = path.join(buildRoot, 'aily-build-inputs.json');
  if (sketchStat.size > 2 * 1024 * 1024) {
    throw new Error('Debug source snapshot exceeds the 2 MiB build limit.');
  }
  const sourceSha256 = await hashFile(sketchPath);
  await Promise.all([
    fs.remove(generatedMemoryMapPath),
    fs.remove(sourceSnapshotPath),
    fs.remove(instrumentationManifestPath),
    fs.remove(bootApp0ArtifactPath),
    fs.remove(buildInputsPath),
  ]);
  // Evidence is a sidecar, never firmware/source content or a compiler input.
  if (options.buildInputs) await fs.writeJson(buildInputsPath, options.buildInputs, { spaces: 2 });
  await fs.copyFile(sketchPath, sourceSnapshotPath);
  if (target.architecture === 'esp32') {
    await copyEsp32BootApp0(buildRoot, options.sdkPath);
  }
  let files = await collectArtifactFiles(buildRoot);
  if (files.length === 0) {
    throw new Error(`No firmware artifacts found in build directory: ${buildRoot}`);
  }

  const sourceSnapshot = files.find(
    (file) => file.role === 'debug-source',
  );
  if (
    !sourceSnapshot
    || sourceSnapshot.sizeBytes !== sketchStat.size
    || sourceSnapshot.sha256 !== sourceSha256
  ) {
    throw new Error(
      'Debug source snapshot does not match the exact source being compiled.',
    );
  }
  const sourceMap = files.find((file) => file.role === 'source-map');
  if (sourceMap) {
    await validateBlockSourceMap(
      path.join(buildRoot, sourceMap.path),
      sketchPath,
      sketchStat.size,
      sourceSha256,
    );
  }

  const initialElf = files.find((file) => file.role === 'elf');
  const initialLinkerMap = files.find((file) => file.role === 'map');
  let memoryMapPath: string | null = null;
  if (initialElf && initialLinkerMap) {
    memoryMapPath = await emitDebugMemoryMap(
      buildRoot,
      target,
      initialElf,
      initialLinkerMap,
    );
  }
  const instrumentationPath = await emitDebugInstrumentationManifest(
    buildRoot,
    target,
    initialLinkerMap,
  );
  if (memoryMapPath || instrumentationPath) {
    files = await collectArtifactFiles(buildRoot);
  }

  const primaryFile = choosePrimaryFile(buildRoot, files, options.primaryOutputPath);
  const mergedFlash = files.find((file) => file.role === 'merged-flash');
  if (target.architecture === 'esp32' && !mergedFlash) {
    throw new Error('ESP32 Artifact requires a merged flash image.');
  }
  const platformProperties = options.platformProperties ?? {};
  const flashLayout = target.architecture === 'esp32' && mergedFlash
    ? await createEsp32FlashLayout(
        buildRoot,
        target,
        files,
        platformProperties,
        mergedFlash,
      )
    : undefined;
  const buildEnvironment = target.architecture === 'esp32'
    ? await createEsp32BuildEnvironment(
        target,
        platformProperties,
        options.toolVersions,
      )
    : undefined;
  const elf = files.find((file) => file.role === 'elf');
  const linkerMap = files.find((file) => file.role === 'map');
  const memoryMap = files.find((file) => file.role === 'memory-map');
  const instrumentation = files.find(
    (file) => file.role === 'debug-instrumentation',
  );
  if (memoryMapPath && memoryMap?.path !== memoryMapPath) {
    throw new Error('Generated debug memory map was not collected as an Artifact file.');
  }

  const manifest: SimulationArtifactManifest = {
    schemaVersion: 1,
    kind: 'aily-build-artifact',
    artifactId: createArtifactId(
      target,
      sourceSha256,
      files,
      flashLayout,
      buildEnvironment,
      graphProvenance,
      options.buildInputs,
    ),
    target,
    build: {
      builtAt: new Date().toISOString(),
      source: {
        path: path.basename(sketchPath),
        sizeBytes: sketchStat.size,
        sha256: sourceSha256,
      },
      toolVersions: stableToolVersions(options.toolVersions),
      ...(options.buildInputs ? { inputs: {
        schemaVersion: 1 as const,
        kind: 'aily-build-input-reference' as const,
        scope: 'prepared-dependency-trees' as const,
        path: 'aily-build-inputs.json',
        digest: options.buildInputs.digest,
      } } : {}),
      ...(buildEnvironment ? { environment: buildEnvironment } : {}),
      ...(graphProvenance ? { graph: graphProvenance } : {}),
    },
    files,
    primaryFile,
    ...(mergedFlash
      ? {
        flash: {
          format: 'merged' as const,
          imagePath: mergedFlash.path,
          imageSizeBytes: mergedFlash.sizeBytes,
          ...(flashLayout
            ? {
                sdkConfiguredSizeBytes: flashLayout.device.sizeBytes,
                layout: flashLayout,
              }
            : {}),
        },
      }
      : {}),
    ...(elf || linkerMap || sourceMap || sourceSnapshot || memoryMap
      || instrumentation
      ? {
        debug: {
          ...(elf ? { elfPath: elf.path } : {}),
          ...(linkerMap ? { mapPath: linkerMap.path } : {}),
          ...(sourceMap ? { sourceMapPath: sourceMap.path } : {}),
          ...(sourceSnapshot
            ? { sourceSnapshotPath: sourceSnapshot.path }
            : {}),
          ...(memoryMap ? { memoryMapPath: memoryMap.path } : {}),
          ...(instrumentation
            ? { instrumentationPath: instrumentation.path }
            : {}),
        },
      }
      : {}),
  };

  await fs.ensureDir(path.dirname(manifestPath));
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeJson(temporaryPath, manifest, { spaces: 2 });
  await fs.rename(temporaryPath, manifestPath);
  return manifest;
}
