import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';
import { Logger } from './utils/Logger';
import { Dependency } from './DependencyAnalyzer';
import { CacheManager, CacheKey } from './CacheManager';
import { NinjaGenerator, NinjaOptions } from './NinjaGenerator';

export interface NinjaPipelineOptions {
  dependencies: Dependency[];
  compileConfig: any;
}

export interface NinjaCompilationResult {
  success: boolean;
  outFilePath?: string;
  warnings?: string[];
  buildTime?: number;
}

export class NinjaCompilationPipeline {
  private logger: Logger;
  private dependencies: Dependency[];
  private compileConfig: any;
  private cacheManager: CacheManager;
  private ninjaGenerator: NinjaGenerator;

  constructor(logger: Logger) {
    this.logger = logger;
    this.cacheManager = new CacheManager(logger);
    this.ninjaGenerator = new NinjaGenerator(logger);
  }

  async compile({ dependencies, compileConfig }: NinjaPipelineOptions): Promise<NinjaCompilationResult> {
    this.dependencies = dependencies;
    this.compileConfig = compileConfig;

    try {
      const startTime = Date.now();

      // 1. 预处理：从缓存中恢复对象文件
      this.logger.verbose('Checking cache for compiled objects...');
      const cacheHits = await this.restoreFromCache(dependencies);
      // if (cacheHits > 0) {
      //   this.logger.info(`Cache hit: ${cacheHits} objects restored from cache`);
      // }

      // 2. 生成ninja构建文件
      this.logger.verbose('Generating ninja build file...');
      const ninjaOptions: NinjaOptions = {
        dependencies,
        compileConfig,
        buildPath: process.env['BUILD_PATH'] || '',
        jobs: parseInt(process.env['BUILD_JOBS'] || '4'),
        skipExistingObjects: true // 启用增量构建
      };

      const ninjaFilePath = await this.ninjaGenerator.generateNinjaFile(ninjaOptions);
      this.logger.verbose(`Ninja file generated: ${ninjaFilePath}`);

      // 3. 执行ninja构建
      this.logger.info('Starting ninja build...');
      const result = await this.executeNinjaBuild(ninjaFilePath);

      const buildTime = Date.now() - startTime;

      if (result.success) {

        // 显示缓存统计信息
        // await this.showCacheStats();

        // 确定输出文件路径
        const sketchName = process.env['SKETCH_NAME'] || 'sketch';
        const buildPath = process.env['BUILD_PATH'] || '';
        let outFilePath: string;

        if (this.compileConfig.args.hex) {
          outFilePath = path.join(buildPath, `${sketchName}.hex`);
        } else if (this.compileConfig.compiler.bin) {
          outFilePath = path.join(buildPath, `${sketchName}.bin`);
        } else {
          outFilePath = path.join(buildPath, `${sketchName}.elf`);
        }

        return {
          success: true,
          outFilePath,
          buildTime,
          warnings: result.warnings
        };
      } else {
        return {
          success: false,
          warnings: result.warnings
        };
      }
    } catch (error) {
      this.logger.error(`Ninja compilation failed: ${error instanceof Error ? error.message : error}`);
      return {
        success: false,
        warnings: [`Compilation error: ${error instanceof Error ? error.message : error}`]
      };
    }
  }

