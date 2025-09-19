import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
// @ts-ignore - 临时忽略类型检查
import Cpp from 'tree-sitter-cpp';
import { Logger } from './utils/Logger';

export interface PreprocessOptions {
  libraries?: string;
  board: any;
}

export interface Dependency {
  name: string;
  path: string;
  type?: 'library' | 'core' | 'sketch' | 'variant';
  includes?: string[];
  others?: string[]
}

export interface PreprocessResult {
  dependencies: Dependency[];
  files: string[];
  includes: string[];
  defines: string[];
}

export interface MacroDefinition {
  name: string;
  value?: string;
  isDefined: boolean;
}

export interface ConditionalInclude {
  include: string;
  condition: string;
  conditionType: 'ifdef' | 'ifndef' | 'if' | 'elif';
  isActive: boolean;
}

export class DependencyAnalyzer {
  private logger: Logger;
  private treeSitterParser: Parser;
  private dependencyList: Map<string, Dependency>
  // private processedFiles: Set<string>;
  private macroDefinitions: Map<string, MacroDefinition>;
  private libraryMap: Map<string, Dependency>

  /**
   * 构造函数，初始化预处理引擎
   * @param logger 日志记录器实例
   */
  constructor(logger: Logger) {
    this.logger = logger;
    this.treeSitterParser = new Parser();
    this.treeSitterParser.setLanguage(Cpp);
    // this.processedFiles = new Set<string>();
    this.dependencyList = new Map<string, Dependency>()
    this.macroDefinitions = new Map<string, MacroDefinition>();
  }

  /**
 * 主预处理函数，分析Arduino项目的依赖关系
 * 包括分析sketch文件、核心SDK依赖、变体依赖和递归库依赖
 * @returns 返回包含所有依赖信息的配置对象
 */
  async preprocess(arduinoConfig): Promise<any> {
    this.logger.verbose('Starting preprocessing with tree-sitter analysis...');
    const sketchName = process.env['SKETCH_NAME'];
    const sketchPath = process.env['SKETCH_PATH'];
    const sketchDir = process.env['SKETCH_DIR_PATH'];

    // 获取核心SDK和库路径
    const coreSDKPath = process.env['SDK_CORE_PATH'];
    const variantPath = process.env['SDK_VARIANT_PATH'];
    const librariesPathEnv = process.env['LIBRARIES_PATH'];
    const coreLibrariesPath = process.env['SDK_CORE_LIBRARIES_PATH'];

    // 处理 librariesPath，支持多个路径（用分号或冒号分隔）
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    const librariesPaths = librariesPathEnv ? librariesPathEnv.split(pathSeparator).filter(p => p.trim()) : [];

    this.logger.debug(`Sketch Path: ${sketchPath}`)
    this.logger.debug(`Core SDK Path: ${coreSDKPath}`);
    this.logger.debug(`Variant Path: ${variantPath}`);
    this.logger.debug(`Core Libraries Path: ${coreLibrariesPath}`);
    this.logger.debug(`Libraries Paths: ${librariesPaths.join(', ')}`);
    this.initializeDefaultMacros(arduinoConfig);

    // 1. 分析主sketch文件
    const mainIncludeFiles = await this.analyzeFile(sketchPath);
    // console.log('mainIncludes', mainIncludeFiles);
    // this.dependencyList.add({
    //   name: sketchName,
    //   path: sketchDir,
    //   type: 'sketch',
    //   includes: [sketchPath]
    // });
    // 2. 添加核心SDK依赖
    let coreDependency, variantDependency;
    if (coreSDKPath) {
      coreDependency = await this.createDependency('core', coreSDKPath);
      if (coreDependency) {
        this.dependencyList.set(`${coreDependency.name}`, coreDependency);
      }
    }
    // 3. 添加变体路径依赖
    if (variantPath) {
      variantDependency = await this.createDependency('variant', variantPath);
      if (variantDependency) {
        this.dependencyList.set(`${variantDependency.name}`, variantDependency);
      }
      // 将variantDependency.includes合并到coreDependency.includes中
      if (variantDependency.includes.length > 0) {
        coreDependency.includes = [...coreDependency.includes, ...variantDependency.includes];
        variantDependency.includes = []
      }
    }


    // 4. 解析路径，解出libraryMap
    this.libraryMap = await this.parserLibraryPaths([coreLibrariesPath, ...librariesPaths]);
    // console.log(this.libraryMap);

    // 5. 递归分析依赖，resolveA用于确定是否处理预编译库
    let resolveA = arduinoConfig.platform['compiler.libraries.ldflags'] ? true : false;
    // console.log(`resolveA: ${resolveA}`);
    await this.resolveDependencies(mainIncludeFiles, resolveA);
    // this.dependencyList = this.deduplicateDependencies(this.dependencyList);
    // console.log(this.dependencyList);
    // this.dependencyList = deduplicateDependencies(this.dependencyList);

    return Array.from(this.dependencyList.values());
  }

