import fs from 'fs-extra';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { Logger } from './utils/Logger';
import { NinjaCompilationPipeline } from './NinjaCompilationPipeline';
import { CompileConfigManager } from './CompileConfigManager';
import { ArduinoConfigParser } from './ArduinoConfigParser';
import { DependencyAnalyzer } from './DependencyAnalyzer';

export interface ExecutableSectionSize {
  name: string;
  size: number;
  maxSize: number;
}

export interface FirmwareSizeInfo {
  sections: ExecutableSectionSize[];
  warnings?: string[];
  errors?: string[];
}

export interface CompileResult {
  success: boolean;
  outFilePath?: string,
  preprocessTime: number;
  buildTime: number;
  totalTime: number;
  firmwareSize?: FirmwareSizeInfo;
  error?: string;
  warnings?: string[];
}

export class ArduinoCompiler {
  private logger: Logger;
  private ninjaPipeline: NinjaCompilationPipeline;
  private compileConfigManager: CompileConfigManager;
  private arduinoConfigParser: ArduinoConfigParser;
  private analyzer: DependencyAnalyzer;

  constructor(logger: Logger, options?: { useNinja?: boolean }) {
    this.logger = logger;
    this.ninjaPipeline = new NinjaCompilationPipeline(logger);
    this.arduinoConfigParser = new ArduinoConfigParser();
    this.compileConfigManager = new CompileConfigManager(logger);
    this.analyzer = new DependencyAnalyzer(logger);
  }

  async compile(options: any): Promise<CompileResult> {
    const startTime = Date.now();

    // try {
    this.logger.info(`Starting compilation process...`);

    // 1. 验证sketch文件
    await this.validateSketch(options.sketchPath);

    // 2. 获取开发板、平台、编译配置
    const arduinoConfig = await this.arduinoConfigParser.parseByFQBN(options.board, options.buildProperties || {}, options.toolVersions || {});

    // 3. 准备构建目录
    await this.prepareBuildDirectory(options.buildPath, options.sketchPath);

    // 4-6. 并行执行：预处理钩子、构建编译配置、依赖分析
    this.logger.info('Starting parallel preprocessing tasks...');
    const [compileConfig, dependencies] = await Promise.all([
      // 6. 构建编译配置
      (async () => {
        this.logger.info('Generating compile configuration...');
        return await this.compileConfigManager.parseCompileConfig(arduinoConfig);
      })(),

      // 4. 依赖分析
      (async () => {
        this.logger.info('Analyzing dependencies...');
        const deps = await this.analyzer.preprocess(arduinoConfig);
        this.logger.info(`Dependency analysis completed.`);
        return deps;
      })(),

      // 5. 预处理2：运行编译前钩子（ESP32需要）
      (async () => {
        if (arduinoConfig.platform['recipe.hooks.prebuild.1.pattern']) {
          this.logger.info('Running prebuild hook scripts...');
          await this.runPreBuildHooks(arduinoConfig);
        }
      })()
    ]);


    // 输出分析
    this.logger.info(`Found ${dependencies.length} dependencies.`);
    dependencies.map((dep, index) => {
      this.logger.info(`|- ${dep.name}`)
    });


    // 计算预处理耗时
    const preprocessTime = Date.now() - startTime;

    // 8. 编译pipeline
    this.logger.verbose(`Starting compilation pipeline...`);
    let compileResult;

    compileResult = await this.ninjaPipeline.compile({ dependencies, compileConfig });

    if (!compileResult.success) {
      return {
        success: false,
        preprocessTime,
        buildTime: 0,
        totalTime: Date.now() - startTime,
        error: 'Compilation failed'
      };
    }

    // 运行编译后钩子（ESP32需要）
    if (arduinoConfig.platform['recipe.objcopy.partitions.bin.pattern']) {
      this.logger.info(arduinoConfig.platform['recipe.objcopy.partitions.bin.pattern']);
      await this.runCommand(arduinoConfig.platform['recipe.objcopy.partitions.bin.pattern']);
    }
    if (arduinoConfig.platform['recipe.hooks.objcopy.postobjcopy.1.pattern']) {
      this.logger.info('Running post-build hook scripts...');
      await this.runPostBuildHooks(arduinoConfig);
      compileResult.outFilePath = path.join(process.env['BUILD_PATH'], 'sketch.merged.bin');
    }

    const totalTime = Date.now() - startTime;
    const buildTime = totalTime - preprocessTime;
    // 6. 计算固件大小信息
    const firmwareSize = await this.calculateFirmwareSize(arduinoConfig);

    return {
      success: true,
      preprocessTime,
      buildTime,
      totalTime,
      outFilePath: compileResult.outFilePath,
      firmwareSize
    }
  }

