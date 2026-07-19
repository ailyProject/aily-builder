import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs-extra';
import path from 'path';

export type ArtifactFileRole =
  | 'application'
  | 'merged-flash'
  | 'bootloader'
  | 'partitions'
  | 'elf'
  | 'map'
  | 'source-map'
  | 'debug-source'
  | 'memory-map'
  | 'hex'
  | 'uf2'
  | 'archive';

export interface ArtifactFile {
  role: ArtifactFileRole;
  path: string;
  sizeBytes: number;
  sha256: string;
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
  };
  files: ArtifactFile[];
  primaryFile: string;
  flash?: {
    format: 'merged';
    imagePath: string;
    imageSizeBytes: number;
    sdkConfiguredSizeBytes?: number;
  };
  debug?: {
    elfPath?: string;
    mapPath?: string;
    sourceMapPath?: string;
    sourceSnapshotPath?: string;
    memoryMapPath?: string;
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
  mcu?: string;
  toolVersions?: Record<string, string>;
  primaryOutputPath?: string;
  manifestPath: string;
}

const ARTIFACT_FILE_NAMES = [
  /^aily-block-source-map\.json$/i,
  /^aily-debug-source\.txt$/i,
  /^aily-debug-memory-map\.json$/i,
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
  if (lowerName === 'aily-block-source-map.json') return 'source-map';
  if (lowerName === 'aily-debug-source.txt') return 'debug-source';
  if (lowerName === 'aily-debug-memory-map.json') return 'memory-map';
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

function parseTarget(board: string, mcu?: string): SimulationArtifactManifest['target'] {
  const [packageName = '', architecture = '', boardId = ''] = board.split(':');
  if (!packageName || !architecture || !boardId) {
    throw new Error(`Invalid board FQBN for artifact manifest: ${board}`);
  }
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
  sdkConfiguredFlashSizeBytes?: number,
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
  if (sdkConfiguredFlashSizeBytes !== undefined) {
    hash.update('\0sdk-configured-flash-size\0');
    hash.update(String(sdkConfiguredFlashSizeBytes));
  }
  return hash.digest('hex');
}

async function readSdkConfiguredFlashSize(
  buildRoot: string,
): Promise<number | undefined> {
  const sdkconfigPath = path.join(buildRoot, 'sdkconfig');
  const sdkconfig = await fs.readFile(sdkconfigPath, 'utf8').catch(() => null);
  if (sdkconfig === null) return undefined;

  const match = sdkconfig.match(
    /^CONFIG_ESPTOOLPY_FLASHSIZE="([1-9]\d*)(KB|MB)"$/m,
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isSafeInteger(value)) return undefined;
  return value * (unit === 'MB' ? 1024 * 1024 : 1024);
}

export async function emitSimulationArtifactManifest(
  options: EmitArtifactManifestOptions,
): Promise<SimulationArtifactManifest> {
  const buildRoot = await fs.realpath(options.buildPath);
  const manifestPath = path.resolve(options.manifestPath);
  assertInside(buildRoot, manifestPath, 'Artifact manifest');
  const target = parseTarget(options.board, options.mcu);

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
  if (sketchStat.size > 2 * 1024 * 1024) {
    throw new Error('Debug source snapshot exceeds the 2 MiB build limit.');
  }
  const sourceSha256 = await hashFile(sketchPath);
  await Promise.all([
    fs.remove(generatedMemoryMapPath),
    fs.remove(sourceSnapshotPath),
  ]);
  await fs.copyFile(sketchPath, sourceSnapshotPath);
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
    if (memoryMapPath) files = await collectArtifactFiles(buildRoot);
  }

  const primaryFile = choosePrimaryFile(buildRoot, files, options.primaryOutputPath);
  const sdkConfiguredFlashSizeBytes = await readSdkConfiguredFlashSize(buildRoot);
  const mergedFlash = files.find((file) => file.role === 'merged-flash');
  const elf = files.find((file) => file.role === 'elf');
  const linkerMap = files.find((file) => file.role === 'map');
  const memoryMap = files.find((file) => file.role === 'memory-map');
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
      sdkConfiguredFlashSizeBytes,
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
    },
    files,
    primaryFile,
    ...(mergedFlash
      ? {
        flash: {
          format: 'merged' as const,
          imagePath: mergedFlash.path,
          imageSizeBytes: mergedFlash.sizeBytes,
          ...(sdkConfiguredFlashSizeBytes !== undefined
            ? { sdkConfiguredSizeBytes: sdkConfiguredFlashSizeBytes }
            : {}),
        },
      }
      : {}),
    ...(elf || linkerMap || sourceMap || sourceSnapshot || memoryMap
      ? {
        debug: {
          ...(elf ? { elfPath: elf.path } : {}),
          ...(linkerMap ? { mapPath: linkerMap.path } : {}),
          ...(sourceMap ? { sourceMapPath: sourceMap.path } : {}),
          ...(sourceSnapshot
            ? { sourceSnapshotPath: sourceSnapshot.path }
            : {}),
          ...(memoryMap ? { memoryMapPath: memoryMap.path } : {}),
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
