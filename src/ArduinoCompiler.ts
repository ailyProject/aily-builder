import fs from 'fs-extra';
import path from 'path';
import { Logger } from './utils/Logger';
import { NinjaCompilationPipeline } from './NinjaCompilationPipeline';
import { CompileConfigManager } from './CompileConfigManager';
import { ArduinoConfigParser } from './ArduinoConfigParser';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import { sanitizeObjectPaths } from './utils/ShortPath';
import { collectPackageIdentitiesFromPaths, extractPackageIdentityFromPath } from './utils/PackageIdentity';
import { RecipeRunner, RecipeRunnerError } from './RecipeRunner';
import type { ArduinoUploadCommand } from './ArduinoUploadCommand';

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
  upload?: ArduinoUploadCommand;
  compileConfig?: any;
  dependencies?: any[];
  error?: string;
  cacheIdentity?: ArchiveCacheIdentity;
  // 保存编译所需的环境变量
  envVars?: Record<string, string>;
}

export interface ArchiveCacheIdentity {
  sdkIdentity?: string;
  toolPackages?: string[];
  requestedToolVersions?: Record<string, string>;
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
      const parsedArduinoConfig = await this.arduinoConfigParser.parseByFQBN(
        options.board,
        options.buildProperties || {},
        options.toolVersions || {},
        options.buildMacros || []
      );
      const { upload, ...arduinoConfig } = parsedArduinoConfig;

      // Global prebuild hooks may generate response files, headers and source
      // files consumed by compile configuration and dependency analysis.
      await this.runGlobalPrebuild(arduinoConfig, options.buildPath);

      // Preserve the fast analyzer: only the read-only work remains parallel,
      // after the mandatory prebuild barrier.
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

      const cacheIdentity = this.createArchiveCacheIdentity(options, arduinoConfig, compileConfig);
      (compileConfig as any).cacheIdentity = cacheIdentity;

