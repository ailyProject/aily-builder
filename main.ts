#!/usr/bin/env node

import { Command } from 'commander';
import { ArduinoCompiler } from './src/ArduinoCompiler';
import { Logger } from './src/utils/Logger';
import { CacheManager } from './src/CacheManager';
import { calculateMD5 } from './src/utils/md5';
import path from 'path';
import os from 'os';

const program = new Command();
const logger = new Logger();

program
  .name('aily')
  .description('Fast Arduino compilation CLI tool with optimized preprocessing and parallel compilation')
  .version('1.0.0');

program
  .command('compile')
  .description('Compile Arduino sketch')
  .argument('<sketch>', 'Path to Arduino sketch (.ino file)')
  .option('-b, --board <board>', 'Target board (e.g., arduino:avr:uno)', 'arduino:avr:uno')
  .option('-p, --port <port>', 'Serial port for upload')
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
  .option('-j, --jobs <number>', 'Number of parallel compilation jobs', (os.cpus().length + 1).toString())
  .option('--verbose', 'Enable verbose output', false)
  .option('--use-sccache', 'Use sccache for compilation caching', true)
  .option('--use-ninja', 'Use ninja build system (default: true)', true)
  .option('--use-legacy', 'Use legacy parallel compilation instead of ninja', false)
  .option('--no-cache', 'Disable compilation cache', false)
  .option('--clean-cache', 'Clean cache before compilation', false)
  .action(async (sketch, options) => {
    console.log('options:', options);

    logger.setVerbose(options.verbose);

    // 确定使用的编译方式
    const useNinja = options.useLegacy ? false : options.useNinja;

    const compiler = new ArduinoCompiler(logger, { useNinja });

    // 设置默认的 build 路径到 AppData\Local\aily-builder\project\<sketchname>_<md5>
    const sketchPath = path.resolve(sketch);
    const sketchDirPath = path.dirname(sketchPath);
    const sketchName = path.basename(sketchPath, '.ino');
    
    // 为了避免不同项目的同名sketch冲突，使用项目路径的MD5哈希值
    const projectPathMD5 = calculateMD5(sketchDirPath).substring(0, 8); // 只取前8位MD5值
    const uniqueSketchName = `${sketchName}_${projectPathMD5}`;
    const defaultBuildPath = path.join(os.homedir(), 'AppData', 'Local', 'aily-builder', 'project', uniqueSketchName);

    process.env['SKETCH_NAME'] = sketchName;
    process.env['SKETCH_PATH'] = sketchPath;
    process.env['SKETCH_DIR_PATH'] = sketchDirPath;
    process.env['BUILD_PATH'] = options.buildPath ? path.resolve(options.buildPath) : defaultBuildPath;
    process.env['BUILD_JOBS'] = options.jobs;
    process.env['USE_SCCACHE'] = options.useSccache;

    if (options.sdkPath) {
      process.env['SDK_PATH'] = options.sdkPath;
    }

    if (options.toolsPath) {
      process.env['TOOLS_PATH'] = options.toolsPath;
    }
    // 修复 libraries path 处理
    if (options.librariesPath && options.librariesPath.length > 0) {
      console.log('Setting LIBRARIES_PATH to:', options.librariesPath);
      // 将多个路径用分号分隔（Windows）或冒号分隔（Unix）
      const pathSeparator = os.platform() === 'win32' ? ';' : ':';
      const resolvedPaths = options.librariesPath.map((libPath: string) => path.resolve(libPath));
      process.env['LIBRARIES_PATH'] = resolvedPaths.join(pathSeparator);
    }

    const buildOptions = {
      sketchPath,
      sketchDirPath,
      board: options.board,
      buildPath: options.buildPath ? path.resolve(options.buildPath) : defaultBuildPath,
      librariesPath: options.librariesPath && options.librariesPath.length > 0 
        ? options.librariesPath.map((libPath: string) => path.resolve(libPath)) 
        : [],
      buildProperties: options.buildProperty || {},
      jobs: parseInt(options.jobs),
      verbose: options.verbose,
      useSccache: options.useSccache
    };

    logger.info(`🚀 Starting compilation of ${sketch}`);
    logger.info(`Board: ${options.board}`);
    logger.info(`Build path: ${buildOptions.buildPath}`);
    logger.info(`Libraries paths: ${JSON.stringify(buildOptions.librariesPath)}`);
    logger.info(`buildProperties: ${JSON.stringify(buildOptions.buildProperties)}`);
    logger.info(`Parallel jobs: ${options.jobs}`);
    logger.info(`Build system: ${useNinja ? 'ninja' : 'legacy parallel'}`);
    // logger.info(`buildOptions: ${JSON.stringify(buildOptions, null, 2)}`);

    const result = await compiler.compile(buildOptions);

    if (result.success) {
      logger.success(`Compilation successful!`);
      logger.info(`Output File: ${result.outFilePath}`);
    } else {
      logger.error(`❌ Compilation failed: ${result.error}`);
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
      logger.warn(`Cache maintenance failed: ${maintainError instanceof Error ? maintainError.message : maintainError}`);
    }
  });