  /**
   * 初始化默认的宏定义，如Arduino平台相关的宏
   */
  private initializeDefaultMacros(arduinoConfig): void {
    // Arduino平台默认宏
    this.setMacro('ARDUINO', '100', true);
    // 从 arduinoConfig.platform['recipe.cpp.o.pattern'] 中提取宏定义
    const macros = extractMacroDefinitions(arduinoConfig.platform['recipe.cpp.o.pattern'])
    // console.log('提取的宏定义:', macros);
    // console.log('提取的宏定义:', macros);
    macros.forEach(macro => {
      let [key, value] = macro.split('=')
      this.setMacro(key.trim(), value ? value.trim() : '1');
    })

    this.logger.debug(`Initialized default macros: ${Array.from(this.macroDefinitions.keys()).join(', ')}`);
  }

  /**
   * 设置宏定义
   * @param name 宏名称
   * @param value 宏值（可选）
   * @param isDefined 是否定义
   */
  public setMacro(name: string, value?: string, isDefined: boolean = true): void {
    this.macroDefinitions.set(name, { name, value, isDefined });
  }

  /**
   * 检查宏是否已定义
   * @param name 宏名称
   * @returns 是否已定义
   */
  private isMacroDefined(name: string): boolean {
    const macro = this.macroDefinitions.get(name);
    return macro ? macro.isDefined : false;
  }

  /**
   * 评估条件编译表达式
   * @param condition 条件表达式，如 "defined(ESP32)" 或 "ESP32"
   * @returns 条件是否为真
   */
  private evaluateCondition(condition: string): boolean {
    // 移除空白字符
    const cleanCondition = condition.trim();

    // 处理 ! 否定 - 这需要在其他处理之前
    if (cleanCondition.startsWith('!')) {
      const negatedCondition = cleanCondition.substring(1).trim();
      return !this.evaluateCondition(negatedCondition);
    }

    // 处理 defined(MACRO) 形式
    const definedMatch = cleanCondition.match(/defined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    if (definedMatch) {
      const macroName = definedMatch[1];
      return this.isMacroDefined(macroName);
    }

    // 处理简单的宏名称
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanCondition)) {
      return this.isMacroDefined(cleanCondition);
    }

    // 处理逻辑运算符 && 和 ||
    if (cleanCondition.includes('&&')) {
      const parts = cleanCondition.split('&&').map(p => p.trim());
      return parts.every(part => this.evaluateCondition(part));
    }

    if (cleanCondition.includes('||')) {
      const parts = cleanCondition.split('||').map(p => p.trim());
      return parts.some(part => this.evaluateCondition(part));
    }

