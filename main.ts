#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { ArduinoCompiler } from './src/ArduinoCompiler';
import { Logger } from './src/utils/Logger';
import { CacheManager } from './src/CacheManager';
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
  .option('--build-path <path>', 'Build output directory')
  .option('--libraries-path <path>', 'Additional libraries path')
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

    // 设置默认的 build 路径为 sketch 所在目录下的 build 目录
    const sketchPath = path.resolve(sketch);
    const sketchDirPath = path.dirname(sketchPath);
    const defaultBuildPath = path.join(sketchDirPath, 'build');

    process.env['SKETCH_NAME'] = path.basename(sketchPath, '.ino');
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
    if (options.librariesPath) {
      process.env['LIBRARIES_PATH'] = path.resolve(options.librariesPath);
    }

    const buildOptions = {
      sketchPath,
      sketchDirPath,
      board: options.board,
      buildPath: options.buildPath ? path.resolve(options.buildPath) : defaultBuildPath,
      librariesPath: options.librariesPath ? path.resolve(options.librariesPath) : '',
      jobs: parseInt(options.jobs),
      verbose: options.verbose,
      useSccache: options.useSccache
    };

    logger.info(chalk.blue(`🚀 Starting compilation of ${sketch}`));
    logger.info(chalk.gray(`Board: ${options.board}`));
    logger.info(chalk.gray(`Build path: ${buildOptions.buildPath}`));
    logger.info(chalk.gray(`Parallel jobs: ${options.jobs}`));
    logger.info(chalk.gray(`Build system: ${useNinja ? 'ninja' : 'legacy parallel'}`));
    // logger.info(chalk.gray(`buildOptions: ${JSON.stringify(buildOptions, null, 2)}`));

    const result = await compiler.compile(buildOptions);

    if (result.success) {
      logger.success(chalk.green(`✅ Compilation successful!`));
      logger.info(chalk.gray(`Output File: ${result.outFilePath}`));
    } else {
      logger.error(chalk.red(`❌ Compilation failed: ${result.error}`));
      process.exit(1);
    }
    logger.info(chalk.gray(`Preprocess time: ${result.preprocessTime / 1000}s`));
    logger.info(chalk.gray(`Build time: ${result.buildTime / 1000}s`));
    logger.info(chalk.gray(`Total time: ${result.totalTime / 1000}s`));
  });

program
  .command('init')
  .description('Initialize aily configuration')
  .option('--arduino-path <path>', 'Path to Arduino IDE installation')
  .option('--libraries-path <path>', 'Path to Arduino libraries')
  .action(async (options) => {
    try {
      logger.success(chalk.green('✅ Configuration initialized successfully!'));
    } catch (error) {
      logger.error(chalk.red(`❌ Error initializing config: ${error instanceof Error ? error.message : error}`));
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
      logger.success(chalk.green('✅ Build artifacts cleaned!'));
    } catch (error) {
      logger.error(chalk.red(`❌ Error cleaning: ${error instanceof Error ? error.message : error}`));
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
          
          logger.info(chalk.blue('📊 Cache Statistics:'));
          logger.info(chalk.gray(`Cache directory: ${stats.cacheDir}`));
          logger.info(chalk.gray(`Total files: ${stats.totalFiles}`));
          logger.info(chalk.gray(`Total size: ${stats.totalSizeFormatted}`));
          
          if (stats.totalFiles === 0) {
            logger.info(chalk.yellow('No cached files found.'));
          }
        } catch (error) {
          logger.error(chalk.red(`❌ Error getting cache stats: ${error instanceof Error ? error.message : error}`));
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
            logger.info(chalk.blue('🗑️  Clearing all cache files...'));
            await cacheManager.clearAllCache();
            logger.success(chalk.green('✅ All cache files cleared!'));
          } else {
            const clearOptions: any = {};
            if (options.olderThan) {
              clearOptions.olderThanDays = parseInt(options.olderThan);
            }
            if (options.pattern) {
              clearOptions.pattern = options.pattern;
            }
            
            logger.info(chalk.blue('🗑️  Clearing cache files...'));
            await cacheManager.clearCache(clearOptions);
            logger.success(chalk.green('✅ Cache files cleared!'));
          }
        } catch (error) {
          logger.error(chalk.red(`❌ Error clearing cache: ${error instanceof Error ? error.message : error}`));
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
      
      console.log(chalk.blue('\n📊 Cache Statistics:'));
      console.log(`   Files: ${chalk.yellow(stats.totalFiles.toString())}`);
      console.log(`   Size: ${chalk.yellow(stats.totalSizeFormatted)}`);
      console.log(`   Location: ${chalk.gray(stats.cacheDir)}`);
      
      if (stats.totalFiles > 0) {
        const avgSize = stats.totalSize / stats.totalFiles;
        console.log(`   Average file size: ${chalk.cyan((avgSize / 1024).toFixed(1))} KB`);
      }
      
      console.log(chalk.green('\n✅ Cache statistics displayed successfully'));
    } catch (error) {
      logger.error(chalk.red(`❌ Error getting cache statistics: ${error instanceof Error ? error.message : error}`));
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
      
      console.log(chalk.blue(`\n🧹 Cleaning cache files older than ${days} days...`));
      if (options.pattern) {
        console.log(chalk.gray(`   Pattern: ${options.pattern}`));
      }
      if (options.dryRun) {
        console.log(chalk.yellow('   (Dry run - no files will be deleted)'));
      }
      
      if (!options.dryRun) {
        await cacheManager.clearCache({
          olderThanDays: days,
          pattern: options.pattern
        });
      } else {
        // 对于dry run，我们只显示统计信息
        const stats = await cacheManager.getCacheStats();
        console.log(chalk.gray(`   Would analyze ${stats.totalFiles} files in cache`));
      }
      
      console.log(chalk.green('\n✅ Cache cleaning completed'));
    } catch (error) {
      logger.error(chalk.red(`❌ Error cleaning cache: ${error instanceof Error ? error.message : error}`));
      process.exit(1);
    }
  });

// 错误处理
process.on('uncaughtException', (error) => {
  logger.error(chalk.red(`❌ Uncaught exception: ${error.message}`));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(chalk.red(`❌ Unhandled rejection: ${reason}`));
  process.exit(1);
});

program.parse();