  private async executeNinjaBuild(ninjaFilePath: string): Promise<{ success: boolean; warnings?: string[] }> {
    return new Promise((resolve, reject) => {
      const ninjaPath = this.getNinjaExecutablePath();
      const buildDir = path.dirname(ninjaFilePath);
      const jobs = parseInt(process.env['BUILD_JOBS'] || '4');

      const args = [
        '-f', path.basename(ninjaFilePath),
        '-j', jobs.toString(),
        '-v' // verbose模式显示执行的命令
      ];

      this.logger.verbose(`Executing: ${ninjaPath} ${args.join(' ')}`);
      this.logger.verbose(`Working directory: ${buildDir}`);

      const childProcess = spawn(ninjaPath, args, {
        cwd: buildDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: [
            process.env['COMPILER_PATH'],
            process.env['ESPTOOL_PY_PATH'],
            process.env['PATH']
          ].filter(Boolean).join(path.delimiter)
        }
      });

      let stdout = '';
      let stderr = '';
      const warnings: string[] = [];
      let isInFailureMode = false; // 标识是否处于失败模式

      childProcess.stdout?.on('data', (data: any) => {
        const output = data.toString('utf8');
        stdout += output;

        // 实时输出编译信息
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            if (/\[\d+\/\d+\]/.test(line)) {
              // 这是ninja的进度信息，重置失败模式
              isInFailureMode = false;
              this.logger.info(line.trim());
              // 检查是否是编译完成的消息，立即存储到缓存
              this.handleCompilationProgress(line.trim(), buildDir);
            } else if (line.startsWith('FAILED:')) {
              // 编译失败信息，进入失败模式
              isInFailureMode = true;
              this.logger.error(line.trim());
            } else if (isInFailureMode) {
              // 在失败模式下，所有后续行都作为错误信息
              // 但隐藏 ninja 的构建停止消息
              if (line.includes('ninja: build stopped') || line.includes('subcommand failed')) {
                isInFailureMode = false;
                // 不输出这个消息，只是退出失败模式
              } else {
                this.logger.error(line.trim());
              }
            } else {
              // 其他输出
              this.logger.verbose(line.trim());
            }
          }
        }
      });

