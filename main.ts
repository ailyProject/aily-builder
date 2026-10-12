#!/usr/bin/env node
import { Command } from 'commander';
import { ArduinoCompiler, PreprocessResult } from './src/ArduinoCompiler';
import { ArduinoUploader } from './src/ArduinoUploader';
import { Logger } from './src/utils/Logger';
import { CacheManager } from './src/CacheManager';
import { CacheClearMode, CacheRegistry, CacheStatsReport, CacheClearReport } from './src/CacheRegistry';
import { calculateMD5 } from './src/utils/md5';
import { initShortPath, sanitizeNonAsciiPaths } from './src/utils/ShortPath';
import { getPathListDelimiter, isWindowsHost } from './src/utils/HostPlatform';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import packageJson from './package.json';
import { withBuildWorkspace, assertBuildOutputPath } from './src/BuildWorkspace';

const program = new Command();
const logger = new Logger();

async function runBuildCommand(buildPath: string, operation: 'compile' | 'preprocess', action: () => Promise<void>) {
  await withBuildWorkspace(buildPath, operation, async () => {
    try { await action(); } finally { logger.disableLogFile(); }
  });
}

function isTruthyEnv(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value?.toLowerCase() === 'true';
}

function getSourceBaseName(sourcePath: string): string {
  return path.parse(sourcePath).name;
}

/**
 * 生成同名 sketch 不冲突的默认构建目录。
 * 路径布局保持现有 CLI 约定，项目路径哈希用于区分不同目录下的同名文件。
 */
function getDefaultBuildPath(sketchPath: string, sketchName: string): string {
  const projectPathHash = calculateMD5(sketchPath).substring(0, 8);
  const uniqueSketchName = `${sketchName}_${projectPathHash}`;
  const userDataPath = isWindowsHost()
    ? path.join(os.homedir(), 'AppData', 'Local')
    : path.join(os.homedir(), 'Library');

  return path.join(userDataPath, 'aily-builder', 'project', uniqueSketchName);
}

/**
 * 将命令行提供的库目录写入 LIBRARIES_PATH。
 * 每个目录先转换为绝对路径，再使用当前主机的路径列表分隔符连接。
 */
function setLibrariesPathEnvironment(libraryPaths?: readonly string[]): void {
  if (!libraryPaths || libraryPaths.length === 0) {
    return;
  }

  const resolvedPaths = libraryPaths.map(libraryPath => path.resolve(libraryPath));
  process.env['LIBRARIES_PATH'] = resolvedPaths.join(getPathListDelimiter());
}

async function readSceneGpioDirectionsFile(
  inputPath: string,
  expectedGraphSemanticRevision: string,
): Promise<Record<string, 'input' | 'output'>> {
  const resolvedPath = path.resolve(inputPath);
  const pathStat = await fs.lstat(resolvedPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > 64 * 1024) {
    throw new Error('Scene GPIO directions must be a regular JSON file of at most 64 KiB.');
  }
  const value: unknown = await fs.readJson(resolvedPath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Scene GPIO directions file must contain an object.');
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join('\0')
      !== ['directions', 'graphSemanticRevision', 'kind', 'schemaVersion'].sort().join('\0')
    || envelope.schemaVersion !== 1
    || envelope.kind !== 'aily-scene-gpio-directions'
    || envelope.graphSemanticRevision !== expectedGraphSemanticRevision
    || !envelope.directions
    || typeof envelope.directions !== 'object'
    || Array.isArray(envelope.directions)
  ) {
    throw new Error('Scene GPIO directions file identity or graph revision is invalid.');
  }
  const entries = Object.entries(envelope.directions as Record<string, unknown>);
  if (entries.length > 256) {
    throw new Error('Scene GPIO directions file exceeds 256 entries.');
  }
  const directions: Record<string, 'input' | 'output'> = {};
  for (const [endpoint, direction] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(endpoint)
      || (direction !== 'input' && direction !== 'output')
    ) {
      throw new Error(`Scene GPIO direction ${endpoint} is invalid.`);
    }
    directions[endpoint] = direction;
  }
  return directions;
}