  async clean(buildPath: string): Promise<void> {
    try {
      if (await fs.pathExists(buildPath)) {
        await fs.remove(buildPath);
        this.logger.debug(`Cleaned build directory: ${buildPath}`);
      }
    } catch (error) {
      throw new Error(`Failed to clean build directory: ${error instanceof Error ? error.message : error}`);
    }
  }


  /*  验证sketch文件
  */
  private async validateSketch(sketchPath: string): Promise<void> {
    if (!await fs.pathExists(sketchPath)) {
      throw new Error(`Sketch file not found: ${sketchPath}`);
    }

    if (!sketchPath.endsWith('.ino')) {
      throw new Error(`Invalid sketch file extension. Expected .ino file: ${sketchPath}`);
    }

    const content = await fs.readFile(sketchPath, 'utf-8');
    if (content.trim().length === 0) {
      throw new Error(`Sketch file is empty: ${sketchPath}`);
    }

    this.logger.debug(`Sketch validation passed: ${sketchPath}`);
  }

  /*
  准备构建目录
  */
  private async prepareBuildDirectory(buildPath: string, sketchPath: string): Promise<void> {
    try {
      // 创建构建目录
      await fs.ensureDir(buildPath);

      // 使用GCC预处理
      // let command = `${process.env['COMPILER_GPP_PATH']} -o "${path.join(process.env['BUILD_PATH'], process.env['SKETCH_NAME'] + '.cpp')}" -x c++ -fpreprocessed -dD -E ${process.env['SKETCH_PATH']}`
      // try {
      //   const stdout = execSync(command, { encoding: 'utf8' });
      //   process.env['SKETCH_PATH'] = path.join(process.env['BUILD_PATH'], process.env['SKETCH_NAME'] + '.cpp');
      // } catch (error) {
      //   console.error(error);
      // }

      // 直接复制并转换为 .cpp 文件
      const targetPath = path.join(process.env['BUILD_PATH']!, process.env['SKETCH_NAME'] + '.cpp');

      // 读取原始 .ino 文件内容
      let content = await fs.readFile(process.env['SKETCH_PATH']!, 'utf-8');

      // 检查是否已包含 Arduino.h
      const hasArduinoInclude = /#include\s*[<"]Arduino\.h[>"]/i.test(content);

      if (!hasArduinoInclude) {
        this.logger.verbose('Adding #include <Arduino.h> to sketch');
        // 在文件开头添加 Arduino.h
        content = '#include <Arduino.h>\n' + content;
      }

      // 添加行号指令（用于更好的错误定位）
      const lineDirective = `# 1 "${process.env['SKETCH_PATH']!.replace(/\\/g, '\\\\')}"\n`;
      content = lineDirective + content;

      // 写入新的 .cpp 文件
      await fs.writeFile(targetPath, content, 'utf-8');

      // 更新环境变量指向新的 .cpp 文件
      process.env['SKETCH_PATH'] = targetPath;
    } catch (error) {
      throw new Error(`Failed to prepare build directory: ${error instanceof Error ? error.message : error}`);
    }
  }

