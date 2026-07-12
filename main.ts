#!/usr/bin/env node
import { Command } from 'commander';
import { ArduinoCompiler, PreprocessResult } from './src/ArduinoCompiler';
import { ArduinoUploader } from './src/ArduinoUploader';
import { Logger } from './src/utils/Logger';
import { CacheManager } from './src/CacheManager';
import { CacheClearMode, CacheRegistry, CacheStatsReport, CacheClearReport } from './src/CacheRegistry';
import { calculateMD5 } from './src/utils/md5';
import { initShortPath, sanitizeNonAsciiPaths } from './src/utils/ShortPath';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

const program = new Command();
const logger = new Logger();

function isTruthyEnv(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value?.toLowerCase() === 'true';
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
  .version('1.2.4');

program
  .command('compile')
  .description('Compile Arduino sketch')
  .argument('<sketch>', 'Path to Arduino sketch (.ino file)')
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
  .option('--archive-cloud-cache <path>', 'Local archive cloud cache directory')
  .option('--no-archive-cloud-cache', 'Disable archive cloud cache restore and generation')
  .option('--archive-cloud-cache-url <url>', 'Remote archive cloud cache base URL')
  .option('--no-fetch-archive-cloud-cache', 'Do not fetch compiled .a archives from remote cloud cache')
  .option('--archive-cloud-cache-local-only', 'Only use local archive cloud cache; do not request remote cache', false)
  .option('--generate-archive-cloud-cache', 'Generate uploadable archive cloud cache entries after successful builds', isTruthyEnv('AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE'))
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
    const sketchName = path.basename(sketchPath, '.ino');

    // 为了避免不同项目的同名sketch冲突，使用项目路径的MD5哈希值
    const projectPathMD5 = calculateMD5(sketchPath).substring(0, 8); // 只取前8位MD5值
    const uniqueSketchName = `${sketchName}_${projectPathMD5}`;
    // 修复默认构建路径，使其在不同操作系统上都能正常工作
    const defaultBuildPath = path.join(
      os.platform() === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local')
        : path.join(os.homedir(), 'Library'),
      'aily-builder',
      'project',
      uniqueSketchName
    );

    const buildPath = options.buildPath ? path.resolve(options.buildPath) : defaultBuildPath;

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
          logger.info(`Loaded preprocess result from: ${preprocessResultPath}`);
          logger.info(`Preprocess result contains ${preprocessResult.dependencies?.length || 0} dependencies`);
          
          // 恢复预处理时保存的环境变量（优先使用预处理结果中的环境变量）
          if (preprocessResult.envVars) {
            for (const [key, value] of Object.entries(preprocessResult.envVars)) {
              process.env[key] = value;
              logger.verbose(`Restored env: ${key}=${value}`);
            }
            logger.info(`Restored ${Object.keys(preprocessResult.envVars).length} environment variables from preprocess result`);
          }

          // 在 Windows 上，将含非 ASCII 字符的路径替换为 junction 别名
          if (os.platform() === 'win32') {
            initShortPath();
            for (const key of Object.keys(process.env)) {
              if (process.env[key]) {
                process.env[key] = sanitizeNonAsciiPaths(process.env[key]!);
              }
            }
          }
        } catch (error) {
          logger.error(`Failed to load preprocess result: ${error instanceof Error ? error.message : error}`);
          process.exit(1);
        }
      } else {
        logger.error(`Preprocess result file not found: ${preprocessResultPath}`);
        process.exit(1);
      }
    }

    // 设置基本环境变量（如果预处理结果中没有提供，则使用当前值）
    if (!process.env['SKETCH_NAME']) process.env['SKETCH_NAME'] = sketchName;
    if (!process.env['SKETCH_PATH']) process.env['SKETCH_PATH'] = sketchPath;
    if (!process.env['SKETCH_DIR_PATH']) process.env['SKETCH_DIR_PATH'] = sketchDirPath;
    if (!process.env['BUILD_PATH']) process.env['BUILD_PATH'] = buildPath;
    if (!process.env['BUILD_JOBS']) process.env['BUILD_JOBS'] = options.jobs;

    // 如果命令行提供了这些参数，则覆盖预处理结果中的值
    if (options.sdkPath) {
      process.env['SDK_PATH'] = options.sdkPath;
    }

    if (options.toolsPath) {
      process.env['TOOLS_PATH'] = options.toolsPath;
    }
    
    // 修复 libraries path 处理
    if (options.librariesPath && options.librariesPath.length > 0) {
      // console.log('Setting LIBRARIES_PATH to:', options.librariesPath);
      // 将多个路径用分号分隔（Windows）或冒号分隔（Unix）
      const pathSeparator = os.platform() === 'win32' ? ';' : ':';
      const resolvedPaths = options.librariesPath.map((libPath: string) => path.resolve(libPath));
      process.env['LIBRARIES_PATH'] = resolvedPaths.join(pathSeparator);
    }

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
      preprocessResult: preprocessResult
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
    } else {
      logger.error(`Compilation failed: ${result.error}`);
      process.exit(1);
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

program
  .command('preprocess')
  .description('Preprocess Arduino sketch without compilation (dependency analysis, config generation, prebuild hooks)')
  .argument('<sketch>', 'Path to Arduino sketch (.ino file)')
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
    const sketchName = path.basename(sketchPath, '.ino');

    const projectPathMD5 = calculateMD5(sketchPath).substring(0, 8);
    const uniqueSketchName = `${sketchName}_${projectPathMD5}`;
    const defaultBuildPath = path.join(
      os.platform() === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local')
        : path.join(os.homedir(), 'Library'),
      'aily-builder',
      'project',
      uniqueSketchName
    );

    const buildPath = options.buildPath ? path.resolve(options.buildPath) : defaultBuildPath;

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

    if (options.librariesPath && options.librariesPath.length > 0) {
      const pathSeparator = os.platform() === 'win32' ? ';' : ':';
      const resolvedPaths = options.librariesPath.map((libPath: string) => path.resolve(libPath));
      process.env['LIBRARIES_PATH'] = resolvedPaths.join(pathSeparator);
    }

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
        process.exit(1);
      }
    }

    process.exit(result.success ? 0 : 1);
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