async function readSceneGpioPullsFile(
  inputPath: string,
  expectedGraphSemanticRevision: string,
): Promise<Record<string, 'up' | 'down'>> {
  const resolvedPath = path.resolve(inputPath);
  const pathStat = await fs.lstat(resolvedPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > 64 * 1024) {
    throw new Error('Scene GPIO pulls must be a regular JSON file of at most 64 KiB.');
  }
  const value: unknown = await fs.readJson(resolvedPath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Scene GPIO pulls file must contain an object.');
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join('\0')
      !== ['graphSemanticRevision', 'kind', 'pulls', 'schemaVersion'].sort().join('\0')
    || envelope.schemaVersion !== 1
    || envelope.kind !== 'aily-scene-gpio-pulls'
    || envelope.graphSemanticRevision !== expectedGraphSemanticRevision
    || !envelope.pulls
    || typeof envelope.pulls !== 'object'
    || Array.isArray(envelope.pulls)
  ) {
    throw new Error('Scene GPIO pulls file identity or graph revision is invalid.');
  }
  const entries = Object.entries(envelope.pulls as Record<string, unknown>);
  if (entries.length > 256) {
    throw new Error('Scene GPIO pulls file exceeds 256 entries.');
  }
  const pulls: Record<string, 'up' | 'down'> = {};
  for (const [endpoint, pull] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(endpoint)
      || (pull !== 'up' && pull !== 'down')
    ) {
      throw new Error(`Scene GPIO pull ${endpoint} is invalid.`);
    }
    pulls[endpoint] = pull;
  }
  return pulls;
}

function resolveCacheClearMode(options: any): CacheClearMode {
  const selected: CacheClearMode[] = [];

  if (options.all) selected.push('all');
  if (options.unused30) selected.push('unused-30');
  if (options.unused7) selected.push('unused-7');

  if (selected.length !== 1) {
    throw new Error('Choose exactly one clear option: --all, --unused-30, or --unused-7');
  }

  return selected[0];
}

function printCacheStats(report: CacheStatsReport, verbose = false): void {
  logger.info('Cache statistics:');
  for (const bucket of report.buckets) {
    logger.info(`- ${bucket.name} (${bucket.id})`);
    logger.info(`  Entries: ${bucket.entries}`);
    logger.info(`  Files: ${bucket.files}`);
    logger.info(`  Size: ${bucket.totalSizeFormatted}`);
    logger.info(`  Path: ${bucket.directory}`);
    if (bucket.newestLastUsedAt) {
      logger.info(`  Last used: ${bucket.newestLastUsedAt}`);
    }
    if (verbose) {
      logger.info(`  Description: ${bucket.description}`);
      if (bucket.oldestLastUsedAt) {
        logger.info(`  Oldest file use: ${bucket.oldestLastUsedAt}`);
      }
    }
  }

  logger.info(`Total entries: ${report.total.entries}`);
  logger.info(`Total files: ${report.total.files}`);
  logger.info(`Total size: ${report.total.totalSizeFormatted}`);
}

function printCacheClearReport(report: CacheClearReport): void {
  const action = report.dryRun ? 'Would delete' : 'Deleted';
  logger.info(`Cache clear mode: ${report.mode}${report.dryRun ? ' (dry run)' : ''}`);
  if (report.cutoffAt) {
    logger.info(`Cutoff: unused since before ${report.cutoffAt}`);
  }

  for (const bucket of report.buckets) {
    logger.info(`- ${bucket.name}: ${action} ${bucket.deletedFiles} files, ${bucket.deletedDirectories} directories, ${bucket.bytesFreedFormatted}`);
    logger.info(`  Path: ${bucket.directory}`);
  }

  logger.success(`${report.dryRun ? 'Cache clear dry run completed' : 'Cache clear completed'}: ${action.toLowerCase()} ${report.total.deletedFiles} files, ${report.total.deletedDirectories} directories, ${report.total.bytesFreedFormatted}`);
}

program
  .name('aily-builder')
  .description('Fast Arduino compilation CLI tool with optimized preprocessing and parallel compilation')
  .version(packageJson.version);