  async runPreBuildHooks(arduinoConfig: any) {
    for (let i = 1; i <= 8; i++) {
      const key = `recipe.hooks.prebuild.${i}.pattern`;
      const script = arduinoConfig.platform[key];
      if (script) {
        this.logger.info(`Pre-build hook ${i}: ${script}`);
        try {
          const output = await this.runCommand(script);
          if (output.trim()) {
            this.logger.verbose(`Pre-build hook ${i} output: ${output.trim()}`);
          }
          this.logger.verbose(`Pre-build hook ${i} executed successfully`);
        } catch (error) {
          this.logger.error(`Pre-build hook ${i} failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
  }

  async runPostBuildHooks(arduinoConfig) {
    for (let i = 1; i <= 3; i++) {
      const key = `recipe.hooks.objcopy.postobjcopy.${i}.pattern.windows`;
      let script = arduinoConfig.platform[key] ? arduinoConfig.platform[key] : arduinoConfig.platform[`recipe.hooks.objcopy.postobjcopy.${i}.pattern`];
      if (script) {
        this.logger.info(`Post-build hook ${i}: ${script}`);
        try {
          const output = await this.runCommand(script);
          if (output.trim()) {
            this.logger.verbose(`Post-build hook ${i} output: ${output.trim()}`);
          }
          this.logger.verbose(`Post-build hook ${i} executed successfully`);
        } catch (error) {
          this.logger.error(`Post-build hook ${i} failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
  }

  private async runCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [], {
        shell: true,
        stdio: 'pipe'
      });

      const stdoutBuffers: Buffer[] = [];
      const stderrBuffers: Buffer[] = [];

      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffers.push(data);
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderrBuffers.push(data);
      });

      child.on('close', (code) => {
        const stdoutBuffer = Buffer.concat(stdoutBuffers);
        const stderrBuffer = Buffer.concat(stderrBuffers);

        // 直接使用 UTF-8 解码
        const stdout = stdoutBuffer.toString('utf8');
        const stderr = stderrBuffer.toString('utf8');

        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${command}\nStderr: ${stderr}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to execute command: ${error.message}`));
      });
    });
  }

  async calculateFirmwareSize(arduinoConfig: any): Promise<FirmwareSizeInfo> {
    this.logger.verbose('Calculating firmware size...');
    try {
      // 获取最大尺寸配置
      const maxTextSizeString = arduinoConfig.platform['upload.maximum_size'];
      const maxDataSizeString = arduinoConfig.platform['upload.maximum_data_size'];

      if (!maxTextSizeString) {
        return { sections: [] };
      }

      const maxTextSize = parseInt(maxTextSizeString);
      const maxDataSize = maxDataSizeString ? parseInt(maxDataSizeString) : -1;

      // 执行size命令获取输出
      const output = await this.runCommand(arduinoConfig.platform['recipe.size.pattern']);

      // 计算各部分大小
      const textSize = this.computeSize(arduinoConfig.platform['recipe.size.regex'], output);
      const dataSize = this.computeSize(arduinoConfig.platform['recipe.size.regex.data'], output);

      if (textSize === -1) {
        throw new Error('Missing size regexp');
      }

      // 构建输出信息
      const sections: ExecutableSectionSize[] = [
        {
          name: 'text',
          size: textSize,
          maxSize: maxTextSize
        }
      ];

      if (maxDataSize > 0) {
        sections.push({
          name: 'data',
          size: dataSize >= 0 ? dataSize : 0,
          maxSize: maxDataSize
        });
      }

      // 生成用户友好的信息
      const textPercentage = Math.round((textSize * 100) / maxTextSize);
      this.logger.info(`Sketch uses ${textSize} bytes (${textPercentage}%) of program storage space. Maximum is ${maxTextSize} bytes.`);

      if (dataSize >= 0) {
        if (maxDataSize > 0) {
          const dataPercentage = Math.round((dataSize * 100) / maxDataSize);
          const remainingData = maxDataSize - dataSize;
          this.logger.info(`Global variables use ${dataSize} bytes (${dataPercentage}%) of dynamic memory, leaving ${remainingData} bytes for local variables. Maximum is ${maxDataSize} bytes.`);
        } else {
          this.logger.info(`Global variables use ${dataSize} bytes of dynamic memory.`);
        }
      }

      // 检查是否超出限制
      const warnings: string[] = [];
      const errors: string[] = [];

      if (textSize > maxTextSize) {
        const errorMsg = 'text section exceeds available space in board';
        errors.push(errorMsg);
        this.logger.debug('Sketch too big!');
      }

      if (maxDataSize > 0 && dataSize > maxDataSize) {
        const errorMsg = 'data section exceeds available space in board';
        errors.push(errorMsg);
        this.logger.debug('Not enough memory!');
      }

      // 检查内存警告阈值
      const warnDataPercentage = 75; // 默认75%
      if (maxDataSize > 0 && dataSize > (maxDataSize * warnDataPercentage / 100)) {
        warnings.push('Low memory available, stability problems may occur.');
        this.logger.debug('Low memory available, stability problems may occur.');
      }

      return {
        sections,
        warnings: warnings.length > 0 ? warnings : undefined,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      this.logger.error(`Error calculating firmware size: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  private computeSize(regex: string, output: string): number {
    if (!regex) {
      return -1;
    }

    try {
      // 添加多行匹配标志
      const regexPattern = new RegExp(regex, 'gm');
      const matches = output.matchAll(regexPattern);
      let totalSize = 0;

      for (const match of matches) {
        // 遍历所有捕获组，找到数字并累加
        for (let i = 1; i < match.length; i++) {
          const size = parseInt(match[i]);
          if (!isNaN(size)) {
            totalSize += size;
          }
        }
      }

      return totalSize;
    } catch (error) {
      this.logger.error(`Invalid size regexp: ${regex}, error: ${error instanceof Error ? error.message : error}`);
      return -1;
    }
  }
}