      childProcess.stderr?.on('data', (data: any) => {
        const output = data.toString('utf8');
        stderr += output;

        // 检查是否是警告
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            if (line.toLowerCase().includes('warning')) {
              warnings.push(line.trim());
              this.logger.debug(line.trim());
            } else {
              this.logger.error(line.trim());
            }
          }
        }
      });

      childProcess.on('close', (code) => {
        if (code === 0) {
          this.logger.info('Ninja build completed successfully');
          resolve({ success: true, warnings: warnings.length > 0 ? warnings : undefined });
        } else {
          // this.logger.error(`Ninja build failed with exit code ${code}`);
          // if (stderr) {
          //   this.logger.error(`stderr: ${stderr}`);
          // }
          resolve({ success: false, warnings: warnings.length > 0 ? warnings : undefined });
        }
      });

      childProcess.on('error', (error) => {
        this.logger.error(`Failed to start ninja: ${error.message}`);
        reject(new Error(`Failed to start ninja: ${error.message}`));
      });
    });
  }

  /**
   * 处理编译进度并立即存储缓存
   */
  private async handleCompilationProgress(progressLine: string, buildDir: string): Promise<void> {
    // 解析ninja的进度信息，查找编译完成的文件

    let objectFileName: string | null = null; // 輸出的文件
    let sourceFileName: string | null = null; // 源文件
    let compileCommand: string | null = null; // 编译命令

    // 匹配 -o <path>.o 格式，这表示编译器的输出文件
    const outputMatch = progressLine.match(/-o\s+([^\s]+\.o)/);
    if (outputMatch) {
      objectFileName = outputMatch[1];
      if (objectFileName) {
        const objectFilePath = path.join(buildDir, objectFileName);

        // 检查对象文件是否确实存在
        if (await fs.pathExists(objectFilePath)) {
          // 根据对象文件路径找到对应的源文件和依赖信息
          await this.storeSingleFileToCache(objectFileName, objectFilePath);
        }
      }
    }
  }

  /**
   * 存储单个编译文件到缓存
   */
  private async storeSingleFileToCache(objectFileName: string, objectFilePath: string): Promise<void> {
    try {
      // 从对象文件名解析出源文件信息
      const pathParts = objectFileName.split('/');
      let dependencyType: string;
      let dependencyName: string;
      let baseName: string;

      if (pathParts.length === 3) {
        // library/libraryName/file.ext.o 或 variant/variantName/file.ext.o
        [dependencyType, dependencyName, baseName] = pathParts;
        // 移除 .o 扩展名，保留原始文件的扩展名
        if (baseName.endsWith('.o')) {
          baseName = baseName.slice(0, -2); // 移除 '.o'
        }
        // 再移除原始文件的扩展名以获得基本名称
        baseName = path.basename(baseName, path.extname(baseName));
      } else if (pathParts.length === 2) {
        // core/file.ext.o 或 sketch/file.ext.o
        [dependencyType, baseName] = pathParts;
        // 移除 .o 扩展名，保留原始文件的扩展名
        if (baseName.endsWith('.o')) {
          baseName = baseName.slice(0, -2); // 移除 '.o'
        }
        // 再移除原始文件的扩展名以获得基本名称
        baseName = path.basename(baseName, path.extname(baseName));
        dependencyName = dependencyType;
      } else {
        // file.ext.o (直接在构建根目录)
        baseName = pathParts[0];
        // 移除 .o 扩展名
        if (baseName.endsWith('.o')) {
          baseName = baseName.slice(0, -2); // 移除 '.o'
        }
        // 再移除原始文件的扩展名以获得基本名称
        baseName = path.basename(baseName, path.extname(baseName));
        dependencyType = 'sketch';
        dependencyName = 'sketch';
      }

      // 跳过sketch文件的缓存，因为sketch文件经常变化
      if (dependencyType === 'sketch') {
        this.logger.debug(`Skipping cache for sketch file: ${objectFileName}`);
        return;
      }

      // 查找对应的依赖和源文件
      const dependency = this.dependencies.find(dep =>
        dep.type === dependencyType &&
        (dep.name === dependencyName || dependencyType === dep.type)
      );

      if (!dependency) {
        this.logger.debug(`Cannot find dependency for object file: ${objectFileName}`);
        return;
      }

      // 查找对应的源文件
      const sourceFile = dependency.includes?.find(file => {
        const sourceBaseName = path.basename(file, path.extname(file));
        return sourceBaseName === baseName;
      });

      if (!sourceFile) {
        // this.logger.debug(`Cannot find source file for object: ${objectFileName} in dependency ${dependency.name}`);
        // this.logger.debug(`Looking for baseName: ${baseName}`);
        // this.logger.debug(`Available source files: ${dependency.includes?.map(f => path.basename(f, path.extname(f))).join(', ')}`);
        return;
      }

      // 确定编译器和参数模板
      const ext = path.extname(sourceFile);
      let compiler: string;
      let argsTemplate: string;

      switch (ext) {
        case '.ino':
        case '.cpp':
          compiler = this.compileConfig.compiler.cpp;
          argsTemplate = this.compileConfig.args.cpp;
          break;
        case '.c':
          compiler = this.compileConfig.compiler.c;
          argsTemplate = this.compileConfig.args.c;
          break;
        case '.s':
        case '.S':
          compiler = this.compileConfig.compiler.c;
          argsTemplate = this.compileConfig.args.s;
          break;
        default:
          return; // 跳过不支持的文件类型
      }

      // 创建缓存键
      const cacheKey: CacheKey = {
        command: compiler,
        args: this.parseCompileArgs(argsTemplate, sourceFile),
        sourceFile: sourceFile
      };

      // 存储到缓存
      await this.cacheManager.storeToCache(cacheKey, objectFilePath);
    } catch (error) {
      this.logger.debug(`Failed to cache single file ${objectFileName}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private getNinjaExecutablePath(): string {
    // 打包后路径
    let projectNinjaPath = path.join(__dirname, 'ninja', 'ninja.exe');
    if (fs.existsSync(projectNinjaPath)) {
      return projectNinjaPath;
    }
    // 开发环境路径
    projectNinjaPath = path.join(process.cwd(), 'ninja', 'ninja.exe');
    if (fs.existsSync(projectNinjaPath)) {
      return projectNinjaPath;
    }
    // 检查系统PATH中的ninja
    const systemNinja = process.platform === 'win32' ? 'ninja.exe' : 'ninja';

    // 尝试在PATH中查找
    try {
      const { execSync } = require('child_process');
      const which = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${which} ${systemNinja}`, { encoding: 'utf8' });
      return result.trim().split('\n')[0];
    } catch (error) {
      // 如果找不到，抛出错误
      throw new Error(`Ninja executable not found. Please install ninja or place ninja.exe in the project's ninja/ directory.`);
    }
  }

  /**
   * 清理ninja构建文件
   */
  async cleanNinjaBuild(): Promise<void> {
    const buildPath = process.env['BUILD_PATH'] || '';
    const ninjaFilePath = path.join(buildPath, 'build.ninja');
    const ninjaDepsPath = path.join(buildPath, '.ninja_deps');
    const ninjaLogPath = path.join(buildPath, '.ninja_log');

    try {
      await Promise.all([
        fs.remove(ninjaFilePath).catch(() => { }),
        fs.remove(ninjaDepsPath).catch(() => { }),
        fs.remove(ninjaLogPath).catch(() => { })
      ]);
      this.logger.debug('Cleaned ninja build files');
    } catch (error) {
      this.logger.debug(`Failed to clean ninja files: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 获取缓存统计信息
   */
  async getCacheStats() {
    return await this.cacheManager.getCacheStats();
  }

  /**
   * 显示缓存统计信息
   */
  async showCacheStats(): Promise<void> {
    const stats = await this.getCacheStats();
    this.logger.info(`📊 Cache Statistics:`);
    this.logger.info(`   Files: ${stats.totalFiles}`);
    this.logger.info(`   Size: ${stats.totalSizeFormatted}`);
    this.logger.info(`   Location: ${stats.cacheDir}`);

    const totalOps = (stats.hardLinksUsed || 0) + (stats.copiesUsed || 0);
    if (totalOps > 0) {
      const hardPercent = (((stats.hardLinksUsed || 0) / totalOps) * 100).toFixed(1);
      const copyPercent = (((stats.copiesUsed || 0) / totalOps) * 100).toFixed(1);

      this.logger.info(`   Performance:`);
      this.logger.info(`     Hard links: ${stats.hardLinksUsed || 0} (${hardPercent}%)`);
      this.logger.info(`     File copies: ${stats.copiesUsed || 0} (${copyPercent}%)`);

      const linkRate = ((stats.hardLinksUsed || 0) / totalOps * 100).toFixed(1);
      this.logger.info(`     Hard link success rate: ${linkRate}%`);
    }
  }

  /**
   * 清除编译缓存
   */
  async clearCache(options?: { olderThanDays?: number; pattern?: string }) {
    return await this.cacheManager.clearCache(options);
  }

  /**
   * 清除所有编译缓存
   */
  async clearAllCache() {
    return await this.cacheManager.clearAllCache();
  }

  /**
   * 从缓存中恢复对象文件
   */
  private async restoreFromCache(dependencies: Dependency[]): Promise<number> {
    let cacheHits = 0;
    const buildPath = process.env['BUILD_PATH'] || '';

    // 处理依赖文件，跳过sketch文件
    for (const dependency of dependencies) {
      // 跳过sketch类型的依赖
      if (dependency.type === 'sketch') {
        continue;
      }

      for (const sourceFile of dependency.includes) {
        const ext = path.extname(sourceFile);
        let compiler: string;
        let argsTemplate: string;

        // 确定编译器和参数模板
        switch (ext) {
          case '.ino':
          case '.cpp':
            compiler = this.compileConfig.compiler.cpp;
            argsTemplate = this.compileConfig.args.cpp;
            break;
          case '.c':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.c;
            break;
          case '.s':
          case '.S':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.s;
            break;
          default:
            continue; // 跳过不支持的文件类型
        }

        const cacheKey: CacheKey = {
          command: compiler,
          args: this.parseCompileArgs(argsTemplate, sourceFile),
          sourceFile: sourceFile
        };

        // 确定对象文件路径
        const baseName = path.basename(sourceFile, ext);
        let objectPath: string;

        if (dependency.type === 'library' || dependency.type === 'variant') {
          objectPath = path.join(buildPath, dependency.type, dependency.name, `${baseName}.o`);
        } else {
          objectPath = path.join(buildPath, dependency.type, `${baseName}.o`);
        }

        // 检查缓存并恢复
        if (await this.cacheManager.hasCache(cacheKey)) {
          await fs.ensureDir(path.dirname(objectPath));
          if (await this.cacheManager.extractFromCache(cacheKey, objectPath)) {
            cacheHits++;
            this.logger.debug(`Cache hit for ${dependency.type}/${dependency.name}: ${baseName}${ext}`);
          }
        }
      }
    }

    return cacheHits;
  }

  /**
   * 将新编译的对象文件存储到缓存
   */
  private async storeToCache(dependencies: Dependency[]): Promise<void> {
    const buildPath = process.env['BUILD_PATH'] || '';

    // 只处理依赖文件，跳过sketch文件缓存

    // 处理依赖文件
    for (const dependency of dependencies) {
      // 跳过sketch类型的依赖
      if (dependency.type === 'sketch') {
        continue;
      }

      for (const sourceFile of dependency.includes) {
        const ext = path.extname(sourceFile);
        let compiler: string;
        let argsTemplate: string;

        // 确定编译器和参数模板
        switch (ext) {
          case '.ino':
          case '.cpp':
            compiler = this.compileConfig.compiler.cpp;
            argsTemplate = this.compileConfig.args.cpp;
            break;
          case '.c':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.c;
            break;
          case '.s':
          case '.S':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.s;
            break;
          default:
            continue; // 跳过不支持的文件类型
        }

        const cacheKey: CacheKey = {
          command: compiler,
          args: this.parseCompileArgs(argsTemplate, sourceFile),
          sourceFile: sourceFile
        };

        // 确定对象文件路径
        const baseName = path.basename(sourceFile, ext);
        let objectPath: string;

        if (dependency.type === 'library' || dependency.type === 'variant') {
          objectPath = path.join(buildPath, dependency.type, dependency.name, `${baseName}.o`);
        } else {
          objectPath = path.join(buildPath, dependency.type, `${baseName}.o`);
        }

        // 存储到缓存
        if (await fs.pathExists(objectPath)) {
          try {
            await this.cacheManager.storeToCache(cacheKey, objectPath);
            this.logger.debug(`Cached ${dependency.type}/${dependency.name}: ${baseName}${ext}`);
          } catch (error) {
            this.logger.debug(`Failed to cache ${baseName}${ext}: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }
  }

  /**
   * 解析编译参数
   */
  private parseCompileArgs(argsTemplate: string, sourceFile: string): string[] {
    // 简化参数解析，将模板转换为实际的编译参数
    let args = argsTemplate;

    // 替换include路径
    if (args.includes('%INCLUDE_PATHS%')) {
      const includeArgs = this.dependencies
        .map(dep => `-I"${dep.path}"`)
        .join(' ');
      args = args.replace(/%INCLUDE_PATHS%/g, includeArgs);
    }

    // 替换源文件路径
    args = args.replace(/"%SOURCE_FILE_PATH%"/g, `"${sourceFile}"`);

    // 移除输出文件参数（缓存键不需要包含输出路径）
    args = args.replace(/"-o"\s*"%OBJECT_FILE_PATH%"/g, '');
    args = args.replace(/%OBJECT_FILE_PATH%/g, '');

    // 添加编译器版本信息到缓存键中（确保编译器更新时缓存失效）
    const compilerVersion = this.getCompilerVersion();
    if (compilerVersion) {
      args += ` --compiler-version=${compilerVersion}`;
    }

    // 分割参数并清理
    return args
      .split(/\s+/)
      .filter(arg => arg.trim() && !arg.includes('%'))
      .map(arg => arg.replace(/"/g, ''))
      .sort(); // 排序参数以确保一致性
  }

  /**
   * 获取编译器版本（用于缓存键）
   */
  private getCompilerVersion(): string {
    try {
      // 这里可以根据需要实现编译器版本检测
      // 简单起见，我们使用编译器路径的修改时间作为版本标识
      const compilerPath = this.compileConfig.compiler.cpp;
      if (fs.existsSync(compilerPath)) {
        const stat = fs.statSync(compilerPath);
        return stat.mtime.getTime().toString();
      }
    } catch (error) {
      this.logger.debug(`Cannot get compiler version: ${error}`);
    }
    return '';
  }
}