program
  .command('capabilities')
  .description('Print machine-readable builder capabilities')
  .option('--json', 'Print compact JSON', false)
  .action((options) => {
    const capabilities = {
      schemaVersion: 1,
      service: 'aily-builder',
      version: packageJson.version,
      capabilities: {
        buildWorkspaceLease: {
          schemaVersion: 1,
          ownerFileName: 'aily-workspace.lock',
          delegateFileName: 'aily-builder.lock',
          delegationEnvironment: 'AILY_BUILDER_WORKSPACE',
          operations: ['compile', 'preprocess', 'clean'],
        },
        simulationArtifactManifest: {
          schemaVersion: 1,
          cliOption: '--emit-artifact-manifest',
          defaultFileName: 'aily-artifact-manifest.json',
        },
        buildInputRecord: {
          schemaVersion: 1,
          cliOption: '--record-build-inputs',
          manifestField: 'build.inputs',
          storage: 'sidecar-reference',
          defaultFileName: 'aily-build-inputs.json',
          scope: 'build-graph-facts',
          currentProjectFreshness: false,
        },
        sceneGraphProvenance: {
          schemaVersion: 1,
          cliOption: '--graph-semantic-revision',
          sourceDocumentSchemaOption: '--scene-document-schema-version',
          gpioDirectionsOption: '--scene-gpio-directions',
          gpioPullsOption: '--scene-gpio-pulls',
          manifestField: 'build.graph',
        },
        blockSourceMap: {
          schemaVersion: 1,
          inputFileName: 'aily-block-source-map.json',
          artifactRole: 'source-map',
        },
        debugSourceSnapshot: {
          schemaVersion: 1,
          outputFileName: 'aily-debug-source.txt',
          artifactRole: 'debug-source',
          maxSizeBytes: 2 * 1024 * 1024,
        },
        simulationSourceDebug: {
          schemaVersion: 1,
          cliOption: '--simulation-debug',
          compileProfile: 'source-debug',
        },
        debugInstrumentation: {
          schemaVersion: 1,
          detection: 'linked-symbol',
          outputFileName: 'aily-debug-instrumentation.json',
          artifactRole: 'debug-instrumentation',
          supportedAbis: [{
            name: 'aily.freertos-object-registry',
            version: 1,
          }],
        },
        debugMemoryMap: {
          schemaVersion: 1,
          outputFileName: 'aily-debug-memory-map.json',
          artifactRole: 'memory-map',
          source: 'gnu-linker-memory-configuration',
        },
      },
    };
    console.log(JSON.stringify(capabilities, null, options.json ? 0 : 2));
  });

