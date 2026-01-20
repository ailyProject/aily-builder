import fs from 'fs-extra';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { Logger } from './utils/Logger';
import { NinjaCompilationPipeline } from './NinjaCompilationPipeline';
import { CompileConfigManager } from './CompileConfigManager';
import { ArduinoConfigParser } from './ArduinoConfigParser';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import { escapeQuotedDefines } from './utils/escapeQuotes';

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

export interface PreprocessResult {
  success: boolean;
  preprocessTime: number;
  arduinoConfig?: any;
  compileConfig?: any;
  dependencies?: any[];
  error?: string;
  // 保存编译所需的环境变量
  envVars?: Record<string, string>;
}

export interface CompileOptions {
  sketchPath: string;
  board: string;
  buildPath: string;
  buildProperties?: Record<string, string>;
  toolVersions?: Record<string, string>;
  buildMacros?: string[];
  preprocessResult?: PreprocessResult;
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

  /**
   * 单独执行预处理步骤
   * 包括：验证sketch、解析配置、依赖分析、运行预构建钩子
   * 注意：不包含 prepareBuildDirectory，该步骤在 compile 时执行
   */
  async preprocess(options: CompileOptions): Promise<PreprocessResult> {
    const startTime = Date.now();

    try {
      this.logger.info(`Starting preprocessing...`);

      // 1. 验证sketch文件
      await this.validateSketch(options.sketchPath);

      // 2-0. 获取sketch.ino中的宏定义并合并到buildMacros
      const sketchMacros = await this.analyzer.extractMacrosFromSketch(options.sketchPath);
      options.buildMacros = [...(options.buildMacros || []), ...sketchMacros];

      // 2. 获取开发板、平台、编译配置(包含自定义宏定义)
      const arduinoConfig = await this.arduinoConfigParser.parseByFQBN(
        options.board,
        options.buildProperties || {},
        options.toolVersions || {},
        options.buildMacros || []
      );

      // 3. 确保构建目录存在（pre-build hooks 需要）
      await fs.ensureDir(options.buildPath);

      // 4. 并行执行：预处理钩子、构建编译配置、依赖分析
      this.logger.info('Starting parallel preprocessing tasks...');
      const [compileConfig, dependencies] = await Promise.all([
        // 构建编译配置
        (async () => {
          this.logger.info('Generating compile configuration...');
          return await this.compileConfigManager.parseCompileConfig(arduinoConfig);
        })(),

        // 依赖分析
        (async () => {
          this.logger.info('Analyzing dependencies...');
          const deps = await this.analyzer.preprocess(arduinoConfig);
          this.logger.info(`Dependency analysis completed.`);
          return deps;
        })(),

        // 运行编译前钩子（ESP32需要）
        (async () => {
          if (arduinoConfig.platform['recipe.hooks.prebuild.1.pattern']) {
            this.logger.info('Running prebuild hook scripts...');
            await this.runPreBuildHooks(arduinoConfig);
          }
        })()
      ]);

      // 输出分析
      this.logger.info(`Found ${dependencies.length} dependencies.`);
      dependencies.map((dep) => {
        this.logger.info(`|- ${dep.name}`);
      });

      const preprocessTime = Date.now() - startTime;
      this.logger.info(`Preprocessing completed in ${preprocessTime}ms`);

      // 保存编译所需的环境变量
      const envVars: Record<string, string> = {};
      
      // 保存所有可能与编译相关的环境变量
      // 包括：路径、工具、编译器等
      for (const [key, value] of Object.entries(process.env)) {
        if (value && (
          // 基本路径变量
          key === 'SKETCH_NAME' || key === 'SKETCH_PATH' || key === 'SKETCH_DIR_PATH' ||
          key === 'BUILD_PATH' || key === 'SDK_PATH' || key === 'TOOLS_PATH' ||
          key === 'LIBRARIES_PATH' || key === 'BUILD_JOBS' ||
          // 编译器相关
          key.startsWith('COMPILER_') ||
          // 运行时路径
          key.startsWith('RUNTIME_') ||
          // 工具路径（如 esptool, ctags 等）
          key.startsWith('TOOLS_') ||
          // ESP32 相关
          key.startsWith('ESP_') || key.startsWith('ESPTOOL_') ||
          // 其他可能的前缀
          key.endsWith('_PATH') || key.endsWith('_DIR') ||
          key.includes('ARDUINO')
        )) {
          envVars[key] = value;
        }
      }

      this.logger.verbose(`Saved ${Object.keys(envVars).length} environment variables for later compilation`);

      return {
        success: true,
        preprocessTime,
        arduinoConfig,
        compileConfig,
        dependencies,
        envVars
      };
    } catch (error) {
      const preprocessTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Preprocessing failed: ${errorMessage}`);
      return {
        success: false,
        preprocessTime,
        error: errorMessage
      };
    }
  }

  /**
   * 编译项目
   * @param options 编译选项，可以包含预处理结果以跳过预处理步骤
   */
  async compile(options: CompileOptions): Promise<CompileResult> {
    const startTime = Date.now();

    this.logger.info(`Starting compilation process...`);

    let preprocessTime: number;
    let arduinoConfig: any;
    let compileConfig: any;
    let dependencies: any[];

    // 检查是否提供了预处理结果
    if (options.preprocessResult && options.preprocessResult.success) {
      this.logger.info('Using provided preprocess result, skipping preprocessing...');
      preprocessTime = options.preprocessResult.preprocessTime;
      arduinoConfig = options.preprocessResult.arduinoConfig;
      compileConfig = options.preprocessResult.compileConfig;
      dependencies = options.preprocessResult.dependencies!;
    } else {
      // 执行预处理
      const preprocessResult = await this.preprocess(options);
      
      if (!preprocessResult.success) {
        return {
          success: false,
          preprocessTime: preprocessResult.preprocessTime,
          buildTime: 0,
          totalTime: Date.now() - startTime,
          error: preprocessResult.error || 'Preprocessing failed'
        };
      }

      preprocessTime = preprocessResult.preprocessTime;
      arduinoConfig = preprocessResult.arduinoConfig;
      compileConfig = preprocessResult.compileConfig;
      dependencies = preprocessResult.dependencies!;
    }

    // 准备构建目录（将 sketch.ino 转换为 sketch.cpp）
    // 每次编译都需要执行，确保源文件变化能被检测到
    await this.prepareBuildDirectory(options.buildPath);

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

    // 运行编译后钩子和输出文件生成
    let finalOutputPath = compileResult.outFilePath;

    /*
    ESP32 配置 begin
    */
    // ESP32平台的后处理钩子
    if (arduinoConfig.platform['recipe.objcopy.partitions.bin.pattern']) {
      this.logger.info('Running ESP32 partition generation...');
      const resolvedCommand = this.resolveVariables(arduinoConfig.platform['recipe.objcopy.partitions.bin.pattern']);
      await this.runCommand(resolvedCommand);
    }

    if (arduinoConfig.platform['recipe.hooks.objcopy.postobjcopy.1.pattern']) {
      this.logger.info('Running ESP32 post-build hook scripts...');
      await this.runPostBuildHooks(arduinoConfig);
      finalOutputPath = path.join(process.env['BUILD_PATH'], 'sketch.merged.bin');
    }

    /*
    ESP32 配置 end
    */

    /*
    RP2040 配置 begin
    */
    // RP2040平台的输出文件生成
    if (arduinoConfig.platform['recipe.objcopy.uf2.pattern']) {
      this.logger.info('Generating UF2 file...');
      const resolvedCommand = this.resolveVariables(arduinoConfig.platform['recipe.objcopy.uf2.pattern']);
      await this.runCommand(resolvedCommand);
      finalOutputPath = path.join(process.env['BUILD_PATH'], `${process.env['SKETCH_NAME']}.uf2`);
    }

    // 生成BIN文件（如果配置了）
    if (arduinoConfig.platform['recipe.objcopy.bin.1.pattern']) {
      this.logger.info('Generating BIN file...');
      const resolvedCommand = this.resolveVariables(arduinoConfig.platform['recipe.objcopy.bin.1.pattern']);
      await this.runCommand(resolvedCommand);
    }

    // 签名BIN文件（如果配置了）
    if (arduinoConfig.platform['recipe.objcopy.bin.2.pattern']) {
      this.logger.info('Signing BIN file...');
      const resolvedCommand = this.resolveVariables(arduinoConfig.platform['recipe.objcopy.bin.2.pattern']);
      await this.runCommand(resolvedCommand);
    }
    /*
    RP2040 配置 end
    */

    /*
    NRF52 和其他平台的 ZIP 文件生成
    */
    // 生成ZIP文件（如果配置了，用于DFU上传等）
    if (arduinoConfig.platform['recipe.objcopy.zip.pattern']) {
      this.logger.info('Generating ZIP file for DFU upload...');
      try {
        const resolvedCommand = this.resolveVariables(arduinoConfig.platform['recipe.objcopy.zip.pattern']);
        await this.runCommand(resolvedCommand);
        finalOutputPath = path.join(process.env['BUILD_PATH'] || '', `${process.env['SKETCH_NAME']}.zip`);
        this.logger.info(`ZIP file generated: ${finalOutputPath}`);
      } catch (error) {
        this.logger.warn(`Failed to generate ZIP file: ${error instanceof Error ? error.message : error}`);
        // 不中断编译，继续返回HEX文件
      }
    }
    /*
    NRF52 ZIP 文件生成 end
    */

    const totalTime = Date.now() - startTime;
    const buildTime = totalTime - preprocessTime;
    // 6. 计算固件大小信息
    const firmwareSize = await this.calculateFirmwareSize(arduinoConfig);

    return {
      success: true,
      preprocessTime,
      buildTime,
      totalTime,
      outFilePath: finalOutputPath,
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
  private async prepareBuildDirectory(buildPath: string): Promise<void> {
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

      // 添加前向声明
      const forwardDeclarations = this.generateForwardDeclarations(content);
      if (forwardDeclarations.length > 0) {
        this.logger.verbose(`Adding ${forwardDeclarations.length} forward declarations`);
        const declarationsBlock = forwardDeclarations.join('\n') + '\n\n';
        // 在 #include 语句之后插入前向声明
        const lastIncludeMatch = content.match(/^([\s\S]*#include\s*[<"][^>"]+[>"].*\n)/m);
        if (lastIncludeMatch) {
          // 找到所有 #include 的最后一个位置
          const includeRegex = /#include\s*[<"][^>"]+[>"]/g;
          let lastIncludeEnd = 0;
          let match;
          while ((match = includeRegex.exec(content)) !== null) {
            // 找到该行的结尾
            const lineEnd = content.indexOf('\n', match.index);
            if (lineEnd > lastIncludeEnd) {
              lastIncludeEnd = lineEnd + 1;
            }
          }
          if (lastIncludeEnd > 0) {
            content = content.slice(0, lastIncludeEnd) + '\n' + declarationsBlock + content.slice(lastIncludeEnd);
          } else {
            content = declarationsBlock + content;
          }
        } else {
          content = declarationsBlock + content;
        }
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
          // 解析变量并清理空的命令部分
          let resolvedScript = this.resolveVariables(script);
          resolvedScript = this.cleanEmptyCommands(resolvedScript);

          this.logger.verbose(`Resolved pre-build hook ${i}: ${resolvedScript}`);

          const output = await this.runCommand(resolvedScript);
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
      // 根据操作系统选择相应的键
      const isWindows = process.platform === 'win32';
      const windowsKey = `recipe.hooks.objcopy.postobjcopy.${i}.pattern.windows`;
      const defaultKey = `recipe.hooks.objcopy.postobjcopy.${i}.pattern`;

      let script;
      if (isWindows && arduinoConfig.platform[windowsKey]) {
        script = arduinoConfig.platform[windowsKey];
      } else {
        script = arduinoConfig.platform[defaultKey];
      }

      if (script) {
        this.logger.info(`Post-build hook ${i}: ${script}`);
        try {
          // 解析变量并清理空的命令部分
          let resolvedScript = this.resolveVariables(script);
          resolvedScript = this.cleanEmptyCommands(resolvedScript);

          this.logger.verbose(`Resolved post-build hook ${i}: ${resolvedScript}`);

          const output = await this.runCommand(resolvedScript);
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

  /**
   * 解析命令中的变量并转义引号
   * @param command 包含变量的命令字符串
   * @returns 解析后的命令字符串
   */
  private resolveVariables(command: string): string {
    if (!command) return command;

    // 首先替换环境变量（基础变量替换）
    let resolvedCommand = command.replace(/\{([^}]+)\}/g, (match, variable) => {
      // 从环境变量中获取值
      const value = process.env[variable.toUpperCase()];
      if (value !== undefined) {
        return value;
      }

      // 如果环境变量不存在，保持原始格式
      this.logger.warn(`Variable ${variable} not found in environment`);
      return match;
    });

    // 然后应用引号转义
    resolvedCommand = escapeQuotedDefines(resolvedCommand);

    return resolvedCommand;
  }

  /**
   * 清理命令中的空字符串部分，避免执行空命令
   * @param command 待清理的命令字符串
   * @returns 清理后的命令字符串
   */
  private cleanEmptyCommands(command: string): string {
    if (!command) return command;

    // 将命令按空格分割，移除空的引号对和空字符串
    const parts = command.split(/\s+/);
    const cleanedParts = parts.filter(part => {
      // 移除空字符串
      if (!part || part.trim() === '') return false;
      // 移除空的引号对
      if (part === '""' || part === "''") return false;
      return true;
    });

    return cleanedParts.join(' ');
  }

  /**
   * 分析代码内容，生成需要的前向声明
   * 用于处理 Arduino sketch 中先使用后定义的函数
   * @param content 源代码内容
   * @returns 前向声明数组
   */
  private generateForwardDeclarations(content: string): string[] {
    // 移除注释和字符串，避免误匹配
    const cleanedContent = this.removeCommentsAndStrings(content);
    
    // 解析所有函数定义
    const functionDefs = this.parseFunctionDefinitions(cleanedContent);
    
    // 解析所有函数调用
    const functionCalls = this.parseFunctionCalls(cleanedContent);
    
    // 找出需要前向声明的函数（在调用位置之前未定义的函数）
    const forwardDeclarations: string[] = [];
    const declaredFunctions = new Set<string>();
    
    // 按照在代码中出现的位置排序函数定义
    const sortedDefs = [...functionDefs].sort((a, b) => a.position - b.position);
    
    for (const call of functionCalls) {
      // 检查该函数调用是否在其定义之前
      const funcDef = functionDefs.find(def => def.name === call.name);
      
      if (funcDef && call.position < funcDef.position && !declaredFunctions.has(call.name)) {
        // 该函数在定义之前被调用，需要前向声明
        forwardDeclarations.push(funcDef.declaration + ';');
        declaredFunctions.add(call.name);
        this.logger.verbose(`Forward declaration needed for: ${call.name}`);
      }
    }
    
    return forwardDeclarations;
  }

  /**
   * 移除代码中的注释和字符串字面量
   * @param content 源代码内容
   * @returns 清理后的代码
   */
  private removeCommentsAndStrings(content: string): string {
    let result = '';
    let i = 0;
    
    while (i < content.length) {
      // 检查单行注释
      if (content[i] === '/' && content[i + 1] === '/') {
        // 跳过到行尾
        while (i < content.length && content[i] !== '\n') {
          result += ' ';
          i++;
        }
      }
      // 检查多行注释
      else if (content[i] === '/' && content[i + 1] === '*') {
        result += '  ';
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          result += content[i] === '\n' ? '\n' : ' ';
          i++;
        }
        if (i < content.length) {
          result += '  ';
          i += 2;
        }
      }
      // 检查字符串字面量
      else if (content[i] === '"') {
        result += ' ';
        i++;
        while (i < content.length && content[i] !== '"') {
          if (content[i] === '\\' && i + 1 < content.length) {
            result += '  ';
            i += 2;
          } else {
            result += ' ';
            i++;
          }
        }
        if (i < content.length) {
          result += ' ';
          i++;
        }
      }
      // 检查字符字面量
      else if (content[i] === "'") {
        result += ' ';
        i++;
        while (i < content.length && content[i] !== "'") {
          if (content[i] === '\\' && i + 1 < content.length) {
            result += '  ';
            i += 2;
          } else {
            result += ' ';
            i++;
          }
        }
        if (i < content.length) {
          result += ' ';
          i++;
        }
      }
      else {
        result += content[i];
        i++;
      }
    }
    
    return result;
  }

  /**
   * 解析代码中的函数定义
   * @param content 已清理的代码内容
   * @returns 函数定义信息数组
   */
  private parseFunctionDefinitions(content: string): Array<{name: string, declaration: string, position: number}> {
    const functions: Array<{name: string, declaration: string, position: number}> = [];
    
    // 匹配函数定义的正则表达式
    // 支持: 返回类型 函数名(参数列表) { 或 返回类型 函数名(参数列表) 换行 {
    const functionRegex = /^[ \t]*((?:(?:static|inline|virtual|explicit|constexpr|extern)\s+)*(?:(?:unsigned|signed|long|short)\s+)*(?:void|int|char|float|double|bool|String|byte|word|size_t|uint\d+_t|int\d+_t|[A-Z][a-zA-Z0-9_]*(?:\s*[*&])?)\s*[*&]?\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*(?:const)?\s*\{/gm;
    
    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      const returnType = match[1].trim();
      const funcName = match[2];
      const params = match[3].trim();
      
      // 跳过 setup 和 loop 函数，它们是 Arduino 的入口函数
      // 也跳过构造函数风格的定义（类名::函数名）
      if (funcName === 'setup' || funcName === 'loop' || funcName === 'if' || 
          funcName === 'while' || funcName === 'for' || funcName === 'switch') {
        continue;
      }
      
      functions.push({
        name: funcName,
        declaration: `${returnType} ${funcName}(${params})`,
        position: match.index
      });
    }
    
    return functions;
  }

  /**
   * 解析代码中的函数调用
   * @param content 已清理的代码内容
   * @returns 函数调用信息数组
   */
  private parseFunctionCalls(content: string): Array<{name: string, position: number}> {
    const calls: Array<{name: string, position: number}> = [];
    const seenCalls = new Map<string, number>(); // 记录每个函数首次调用的位置
    
    // 匹配函数调用: 函数名(
    // 排除函数定义（后面跟着 { 或参数类型）
    const callRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
    
    // C++ 关键字和常见内置函数，需要排除
    const keywords = new Set([
      'if', 'while', 'for', 'switch', 'catch', 'sizeof', 'typeof', 'alignof',
      'decltype', 'static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast',
      'return', 'new', 'delete', 'throw'
    ]);
    
    let match;
    while ((match = callRegex.exec(content)) !== null) {
      const funcName = match[1];
      
      // 跳过关键字
      if (keywords.has(funcName)) {
        continue;
      }
      
      // 只记录首次调用位置
      if (!seenCalls.has(funcName)) {
        seenCalls.set(funcName, match.index);
        calls.push({
          name: funcName,
          position: match.index
        });
      }
    }
    
    return calls;
  }
}