    // 默认返回false（未知条件）
    // this.logger.debug(`Unknown condition format: ${condition}`);
    return false;
  }

  /**
   * 使用Tree-sitter解析器分析单个文件的#include指令
   * 支持条件编译指令，如 #if defined(ESP32)
   * @param filePath 要分析的文件路径
   * @returns 返回该文件中包含的所有头文件列表
   */
  private async analyzeFile(filePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const tree = this.treeSitterParser.parse(content);

      let includes: string[] = [];
      const conditionalIncludes: ConditionalInclude[] = [];
      let conditionStack: Array<{ condition: string, isActive: boolean }> = [];

      this.traverseTree(tree.rootNode, (node) => {
        switch (node.type) {
          case 'preproc_ifdef':
          case 'preproc_ifndef':
          case 'preproc_if':
            this.handleConditionalStart(node, conditionStack);
            break;

          case 'preproc_elif':
            this.handleConditionalElif(node, conditionStack);
            break;

          case 'preproc_else':
            this.handleConditionalElse(conditionStack);
            break;

          case 'preproc_endif':
            this.handleConditionalEnd(conditionStack);
            break;

          case 'preproc_include':
            this.handleIncludeDirective(node, conditionStack, includes, conditionalIncludes);
            break;

          case 'preproc_def':
            this.handleDefineDirective(node);
            break;
        }
      });

      // 记录条件编译的include结果
      if (conditionalIncludes.length > 0) {
        // this.logger.debug(`Conditional includes in ${path.basename(filePath)}:`);
        conditionalIncludes.forEach(ci => {
          // this.logger.debug(`  ${ci.include} (${ci.condition}) -> ${ci.isActive ? 'INCLUDED' : 'SKIPPED'}`);
        });
      }

      return includes;
    } catch (error) {
      this.logger.debug(`Failed to analyze file ${filePath}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /**
   * 处理条件编译开始指令 (#if, #ifdef, #ifndef)
   */
  private handleConditionalStart(node: Parser.SyntaxNode, conditionStack: Array<{ condition: string, isActive: boolean }>): void {
    const text = node.text;
    let condition = '';
    let isActive = false;

    if (text.startsWith('#ifdef')) {
      const match = text.match(/#ifdef\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (match) {
        condition = `defined(${match[1]})`;
        isActive = this.isMacroDefined(match[1]);
      }
    } else if (text.startsWith('#ifndef')) {
      const match = text.match(/#ifndef\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (match) {
        condition = `!defined(${match[1]})`;
        isActive = !this.isMacroDefined(match[1]);
      }
    } else if (text.startsWith('#if ')) {
      const match = text.match(/#if\s+(.+)/);
      if (match) {
        condition = match[1].trim();
        isActive = this.evaluateCondition(condition);
      }
    }

    if (condition.trim() !== '') {
      // 检查父级条件是否都为true
      const parentConditionsActive = conditionStack.length === 0 || conditionStack.every(c => c.isActive);
      const effectiveActive = parentConditionsActive && isActive;

      conditionStack.push({ condition, isActive: effectiveActive });
    }
  }

  /**
   * 处理 #elif 指令
   */
  private handleConditionalElif(node: Parser.SyntaxNode, conditionStack: Array<{ condition: string, isActive: boolean }>): void {
    if (conditionStack.length === 0) return;

    const text = node.text;
    const match = text.match(/#elif\s+(.+)/);
    if (match) {
      const condition = match[1].trim();
      const currentLevel = conditionStack[conditionStack.length - 1];

      // elif只有在当前级别的条件为false时才评估
      if (!currentLevel.isActive) {
        const parentConditionsActive = conditionStack.length === 1 ||
          conditionStack.slice(0, -1).every(c => c.isActive);
        const isActive = parentConditionsActive && this.evaluateCondition(condition);

        conditionStack[conditionStack.length - 1] = { condition, isActive };
      }
    }
  }

  /**
   * 处理 #else 指令
   */
  private handleConditionalElse(conditionStack: Array<{ condition: string, isActive: boolean }>): void {
    if (conditionStack.length === 0) return;

    const currentLevel = conditionStack[conditionStack.length - 1];
    const parentConditionsActive = conditionStack.length === 1 ||
      conditionStack.slice(0, -1).every(c => c.isActive);

    // else的激活状态与当前条件相反，但也要考虑父级条件
    const isActive = parentConditionsActive && !currentLevel.isActive;

    conditionStack[conditionStack.length - 1] = {
      condition: `!(${currentLevel.condition})`,
      isActive
    };
  }

  /**
   * 处理 #endif 指令
   */
  private handleConditionalEnd(conditionStack: Array<{ condition: string, isActive: boolean }>): void {
    conditionStack.pop();
  }

  /**
   * 处理 #include 指令
   */
  private handleIncludeDirective(
    node: Parser.SyntaxNode,
    conditionStack: Array<{ condition: string, isActive: boolean }>,
    includes: string[],
    conditionalIncludes: ConditionalInclude[]
  ): void {
    const includeText = node.text;
    const match = includeText.match(/#include\s*[<"]([^>"]+)[>"]/);

    if (match) {
      const includePath = match[1];

      // 检查当前是否在任何条件编译块中
      const isInConditionalBlock = conditionStack.length > 0;

      if (isInConditionalBlock) {
        // 只需要检查当前最内层的条件是否激活
        const currentConditionActive = conditionStack[conditionStack.length - 1].isActive;
        const currentCondition = conditionStack[conditionStack.length - 1].condition;

        conditionalIncludes.push({
          include: includePath,
          condition: currentCondition,
          conditionType: 'if',
          isActive: currentConditionActive
        });

        if (currentConditionActive) {
          includes.push(includePath);
          // this.logger.debug(`Conditional include ACTIVE: ${includePath} (${currentCondition})`);
        } else {
          // this.logger.debug(`Conditional include SKIPPED: ${includePath} (${currentCondition})`);
        }
      } else {
        // 无条件include
        includes.push(includePath);
      }
    }
  }

  /**
   * 处理 #define 指令
   */
  private handleDefineDirective(node: Parser.SyntaxNode): void {
    // this.logger.debug(`Processing #define directive: ${JSON.stringify(node.text)}`);
    const text = node.text;

    // 按行分割文本，处理每个 #define 行
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('#define')) {
        // 匹配 #define 指令，只匹配当前行
        const match = trimmedLine.match(/#define\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)/);

        if (match) {
          const macroName = match[1];
          const macroValue = match[2] ? match[2].trim() : '';
          this.setMacro(macroName, macroValue, true);
          this.logger.debug(`Defined macro: ${macroName} = ${macroValue}`);
        }
      }
    }
  }


  /**
   * 递归遍历语法树节点
   * @param node 当前语法树节点
   * @param callback 对每个节点执行的回调函数
   */
  private traverseTree(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void): void {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
      this.traverseTree(node.child(i)!, callback);
    }
  }

  /**
   * 递归解析依赖关系，查找并添加所有需要的库文件
   * @param includeFiles 当前文件包含的头文件列表
   * @param depth 当前递归深度，默认为0
   * @param maxDepth 最大递归深度，默认为10
   */
  private async resolveDependencies(includeFiles: string[], resolveA = false, depth: number = 0, maxDepth: number = 10): Promise<void> {
    // 检查递归深度限制
    if (depth >= maxDepth) {
      this.logger.debug(`Reached maximum recursion depth (${maxDepth}) while resolving dependencies`);
      return;
    }

    for (const includeFile of includeFiles) {
      // 跳过系统头文件
      if (this.isSystemHeader(includeFile)) {
        continue;
      }

      if (this.libraryMap.has(includeFile)) {
        // 库存在
        const libraryObject = this.libraryMap.get(includeFile)
        // console.log(`Found library for ${includeFile}: ${libraryObject.name}`);

        if (this.dependencyList.has(libraryObject.name)) {
          continue;
        }
        await this.updateLibraryDependency(libraryObject)
        this.dependencyList.set(libraryObject.name, libraryObject);

        // 读取libraryObject.path下的所有.a文件
        if (resolveA) {
          const aFiles = await glob('*.a', {
            cwd: path.join(libraryObject.path, process.env['BUILD_MCU']),
            absolute: true,
            nodir: true
          });
          // console.log(aFiles);
          if (aFiles.length > 0) {
            libraryObject['others'] = aFiles;
          }
        }

        // 读取libraryObject.path下的所有源文件
        let includeFilePaths: string[] = [];
        try {
          const libraryFiles = await glob('**/*.{h,cpp,c}', {
            cwd: libraryObject.path,
            absolute: true,
            nodir: true,
            maxDepth: 9
          });
          includeFilePaths = libraryFiles;
          // console.log('includeFilePaths:', includeFilePaths);
        } catch (error) {
          this.logger.debug(`Failed to read header files in ${libraryObject.path}: ${error instanceof Error ? error.message : error}`);
        }

        // 分析每个源文件
        const libraryIncludeHeaderFiles: string[] = [];
        for (const includeFilePath of includeFilePaths) {
          const headerIncludes = await this.analyzeFile(includeFilePath);
          libraryIncludeHeaderFiles.push(...headerIncludes);
        }
        // if (libraryObject.name == 'WiFi') {
        //   console.log('libraryIncludeHeaderFiles:', libraryIncludeHeaderFiles.join(', '));
        // }
        // const libraryIncludeSourceFiles = libraryIncludeHeaderFiles.filter(f => !this.isSystemHeader(f));
        await this.resolveDependencies(libraryIncludeHeaderFiles, resolveA, depth + 1, maxDepth)
      } else {
        this.logger.verbose(`Not found ${includeFile}`);
      }
    }
  }

  /**
   * 判断给定的头文件是否为系统头文件
   * 系统头文件包括C/C++标准库、ESP-IDF、AVR等平台特定头文件
   * @param include 头文件名
   * @returns 如果是系统头文件返回true，否则返回false
   */
  private isSystemHeader(include: string): boolean {
    const systemHeaders = [
      // Arduino核心文件
      'Arduino.h',
      // 标准C/C++头文件
      'math.h', 'string.h', 'stdio.h', 'stdlib.h', 'stdint.h', 'stdbool.h',
      'inttypes.h', 'stddef.h', 'limits.h', 'float.h', 'time.h', 'cstring',
      'memory', 'vector',

      // IDF特定头文件
      'sdkconfig.h', 'freertos/', 'esp_', 'driver/', 'soc/', 'hal/', 'rom/', 'bootloader_',
      'esp_system.h', 'esp_wifi.h', 'esp_event.h', 'esp_log.h', 'esp_err.h',
      'esp_bt.h', 'esp_gap_', 'esp_gatt_', 'esp_spp_', 'esp_a2dp_',
      'nvs_flash.h', 'nvs.h', 'spiffs.h', 'esp_vfs.h', 'esp_vfs_fat.h',
      'esp_http_client.h', 'esp_https_ota.h', 'esp_ota_ops.h',
      'esp_partition.h', 'esp_flash.h', 'esp_timer.h', 'esp_task_wdt.h',
      'lwip/', 'mbedtls/', 'protocomm/', 'wifi_provisioning/',

      // AVR特定头文件
      'avr/', 'util/', 'pgmspace.h',

      // 其他嵌入式系统头文件
      'arm_', 'cmsis_',
    ];

    // Arduino.h 通常不是系统头文件，需要从核心SDK中找到
    const arduinoHeaders = ['Arduino.h', 'Printable.h', 'Print.h', 'Stream.h', 'WString.h'];

    // 检查是否为标准系统头文件
    const isStandardSystem = systemHeaders.some(header => include.startsWith(header));

    // Arduino核心头文件不应该被跳过，需要从核心SDK中解析
    const isArduinoCore = arduinoHeaders.includes(include);

    return isStandardSystem && !isArduinoCore;
  }

  /**
   * 创建依赖项
   * 扫描指定路径下的所有源文件和头文件
   * @param type 依赖项类型，如 'core' 或 'variant'
   * @param path 核心SDK路径
   * @returns 返回核心SDK依赖项，如果创建失败则返回null
   */
  private async createDependency(type, path: string): Promise<Dependency | null> {
    try {
      const name = type;
      const includeFiles: string[] = [];

      // 扫描核心SDK的源文件和头文件
      const extensions = ['.cpp', '.c', '.S', '.s'];

      // 直接扫描path
      if (await fs.pathExists(path)) {
        const files = await this.scanDirectoryRecursive(path, extensions);
        const filteredFiles = this.filterSourceFiles(files);
        includeFiles.push(...filteredFiles);
        // this.logger.debug(`Found ${files.length} core files in ${coreSDKPath}`);
      }

      return {
        name,
        path,
        type,
        includes: includeFiles
      };
    } catch (error) {
      this.logger.debug(`Failed to create dependency for ${path}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 创建库依赖项
   * 根据库路径扫描其包含的所有源文件和头文件
   * @param libraryPath 库路径（可能是库根目录或src目录）
   * @param originalInclude 原始包含的头文件名
   * @returns 返回库依赖项，如果创建失败则返回null
   */
  private async updateLibraryDependency(libraryObject: Dependency): Promise<boolean> {
    try {
      const extensions = ['.cpp', '.c', '.S', '.s'];
      // 直接扫描传入的路径（可能是库根目录或src目录）
      const files = await this.scanDirectoryRecursive(libraryObject.path, extensions);
      // const filteredFiles = this.filterSourceFiles(files);
      // console.log(files);

      libraryObject.includes.push(...files);
      return true
    } catch (error) {
      this.logger.debug(`Failed to create library dependency for ${libraryObject.name}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 检查指定目录是否包含源文件
   * 检查是否存在.cpp、.c、.s、.h文件
   * @param dirPath 要检查的目录路径
   * @returns 如果包含源文件返回true，否则返回false
   */
  private async hasSourceFiles(dirPath: string): Promise<boolean> {
    if (!await fs.pathExists(dirPath)) {
      return false;
    }

    try {
      // 使用glob检查是否有源文件
      const files = await glob('*.{cpp,c,s,h}', {
        cwd: dirPath,
        nodir: true,
        maxDepth: 1  // 只检查当前目录，不递归
      });

      return files.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * 递归扫描目录以查找指定扩展名的文件
   * 自动排除examples和extras目录
   * @param dir 要扫描的目录
   * @param extensions 要查找的文件扩展名数组
   * @returns 返回找到的所有匹配文件的绝对路径列表
   */
  private async scanDirectoryRecursive(dir: string, extensions: string[]): Promise<string[]> {
    if (!await fs.pathExists(dir)) {
      return [];
    }

    try {
      // 创建glob模式来匹配指定扩展名的文件
      const patterns = extensions.map(ext => `**/*${ext}`);
      const globPattern = patterns.length === 1 ? patterns[0] : `**/*.{${extensions.map(ext => ext.slice(1)).join(',')}}`;

      // 使用glob搜索文件，排除examples和extras目录
      const files = await glob(globPattern, {
        cwd: dir,
        absolute: true,
        ignore: ['**/examples/**', '**/extras/**'],
        nodir: true
      });

      // 去重
      return [...new Set(files)];
    } catch (error) {
      this.logger.debug(`Failed to scan directory ${dir}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /**
   * 过滤源文件，解决同一基本名称但扩展名不同的文件冲突。
   * 优先级: .S > .s > .cpp > .c
   * @param files 文件路径数组
   * @returns 过滤后的文件路径数组
   */
  private filterSourceFiles(files: string[]): string[] {
    // 首先按架构过滤库文件
    const architectureFilteredFiles = this.filterByArchitecture(files);

    // 然后按扩展名优先级过滤
    const fileMap = new Map<string, string>();
    const precedence = ['.S', '.s', '.cpp', '.c'];

    for (const file of architectureFilteredFiles) {
      const ext = path.extname(file);
      const base = file.slice(0, -ext.length);

      if (precedence.includes(ext)) {
        const existingFile = fileMap.get(base);
        if (existingFile) {
          const existingExt = path.extname(existingFile);
          if (precedence.indexOf(ext) < precedence.indexOf(existingExt)) {
            // 当前文件有更高优先级
            fileMap.set(base, file);
          }
        } else {
          fileMap.set(base, file);
        }
      }
    }

    return Array.from(fileMap.values());
  }

  /**
   * 按架构过滤库文件，优先选择与目标架构匹配的文件
   */
  private filterByArchitecture(files: string[]): string[] {
    // 定义架构优先级，AVR架构优先
    const architecturePriority = ['avr', 'megaavr'];
    // 定义所有已知的架构目录（包括我们不支持的）
    const allArchitectures = ['avr', 'megaavr', 'xmc', 'samd', 'stm32f4', 'renesas', 'sam', 'nrf52', 'mbed'];

    // 将文件按架构分组
    const architectureGroups = new Map<string, string[]>();
    const generalFiles: string[] = [];

    for (const file of files) {
      const normalizedPath = file.replace(/\\/g, '/');
      let foundArchitecture = false;

      // 首先检查是否匹配我们支持的架构
      for (const arch of architecturePriority) {
        if (normalizedPath.includes(`/${arch}/`)) {
          if (!architectureGroups.has(arch)) {
            architectureGroups.set(arch, []);
          }
          architectureGroups.get(arch)!.push(file);
          foundArchitecture = true;
          break;
        }
      }

      if (!foundArchitecture) {
        // 检查是否是其他架构的文件（应该被排除）
        let isOtherArchitecture = false;
        for (const arch of allArchitectures) {
          if (normalizedPath.includes(`/${arch}/`)) {
            isOtherArchitecture = true;
            break;
          }
        }

        if (!isOtherArchitecture) {
          // 没有架构标识的文件（如根目录下的文件）
          generalFiles.push(file);
        }
      }
    }

    // 按优先级选择架构
    for (const arch of architecturePriority) {
      if (architectureGroups.has(arch)) {
        const archFiles = architectureGroups.get(arch)!;
        const result = [...archFiles, ...generalFiles];
        // 如果找到架构特定的文件，返回这些文件加上通用文件
        return result;
      }
    }

    // 如果没有找到任何架构特定的文件，返回通用文件
    return generalFiles;
  }

  async parserLibraryPaths(paths: (string | undefined)[]): Promise<Map<string, Dependency>> {
    // console.log('找到库列表:');
    const resultDirs = new Set<string>();
    for (const libPath of paths) {
      if (libPath && await fs.pathExists(libPath)) {
        const sourceDirs = await this.findSourceDirectories(libPath);
        sourceDirs.forEach(dir => resultDirs.add(dir));
      }
    }
    // console.log(resultDirs);
    // 构建头文件到库信息的映射
    const libraryMap = new Map<string, Dependency>();
    for (const dir of resultDirs) {
      let libName = path.basename(dir);
      if (libName === 'src') {
        libName = path.basename(path.dirname(dir));
      }
      let libObject: Dependency = {
        path: dir,
        name: libName,
        type: 'library',
        includes: [],
        others: []
      }

      try {
        // 扫描目录中的所有.h文件，只搜索当前目录，不递归子目录
        const headerFiles = await glob('*.h', {
          cwd: dir,
          absolute: true,
          nodir: true
        });
        // console.log(headerFiles);
        for (const headerFile of headerFiles) {
          const headerName = path.basename(headerFile);
          libraryMap.set(headerName, libObject);
        }
      } catch (error) {
        this.logger.debug(`Failed to scan headers in ${dir}: ${error instanceof Error ? error.message : error}`);
      }
    }

    // console.log(libraryMap);
    return libraryMap;
  }

  /**
   * 搜索包含源文件的目录，只要上级目录中有源文件就停止搜索
   * @param libPath 要搜索的根路径
   * @returns 返回包含源文件的目录数组
   */
  private async findSourceDirectories(libPath: string): Promise<string[]> {
    const sourceDirs = new Set<string>();

    try {
      // 使用glob搜索所有源文件（.h, .c, .cpp, .S）
      const patterns = ['**/*.h', '**/*.c', '**/*.cpp', '**/*.S'];
      const files: string[] = [];

      for (const pattern of patterns) {
        const matchedFiles = await glob(pattern, {
          cwd: libPath,
          absolute: true,
          nodir: true,
          ignore: ['**/examples/**', '**/extras/**', '**/test/**', '**/tests/**', '**/docs/**']
        });
        files.push(...matchedFiles);
      }

      // 获取文件所在的目录
      const fileDirs = new Set(files.map(file => path.dirname(file)));

      // 过滤逻辑：如果上级目录已经包含源文件，则不添加子目录
      for (const dir of fileDirs) {
        let shouldAdd = true;

        // 检查当前目录是否是已存在目录的子目录
        for (const existingDir of sourceDirs) {
          if (dir.startsWith(existingDir + path.sep)) {
            // 当前目录是已存在目录的子目录，跳过
            shouldAdd = false;
            break;
          }
        }

        if (shouldAdd) {
          // 检查是否需要移除已存在的子目录（因为找到了父目录）
          const dirsToRemove = new Set<string>();
          for (const existingDir of sourceDirs) {
            if (existingDir.startsWith(dir + path.sep)) {
              dirsToRemove.add(existingDir);
            }
          }
          // 移除子目录
          dirsToRemove.forEach(d => sourceDirs.delete(d));
          // 添加当前目录
          sourceDirs.add(dir);
        }
      }

    } catch (error) {
      this.logger.debug(`Failed to find source directories in ${libPath}: ${error instanceof Error ? error.message : error}`);
    }

    return Array.from(sourceDirs);
  }
}

function extractMacroDefinitions(text: string): string[] {
  // 使用正则表达式匹配 -D 后的宏定义
  // 匹配 -D 后跟非空白字符，直到遇到空格或引号结束
  const regex = /-D([^\s]+(?:"[^"]*")?[^\s]*)/g;
  const macros = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    // 去除可能的引号
    let macro = match[1];
    if (macro.startsWith('"') && macro.endsWith('"')) {
      macro = macro.slice(1, -1);
    }
    macros.push(macro);
  }

  return macros;
}