program
  .command('compile')
  .description('Compile Arduino source')
  .argument('<sketch>', 'Path to Arduino source (.ino or .cpp file)')
  .option('-b, --board <board>', 'Target board (e.g., arduino:avr:uno)', 'arduino:avr:uno')
  .option('--sdk-path <path>', 'Path to Arduino SDK')
  .option('--tools-path <path>', 'Path to additional tools')
  .option('--build-path <path>', 'Build output directory')
  .option('--libraries-path <path>', 'Additional libraries path', (val, libraries) => {
    libraries.push(val);
    return libraries;
  }, [])
  .option('--build-property <key=value>', 'Additional build property', (val, memo) => {
    const [key, value] = val.split('=');
    memo[key] = value;
    return memo;
  }, {})
  .option('--build-macros <macro[=value]>', 'Custom macro definitions (e.g., DEBUG, VERSION=1.0.0)', (val, memo) => {
    if (!memo) memo = [];
    memo.push(val);
    return memo;
  }, [])
  .option('--board-options <key=value>', 'Board menu option (e.g., flash=2097152_0, uploadmethod=default)', (val, memo) => {
    const [key, value] = val.split('=');
    memo[key] = value;
    return memo;
  }, {})
  .option('-j, --jobs <number>', 'Number of parallel compilation jobs', '4')
  .option('--verbose', 'Enable verbose output', false)
  .option('--log-file', 'Write logs to file in build directory', false)
  .option('--tool-versions <versions>', 'Specify tool versions (format: tool1@version1,tool2@version2)', undefined)
  .option('--preprocess-result <path>', 'Path to preprocess result JSON file (skip preprocessing if provided)')
  .option('--record-build-inputs', 'Record resolved configuration and successful build graph/recipe facts; requires --emit-artifact-manifest', false)
  .option('--archive-cloud-cache <path>', 'Local archive cloud cache directory')
  .option('--no-archive-cloud-cache', 'Disable archive cloud cache restore and generation')
  .option('--archive-cloud-cache-url <url>', 'Remote archive cloud cache base URL')
  .option('--no-fetch-archive-cloud-cache', 'Do not fetch compiled .a archives from remote cloud cache')
  .option('--archive-cloud-cache-local-only', 'Only use local archive cloud cache; do not request remote cache', false)
  .option('--generate-archive-cloud-cache', 'Generate uploadable archive cloud cache entries after successful builds', isTruthyEnv('AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE'))
  .option(
    '--emit-artifact-manifest [path]',
    'Emit a portable simulation artifact manifest (default: <build-path>/aily-artifact-manifest.json)'
  )
  .option(
    '--graph-semantic-revision <sha256>',
    'Bind the simulation Artifact to an exact Scene graph semantic revision'
  )
  .option(
    '--scene-document-schema-version <1|2>',
    'Record the Scene document schema compiled into the Artifact graph provenance'
  )
  .option(
    '--scene-gpio-directions <path>',
    'Read versioned firmware GPIO directions locked to the same Scene graph revision'
  )
  .option(
    '--scene-gpio-pulls <path>',
    'Read versioned firmware GPIO internal pulls locked to the same Scene graph revision'
  )
  .option(
    '--simulation-debug',
    'Compile source and library objects with source-level debug information',
    false
  )
  .action(async (sketch, options) => {
    // console.log('options:', options);
    logger.setVerbose(options.verbose);

    // 解析工具版本参数
    let toolVersions: Record<string, string> = {};
    if (options.toolVersions) {
      try {
        // 支持格式: tool1@version1,tool2@version2
        const versionPairs = options.toolVersions.split(',');
        for (const pair of versionPairs) {
          const trimmedPair = pair.trim();
          if (trimmedPair) {
            const [toolName, version] = trimmedPair.split('@');
            if (toolName && version) {
              toolVersions[toolName.trim()] = version.trim();
            } else {
              throw new Error(`Invalid tool version format: ${trimmedPair}. Expected format: tool@version`);
            }
          }
        }
        logger.verbose(`Parsed tool versions: ${JSON.stringify(toolVersions)}`);
      } catch (error) {
        logger.error(`Error parsing tool versions: ${error instanceof Error ? error.message : error}`);
        logger.error('Expected format: tool1@version1,tool2@version2');
        process.exit(1);
      }
    }

    if (options.archiveCloudCache === false) {
      process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE'] = '0';
    } else if (typeof options.archiveCloudCache === 'string') {
      process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE'] = '1';
      process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR'] = path.resolve(options.archiveCloudCache);
    }
    if (options.archiveCloudCacheUrl) {
      process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE_URL'] = options.archiveCloudCacheUrl;
    }
    if (options.fetchArchiveCloudCache === false || options.archiveCloudCacheLocalOnly) {
      process.env['AILY_BUILDER_FETCH_ARCHIVE_CLOUD_CACHE'] = '0';
      process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE_LOCAL_ONLY'] = '1';
    }
    if (options.generateArchiveCloudCache) {
      process.env['AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE'] = '1';
    }

    const compiler = new ArduinoCompiler(logger);

    // 设置默认的 build 路径到 AppData\Local\aily-builder\project\<sketchname>_<md5>
    const sketchPath = path.resolve(sketch);
    const sketchDirPath = path.dirname(sketchPath);
    const sketchName = getSourceBaseName(sketchPath);

    // 为了避免不同项目的同名sketch冲突，使用项目路径的MD5哈希值
    const defaultBuildPath = getDefaultBuildPath(sketchPath, sketchName);

    const buildPath = options.buildPath ? path.resolve(options.buildPath) : defaultBuildPath;
    const artifactManifestPath = options.emitArtifactManifest
      ? path.resolve(
        typeof options.emitArtifactManifest === 'string'
          ? options.emitArtifactManifest
          : path.join(buildPath, 'aily-artifact-manifest.json')
      )
      : undefined;
    if (options.graphSemanticRevision && !artifactManifestPath) {
      logger.error('--graph-semantic-revision requires --emit-artifact-manifest.');
      process.exit(1);
    }
    if (
      options.graphSemanticRevision
      && !/^[a-f0-9]{64}$/.test(options.graphSemanticRevision)
    ) {
      logger.error('--graph-semantic-revision must be a lowercase SHA-256 value.');
      process.exit(1);
    }
    const parsedSourceDocumentSchemaVersion =
      options.sceneDocumentSchemaVersion === undefined
        ? undefined
        : Number(options.sceneDocumentSchemaVersion);
    if (
      parsedSourceDocumentSchemaVersion !== undefined
      && parsedSourceDocumentSchemaVersion !== 1
      && parsedSourceDocumentSchemaVersion !== 2
    ) {
      logger.error('--scene-document-schema-version must be 1 or 2.');
      process.exit(1);
    }
    if (
      parsedSourceDocumentSchemaVersion !== undefined
      && !options.graphSemanticRevision
    ) {
      logger.error(
        '--scene-document-schema-version requires --graph-semantic-revision.',
      );
      process.exit(1);
    }
    const sourceDocumentSchemaVersion: 1 | 2 | undefined =
      parsedSourceDocumentSchemaVersion === 1
        ? 1
        : parsedSourceDocumentSchemaVersion === 2
          ? 2
          : undefined;
    let gpioDirections: Record<string, 'input' | 'output'> | undefined;
    if (options.sceneGpioDirections !== undefined) {
      if (!artifactManifestPath || !options.graphSemanticRevision) {
        logger.error(
          '--scene-gpio-directions requires --emit-artifact-manifest and --graph-semantic-revision.',
        );
        process.exit(1);
      }
      try {
        gpioDirections = await readSceneGpioDirectionsFile(
          options.sceneGpioDirections,
          options.graphSemanticRevision,
        );
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    }
    let gpioPulls: Record<string, 'up' | 'down'> | undefined;
    if (options.sceneGpioPulls !== undefined) {
      if (!artifactManifestPath || !options.graphSemanticRevision) {
        logger.error(
          '--scene-gpio-pulls requires --emit-artifact-manifest and --graph-semantic-revision.',
        );
        process.exit(1);
      }
      try {
        gpioPulls = await readSceneGpioPullsFile(
          options.sceneGpioPulls,
          options.graphSemanticRevision,
        );
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    }

    await runBuildCommand(buildPath, 'compile', async () => {
      // 如果启用了日志文件功能，设置日志文件路径
      if (options.logFile) {
        const logFilePath = path.join(buildPath, 'aily-builder.log');
        logger.setLogFile(logFilePath);
        logger.info(`Log file enabled: ${logFilePath}`);
      }

      // 检查是否提供了预处理结果文件
      let preprocessResult: PreprocessResult | undefined;
      if (options.preprocessResult) {
        const preprocessResultPath = path.resolve(options.preprocessResult);
        if (await fs.pathExists(preprocessResultPath)) {
          try {
            const preprocessData = await fs.readJson(preprocessResultPath);
            preprocessResult = preprocessData as PreprocessResult;
            // Cached environment must not redirect writes outside the directory
            // this command owns. Host preprocess caches are bound to that path.
            if (preprocessResult.envVars?.BUILD_PATH) assertBuildOutputPath(buildPath, preprocessResult.envVars.BUILD_PATH);
            logger.info(`Loaded preprocess result from: ${preprocessResultPath}`);
            logger.info(`Preprocess result contains ${preprocessResult.dependencies?.length || 0} dependencies`);
          
            // 恢复预处理时保存的环境变量（优先使用预处理结果中的环境变量）
            if (preprocessResult.envVars) {
              for (const [key, value] of Object.entries(preprocessResult.envVars)) {
                if (key.startsWith('AILY_BUILD_WORKSPACE_') || key === 'AILY_BUILDER_WORKSPACE') continue;
                process.env[key] = value;
                logger.verbose(`Restored env: ${key}=${value}`);
              }
              logger.info(`Restored ${Object.keys(preprocessResult.envVars).length} environment variables from preprocess result`);
            }

            // 在 Windows 上，将含非 ASCII 字符的路径替换为 junction 别名
            if (isWindowsHost()) {
              initShortPath();
              for (const key of Object.keys(process.env)) {
                if (process.env[key]) {
                  process.env[key] = sanitizeNonAsciiPaths(process.env[key]!);
                }
              }
            }
          } catch (error) {
            logger.error(`Failed to load preprocess result: ${error instanceof Error ? error.message : error}`);
            process.exitCode = 1;
            return;
          }
        } else {
          logger.error(`Preprocess result file not found: ${preprocessResultPath}`);
          process.exitCode = 1;
          return;
        }
      }

      // 设置基本环境变量（如果预处理结果中没有提供，则使用当前值）
      if (!process.env['SKETCH_NAME']) process.env['SKETCH_NAME'] = sketchName;
      if (!process.env['SKETCH_PATH']) process.env['SKETCH_PATH'] = sketchPath;
      if (!process.env['SKETCH_DIR_PATH']) process.env['SKETCH_DIR_PATH'] = sketchDirPath;
      process.env['BUILD_PATH'] = buildPath;
      if (!process.env['BUILD_JOBS']) process.env['BUILD_JOBS'] = options.jobs;

      // 如果命令行提供了这些参数，则覆盖预处理结果中的值
      if (options.sdkPath) {
        process.env['SDK_PATH'] = options.sdkPath;
      }

      if (options.toolsPath) {
        process.env['TOOLS_PATH'] = options.toolsPath;
      }
    
      setLibrariesPathEnvironment(options.librariesPath);

      const buildOptions = {
        sketchPath,
        sketchDirPath,
        board: options.board,
        buildPath: buildPath,
        librariesPath: options.librariesPath && options.librariesPath.length > 0
          ? options.librariesPath.map((libPath: string) => path.resolve(libPath))
          : [],
        buildProperties: {
          ...(options.buildProperty || {}),
          ...(options.boardOptions || {}) // 将 board-options 合并到 build-properties
        },
        buildMacros: options.buildMacros || [],
        toolVersions: toolVersions,
        jobs: parseInt(options.jobs),
        verbose: options.verbose,
        preprocessResult: preprocessResult,
        artifactManifestPath,
        graphSemanticRevision: options.graphSemanticRevision,
        sourceDocumentSchemaVersion,
        gpioDirections,
        gpioPulls,
        simulationDebug: options.simulationDebug,
        recordBuildInputs: options.recordBuildInputs,
      };

      logger.info(`Starting compilation of ${sketch}`);
      logger.info(`Board: ${options.board}`);
      logger.info(`Build path: ${buildOptions.buildPath}`);
      logger.info(`Libraries paths: ${buildOptions.librariesPath}`);
      if (options.boardOptions && Object.keys(options.boardOptions).length > 0) {
        logger.info(`Board options: ${JSON.stringify(options.boardOptions)}`);
      }
      if (options.buildProperty && Object.keys(options.buildProperty).length > 0) {
        logger.info(`Build properties: ${JSON.stringify(options.buildProperty)}`);
      }
      if (Object.keys(toolVersions).length > 0) {
        logger.info(`Tool versions: ${JSON.stringify(toolVersions)}`);
      }
      logger.info(`Parallel jobs: ${options.jobs}`);

      const result = await compiler.compile(buildOptions);

      if (result.success) {
        logger.success(`Compilation successful!`);
        logger.info(`Output File: ${result.outFilePath}`);
        if (result.artifactManifestPath) logger.info(`Artifact Manifest: ${result.artifactManifestPath}`);
      } else {
        logger.error(`Compilation failed: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      logger.info(`Preprocess time: ${result.preprocessTime / 1000}s`);
      logger.info(`Build time: ${result.buildTime / 1000}s`);
      logger.info(`Total time: ${result.totalTime / 1000}s`);

      // 执行缓存维护（在整个程序最后执行）
      try {
        logger.verbose('Performing cache maintenance...');
        const cacheManager = new CacheManager(logger);
        await cacheManager.maintainCache();
        logger.verbose('Cache maintenance completed');
      } catch (maintainError) {
        logger.debug(`Cache maintenance failed: ${maintainError instanceof Error ? maintainError.message : maintainError}`);
      }
    });
  });

program
  .command('preprocess')
  .description('Preprocess Arduino source without compilation (dependency analysis, config generation, prebuild hooks)')
  .argument('<sketch>', 'Path to Arduino source (.ino or .cpp file)')
  .option('-b, --board <board>', 'Target board (e.g., arduino:avr:uno)', 'arduino:avr:uno')
  .option('--sdk-path <path>', 'Path to Arduino SDK')
  .option('--tools-path <path>', 'Path to additional tools')
  .option('--build-path <path>', 'Build output directory')
  .option('--libraries-path <path>', 'Additional libraries path', (val, libraries) => {
    libraries.push(val);
    return libraries;
  }, [])
  .option('--build-property <key=value>', 'Additional build property', (val, memo) => {
    const [key, value] = val.split('=');
    memo[key] = value;
    return memo;
  }, {})
  .option('--build-macros <macro[=value]>', 'Custom macro definitions (e.g., DEBUG, VERSION=1.0.0)', (val, memo) => {
    if (!memo) memo = [];
    memo.push(val);
    return memo;
  }, [])
  .option('--board-options <key=value>', 'Board menu option (e.g., flash=2097152_0, uploadmethod=default)', (val, memo) => {
    const [key, value] = val.split('=');
    memo[key] = value;
    return memo;
  }, {})
  .option('--verbose', 'Enable verbose output', false)
  .option('--log-file', 'Write logs to file in build directory', false)
  .option('--tool-versions <versions>', 'Specify tool versions (format: tool1@version1,tool2@version2)', undefined)
  .option('--output-json', 'Output preprocess result as JSON', false)
  .option('--save-result <path>', 'Save full preprocess result to JSON file for later use with compile --preprocess-result')
  .addHelpText('after', `
Examples:
  # Basic preprocessing
  $ aily-builder preprocess sketch.ino --board arduino:avr:uno
  
  # With external libraries
  $ aily-builder preprocess sketch.ino --board esp32:esp32:esp32 --libraries-path "C:\\Arduino\\libraries"
  
  # Output as JSON for programmatic use
  $ aily-builder preprocess sketch.ino --board arduino:avr:uno --output-json
  
  # Save result for later compilation
  $ aily-builder preprocess sketch.ino --board arduino:avr:uno --save-result ./preprocess.json
  $ aily-builder compile sketch.ino --board arduino:avr:uno --preprocess-result ./preprocess.json
  
  # With SDK and tools paths
  $ aily-builder preprocess sketch.ino --sdk-path "C:\\sdk\\esp32" --tools-path "C:\\tools"

Preprocessing Steps:
  1. Validate sketch file
  2. Extract macros from sketch
  3. Parse board and platform configuration
  4. Prepare build directory
  5. Analyze dependencies
  6. Generate compile configuration
  7. Run prebuild hooks (if configured)

Note: This command only performs preprocessing without actual compilation.
      Use 'aily-builder compile' to perform full compilation.
  `)
  .action(async (sketch, options) => {
    logger.setVerbose(options.verbose);

    // 解析工具版本参数
    let toolVersions: Record<string, string> = {};
    if (options.toolVersions) {
      try {
        const versionPairs = options.toolVersions.split(',');
        for (const pair of versionPairs) {
          const trimmedPair = pair.trim();
          if (trimmedPair) {
            const [toolName, version] = trimmedPair.split('@');
            if (toolName && version) {
              toolVersions[toolName.trim()] = version.trim();
            } else {
              throw new Error(`Invalid tool version format: ${trimmedPair}. Expected format: tool@version`);
            }
          }
        }
        logger.verbose(`Parsed tool versions: ${JSON.stringify(toolVersions)}`);
      } catch (error) {
        logger.error(`Error parsing tool versions: ${error instanceof Error ? error.message : error}`);
        logger.error('Expected format: tool1@version1,tool2@version2');
        process.exit(1);
      }
    }

    const compiler = new ArduinoCompiler(logger);

    // 设置路径
    const sketchPath = path.resolve(sketch);
    const sketchDirPath = path.dirname(sketchPath);
    const sketchName = getSourceBaseName(sketchPath);

    const defaultBuildPath = getDefaultBuildPath(sketchPath, sketchName);

    const buildPath = options.buildPath ? path.resolve(options.buildPath) : defaultBuildPath;

    await runBuildCommand(buildPath, 'preprocess', async () => {
      // 如果启用了日志文件功能，设置日志文件路径
      if (options.logFile) {
        const logFilePath = path.join(buildPath, 'aily-preprocess.log');
        logger.setLogFile(logFilePath);
        logger.info(`Log file enabled: ${logFilePath}`);
      }

      // 设置环境变量
      process.env['SKETCH_NAME'] = sketchName;
      process.env['SKETCH_PATH'] = sketchPath;
      process.env['SKETCH_DIR_PATH'] = sketchDirPath;
      process.env['BUILD_PATH'] = buildPath;

      if (options.sdkPath) {
        process.env['SDK_PATH'] = options.sdkPath;
      }

      if (options.toolsPath) {
        process.env['TOOLS_PATH'] = options.toolsPath;
      }

      setLibrariesPathEnvironment(options.librariesPath);

      const preprocessOptions = {
        sketchPath,
        sketchDirPath,
        board: options.board,
        buildPath: buildPath,
        librariesPath: options.librariesPath && options.librariesPath.length > 0
          ? options.librariesPath.map((libPath: string) => path.resolve(libPath))
          : [],
        buildProperties: {
          ...(options.buildProperty || {}),
          ...(options.boardOptions || {})
        },
        buildMacros: options.buildMacros || [],
        toolVersions: toolVersions,
        verbose: options.verbose
      };

      if (!options.outputJson) {
        logger.info(`Starting preprocessing of ${sketch}`);
        logger.info(`Board: ${options.board}`);
        logger.info(`Build path: ${buildPath}`);
        if (options.librariesPath && options.librariesPath.length > 0) {
          logger.info(`Libraries paths: ${options.librariesPath.join(', ')}`);
        }
        if (options.boardOptions && Object.keys(options.boardOptions).length > 0) {
          logger.info(`Board options: ${JSON.stringify(options.boardOptions)}`);
        }
        if (options.buildProperty && Object.keys(options.buildProperty).length > 0) {
          logger.info(`Build properties: ${JSON.stringify(options.buildProperty)}`);
        }
        if (Object.keys(toolVersions).length > 0) {
          logger.info(`Tool versions: ${JSON.stringify(toolVersions)}`);
        }
      }

      const result = await compiler.preprocess(preprocessOptions);

      // 保存完整的预处理结果到文件（用于后续编译）
      if (options.saveResult && result.success) {
        const saveResultPath = path.resolve(options.saveResult);
        try {
          await fs.ensureDir(path.dirname(saveResultPath));
          await fs.writeJson(saveResultPath, result, { spaces: 2 });
          logger.success(`Preprocess result saved to: ${saveResultPath}`);
          logger.info(`Use with: aily-builder compile sketch.ino --preprocess-result "${saveResultPath}"`);
        } catch (error) {
          logger.error(`Failed to save preprocess result: ${error instanceof Error ? error.message : error}`);
          process.exitCode = 1;
          return;
        }
      }

      if (options.outputJson) {
        // 输出 JSON 格式结果（用于程序化调用）
        const jsonOutput = {
          success: result.success,
          preprocessTime: result.preprocessTime,
          dependencyCount: result.dependencies?.length || 0,
          dependencies: result.dependencies?.map(dep => dep.name) || [],
          error: result.error
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
      } else {
        if (result.success) {
          logger.success(`Preprocessing completed successfully!`);
          logger.info(`Dependencies found: ${result.dependencies?.length || 0}`);
          logger.info(`Preprocess time: ${result.preprocessTime / 1000}s`);
        } else {
          logger.error(`Preprocessing failed: ${result.error}`);
          process.exitCode = 1;
          return;
        }
      }

      process.exitCode = result.success ? 0 : 1;
    });
  });

program
  .command('clean')
  .description('Clean build artifacts')
  .argument('[build-path]', 'Build directory to clean', './build')
  .action(async (buildPath) => {
    try {
      const compiler = new ArduinoCompiler(logger);
      await compiler.clean(path.resolve(buildPath));
      logger.success('Build artifacts cleaned!');
    } catch (error) {
      logger.error(`Error cleaning: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

program
  .command('upload')
  .description('Upload firmware to Arduino board')
  .option('-b, --board <board>', 'Target board (e.g., arduino:avr:uno)', 'arduino:avr:uno')
  .option('-p, --port <port>', 'Serial port for upload (e.g., COM3 or /dev/ttyUSB0)', undefined)
  .option('-f, --file <file>', 'Firmware file path to upload (.hex or .bin)', undefined)
  .option('--verbose', 'Enable verbose output', false)
  .option('--log-file', 'Write logs to file in current directory', false)
  .option('--build-property <key=value>', 'Additional build property', (val, memo) => {
    const [key, value] = val.split('=');
    memo[key] = value;
    return memo;
  }, {})
  .action(async (options) => {
    logger.setVerbose(options.verbose);

    // 如果启用了日志文件功能，设置日志文件路径
    if (options.logFile) {
      const logFilePath = path.join(process.cwd(), 'aily-upload.log');
      logger.setLogFile(logFilePath);
      logger.info(`Log file enabled: ${logFilePath}`);
    }

    // 验证必需参数
    if (!options.port) {
      logger.error('Port parameter is required. Use -p or --port to specify the serial port.');
      process.exit(1);
    }

    if (!options.file) {
      logger.error('File parameter is required. Use -f or --file to specify the firmware file path.');
      process.exit(1);
    }

    const uploader = new ArduinoUploader(logger);

    const uploadOptions = {
      board: options.board,
      port: options.port,
      filePath: path.resolve(options.file),
      buildProperties: options.buildProperty || {},
      verbose: options.verbose
    };

    logger.info(`Starting upload to ${options.board}`);
    logger.info(`Port: ${options.port}`);
    logger.info(`File: ${uploadOptions.filePath}`);
    if (Object.keys(uploadOptions.buildProperties).length > 0) {
      logger.info(`Build properties: ${JSON.stringify(uploadOptions.buildProperties)}`);
    }

    const result = await uploader.upload(uploadOptions);

    if (result.success) {
      logger.success(`Upload completed successfully!`);
      logger.info(`Upload time: ${result.uploadTime / 1000}s`);
      if (result.output && options.verbose) {
        logger.verbose(`Upload output: ${result.output}`);
      }
    } else {
      logger.error(`Upload failed: ${result.error}`);
      if (result.output && options.verbose) {
        logger.verbose(`Upload output: ${result.output}`);
      }
      process.exit(1);
    }
  });

program
  .command('cache')
  .description('Manage persistent caches')
  .addCommand(
    new Command('stats')
      .description('Show statistics for all persistent caches')
      .option('--json', 'Output machine-readable JSON', false)
      .option('--verbose', 'Show cache descriptions and oldest access times', false)
      .action(async (options) => {
        try {
          logger.setVerbose(options.verbose);
          const registry = new CacheRegistry(logger);
          const report = await registry.getStats();

          if (options.json) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            printCacheStats(report, options.verbose);
          }
        } catch (error) {
          logger.error(`Error getting cache stats: ${error instanceof Error ? error.message : error}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('clear')
      .description('Clear persistent caches')
      .option('--all', 'Clear every persistent cache entry', false)
      .option('--unused-30', 'Clear entries not used in the last 30 days', false)
      .option('--unused-7', 'Clear entries not used in the last 7 days', false)
      .option('--dry-run', 'Show what would be deleted without deleting files', false)
      .option('--json', 'Output machine-readable JSON', false)
      .addHelpText('after', `
Examples:
  $ aily-builder cache clear --all
  $ aily-builder cache clear --unused-30
  $ aily-builder cache clear --unused-7 --dry-run
`)
      .action(async (options) => {
        try {
          const clearMode = resolveCacheClearMode(options);
          const registry = new CacheRegistry(logger);
          const report = await registry.clear(clearMode, options.dryRun);

          if (options.json) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            printCacheClearReport(report);
          }
        } catch (error) {
          logger.error(`Error clearing cache: ${error instanceof Error ? error.message : error}`);
          process.exit(1);
        }
      })
  );

// 错误处理
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
  process.exit(1);
});

program.parse();