program
  .command('init')
  .description('Initialize aily configuration')
  .option('--arduino-path <path>', 'Path to Arduino IDE installation')
  .option('--libraries-path <path>', 'Path to Arduino libraries')
  .action(async (options) => {
    try {
      logger.success('Configuration initialized successfully!');
    } catch (error) {
      logger.error(`❌ Error initializing config: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
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
      logger.error(`❌ Error cleaning: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

program
  .command('cache')
  .description('Manage compilation cache')
  .addCommand(
    new Command('stats')
      .description('Show cache statistics')
      .action(async () => {
        try {
          const cacheManager = new CacheManager(logger);
          const stats = await cacheManager.getCacheStats();
          
          logger.info('📊 Cache Statistics:');
          logger.info(`Cache directory: ${stats.cacheDir}`);
          logger.info(`Total files: ${stats.totalFiles}`);
          logger.info(`Total size: ${stats.totalSizeFormatted}`);
          
          if (stats.totalFiles === 0) {
            logger.info('No cached files found.');
          }
        } catch (error) {
          logger.error(`❌ Error getting cache stats: ${error instanceof Error ? error.message : error}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('clear')
      .description('Clear compilation cache')
      .option('--older-than <days>', 'Clear files older than specified days', undefined)
      .option('--pattern <pattern>', 'Clear files matching pattern', undefined)
      .option('--all', 'Clear all cached files', false)
      .action(async (options) => {
        try {
          const cacheManager = new CacheManager(logger);
          
          if (options.all) {
            logger.info('🗑️  Clearing all cache files...');
            await cacheManager.clearAllCache();
            logger.success('All cache files cleared!');
          } else {
            const clearOptions: any = {};
            if (options.olderThan) {
              clearOptions.olderThanDays = parseInt(options.olderThan);
            }
            if (options.pattern) {
              clearOptions.pattern = options.pattern;
            }
            
            logger.info('🗑️  Clearing cache files...');
            await cacheManager.clearCache(clearOptions);
            logger.success('Cache files cleared!');
          }
        } catch (error) {
          logger.error(`❌ Error clearing cache: ${error instanceof Error ? error.message : error}`);
          process.exit(1);
        }
      })
  );

// 缓存统计命令
program
  .command('cache-stats')
  .description('Display cache statistics')
  .option('--verbose', 'Enable verbose output', false)
  .action(async (options) => {
    try {
      logger.setVerbose(options.verbose);
      const cacheManager = new CacheManager(logger);
      
      const stats = await cacheManager.getCacheStats();
      
      console.log('\n📊 Cache Statistics:');
      console.log(`   Files: ${stats.totalFiles.toString()}`);
      console.log(`   Size: ${stats.totalSizeFormatted}`);
      console.log(`   Location: ${stats.cacheDir}`);
      
      if (stats.totalFiles > 0) {
        const avgSize = stats.totalSize / stats.totalFiles;
        console.log(`   Average file size: ${(avgSize / 1024).toFixed(1)} KB`);
      }
      
      console.log('\nCache statistics displayed successfully');
    } catch (error) {
      logger.error(`❌ Error getting cache statistics: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// 缓存维护命令
program
  .command('cache-clean')
  .description('Clean old cache files')
  .option('--days <number>', 'Remove cache files older than specified days', '30')
  .option('--pattern <pattern>', 'Only remove files matching pattern')
  .option('--dry-run', 'Show what would be deleted without actually deleting', false)
  .option('--verbose', 'Enable verbose output', false)
  .action(async (options) => {
    try {
      logger.setVerbose(options.verbose);
      const cacheManager = new CacheManager(logger);
      
      const days = parseInt(options.days);
      if (isNaN(days) || days < 0) {
        throw new Error('Days must be a non-negative number');
      }
      
      console.log(`\n🧹 Cleaning cache files older than ${days} days...`);
      if (options.pattern) {
        console.log(`   Pattern: ${options.pattern}`);
      }
      if (options.dryRun) {
        console.log('   (Dry run - no files will be deleted)');
      }
      
      if (!options.dryRun) {
        await cacheManager.clearCache({
          olderThanDays: days,
          pattern: options.pattern
        });
      } else {
        // 对于dry run，我们只显示统计信息
        const stats = await cacheManager.getCacheStats();
        console.log(`   Would analyze ${stats.totalFiles} files in cache`);
      }
      
      console.log('\nCache cleaning completed');
    } catch (error) {
      logger.error(`❌ Error cleaning cache: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

// 错误处理
process.on('uncaughtException', (error) => {
  logger.error(`❌ Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`❌ Unhandled rejection: ${reason}`);
  process.exit(1);
});

program.parse();