      return {
        success: true,
        preprocessTime,
        arduinoConfig,
        upload,
        compileConfig,
        dependencies,
        cacheIdentity,
        envVars
      };
    } catch (error) {
      const preprocessTime = Date.now() - startTime;
      const errorMessage = this.formatRecipeError(error);
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

    try {
      return await this.compileInternal(options, startTime);
    } catch (error) {
      const errorMessage = this.formatRecipeError(error);
      this.logger.error(`Compilation failed: ${errorMessage}`);
      return {
        success: false,
        preprocessTime: 0,
        buildTime: 0,
        totalTime: Date.now() - startTime,
        error: errorMessage,
        warnings: [`Compilation error: ${errorMessage}`]
      };
    }
  }

  private async compileInternal(options: CompileOptions, startTime: number): Promise<CompileResult> {

    this.logger.info(`Starting compilation process...`);

    let preprocessTime: number;
    let arduinoConfig: any;
    let compileConfig: any;
    let dependencies: any[];
    let reusedPreprocessResult = false;

    // 检查是否提供了预处理结果
    if (options.preprocessResult && options.preprocessResult.success) {
      this.logger.info('Using provided preprocess result, skipping preprocessing...');
      preprocessTime = options.preprocessResult.preprocessTime;
      arduinoConfig = options.preprocessResult.arduinoConfig;
      compileConfig = options.preprocessResult.compileConfig;
      dependencies = options.preprocessResult.dependencies!;
      reusedPreprocessResult = true;
      if (options.preprocessResult.cacheIdentity && compileConfig && !compileConfig.cacheIdentity) {
        compileConfig.cacheIdentity = options.preprocessResult.cacheIdentity;
      }
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
      if (preprocessResult.cacheIdentity && compileConfig && !compileConfig.cacheIdentity) {
        compileConfig.cacheIdentity = preprocessResult.cacheIdentity;
      }
    }

    const buildStartTime = Date.now();

    // 在 Windows 上，对配置和依赖中嵌入的所有路径做 sanitize
    arduinoConfig = sanitizeObjectPaths(arduinoConfig);
    compileConfig = sanitizeObjectPaths(compileConfig);
    dependencies = sanitizeObjectPaths(dependencies);
    // Preprocess results store the platform once, under arduinoConfig. Attach
    // the runtime view only when the Ninja pipeline is about to consume it.
    compileConfig.arduino = arduinoConfig;

    // A preprocess result describes generated inputs but does not embed them.
    // Replay global hooks so a cleaned/interrupted build directory is restored
    // before Ninja consumes build.opt, partitions or generated sketch sources.
    if (reusedPreprocessResult) {
      await this.runGlobalPrebuild(arduinoConfig, options.buildPath);
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
        error: compileResult.error || 'Compilation failed',
        warnings: compileResult.warnings
      };
    }

    // The pipeline now owns the complete hook/objcopy lifecycle and returns an
    // output that actually exists instead of guessing from platform families.
    const finalOutputPath = compileResult.outFilePath;

    const finishedAt = Date.now();
    const totalTime = finishedAt - startTime;
    const buildTime = finishedAt - buildStartTime;
    // 6. 计算固件大小信息
    const firmwareSize = await this.calculateFirmwareSize(arduinoConfig);

    return {
      success: true,
      preprocessTime,
      buildTime,
      totalTime,
      outFilePath: finalOutputPath,
      firmwareSize,
      warnings: compileResult.warnings
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

  private createArchiveCacheIdentity(options: CompileOptions, arduinoConfig: any, compileConfig: any): ArchiveCacheIdentity {
    const platform = arduinoConfig?.platform || {};
    const sdkPath = platform['runtime.platform.path'] || process.env['SDK_PATH'];
    const sdkIdentity = extractPackageIdentityFromPath(
      sdkPath,
      arduinoConfig?.fqbnParsed?.platform || process.env['platform']
    );
    const toolPackages = this.collectCompileRelevantToolPackages(platform, compileConfig);

    return {
      ...(sdkIdentity ? { sdkIdentity } : {}),
      ...(toolPackages.length > 0 ? { toolPackages } : {}),
      ...(options.toolVersions && Object.keys(options.toolVersions).length > 0
        ? { requestedToolVersions: { ...options.toolVersions } }
        : {})
    };
  }

  private collectCompileRelevantToolPackages(platform: Record<string, any>, compileConfig: any): string[] {
    const compileText = [
      compileConfig?.args?.c,
      compileConfig?.args?.cpp,
      compileConfig?.args?.s,
      compileConfig?.compiler?.c,
      compileConfig?.compiler?.cpp,
      compileConfig?.compiler?.ar
    ].filter(Boolean).join('\n').replace(/\\/g, '/');

    const paths: string[] = [];
    for (const [key, value] of Object.entries(platform || {})) {
      if (typeof value !== 'string') {
        continue;
      }

      const normalized = value.replace(/\\/g, '/');
      if (key === 'compiler.sdk.path' || (key.startsWith('runtime.tools.') && compileText.includes(normalized))) {
        paths.push(value);
      }
    }

    return collectPackageIdentitiesFromPaths(paths);
  }


  /*  验证sketch文件
  */
  private async validateSketch(sketchPath: string): Promise<void> {
    if (!await fs.pathExists(sketchPath)) {
      throw new Error(`Sketch file not found: ${sketchPath}`);
    }

    const sourceExt = path.extname(sketchPath).toLowerCase();
    if (sourceExt !== '.ino' && sourceExt !== '.cpp') {
      throw new Error(`Invalid sketch file extension. Expected .ino or .cpp file: ${sketchPath}`);
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

      const sourcePath = process.env['SKETCH_PATH']!;
      const sourceExt = path.extname(sourcePath).toLowerCase();
      const isInoSource = sourceExt === '.ino';
      const isCppSource = sourceExt === '.cpp';

      // 准备构建目录中的 .cpp 文件
      const targetPath = path.join(process.env['BUILD_PATH']!, process.env['SKETCH_NAME'] + '.cpp');

      if (!isInoSource && !isCppSource) {
        throw new Error(`Unsupported sketch extension for build preparation: ${sourceExt}`);
      }

      // 读取原始源文件内容
      let content = await fs.readFile(sourcePath, 'utf-8');

      if (isInoSource) {
        // 检查是否已包含 Arduino.h
        const hasArduinoInclude = /#include\s*[<"]Arduino\.h[>"]/i.test(content);

        if (!hasArduinoInclude) {
          this.logger.verbose('Adding #include <Arduino.h> to sketch');
          // 在文件开头添加 Arduino.h
          content = '#include <Arduino.h>\n' + content;
        }
      }

      // 为 .ino 和“sketch 风格”的 .cpp 都尝试补前向声明
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

      if (isCppSource && forwardDeclarations.length === 0) {
        if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
          await fs.copyFile(sourcePath, targetPath);
        }
        this.logger.verbose(`Copied .cpp source to build directory: ${targetPath}`);
        process.env['SKETCH_PATH'] = targetPath;
        return;
      }

      // 添加行号指令（用于更好的错误定位）
      const lineDirective = `# 1 "${sourcePath.replace(/\\/g, '\\\\')}"\n`;
      content = lineDirective + content;

      // 写入新的 .cpp 文件
      await fs.writeFile(targetPath, content, 'utf-8');

      // 更新环境变量指向新的 .cpp 文件
      process.env['SKETCH_PATH'] = targetPath;
    } catch (error) {
      throw new Error(`Failed to prepare build directory: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async runRecipeGroup(
    arduinoConfig: any,
    prefix: string,
    label: string,
    cwd = process.env['BUILD_PATH'] || process.cwd()
  ): Promise<void> {
    const runner = new RecipeRunner(arduinoConfig?.platform || {}, {
      cwd,
      env: process.env,
      windowsHide: true
    });
    const recipeKeys = runner.findRecipes(prefix, '.pattern');
    if (recipeKeys.length === 0) {
      return;
    }

    this.logger.info(`${label}: ${recipeKeys.length} recipe(s)`);
    for (const recipeKey of recipeKeys) {
      this.logger.verbose(`Running recipe: ${recipeKey}`);
    }

    const results = await runner.runRecipes(prefix, '.pattern');
    for (const result of results) {
      if (result.stdout.trim()) {
        this.logger.verbose(`${result.recipeKey} stdout: ${result.stdout.trim()}`);
      }
      if (result.stderr.trim()) {
        this.logger.verbose(`${result.recipeKey} stderr: ${result.stderr.trim()}`);
      }
    }
  }

  private formatRecipeError(error: unknown): string {
    if (!(error instanceof RecipeRunnerError)) {
      return error instanceof Error ? error.message : String(error);
    }

    const recipeKey = error.details.recipeKey || 'unknown recipe';
    const stdout = error.details.stdout?.trim();
    const stderr = error.details.stderr?.trim();
    const expandedCommand = error.details.expandedCommand;
    if (expandedCommand) {
      this.logger.verbose(`Failed recipe command (${recipeKey}): ${expandedCommand}`);
    }
    if (stderr) {
      this.logger.error(`${recipeKey} stderr: ${stderr}`);
    }
    if (stdout) {
      this.logger.error(`${recipeKey} stdout: ${stdout}`);
    }

    return [
      `${error.message} [${recipeKey}]`,
      stderr ? `stderr: ${stderr.slice(0, 4000)}` : undefined,
      stdout ? `stdout: ${stdout.slice(0, 4000)}` : undefined
    ].filter(Boolean).join('\n');
  }

  private async runGlobalPrebuild(arduinoConfig: any, buildPath: string): Promise<void> {
    await fs.ensureDir(buildPath);

    // ESP32 selects partitions with "source > variant > platform" semantics.
    // Reset the generated copy so replaying a saved preprocess result cannot
    // accidentally retain a partitions.csv from an older source state.
    const partitionsPath = path.join(buildPath, 'partitions.csv');
    if (await fs.pathExists(partitionsPath)) {
      await fs.remove(partitionsPath);
    }

    await this.runRecipeGroup(
      arduinoConfig,
      'recipe.hooks.prebuild',
      'Global prebuild',
      buildPath
    );
  }

  async runPreBuildHooks(arduinoConfig: any) {
    await this.runRecipeGroup(arduinoConfig, 'recipe.hooks.prebuild', 'Global prebuild');
  }

  async runPostBuildHooks(arduinoConfig) {
    await this.runRecipeGroup(
      arduinoConfig,
      'recipe.hooks.objcopy.postobjcopy',
      'Objcopy postbuild'
    );
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

      // Size is a normal platform recipe and follows the same argv/property
      // semantics as hooks and objcopy commands.
      const runner = new RecipeRunner(arduinoConfig.platform, {
        cwd: process.env['BUILD_PATH'] || process.cwd(),
        env: process.env,
        windowsHide: true
      });
      const sizeResults = await runner.runRecipes('recipe.size', '.pattern');
      if (sizeResults.length === 0) {
        return { sections: [] };
      }
      const output = sizeResults
        .map(result => [result.stdout, result.stderr].filter(Boolean).join('\n'))
        .join('\n');

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
  private parseFunctionDefinitions(content: string): Array<{ name: string, declaration: string, position: number }> {
    const functions: Array<{ name: string, declaration: string, position: number }> = [];

    // 首先识别类/结构体的范围，以便排除成员函数
    const classRanges = this.findClassRanges(content);

    // 匹配函数定义的正则表达式
    // 支持: 返回类型 函数名(参数列表) { 或 返回类型 函数名(参数列表) 换行 {
    // 改进：支持复合类型如 unsigned long, signed int, long long 等
    // 返回类型组成：[static/inline/etc] + [unsigned/signed] + [long/short] + [long] + 基本类型/标识符 + [*/&]
    const typeKeywords = '(?:void|int|char|float|double|bool|String|byte|word|size_t|uint\\d+_t|int\\d+_t|long|short)';
    const typeModifiers = '(?:(?:static|inline|virtual|explicit|constexpr|extern)\\s+)*';
    const signModifier = '(?:(?:unsigned|signed)\\s+)?';
    const sizeModifier = '(?:(?:long|short)\\s+)*';
    const customType = '(?:[A-Z][a-zA-Z0-9_]*)';
    const pointerRef = '(?:\\s*[*&])?';

    // 完整的返回类型模式
    const returnTypePattern = `(${typeModifiers}${signModifier}${sizeModifier}(?:${typeKeywords}|${customType})${pointerRef}\\s*)`;
    const functionRegex = new RegExp(
      `^[ \\t]*${returnTypePattern}([\\p{L}_][\\p{L}\\p{N}_]*)\\s*\\(([^{]*?)\\)\\s*(?:const)?\\s*\\{`,
      // `^[ \\t]*${returnTypePattern}([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(([^{]*?)\\)\\s*(?:const)?\\s*\\{`,
      'gmu'
    );

    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      const returnType = match[1].trim();
      const funcName = match[2];
      let params = match[3].trim();

      // 跳过 setup 和 loop 函数，它们是 Arduino 的入口函数
      // 也跳过 C++ 关键字
      if (funcName === 'setup' || funcName === 'loop' || funcName === 'if' ||
        funcName === 'while' || funcName === 'for' || funcName === 'switch') {
        continue;
      }

      // 检查该函数是否在类定义内部
      const funcPosition = match.index;
      const isInsideClass = classRanges.some(range =>
        funcPosition > range.start && funcPosition < range.end
      );

      if (isInsideClass) {
        // 跳过类成员函数
        continue;
      }

      // 处理嵌套括号的参数（如函数指针）
      params = this.extractBalancedParams(content, match.index + match[0].indexOf('('));

      functions.push({
        name: funcName,
        declaration: `${returnType} ${funcName}(${params})`,
        position: match.index
      });
    }

    return functions;
  }

  /**
   * 查找代码中所有类和结构体的范围
   * @param content 代码内容
   * @returns 类定义的范围数组
   */
  private findClassRanges(content: string): Array<{ start: number, end: number }> {
    const ranges: Array<{ start: number, end: number }> = [];

    // 匹配 class 或 struct 关键字
    const classRegex = /\b(?:class|struct)\s+\w+[^{]*\{/g;

    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const start = match.index;
      const braceStart = match.index + match[0].length - 1;

      // 找到匹配的结束大括号
      let braceCount = 1;
      let i = braceStart + 1;

      while (i < content.length && braceCount > 0) {
        if (content[i] === '{') {
          braceCount++;
        } else if (content[i] === '}') {
          braceCount--;
        }
        i++;
      }

      ranges.push({ start, end: i });
    }

    return ranges;
  }

  /**
   * 提取平衡括号内的参数
   * 处理嵌套括号的情况，如函数指针参数
   * @param content 代码内容
   * @param openParenIndex 开括号位置
   * @returns 参数字符串
   */
  private extractBalancedParams(content: string, openParenIndex: number): string {
    let parenCount = 0;
    let start = -1;
    let i = openParenIndex;

    // 找到开括号
    while (i < content.length && content[i] !== '(') {
      i++;
    }

    if (i >= content.length) return '';

    start = i + 1;
    parenCount = 1;
    i++;

    // 找到匹配的闭括号
    while (i < content.length && parenCount > 0) {
      if (content[i] === '(') {
        parenCount++;
      } else if (content[i] === ')') {
        parenCount--;
      }
      i++;
    }

    return content.slice(start, i - 1).trim();
  }

  /**
   * 解析代码中的函数调用
   * @param content 已清理的代码内容
   * @returns 函数调用信息数组
   */
  private parseFunctionCalls(content: string): Array<{ name: string, position: number }> {
    const calls: Array<{ name: string, position: number }> = [];
    const seenCalls = new Map<string, number>(); // 记录每个函数首次调用的位置

    // 匹配函数调用: 函数名(
    // 排除函数定义（后面跟着 { 或参数类型）
    const callRegex = /(?<![\p{L}\p{N}_])([\p{L}_][\p{L}\p{N}_]*)\s*\(/gu;
    // const callRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

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
