import fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { Logger } from './utils/Logger';
import { analyzeFile } from './utils/AnalyzeFile';

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
    this.logger.verbose('Starting dependency analysis...');
    const sketchPath = process.env['SKETCH_PATH'];

    // 获取核心SDK和库路径
    const coreSDKPath = process.env['SDK_CORE_PATH'];
    const variantPath = process.env['SDK_VARIANT_PATH'];
    const librariesPathEnv = process.env['LIBRARIES_PATH'];
    const coreLibrariesPath = process.env['SDK_CORE_LIBRARIES_PATH'];

    // 处理 librariesPath，支持多个路径（用分号或冒号分隔）
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    const librariesPaths = librariesPathEnv ? librariesPathEnv.split(pathSeparator).filter(p => p.trim()) : [];

    this.logger.info(`- Sketch Path: ${sketchPath}`)
    this.logger.info(`- Core SDK Path: ${coreSDKPath}`);
    this.logger.info(`- Variant Path: ${variantPath}`);
    this.logger.info(`- Core Libraries Path: ${coreLibrariesPath}`);
    this.logger.info(`- Libraries Paths: ${librariesPaths.join(', ')}`);
    this.initializeDefaultMacros(arduinoConfig);

    // 1. 分析主sketch文件
    const mainIncludeFiles = await analyzeFile(sketchPath, this.macroDefinitions);

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
      // 不要将变体文件合并到核心依赖中，保持变体文件独立
      // 变体文件应该作为独立的对象文件直接链接，而不是包含在预编译库中
    }

    // 4. 解析路径，解出libraryMap
    this.libraryMap = await this.parserLibraryPaths([coreLibrariesPath, ...librariesPaths]);
    // this.logger.debug(JSON.stringify(Object.fromEntries(this.libraryMap)));

    // 4.5. 添加平台特定的必需库（如 STM32 SrcWrapper）
    await this.addPlatformSpecificLibraries(arduinoConfig);

    // 5. 递归分析依赖，resolveA用于确定是否处理预编译库
    let resolveA = arduinoConfig.platform['compiler.libraries.ldflags'] ? true : false;
    await this.resolveDependencies(mainIncludeFiles, resolveA);

    return Array.from(this.dependencyList.values());
  }

  /**
   * 初始化默认的宏定义，如Arduino平台相关的宏
   */
  private initializeDefaultMacros(arduinoConfig): void {
    // Arduino平台默认宏
    this.setMacro('ARDUINO', '100', true);
    
    // 从 arduinoConfig.platform['recipe.cpp.o.pattern'] 中提取宏定义
    this.logger.debug('[MACRO_DEBUG] Extracting macros from recipe.cpp.o.pattern...');
    const macros = extractMacroDefinitions(arduinoConfig.platform['recipe.cpp.o.pattern'])
    this.logger.debug(`[MACRO_DEBUG] Found ${macros.length} macros from recipe: ${macros.join(', ')}`);
    macros.forEach(macro => {
      let [key, value] = macro.split('=')
      this.setMacro(key.trim(), value ? value.trim() : '1');
    })

    // 从 build.macros 中提取用户自定义宏定义
    if (arduinoConfig.platform['build.macros']) {
      this.logger.debug('[MACRO_DEBUG] Extracting macros from build.macros...');
      this.logger.debug(`[MACRO_DEBUG] build.macros content: ${arduinoConfig.platform['build.macros']}`);
      const extraFlagsMacros = extractMacroDefinitions(arduinoConfig.platform['build.macros']);
      this.logger.debug(`[MACRO_DEBUG] Found ${extraFlagsMacros.length} macros from build.macros: ${extraFlagsMacros.join(', ')}`);
      extraFlagsMacros.forEach(macro => {
        let [key, value] = macro.split('=')
        this.setMacro(key.trim(), value ? value.trim() : '1');
      });
    }

    // 打印所有宏定义的详细信息
    this.logger.debug('[MACRO_DEBUG] All macro definitions:');
    this.macroDefinitions.forEach((macroDef, name) => {
      this.logger.debug(`[MACRO_DEBUG]   ${name} = ${macroDef.value} (defined: ${macroDef.isDefined})`);
    });
    
    this.logger.info(`Initialized default macros: ${Array.from(this.macroDefinitions.keys()).join(', ')}`);
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
    const result = macro ? macro.isDefined : false;
    this.logger.debug(`isMacroDefined("${name}") -> ${result} (macro: ${JSON.stringify(macro)})`);
    return result;
  }

  /**
   * 评估条件编译表达式
   * @param condition 条件表达式，如 "defined(ESP32)" 或 "ESP32"
   * @returns 条件是否为真
   */
  private evaluateCondition(condition: string): boolean {
    // 移除空白字符
    const cleanCondition = condition.trim();
    
    this.logger.debug(`Evaluating condition: "${condition}" -> "${cleanCondition}"`);

    // 处理 ! 否定 - 这需要在其他处理之前
    if (cleanCondition.startsWith('!')) {
      const negatedCondition = cleanCondition.substring(1).trim();
      const result = !this.evaluateCondition(negatedCondition);
      this.logger.debug(`Negation result for "${condition}": ${result}`);
      return result;
    }

    // 处理 defined(MACRO) 形式
    const definedMatch = cleanCondition.match(/defined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    if (definedMatch) {
      const macroName = definedMatch[1];
      const result = this.isMacroDefined(macroName);
      this.logger.debug(`defined(${macroName}) -> ${result}`);
      return result;
    }

    // 处理数值比较 (如 GCC_VERSION < 60300)
    const comparisonMatch = cleanCondition.match(/([A-Za-z_][A-Za-z0-9_]*)\s*([<>=!]+)\s*(\d+)/);
    if (comparisonMatch) {
      const macroName = comparisonMatch[1];
      const operator = comparisonMatch[2];
      const targetValue = parseInt(comparisonMatch[3]);
      
      const macro = this.macroDefinitions.get(macroName);
      
      // 如果宏未定义，在数值比较中视为0（这是C预处理器的标准行为）
      let macroValue = 0;
      if (macro && macro.value) {
        const parsedValue = parseInt(macro.value);
        macroValue = isNaN(parsedValue) ? 0 : parsedValue;
      }
      
      let result = false;
      switch (operator) {
        case '<':
          result = macroValue < targetValue;
          break;
        case '<=':
          result = macroValue <= targetValue;
          break;
        case '>':
          result = macroValue > targetValue;
          break;
        case '>=':
          result = macroValue >= targetValue;
          break;
        case '==':
          result = macroValue === targetValue;
          break;
        case '!=':
          result = macroValue !== targetValue;
          break;
      }
      
      this.logger.debug(`Comparison ${macroName}(${macroValue}) ${operator} ${targetValue} -> ${result}`);
      return result;
    }

    // 处理简单的宏名称
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanCondition)) {
      const result = this.isMacroDefined(cleanCondition);
      this.logger.debug(`Macro "${cleanCondition}" defined: ${result}`);
      return result;
    }

    // 处理逻辑运算符 && 和 ||
    if (cleanCondition.includes('&&')) {
      const parts = cleanCondition.split('&&').map(p => p.trim());
      const result = parts.every(part => this.evaluateCondition(part));
      this.logger.debug(`AND condition "${condition}" -> ${result}`);
      return result;
    }

    if (cleanCondition.includes('||')) {
      const parts = cleanCondition.split('||').map(p => p.trim());
      const result = parts.some(part => this.evaluateCondition(part));
      this.logger.debug(`OR condition "${condition}" -> ${result}`);
      return result;
    }

    // 默认返回false（未知条件）
    this.logger.debug(`Unknown condition format: ${condition} -> false`);
    return false;
  }

  /**
   * 递归解析依赖关系，查找并添加所有需要的库文件
   * @param includeFiles 当前文件包含的头文件列表
   * @param depth 当前递归深度，默认为0
   * @param maxDepth 最大递归深度，默认为10
   */
  private async resolveDependencies(includeFiles: string[], resolveA = false, depth: number = 0, maxDepth: number = 10, macroDefinitions = this.macroDefinitions): Promise<void> {
    // 检查递归深度限制
    if (depth >= maxDepth) {
      this.logger.debug(`Reached maximum recursion depth (${maxDepth}) while resolving dependencies`);
      return;
    }

    for (const includeFile of includeFiles) {
      // 跳过系统头文件
      if (this.isSystemHeader(includeFile)) {
        this.logger.debug(`Skipping system header: ${includeFile}`);
        continue;
      }

      if (this.libraryMap.has(includeFile)) {
        // 库存在
        const libraryObject = this.libraryMap.get(includeFile)
        this.logger.debug(`Found library for ${includeFile}: ${libraryObject.name}`);

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
          const libraryFiles = await glob('**/*.{h,hpp,cpp,c}', {
            cwd: libraryObject.path,
            absolute: true,
            nodir: true,
            ignore: ['**/examples/**', '**/extras/**', '**/test/**', '**/tests/**', '**/docs/**']
          });
          includeFilePaths = libraryFiles;
          // console.log('includeFilePaths:', includeFilePaths);
        } catch (error) {
          this.logger.debug(`Failed to read header files in ${libraryObject.path}: ${error instanceof Error ? error.message : error}`);
        }

        // 分析每个源文件
        let macroDefinitions_copy = new Map(macroDefinitions);
        const libraryIncludeHeaderFiles: string[] = [];
        for (const includeFilePath of includeFilePaths) {
          const headerIncludes = await await analyzeFile(includeFilePath, macroDefinitions_copy);
          libraryIncludeHeaderFiles.push(...headerIncludes);
        }

        await this.resolveDependencies(libraryIncludeHeaderFiles, resolveA, depth + 1, maxDepth, macroDefinitions_copy)
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
  private async createDependency(type, dependencyPath: string): Promise<Dependency | null> {
    try {
      const name = type;
      const includeFiles: string[] = [];

      // 扫描核心SDK的源文件和头文件
      const extensions = ['.cpp', '.c', '.S', '.s'];

      // 直接扫描path
      if (await fs.pathExists(dependencyPath)) {
        const files = await this.scanDirectoryRecursive(dependencyPath, extensions);
        // 对于 core 类型，不进行按架构过滤 —— core 应包含 SDK 中的所有相关实现文件。
        // core/variant 扫描时跳过该架构过滤，保留扫描得到的所有相关实现文件（再对 core 做 variant.cpp 的单独移除以避免重复）。4
        // 如 DUE
        let filteredFiles: string[];
        this.logger.debug(`createDependency: scanned files for ${dependencyPath}: ${files.length}`);
        if (type === 'core' || type === 'variant') {
          this.logger.debug(`createDependency: skipping architecture filter for ${type}`);
          filteredFiles = files.slice();
        } else {
          filteredFiles = this.filterSourceFiles(files);
        }
        this.logger.debug(`createDependency: filtered files count=${filteredFiles.length} for type=${type}`);

        // 对于core类型的依赖，额外过滤掉variant.cpp文件（但保留variant_helper.cpp等其他文件）
        if (type === 'core') {
          filteredFiles = filteredFiles.filter(file => {
            const fileName = path.basename(file).toLowerCase();
            // 只过滤掉variant.cpp，但保留variant_helper.cpp等其他variant相关文件
            return fileName !== 'variant.cpp';
          });
        }

        includeFiles.push(...filteredFiles);
      }

      return {
        name,
        path: dependencyPath,
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
      const allFiles = await this.scanDirectoryRecursive(libraryObject.path, extensions);
      
      // 过滤掉被其他文件 #include 的代码片段文件
      const includedFiles = new Set<string>();
      
      // 第一遍：扫描所有 .cpp 和 .c 文件，找出哪些文件被 #include
      for (const file of allFiles) {
        if (file.endsWith('.cpp')) {
          const includedCpp = await this.findIncludedCppFiles(file, libraryObject.path);
          includedCpp.forEach(f => includedFiles.add(f));
          
          const includedC = await this.findIncludedCFiles(file, libraryObject.path);
          includedC.forEach(f => includedFiles.add(f));
        } else if (file.endsWith('.c')) {
          const includedCpp = await this.findIncludedCppFiles(file, libraryObject.path);
          includedCpp.forEach(f => includedFiles.add(f));
          
          const includedC = await this.findIncludedCFiles(file, libraryObject.path);
          includedC.forEach(f => includedFiles.add(f));
        }
      }
      
      // 第二遍：过滤代码片段
      const validFiles: string[] = [];
      for (const file of allFiles) {
        // 1. 被 #include 的文件
        if (includedFiles.has(file)) {
          this.logger.debug(`[CODE_FRAGMENT] Skipping included file: ${path.relative(libraryObject.path, file)}`);
          continue;
        }
        
        // 2. 检查是否在代码片段子目录中（相对于库根目录的子目录）
        const relativePath = path.relative(libraryObject.path, file);
        const isInSubdirectory = relativePath.includes(path.sep) && !relativePath.startsWith('src' + path.sep);
        
        if (isInSubdirectory) {
          // 在子目录中（非 src 目录），可能是代码片段或纯数据文件
          
          // 1. 检查是否是纯数据文件（只包含数据定义，没有函数实现）
          // 纯数据文件特征：没有或极少 include，只有数据定义
          // 这类文件不需要单独编译，因为它们通常会被其他文件 include
          const isPureDataFile = await this.isPureDataFile(file);
          if (isPureDataFile) {
            this.logger.debug(`[CODE_FRAGMENT] Skipping pure data file in subdirectory: ${relativePath}`);
            continue;
          }
          
          // 2. 检查是否是真正的代码片段（被条件编译包裹且缺少完整实现）
          const isCodeFragment = await this.isCodeFragment(file);
          if (isCodeFragment) {
            this.logger.debug(`[CODE_FRAGMENT] Skipping code fragment file in subdirectory: ${relativePath}`);
            continue;
          }
        }
        
        validFiles.push(file);
      }

      libraryObject.includes.push(...validFiles);
      return true
    } catch (error) {
      this.logger.debug(`Failed to create library dependency for ${libraryObject.name}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 查找文件中通过 #include 引入的 .cpp 文件
   * @param filePath 要分析的文件路径
   * @param basePath 库的基础路径
   * @returns 被 #include 的 .cpp 文件的绝对路径列表
   */
  private async findIncludedCppFiles(filePath: string, basePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const includedFiles: string[] = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        // 匹配 #include "xxx.cpp" 或 #include <xxx.cpp>
        const match = trimmed.match(/^#include\s+["<]([^">]+\.cpp)[">]/);
        if (match) {
          const includedPath = match[1];
          // 尝试解析相对路径
          const fileDir = path.dirname(filePath);
          let resolvedPath = path.resolve(fileDir, includedPath);
          
          // 如果文件不存在，尝试相对于库根目录解析
          if (!await fs.pathExists(resolvedPath)) {
            resolvedPath = path.resolve(basePath, includedPath);
          }
          
          if (await fs.pathExists(resolvedPath)) {
            includedFiles.push(resolvedPath);
          }
        }
      }
      
      return includedFiles;
    } catch (error) {
      this.logger.debug(`Failed to find included cpp files in ${filePath}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /**
   * 查找文件中通过 #include 引入的 .c 文件
   * @param filePath 要分析的文件路径
   * @param basePath 库的基础路径
   * @returns 被 #include 的 .c 文件的绝对路径列表
   */
  private async findIncludedCFiles(filePath: string, basePath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const includedFiles: string[] = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        // 匹配 #include "xxx.c" 或 #include <xxx.c>
        const match = trimmed.match(/^#include\s+["<]([^">]+\.c)[">]/);
        if (match) {
          const includedPath = match[1];
          // 尝试解析相对路径
          const fileDir = path.dirname(filePath);
          let resolvedPath = path.resolve(fileDir, includedPath);
          
          // 如果文件不存在，尝试相对于库根目录解析
          if (!await fs.pathExists(resolvedPath)) {
            resolvedPath = path.resolve(basePath, includedPath);
          }
          
          if (await fs.pathExists(resolvedPath)) {
            includedFiles.push(resolvedPath);
          }
        }
      }
      
      return includedFiles;
    } catch (error) {
      this.logger.debug(`Failed to find included cpp files in ${filePath}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  /**
   * 检查文件是否为纯数据文件（只包含数据定义，没有函数实现）
   * 纯数据文件特征：
   * 1. 没有 #include 语句（或极少）
   * 2. 只包含数据定义（const 数组、PROGMEM 等）
   * 3. 没有函数实现
   * @param filePath 文件路径
   * @returns 如果是纯数据文件返回true
   */
  private async isPureDataFile(filePath: string): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      
      // 移除注释
      const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, '') // 移除块注释
                                  .replace(/\/\/.*/g, ''); // 移除行注释
      
      // 统计各种特征
      let includeCount = 0;
      let functionCount = 0;
      let dataDefinitionCount = 0;
      
      // 改进的函数检测：分析行模式
      const lines = cleanContent.split('\n');
      let inArrayInit = false;
      let braceBalance = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 跳过空行
        if (!line) {
          continue;
        }
        
        // 统计 #include 语句
        if (line.startsWith('#include')) {
          includeCount++;
          continue;
        }
        
        // 跳过其他预处理指令
        if (line.startsWith('#')) {
          continue;
        }
        
        // 检测数据定义（PROGMEM, const 数组）
        if (line.includes('PROGMEM') || /\bconst\s+\w+.*\[/.test(line)) {
          // 排除函数指针和函数声明
          if (!/\(\s*\*/.test(line) && !/\)\s*;/.test(line)) {
            dataDefinitionCount++;
          }
        }
        
        // 检测数组初始化的开始
        if (/=\s*\{/.test(line) || /\[\s*\]\s*=\s*\{/.test(line)) {
          inArrayInit = true;
        }
        
        // 计算花括号平衡
        const openBraces = (line.match(/{/g) || []).length;
        const closeBraces = (line.match(/}/g) || []).length;
        
        // 检测函数定义：
        // 1. 行中包含 ) { 或 ) 后面几行出现 {
        // 2. 不在数组初始化中
        // 3. 花括号平衡为0（顶层）
        if (!inArrayInit && braceBalance === 0) {
          // 检查当前行或接下来的几行
          let checkLines = line;
          for (let j = 1; j <= 3 && (i + j) < lines.length; j++) {
            checkLines += ' ' + lines[i + j].trim();
          }
          
          // 匹配函数模式：类型 函数名(参数) { 
          // 或 static/inline 类型 函数名(参数) {
          if (/\w+\s+\w+\s*\([^)]*\)\s*\{/.test(checkLines) ||
              /\b(static|inline)\s+\w+\s+\w+\s*\([^)]*\)\s*\{/.test(checkLines)) {
            // 排除数组初始化（包含 = 在括号前）
            if (!/=\s*\{/.test(checkLines)) {
              functionCount++;
            }
          }
        }
        
        braceBalance += openBraces - closeBraces;
        
        // 数组初始化结束
        if (inArrayInit && braceBalance === 0 && closeBraces > 0) {
          inArrayInit = false;
        }
      }
      
      this.logger.debug(`[PURE_DATA_CHECK] ${path.basename(filePath)}: includes=${includeCount}, functions=${functionCount}, dataDefinitions=${dataDefinitionCount}`);
      
      // 判断标准：
      // 1. 没有任何 include（includeCount === 0）- 说明是纯数据片段，会被其他文件 include
      // 2. 函数数量为0
      // 3. 数据定义数量较多（>= 1）
      // 注意：如果有 include，说明它是独立编译单元，应该被编译（如 u8g2_fonts.c）
      const isPureData = includeCount === 0 && functionCount === 0 && dataDefinitionCount >= 1;
      
      if (isPureData) {
        this.logger.debug(`[PURE_DATA_CHECK] ${path.basename(filePath)} is pure data file (0 includes, 0 functions, ${dataDefinitionCount} data definitions)`);
      }
      
      return isPureData;
    } catch (error) {
      this.logger.debug(`Failed to check if file is pure data ${filePath}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /**
   * 检查文件是否为真正的代码片段
   * 真正的代码片段特征：
   * 1. 整个文件被条件编译包裹
   * 2. 且文件内容缺少完整的函数实现（只有声明或宏定义）
   * 3. 或者文件非常简短（少于50行有效代码）且没有复杂的实现
   * @param filePath 文件路径
   * @returns 如果是代码片段返回true
   */
  private async isCodeFragment(filePath: string): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').map(line => line.trim());
      
      // 统计有效代码行数（排除空行、注释、预处理指令）
      let effectiveLines = 0;
      let functionCount = 0;
      let hasComplexImplementation = false;
      let includesCFile = false;  // 是否包含对 .c 文件的 #include
      
      for (const line of lines) {
        // 检测 #include ".c" 模式（如 STM32 SDK 的 system_stm32yyxx.c）
        // 这种文件通过条件编译 #include 实际的实现文件，不应被视为代码片段
        if (line.match(/^#include\s+["<][^">]+\.c[">]/)) {
          includesCFile = true;
        }
        
        // 跳过空行、注释和预处理指令
        if (!line || line.startsWith('//') || line.startsWith('/*') || 
            line.startsWith('*') || line.startsWith('#')) {
          continue;
        }
        
        effectiveLines++;
        
        // 检测函数实现（包含函数体的函数）
        if (line.includes('{') && !line.includes('};')) {
          functionCount++;
        }
        
        // 检测复杂实现的标志
        if (line.includes('for') || line.includes('while') || line.includes('switch') ||
            (line.includes('if') && !line.startsWith('#'))) {
          hasComplexImplementation = true;
        }
      }
      
      // 如果文件 #include 了 .c 文件，说明这是一个包装器文件，不应被视为代码片段
      // 这是 STM32 SDK 等平台的常见模式（如 system_stm32yyxx.c 通过条件编译 include 具体平台的实现）
      if (includesCFile) {
        this.logger.debug(`[CODE_FRAGMENT] File ${filePath} includes .c files, treating as wrapper file, keeping it`);
        return false;
      }
      
      // 如果有条件编译保护
      const hasTopLevelConditional = await this.hasTopLevelConditionalCompilation(filePath);
      
      if (hasTopLevelConditional) {
        // 有条件编译保护的情况下，进一步检查实现完整性
        
        // 如果有至少1个函数实现，就不是代码片段
        // 这些文件通常是平台特定的实现文件（如 exp_nimble_mem.c 提供内存分配函数）
        if (functionCount >= 1) {
          this.logger.debug(`[CODE_FRAGMENT] File ${filePath} has conditional compilation but contains function implementations (${functionCount} functions), keeping it`);
          return false;
        }
        
        // 如果有复杂实现逻辑，也不是代码片段
        if (hasComplexImplementation) {
          this.logger.debug(`[CODE_FRAGMENT] File ${filePath} has conditional compilation with complex implementation, keeping it`);
          return false;
        }
        
        // 没有函数实现且没有复杂逻辑，认为是代码片段
        this.logger.debug(`[CODE_FRAGMENT] File ${filePath} has conditional compilation with no function implementations (${effectiveLines} lines), treating as fragment`);
        return true;
      }
      
      // 没有条件编译保护的情况下，通常不是代码片段
      return false;
    } catch (error) {
      this.logger.debug(`Failed to check if code fragment ${filePath}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /**
   * 检查文件是否在顶层有条件编译保护，并且是代码片段而非完整编译单元
   * @param filePath 文件路径
   * @returns 如果是被条件编译包裹的代码片段返回true，如果是完整编译单元返回false
   */
  private async hasTopLevelConditionalCompilation(filePath: string): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').map(line => line.trim());
      
      let firstDirectiveLine = -1;
      let lastEndifLine = -1;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // 跳过空行和注释
        if (!line || line.startsWith('//')) continue;
        
        // 找到第一个条件编译指令
        if (firstDirectiveLine === -1 && 
            (line.startsWith('#if') || line.startsWith('#ifdef') || line.startsWith('#ifndef'))) {
          firstDirectiveLine = i;
        }
        
        // 找到最后一个 #endif
        if (line.startsWith('#endif')) {
          lastEndifLine = i;
        }
      }
      
      // 如果找到了条件编译指令，检查它们是否包裹了整个文件
      if (firstDirectiveLine !== -1 && lastEndifLine !== -1) {
        // 计算条件编译之外的有效代码行
        let codeBeforeFirst = 0;
        let codeAfterLast = 0;
        
        for (let i = 0; i < firstDirectiveLine; i++) {
          const line = lines[i];
          if (line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) {
            codeBeforeFirst++;
          }
        }
        
        for (let i = lastEndifLine + 1; i < lines.length; i++) {
          const line = lines[i];
          if (line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) {
            codeAfterLast++;
          }
        }
        
        // 如果条件编译之外有实质性代码，则不是代码片段
        if (codeBeforeFirst > 0 || codeAfterLast > 0) {
          return false;
        }
        
        // 整个文件被条件编译包裹，进一步分析内容
        // 检查是否包含完整的实现（类定义、命名空间、多个函数等）
        const hasCompleteImplementation = await this.hasCompleteImplementation(content);
        
        // 如果包含完整实现，则不是代码片段
        return !hasCompleteImplementation;
      }
      
      return false;
    } catch (error) {
      this.logger.debug(`Failed to check conditional compilation ${filePath}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /**
   * 检查文件是否包含完整的实现（而非简单的占位代码）
   * @param content 文件内容
   * @returns 如果包含完整实现返回true
   */
  private async hasCompleteImplementation(content: string): Promise<boolean> {
    // 移除注释
    const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, '') // 移除块注释
                               .replace(/\/\/.*/g, ''); // 移除行注释
    
    // 统计函数实现（包括 C 风格和 C++ 成员函数）
    const cStyleFunctions = (cleanContent.match(/\n\s*\w+\s+\w+\s*\([^)]*\)\s*\{/g) || []).length;
    const cppMemberFunctions = (cleanContent.match(/\w+::\w+\s*\([^)]*\)\s*\{/g) || []).length;
    const totalFunctions = cStyleFunctions + cppMemberFunctions;
    
    // 检查完整实现的特征
    const indicators = {
      // 命名空间定义
      hasNamespace: /namespace\s+\w+\s*\{/.test(cleanContent),
      
      // 类定义（包括构造函数、析构函数）
      hasClassDefinition: /class\s+\w+/.test(cleanContent),
      hasConstructor: /::\w+\s*\(/.test(cleanContent) || /\w+::\w+\s*\(/.test(cleanContent),
      hasDestructor: /::~\w+\s*\(/.test(cleanContent),
      
      // 多个函数实现
      functionCount: totalFunctions,
      
      // 包含复杂逻辑（循环、条件语句、switch）
      hasLoops: /\b(for|while|do)\s*\(/.test(cleanContent),
      hasConditionals: /\bif\s*\(/.test(cleanContent),
      hasSwitchCase: /\bswitch\s*\(/.test(cleanContent),
      
      // 包含成员变量访问
      hasMemberAccess: /\w+_/.test(cleanContent) || /this->/.test(cleanContent) || /->\w+/.test(cleanContent),
      
      // 代码行数（排除空行和预处理指令）
      codeLines: cleanContent.split('\n').filter(line => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith('#') && trimmed !== '{' && trimmed !== '}' && trimmed !== '';
      }).length,
      
      // 计算控制流语句总数
      controlFlowCount: (cleanContent.match(/\b(for|while|do|if|switch)\s*\(/g) || []).length
    };
    
    this.logger.debug(`[IMPLEMENTATION] Functions: ${indicators.functionCount}, ControlFlow: ${indicators.controlFlowCount}, CodeLines: ${indicators.codeLines}`);
    
    // 判断标准（放宽条件以包含更多完整实现）：
    
    // 1. 有命名空间 + 类定义 → 完整实现
    if (indicators.hasNamespace && indicators.hasClassDefinition) {
      return true;
    }
    
    // 2. 有构造函数或析构函数 → 完整实现
    if (indicators.hasConstructor || indicators.hasDestructor) {
      return true;
    }
    
    // 3. 有5个或以上函数实现 → 完整实现
    if (indicators.functionCount >= 5) {
      return true;
    }
    
    // 4. 有3个或以上函数 + 复杂逻辑（控制流 >= 5） → 完整实现
    if (indicators.functionCount >= 3 && indicators.controlFlowCount >= 5) {
      return true;
    }
    
    // 5. 代码量大（> 100行有效代码）→ 完整实现
    if (indicators.codeLines > 100) {
      return true;
    }
    
    // 6. 有多个控制流语句（>= 10个）→ 完整实现
    if (indicators.controlFlowCount >= 10) {
      return true;
    }
    
    // 否则认为是简单的代码片段
    return false;
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
   * 过滤源文件，只进行架构过滤，保留所有扩展名的文件
   * @param files 文件路径数组
   * @returns 过滤后的文件路径数组
   */
  private filterSourceFiles(files: string[]): string[] {
    // 只进行架构过滤，不进行扩展名优先级过滤
    return this.filterByArchitecture(files);
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
    // 同时构建库名称到库信息的映射，用于平台特定库查找
    const libraryByNameMap = new Map<string, Dependency>();
    
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

      // 将库按名称存储，用于平台特定库查找
      libraryByNameMap.set(libName, libObject);

      try {
        // 扫描目录中的所有.h文件，只搜索当前目录，不递归子目录
        const headerFiles = await glob('*.{h,hpp}', {
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

    // 将库名称映射添加到主映射中，使用特殊前缀避免与头文件名冲突
    for (const [libName, libObject] of libraryByNameMap) {
      libraryMap.set(`__LIB_${libName}`, libObject);
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
      // 使用glob搜索所有源文件（.h, .hpp, .c, .cpp, .S）
      const patterns = ['**/*.h', '**/*.hpp', '**/*.c', '**/*.cpp', '**/*.S'];
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

    const result = Array.from(sourceDirs);
    this.logger.debug(`[SOURCE_DIRS] ${path.basename(libPath)}: found ${result.length} directories: ${result.map(d => path.relative(libPath, d) || '(root)').join(', ')}`);
    return result;
  }

  /**
   * 添加平台特定的必需库
   * 对于 STM32 平台，自动添加 SrcWrapper 库
   * @param arduinoConfig Arduino 配置对象
   */
  private async addPlatformSpecificLibraries(arduinoConfig: any): Promise<void> {
    const platformName = arduinoConfig.fqbnParsed?.package;
    
    // 检查是否为 STM32 平台
    if (platformName === 'STMicroelectronics') {
      this.logger.debug('Detected STM32 platform, adding SrcWrapper library...');
      
      // 检查 SrcWrapper 库是否已经在 libraryMap 中
      if (this.libraryMap && this.libraryMap.has('__LIB_SrcWrapper')) {
        const srcWrapperDep = this.libraryMap.get('__LIB_SrcWrapper');
        if (srcWrapperDep) {
          // 先调用 updateLibraryDependency 来扫描源文件
          await this.updateLibraryDependency(srcWrapperDep);
          // 将 SrcWrapper 库添加到依赖列表中
          this.dependencyList.set('SrcWrapper', srcWrapperDep);
          this.logger.info('Added SrcWrapper library for STM32 platform');
        }
      } else {
        this.logger.warn('SrcWrapper library not found in library paths for STM32 platform');
        // 调试：打印所有可用的库
        if (this.libraryMap) {
          const libNames = Array.from(this.libraryMap.keys()).filter(key => key.startsWith('__LIB_'));
          this.logger.debug(`Available libraries: ${libNames.join(', ')}`);
        }
      }
    }
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