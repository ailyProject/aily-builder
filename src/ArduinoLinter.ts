import { Logger } from './utils/Logger';
import { ArduinoConfigParser } from './ArduinoConfigParser';
import { CompileConfigManager } from './CompileConfigManager';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import { CacheManager, CacheKey } from './CacheManager';
import { LintCacheManager, LintCacheKey } from './LintCacheManager';
import * as crypto from 'crypto';
import { ParallelStaticAnalyzer, StaticAnalysisResult } from './ParallelStaticAnalyzer';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';

export interface LintError {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
}

export interface LintResult {
  success: boolean;
  errors: LintError[];
  warnings: LintError[];
  notes: LintError[];
  executionTime: number;
}

export interface LintOptions {
  sketchPath: string;
  board: string;
  buildPath: string;
  sdkPath?: string;
  toolsPath?: string;
  librariesPath?: string[];
  buildProperties?: Record<string, string>;
  boardOptions?: Record<string, string>;
  toolVersions?: string;
  format?: 'vscode' | 'json' | 'human';
  mode?: 'fast' | 'accurate' | 'auto';
  verbose?: boolean;
}

// 缓存结构
interface LintCache {
  libraryPaths?: string[];
  includePaths?: string[];
  config?: Record<string, any>;
  dependencies?: any[];
  lastModified?: number;
}

export class ArduinoLinter {
  private compileConfigManager: CompileConfigManager;
  private dependencyAnalyzer: DependencyAnalyzer;
  private cacheManager: CacheManager;
  private lintCacheManager: LintCacheManager;
  private staticAnalyzer: ParallelStaticAnalyzer;
  private cache: Map<string, LintCache> = new Map(); // 向后兼容的内存缓存

  constructor(
    private logger: Logger,
    private configParser: ArduinoConfigParser
  ) {
    this.compileConfigManager = new CompileConfigManager(logger);
    this.dependencyAnalyzer = new DependencyAnalyzer(logger);
    this.cacheManager = new CacheManager(logger);
    this.lintCacheManager = new LintCacheManager(logger);
    this.staticAnalyzer = new ParallelStaticAnalyzer(logger);
  }

  /**
   * 执行语法检查
   */
  async lint(options: LintOptions): Promise<LintResult> {
    const startTime = Date.now();
    const mode = options.mode || 'fast';
    
    try {
      this.logger.verbose(`Starting ${mode} syntax analysis...`);
      
      switch (mode) {
        case 'fast':
          return await this.performFastAnalysis(options, startTime);
          
        case 'accurate':
          return await this.performCompilerAnalysis(options, startTime);
          
        case 'auto':
          return await this.performAutoAnalysis(options, startTime);
          
        default:
          throw new Error(`Unknown lint mode: ${mode}`);
      }
      
    } catch (error) {
      this.logger.error(`Syntax check failed: ${error instanceof Error ? error.message : error}`);
      
      return {
        success: false,
        errors: [{
          file: options.sketchPath,
          line: 0,
          column: 0,
          message: error instanceof Error ? error.message : String(error),
          severity: 'error'
        }],
        warnings: [],
        notes: [],
        executionTime: Date.now() - startTime
      };
    }
  }

  // /**
  //  * 获取预处理后的文件 - 简化版本，直接进行静态语法检查
  //  */
  // private async getPreprocessedFile(options: LintOptions): Promise<string> {
  //   // 创建临时目录
  //   const tempDir = path.join(os.tmpdir(), `aily-lint-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  //   await fs.ensureDir(tempDir);
    
  //   const preprocessedPath = path.join(tempDir, 'sketch.cpp');
    
  //   try {
  //     this.logger.verbose(`Performing static syntax analysis...`);
      
  //     // 直接转换 sketch 为 C++ 并进行基本语法检查
  //     await this.createSimpleCppFile(options.sketchPath, preprocessedPath);
      
  //     return preprocessedPath;
  //   } catch (error) {
  //     // 清理临时目录
  //     await fs.remove(tempDir).catch(() => {});
  //     throw error;
  //   }
  // }

  /**
   * 创建简单的 C++ 文件用于语法检查
   */
  // private async createSimpleCppFile(
  //   sketchPath: string, 
  //   outputPath: string
  // ): Promise<void> {
  //   // 读取原始 sketch 文件
  //   const sketchContent = await fs.readFile(sketchPath, 'utf-8');
    
  //   // 生成简化的 C++ 代码用于语法检查
  //   const cppContent = this.convertSketchToCpp(sketchContent);
    
  //   // 写入输出文件
  //   await fs.writeFile(outputPath, cppContent);
  // }

  /**
   * 将 Arduino sketch 转换为标准 C++
   */
  // private convertSketchToCpp(sketchContent: string): string {
  //   // 添加 Arduino 核心头文件
  //   let cppContent = '#include <Arduino.h>\n\n';
    
  //   // 简单的函数前向声明检测和添加
  //   const functionDeclarations = this.extractFunctionDeclarations(sketchContent);
  //   if (functionDeclarations.length > 0) {
  //     cppContent += functionDeclarations.join('\n') + '\n\n';
  //   }
    
  //   // 添加原始代码
  //   cppContent += sketchContent;
    
  //   return cppContent;
  // }

  /**
   * 提取函数前向声明
   */
  // private extractFunctionDeclarations(content: string): string[] {
  //   const declarations: string[] = [];
    
  //   // 简单的函数定义匹配（不包括 setup/loop）
  //   const functionRegex = /^((?:static\s+)?(?:inline\s+)?(?:const\s+)?[a-zA-Z_][a-zA-Z0-9_*&\s]+\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{/gm;
    
  //   let match;
  //   while ((match = functionRegex.exec(content)) !== null) {
  //     const [, returnType, funcName] = match;
      
  //     // 跳过 setup 和 loop 函数
  //     if (funcName === 'setup' || funcName === 'loop') {
  //       continue;
  //     }
      
  //     // 提取参数列表
  //     const startPos = match.index + match[0].indexOf('(');
  //     const paramMatch = content.slice(startPos).match(/\([^)]*\)/);
      
  //     if (paramMatch) {
  //       const params = paramMatch[0];
  //       declarations.push(`${returnType.trim()} ${funcName}${params};`);
  //     }
  //   }
    
  //   return declarations;
  // }

  /**
   * 构建语法检查命令
   */
  // private async buildSyntaxCheckCommand(
  //   preprocessedFile: string,
  //   options: LintOptions
  // ): Promise<string> {
  //   // 获取平台配置
  //   const result = await this.configParser.parseByFQBN(options.board, {}, {});
  //   const config = { ...result.platform, ...result.board };
    
  //   // 获取编译器路径和基础参数
  //   let compileCmd = config['recipe.cpp.o.pattern'] || config['recipe.c.o.pattern'];
    
  //   if (!compileCmd) {
  //     throw new Error('Cannot find compiler recipe in platform configuration');
  //   }
    
  //   // 替换变量
  //   compileCmd = this.replaceVariables(compileCmd, {
  //     ...config,
  //     source_file: preprocessedFile,
  //     object_file: '' // 不需要输出文件
  //   });
    
  //   // 修改为语法检查模式
  //   compileCmd = compileCmd
  //     .replace(/-c\s+/g, '-fsyntax-only ')  // 替换 -c 为 -fsyntax-only
  //     .replace(/-o\s+[^\s]+/g, '')          // 移除 -o output.o
  //     .replace(/-MMD\s*/g, '')              // 移除依赖生成
  //     .replace(/-MP\s*/g, '');
    
  //   // 添加诊断选项
  //   compileCmd += ' -fdiagnostics-color=always';
  //   compileCmd += ' -fmax-errors=50'; // 限制错误数量，避免输出过多
    
  //   // 如果支持 JSON 输出格式（GCC 9+）
  //   if (options.format === 'json') {
  //     compileCmd += ' -fdiagnostics-format=json';
  //   }
    
  //   this.logger.verbose(`Syntax check command: ${compileCmd}`);
    
  //   return compileCmd;
  // }

  /**
   * 替换命令中的变量
   */
  // private replaceVariables(command: string, vars: Record<string, string>): string {
  //   let result = command;
    
  //   for (const [key, value] of Object.entries(vars)) {
  //     const pattern = new RegExp(`\\{${key}\\}`, 'g');
  //     let normalizedValue = value || '';
  //     // 规范化路径，去除双斜杠
  //     normalizedValue = normalizedValue.replace(/\/\/+/g, '/').replace(/\\\\+/g, '\\');
  //     result = result.replace(pattern, normalizedValue);
  //   }
    
  //   return result;
  // }

  /**
   * 执行语法检查命令
   */
  // private async executeSyntaxCheck(command: string): Promise<string> {
  //   return new Promise((resolve, reject) => {
  //     const parts = command.split(/\s+/);
  //     const executable = parts[0];
  //     const args = parts.slice(1);
      
  //     let stdout = '';
  //     let stderr = '';
      
  //     const childProcess = spawn(executable, args, {
  //       shell: true,
  //       env: { ...process.env, LANG: 'en_US.UTF-8' } // 确保英文输出
  //     });
      
  //     childProcess.stdout?.on('data', (data) => {
  //       stdout += data.toString();
  //     });
      
  //     childProcess.stderr?.on('data', (data) => {
  //       stderr += data.toString();
  //     });
      
  //     childProcess.on('close', (code) => {
  //       // 语法检查即使有错误也会返回非0，这是正常的
  //       // 我们需要解析输出而不是依赖退出码
  //       resolve(stderr + stdout);
  //     });
      
  //     childProcess.on('error', (error) => {
  //       reject(new Error(`Failed to execute syntax check: ${error.message}`));
  //     });
  //   });
  // }

  /**
   * 解析编译器输出
   */
  // private parseCompilerOutput(
  //   output: string,
  //   format: 'vscode' | 'json' | 'human' = 'human'
  // ): Omit<LintResult, 'success' | 'executionTime'> {
  //   const errors: LintError[] = [];
  //   const warnings: LintError[] = [];
  //   const notes: LintError[] = [];
    
  //   // 尝试 JSON 格式解析
  //   if (format === 'json') {
  //     try {
  //       const diagnostics = this.parseJsonOutput(output);
  //       return this.categorizeDiagnostics(diagnostics);
  //     } catch (e) {
  //       this.logger.debug('JSON parsing failed, falling back to text parsing');
  //     }
  //   }
    
  //   // 文本格式解析
  //   return this.parseTextOutput(output);
  // }

  /**
   * 解析 JSON 格式输出（GCC 9+）
   */
  // private parseJsonOutput(output: string): LintError[] {
  //   const diagnostics: LintError[] = [];
    
  //   // GCC JSON 输出是一行一个 JSON 对象
  //   const lines = output.split('\n').filter(line => line.trim().startsWith('{'));
    
  //   for (const line of lines) {
  //     try {
  //       const diag = JSON.parse(line);
        
  //       if (diag.kind && diag.locations && diag.message) {
  //         const location = diag.locations[0] || {};
          
  //         diagnostics.push({
  //           file: location.file || '',
  //           line: location.line || 0,
  //           column: location.column || 0,
  //           message: diag.message,
  //           severity: this.mapSeverity(diag.kind),
  //           code: diag.option || undefined
  //         });
  //       }
  //     } catch (e) {
  //       // 跳过无效的 JSON 行
  //       continue;
  //     }
  //   }
    
  //   return diagnostics;
  // }

  /**
   * 解析文本格式输出
   */
  // private parseTextOutput(output: string): Omit<LintResult, 'success' | 'executionTime'> {
  //   const errors: LintError[] = [];
  //   const warnings: LintError[] = [];
  //   const notes: LintError[] = [];
    
  //   // 匹配格式：
  //   // file.cpp:15:23: error: expected ';' before '}' token
  //   // file.cpp:20:5: warning: unused variable 'x' [-Wunused-variable]
  //   const diagnosticRegex = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+?)(?:\s+\[(.+?)\])?$/gm;
    
  //   let match;
  //   while ((match = diagnosticRegex.exec(output)) !== null) {
  //     const [, file, line, col, severity, message, code] = match;
      
  //     const diagnostic: LintError = {
  //       file: this.normalizeFilePath(file),
  //       line: parseInt(line),
  //       column: parseInt(col),
  //       message: message.trim(),
  //       severity: this.mapSeverity(severity),
  //       code: code || undefined
  //     };
      
  //     if (diagnostic.severity === 'error') {
  //       errors.push(diagnostic);
  //     } else if (diagnostic.severity === 'warning') {
  //       warnings.push(diagnostic);
  //     } else {
  //       notes.push(diagnostic);
  //     }
  //   }
    
  //   return { errors, warnings, notes };
  // }

  /**
   * 分类诊断信息
   */
  // private categorizeDiagnostics(
  //   diagnostics: LintError[]
  // ): Omit<LintResult, 'success' | 'executionTime'> {
  //   const errors = diagnostics.filter(d => d.severity === 'error');
  //   const warnings = diagnostics.filter(d => d.severity === 'warning');
  //   const notes = diagnostics.filter(d => d.severity === 'note');
    
  //   return { errors, warnings, notes };
  // }

  /**
   * 映射严重性级别
   */
  // private mapSeverity(severity: string): 'error' | 'warning' | 'note' {
  //   switch (severity.toLowerCase()) {
  //     case 'error':
  //     case 'fatal error':
  //       return 'error';
  //     case 'warning':
  //       return 'warning';
  //     case 'note':
  //     case 'info':
  //       return 'note';
  //     default:
  //       return 'note';
  //   }
  // }

  /**
   * 标准化文件路径
   */
  // private normalizeFilePath(filePath: string): string {
  //   // 移除 Windows 盘符后的不必要前缀
  //   return path.normalize(filePath.trim());
  // }

  /**
   * 格式化输出结果
   */
  formatOutput(result: LintResult, format: 'vscode' | 'json' | 'human' = 'human'): string {
    switch (format) {
      case 'json':
        return this.formatJson(result);
      case 'vscode':
        return this.formatVSCode(result);
      default:
        return this.formatHuman(result);
    }
  }

  /**
   * JSON 格式输出
   */
  private formatJson(result: LintResult): string {
    return JSON.stringify(result, null, 2);
  }

  /**
   * VS Code Problem Matcher 兼容格式
   * 格式: file(line,col): severity code: message
   */
  private formatVSCode(result: LintResult): string {
    const lines: string[] = [];
    
    const allDiagnostics = [
      ...result.errors,
      ...result.warnings,
      ...result.notes
    ];
    
    for (const diag of allDiagnostics) {
      // VS Code 格式: file(line,col): severity: message
      const location = `${diag.file}(${diag.line},${diag.column})`;
      const severity = diag.severity;
      const code = diag.code ? ` ${diag.code}` : '';
      
      lines.push(`${location}: ${severity}${code}: ${diag.message}`);
    }
    
    return lines.join('\n');
  }

  /**
   * 人类可读格式（彩色输出）
   */
  private formatHuman(result: LintResult): string {
    const lines: string[] = [];
    
    if (result.errors.length > 0) {
      lines.push('\n❌ Errors:');
      result.errors.forEach(err => {
        lines.push(`  ${err.file}:${err.line}:${err.column}`);
        lines.push(`    ${err.message}`);
        if (err.code) {
          lines.push(`    [${err.code}]`);
        }
      });
    }
    
    if (result.warnings.length > 0) {
      lines.push('\n⚠️  Warnings:');
      result.warnings.forEach(warn => {
        lines.push(`  ${warn.file}:${warn.line}:${warn.column}`);
        lines.push(`    ${warn.message}`);
        if (warn.code) {
          lines.push(`    [${warn.code}]`);
        }
      });
    }
    
    if (result.notes.length > 0 && result.errors.length === 0 && result.warnings.length === 0) {
      lines.push('\nℹ️  Notes:');
      result.notes.forEach(note => {
        lines.push(`  ${note.file}:${note.line}:${note.column}`);
        lines.push(`    ${note.message}`);
      });
    }
    
    // 摘要
    lines.push('\n' + '─'.repeat(50));
    lines.push(`Summary: ${result.errors.length} errors, ${result.warnings.length} warnings`);
    lines.push(`Time: ${result.executionTime}ms`);
    
    if (result.success) {
      lines.push('✅ Syntax check passed!');
    } else {
      lines.push('❌ Syntax check failed!');
    }
    
    return lines.join('\n');
  }

  /**
   * 构建预处理器命令
   */
  // private buildPreprocessorCommand(
  //   sketchPath: string,
  //   outputPath: string,
  //   config: Record<string, any>
  // ): string {
  //   // 获取编译器路径 - 使用更完整的路径构建
  //   const compilerCmd = config['compiler.cpp.cmd'] || 'g++';
  //   const compilerPath = config['compiler.path'] || '';
  //   const toolsPath = config['runtime.tools.arm-none-eabi-gcc.path'] || '';
    
  //   // 尝试多种路径组合
  //   let fullCompilerPath: string;
  //   if (toolsPath && compilerCmd.includes('arm-none-eabi')) {
  //     fullCompilerPath = path.join(toolsPath, 'bin', compilerCmd);
  //   } else if (compilerPath) {
  //     fullCompilerPath = path.join(compilerPath, compilerCmd);
  //   } else {
  //     fullCompilerPath = compilerCmd;
  //   }
    
  //   // 构建预处理命令
  //   let cmd = `"${fullCompilerPath}" -E`; // -E 表示只进行预处理
    
  //   // 添加基本选项
  //   cmd += ` -w`; // 抑制警告
  //   cmd += ` -std=gnu++17`; // C++ 标准
  //   cmd += ` -fpermissive`; // 允许一些宽松的语法
    
  //   // 添加定义
  //   const defines = [
  //     `-DARDUINO=${config['runtime.ide.version'] || '10607'}`,
  //     `-DARDUINO_${config['build.board'] || 'UNKNOWN'}`,
  //     `-DARDUINO_ARCH_${config['build.arch']?.toUpperCase() || 'UNKNOWN'}`
  //   ];
  //   cmd += ` ${defines.join(' ')}`;
    
  //   // 添加核心头文件路径
  //   const corePath = config['runtime.platform.path'] ? 
  //     path.join(config['runtime.platform.path'], 'cores', config['build.core'] || 'arduino') :
  //     '';
  //   if (corePath && fs.existsSync(corePath)) {
  //     cmd += ` -I"${corePath}"`;
  //   }
    
  //   // 添加变体头文件路径
  //   const variantPath = config['runtime.platform.path'] ? 
  //     path.join(config['runtime.platform.path'], 'variants', config['build.variant'] || 'standard') :
  //     '';
  //   if (variantPath && fs.existsSync(variantPath)) {
  //     cmd += ` -I"${variantPath}"`;
  //   }
    
  //   return cmd;
  // }

  /**
   * 运行预处理器
   */
  // private async runPreprocessor(
  //   preprocessorCmd: string,
  //   inputFile: string,
  //   outputFile: string
  // ): Promise<void> {
  //   const fullCmd = `${preprocessorCmd} "${inputFile}" -o "${outputFile}"`;
    
  //   return new Promise((resolve, reject) => {
  //     const childProcess = spawn(fullCmd, [], {
  //       shell: true,
  //       stdio: ['ignore', 'pipe', 'pipe']
  //     });
      
  //     let stderr = '';
      
  //     childProcess.stderr?.on('data', (data) => {
  //       stderr += data.toString();
  //     });
      
  //     childProcess.on('close', (code) => {
  //       if (code === 0) {
  //         resolve();
  //       } else {
  //         reject(new Error(`Preprocessing failed: ${stderr}`));
  //       }
  //     });
      
  //     childProcess.on('error', (error) => {
  //       reject(new Error(`Failed to run preprocessor: ${error.message}`));
  //     });
  //   });
  // }

  /**
   * 执行静态语法分析
   */
  // private async performStaticSyntaxAnalysis(sketchPath: string): Promise<{
  //   errors: LintError[];
  //   warnings: LintError[];
  //   notes: LintError[];
  // }> {
  //   const errors: LintError[] = [];
  //   const warnings: LintError[] = [];
  //   const notes: LintError[] = [];
    
  //   try {
  //     // 读取文件内容
  //     const content = await fs.readFile(sketchPath, 'utf-8');
  //     const lines = content.split('\n');
      
  //     // 执行各种语法检查
  //     this.checkBraces(lines, sketchPath, errors);
  //     this.checkSemicolons(lines, sketchPath, errors, warnings);
  //     this.checkVariableDeclarations(lines, sketchPath, warnings);
  //     this.checkFunctionSyntax(lines, sketchPath, errors, warnings);
  //     this.checkArduinoSpecific(lines, sketchPath, warnings, notes);
      
  //   } catch (error) {
  //     errors.push({
  //       file: sketchPath,
  //       line: 0,
  //       column: 0,
  //       message: `Failed to read file: ${error instanceof Error ? error.message : error}`,
  //       severity: 'error'
  //     });
  //   }
    
  //   return { errors, warnings, notes };
  // }

  /**
   * 检查大括号匹配
   */
  // private checkBraces(lines: string[], filePath: string, errors: LintError[]): void {
  //   const braceStack: { line: number; char: string; column: number }[] = [];
    
  //   lines.forEach((line, lineIndex) => {
  //     for (let i = 0; i < line.length; i++) {
  //       const char = line[i];
  //       const prevChar = i > 0 ? line[i - 1] : '';
  //       const nextChar = i < line.length - 1 ? line[i + 1] : '';
        
  //       // 跳过字符串和注释中的括号
  //       if (this.isInStringOrComment(line, i)) continue;
        
  //       if (char === '{' || char === '(' || char === '[') {
  //         braceStack.push({ line: lineIndex + 1, char, column: i + 1 });
  //       } else if (char === '}' || char === ')' || char === ']') {
  //         const expected = char === '}' ? '{' : char === ')' ? '(' : '[';
          
  //         if (braceStack.length === 0) {
  //           errors.push({
  //             file: filePath,
  //             line: lineIndex + 1,
  //             column: i + 1,
  //             message: `Unexpected '${char}' - no matching opening bracket`,
  //             severity: 'error'
  //           });
  //         } else {
  //           const last = braceStack.pop()!;
  //           if (last.char !== expected) {
  //             errors.push({
  //               file: filePath,
  //               line: lineIndex + 1,
  //               column: i + 1,
  //               message: `Mismatched bracket: expected '${this.getClosingBrace(last.char)}' but found '${char}'`,
  //               severity: 'error'
  //             });
  //           }
  //         }
  //       }
  //     }
  //   });
    
  //   // 检查未关闭的括号
  //   braceStack.forEach(brace => {
  //     errors.push({
  //       file: filePath,
  //       line: brace.line,
  //       column: brace.column,
  //       message: `Unmatched '${brace.char}' - missing closing '${this.getClosingBrace(brace.char)}'`,
  //       severity: 'error'
  //     });
  //   });
  // }

  /**
   * 检查分号
   */
  // private checkSemicolons(lines: string[], filePath: string, errors: LintError[], warnings: LintError[]): void {
  //   for (let i = 0; i < lines.length; i++) {
  //     const line = lines[i];
  //     const trimmed = line.trim();
      
  //     // 跳过空行、注释行、预处理指令
  //     if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || 
  //         trimmed.startsWith('*') || trimmed.startsWith('#')) {
  //       continue;
  //     }
      
  //     // 跳过控制结构、函数定义等不需要分号的行
  //     if (this.isControlStructure(trimmed) || this.isFunctionDefinition(trimmed) || 
  //         trimmed.endsWith('{') || trimmed.endsWith('}')) {
  //       continue;
  //     }
      
  //     // 检查是否是链式调用的一部分
  //     if (this.isPartOfChainedCall(lines, i)) {
  //       continue;
  //     }
      
  //     // 检查是否缺少分号
  //     if (this.shouldEndWithSemicolon(trimmed) && !trimmed.endsWith(';')) {
  //       errors.push({
  //         file: filePath,
  //         line: i + 1,
  //         column: line.length,
  //         message: `Expected ';' at end of statement`,
  //         severity: 'error'
  //       });
  //     }
  //   }
  // }

  /**
   * 检查变量声明
   */
  // private checkVariableDeclarations(lines: string[], filePath: string, warnings: LintError[]): void {
  //   const declaredVars = new Set<string>();
  //   const usedVars = new Set<string>();
    
  //   lines.forEach((line, lineIndex) => {
  //     const trimmed = line.trim();
      
  //     // 检查变量声明
  //     const varDecl = this.extractVariableDeclaration(trimmed);
  //     if (varDecl) {
  //       declaredVars.add(varDecl);
  //     }
      
  //     // 检查变量使用
  //     const usedVar = this.extractVariableUsage(trimmed);
  //     if (usedVar) {
  //       usedVars.add(usedVar);
  //     }
  //   });
    
  //   // 检查未声明的变量使用（基础检查）
  //   usedVars.forEach(varName => {
  //     if (!declaredVars.has(varName) && !this.isArduinoBuiltin(varName)) {
  //       warnings.push({
  //         file: filePath,
  //         line: 1, // 简化：标记在第一行
  //         column: 1,
  //         message: `Possibly undeclared variable: '${varName}'`,
  //         severity: 'warning'
  //       });
  //     }
  //   });
  // }

  /**
   * 检查函数语法
   */
  // private checkFunctionSyntax(lines: string[], filePath: string, errors: LintError[], warnings: LintError[]): void {
  //   lines.forEach((line, lineIndex) => {
  //     const trimmed = line.trim();
      
  //     // 检查函数调用语法
  //     const funcCallMatch = trimmed.match(/(\w+)\s*\(/);
  //     if (funcCallMatch) {
  //       const funcName = funcCallMatch[1];
        
  //       // 检查是否有匹配的右括号
  //       const openCount = (trimmed.match(/\(/g) || []).length;
  //       const closeCount = (trimmed.match(/\)/g) || []).length;
        
  //       if (openCount !== closeCount) {
  //         errors.push({
  //           file: filePath,
  //           line: lineIndex + 1,
  //           column: trimmed.indexOf('(') + 1,
  //           message: `Unmatched parentheses in function call '${funcName}'`,
  //           severity: 'error'
  //         });
  //       }
  //     }
  //   });
  // }

  /**
   * 检查 Arduino 特定语法
   */
  // private checkArduinoSpecific(lines: string[], filePath: string, warnings: LintError[], notes: LintError[]): void {
  //   let hasSetup = false;
  //   let hasLoop = false;
    
  //   lines.forEach((line, lineIndex) => {
  //     const trimmed = line.trim();
      
  //     if (trimmed.includes('void setup(')) {
  //       hasSetup = true;
  //     }
  //     if (trimmed.includes('void loop(')) {
  //       hasLoop = true;
  //     }
  //   });
    
  //   if (!hasSetup) {
  //     warnings.push({
  //       file: filePath,
  //       line: 1,
  //       column: 1,
  //       message: `Missing 'setup()' function - required for Arduino sketches`,
  //       severity: 'warning'
  //     });
  //   }
    
  //   if (!hasLoop) {
  //     warnings.push({
  //       file: filePath,
  //       line: 1,
  //       column: 1,
  //       message: `Missing 'loop()' function - required for Arduino sketches`,
  //       severity: 'warning'
  //     });
  //   }
  // }

  // 辅助方法
  // private isInStringOrComment(line: string, position: number): boolean {
  //   // 简单实现：检查是否在字符串或单行注释中
  //   const beforePos = line.substring(0, position);
  //   const stringCount = (beforePos.match(/"/g) || []).length;
  //   const commentPos = line.indexOf('//');
    
  //   return (stringCount % 2 === 1) || (commentPos !== -1 && position >= commentPos);
  // }

  // private getClosingBrace(openBrace: string): string {
  //   switch (openBrace) {
  //     case '{': return '}';
  //     case '(': return ')';
  //     case '[': return ']';
  //     default: return '';
  //   }
  // }

  // private isControlStructure(line: string): boolean {
  //   const keywords = ['if', 'else', 'while', 'for', 'switch', 'case', 'default', 'do'];
  //   return keywords.some(keyword => 
  //     line.startsWith(keyword + ' ') || line.startsWith(keyword + '(')
  //   );
  // }

  // private isFunctionDefinition(line: string): boolean {
  //   return /^\s*\w+\s+\w+\s*\([^)]*\)\s*$/.test(line) || 
  //          /^\s*\w+\s+\w+\s*\([^)]*\)\s*\{/.test(line);
  // }

  // private shouldEndWithSemicolon(line: string): boolean {
  //   // 简单规则：赋值、函数调用、变量声明等应该以分号结尾
  //   return /^\s*\w/.test(line) && 
  //          !line.endsWith('{') && 
  //          !line.endsWith('}') &&
  //          !this.isControlStructure(line);
  // }

  /**
   * 检查是否是链式调用的一部分
   */
  // private isPartOfChainedCall(lines: string[], currentIndex: number): boolean {
  //   const currentLine = lines[currentIndex].trim();
    
  //   // 如果当前行以点开头，说明是链式调用的延续
  //   if (currentLine.startsWith('.')) {
  //     return true;
  //   }
    
  //   // 检查当前行是否可能是链式调用的开始
  //   // 如果下一行以点开头，当前行就是链式调用的开始
  //   if (currentIndex + 1 < lines.length) {
  //     const nextLine = lines[currentIndex + 1].trim();
  //     if (nextLine.startsWith('.')) {
  //       return true;
  //     }
  //   }
    
  //   // 检查当前行是否是多行表达式的一部分
  //   // 如果当前行包含函数调用但没有分号，且下一行缩进，可能是链式调用
  //   if (currentLine.includes('(') && !currentLine.endsWith(';') && !currentLine.endsWith('{') && !currentLine.endsWith('}')) {
  //     if (currentIndex + 1 < lines.length) {
  //       const nextLine = lines[currentIndex + 1];
  //       const currentIndent = this.getIndentation(lines[currentIndex]);
  //       const nextIndent = this.getIndentation(nextLine);
        
  //       // 如果下一行缩进更多，或者以点开头，说明是链式调用
  //       if (nextIndent > currentIndent || nextLine.trim().startsWith('.')) {
  //         return true;
  //       }
  //     }
  //   }
    
  //   return false;
  // }

  /**
   * 获取行的缩进级别
   */
  // private getIndentation(line: string): number {
  //   const match = line.match(/^(\s*)/);
  //   return match ? match[1].length : 0;
  // }

  // private extractVariableDeclaration(line: string): string | null {
  //   const match = line.match(/^\s*(int|float|double|char|bool|String|byte)\s+(\w+)/);
  //   return match ? match[2] : null;
  // }

  // private extractVariableUsage(line: string): string | null {
  //   const match = line.match(/\b(\w+)\s*[=+\-*/]/);
  //   return match ? match[1] : null;
  // }

  // private isArduinoBuiltin(varName: string): boolean {
  //   const builtins = [
  //     'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP',
  //     'LED_BUILTIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
  //     'Serial', 'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite',
  //     'delay', 'delayMicroseconds', 'millis', 'micros'
  //   ];
  //   return builtins.includes(varName);
  // }

  /**
   * 格式化静态分析结果
   */
  // private formatStaticAnalysisResults(
  //   issues: { errors: LintError[]; warnings: LintError[]; notes: LintError[] },
  //   format: string
  // ): string {
  //   // 创建临时 LintResult 用于格式化
  //   const result: LintResult = {
  //     success: issues.errors.length === 0,
  //     errors: issues.errors,
  //     warnings: issues.warnings,
  //     notes: issues.notes,
  //     executionTime: 0 // 临时值
  //   };
    
  //   if (format === 'json') {
  //     return JSON.stringify(issues, null, 2);
  //   } else if (format === 'vscode') {
  //     return this.formatVSCode(result);
  //   } else {
  //     return this.formatHuman(result);
  //   }
  // }

  /**
   * 快速静态分析模式 - 使用并行分析器
   */
  private async performFastAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    const analysisResult = await this.staticAnalyzer.analyzeFile(options.sketchPath);
    
    return {
      success: analysisResult.errors.length === 0,
      errors: analysisResult.errors,
      warnings: analysisResult.warnings,
      notes: analysisResult.notes,
      executionTime: Date.now() - startTime
    };
  }

  /**
   * 编译器精确分析模式
   */
  private async performCompilerAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    // 检查缓存（仅当不是通过 optimized 方法调用时）
    const cachedResult = await this.getCachedCompilerResult(options);
    if (cachedResult) {
      this.logger.verbose('Using cached compiler analysis result');
      cachedResult.executionTime = Date.now() - startTime;
      return cachedResult;
    }
    
    try {
      // === 环境变量设置（与 ArduinoCompiler 保持一致）===
      
      // 设置 SDK 路径环境变量
      if (options.sdkPath) {
        process.env['SDK_PATH'] = options.sdkPath;
        this.logger.verbose(`Set SDK_PATH: ${process.env['SDK_PATH']}`);
      }

      // 设置工具路径环境变量
      if (options.toolsPath) {
        process.env['TOOLS_PATH'] = options.toolsPath;
        this.logger.verbose(`Set TOOLS_PATH: ${process.env['TOOLS_PATH']}`);
      }

      // 设置库路径环境变量
      if (options.librariesPath && options.librariesPath.length > 0) {
        const pathSeparator = os.platform() === 'win32' ? ';' : ':';
        process.env['LIBRARIES_PATH'] = options.librariesPath.join(pathSeparator);
        this.logger.verbose(`Set LIBRARIES_PATH: ${process.env['LIBRARIES_PATH']}`);
      }

      // === 解析工具版本（与 ArduinoCompiler 保持一致）===
      let toolVersions: { [key: string]: string } = {};
      if (options.toolVersions) {
        // 解析工具版本字符串，格式: tool1@version1,tool2@version2
        const toolVersionPairs = options.toolVersions.split(',');
        for (const pair of toolVersionPairs) {
          const [tool, version] = pair.trim().split('@');
          if (tool && version) {
            toolVersions[tool] = version;
            this.logger.verbose(`Tool version: ${tool}@${version}`);
          }
        }
      }

      // === 合并构建属性（与 ArduinoCompiler 保持一致）===
      const buildProperties = {
        ...(options.buildProperties || {}),
        ...(options.boardOptions || {}) // 将 board-options 合并到 build-properties
      };
      
      this.logger.verbose(`Build properties for lint: ${JSON.stringify(buildProperties)}`);

      // === 调用 ArduinoConfigParser（与 ArduinoCompiler 保持一致）===
      const arduinoConfig = await this.configParser.parseByFQBN(options.board, buildProperties, toolVersions);
      const config = { ...arduinoConfig.platform, ...arduinoConfig.board };
      
      // 2. 创建临时目录
      const tempDir = path.join(os.tmpdir(), `aily-lint-compiler-${Date.now()}`);
      await fs.ensureDir(tempDir);
      
      try {
        // 3. 生成预处理后的 C++ 文件
        const cppFile = await this.generateCppFile(options.sketchPath, tempDir);
        
        // 4. 执行编译器语法检查
        const compilerResult = await this.executeCompilerSyntaxCheck(cppFile, config, options, arduinoConfig);
        
        // 5. 解析编译器输出
        const issues = this.parseCompilerErrors(compilerResult, options.sketchPath);
        
        const result = {
          success: issues.errors.length === 0,
          errors: issues.errors,
          warnings: issues.warnings,
          notes: issues.notes || [],
          executionTime: Date.now() - startTime
        };
        
        // 缓存编译器分析结果（异步执行，不阻塞返回）
        this.cacheCompilerResult(options, result).catch(error => {
          this.logger.debug(`Failed to cache compiler result: ${error instanceof Error ? error.message : error}`);
        });
        
        return result;
        
      } finally {
        // 恢复临时文件清理
        await fs.remove(tempDir).catch(() => {});
      }
      
    } catch (error) {
      throw new Error(`Compiler analysis failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 自动模式：智能决策是否需要编译器检查
   */
  private async performAutoAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    // 首先检查编译器分析缓存
    const cachedCompilerResult = await this.getCachedCompilerResult(options);
    if (cachedCompilerResult) {
      this.logger.verbose('Using cached compiler analysis result');
      cachedCompilerResult.executionTime = Date.now() - startTime;
      return cachedCompilerResult;
    }
    
    // 生成缓存键（向后兼容）
    const cacheKey = this.generateCacheKey(options);
    
    // 执行并行静态分析
    this.logger.verbose('Starting parallel static analysis...');
    const staticAnalysisResult = await this.staticAnalyzer.analyzeFile(options.sketchPath);
    
    // 根据静态分析结果智能决策
    const needsCompilerCheck = this.shouldUseCompilerCheck(staticAnalysisResult, options);
    
    if (!needsCompilerCheck) {
      this.logger.verbose(`Static analysis confidence: ${staticAnalysisResult.confidence}, skipping compiler check`);
      return {
        success: staticAnalysisResult.errors.length === 0,
        errors: staticAnalysisResult.errors,
        warnings: staticAnalysisResult.warnings,
        notes: staticAnalysisResult.notes,
        executionTime: Date.now() - startTime
      };
    }
    
    // 需要编译器检查：并行获取配置和依赖
    this.logger.verbose(`Static analysis suggests compiler check needed (confidence: ${staticAnalysisResult.confidence})`);
    
    const parallelTasks = await this.performParallelPreparation(options, cacheKey);
    
    const resetStartTime = Date.now(); // 重置计时，只计算编译器检查时间
    
    try {
      // 使用准备好的数据进行编译器分析
      const accurateResult = await this.performOptimizedCompilerAnalysis(options, parallelTasks.cachedData, resetStartTime);
      
      // 合并静态分析和编译器分析的结果
      const mergedResult = this.mergeAnalysisResults(staticAnalysisResult, accurateResult);
      mergedResult.executionTime = Date.now() - startTime; // 总时间
      
      return mergedResult;
    } catch (error) {
      // 如果编译器检查失败，回退到静态分析结果
      this.logger.verbose(`Compiler analysis failed: ${error instanceof Error ? error.message : error}`);
      return {
        success: staticAnalysisResult.errors.length === 0,
        errors: staticAnalysisResult.errors,
        warnings: staticAnalysisResult.warnings,
        notes: staticAnalysisResult.notes,
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * 生成预处理后的 C++ 文件
   */
  private async generateCppFile(sketchPath: string, tempDir: string): Promise<string> {
    const sketchContent = await fs.readFile(sketchPath, 'utf-8');
    // const cppContent = this.convertSketchToCpp(sketchContent);
    const cppContent = sketchContent; // 简化处理，直接使用草图内容作为 C++ 内容
    
    const cppFile = path.join(tempDir, 'sketch.cpp');
    await fs.writeFile(cppFile, cppContent, 'utf-8');
    
    return cppFile;
  }

  /**
   * 执行编译器语法检查
   * 使用 platform.txt 中的 recipe.cpp.o.pattern 来确保与实际编译一致
   */
  private async executeCompilerSyntaxCheck(cppFile: string, config: Record<string, any>, options: LintOptions, arduinoConfig: any): Promise<string> {
    // 获取编译 recipe
    let compileCmd = config['recipe.cpp.o.pattern'] || config['recipe.c.o.pattern'];
    if (!compileCmd) {
      throw new Error('No compile recipe found in platform configuration');
    }
    
    this.logger.verbose(`Original compile recipe: ${compileCmd}`);
    
    // 替换 recipe 中的变量为语法检查模式
    // 移除输出文件参数
    compileCmd = compileCmd.replace(/\s+"-o"\s+"[^"]*"/g, ''); // 移除 "-o" "output_file"
    compileCmd = compileCmd.replace(/\s+-o\s+"[^"]*"/g, ''); // 移除 -o "output_file"
    compileCmd = compileCmd.replace(/\s+"-o"\s+%[^%]*%/g, ''); // 移除 "-o" %VAR%
    compileCmd = compileCmd.replace(/\s+-o\s+%[^%]*%/g, ''); // 移除 -o %VAR%
    
    // 替换源文件路径
    compileCmd = compileCmd.replace(/\{source_file\}/g, `"${cppFile}"`);
    compileCmd = compileCmd.replace(/"%SOURCE_FILE_PATH%"/g, `"${cppFile}"`);
    
    // 替换构建路径占位符
    const tempDir = path.dirname(cppFile);
    compileCmd = compileCmd.replace(/\{build\.source\.path\}/g, `"${tempDir}"`);
    compileCmd = compileCmd.replace(/"-I\{build\.source\.path\}"/g, `-I"${tempDir}"`);
    
    // 替换 include 路径变量
    const includePaths = (await this.buildIncludePaths(config, options, arduinoConfig)).join(' ');
    compileCmd = compileCmd.replace(/%INCLUDE_PATHS%/g, includePaths);
    
    // 移除不需要的选项文件引用（@文件），这些在语法检查中不需要
    compileCmd = compileCmd.replace(/"@%OUTPUT_PATH%\/build_opt\.h"/g, '');
    compileCmd = compileCmd.replace(/"@%OUTPUT_PATH%\/file_opts"/g, '');
    compileCmd = compileCmd.replace(/@%OUTPUT_PATH%\/build_opt\.h/g, '');
    compileCmd = compileCmd.replace(/@%OUTPUT_PATH%\/file_opts/g, '');
    
    // 添加语法检查标志
    if (!compileCmd.includes('-fsyntax-only')) {
      // 在编译器命令后面添加 -fsyntax-only
      compileCmd = compileCmd.replace(/^("[^"]+"\s+)/, '$1-fsyntax-only ');
      compileCmd = compileCmd.replace(/^([^"\s]+\s+)/, '$1-fsyntax-only ');
    }
    
    // 禁用颜色输出并移除 -w 参数以显示错误
    compileCmd = compileCmd.replace(/\s+-w\s+/g, ' '); // 移除 -w 参数
    if (!compileCmd.includes('-fdiagnostics-color')) {
      compileCmd = compileCmd.replace(/^("[^"]+"\s+)/, '$1-fdiagnostics-color=never ');
      compileCmd = compileCmd.replace(/^([^"\s]+\s+)/, '$1-fdiagnostics-color=never ');
    }
    
    // 规范化路径分隔符 - 修复混合斜杠问题
    compileCmd = this.normalizePathSeparators(compileCmd);
    
    this.logger.verbose(`Modified compile command: ${compileCmd}`);
    
    // 调试：显示生成的 C++ 文件内容
    const cppContent = await fs.readFile(cppFile, 'utf-8');
    this.logger.verbose('Generated C++ file content:');
    this.logger.verbose('------- START -------');
    this.logger.verbose(cppContent);
    this.logger.verbose('------- END -------');
    
    return new Promise(async (resolve, reject) => {
      try {
        // 解析编译命令，分离可执行文件和参数
        const cmdMatch = compileCmd.match(/^"([^"]+)"\s+(.*)$/) || compileCmd.match(/^(\S+)\s+(.*)$/);
        if (!cmdMatch) {
          reject(new Error('Invalid compile command format'));
          return;
        }
        
        const executable = cmdMatch[1];
        const argsString = cmdMatch[2];
        
        // 使用改进的参数解析方法
        let args = this.parseCommandArgsImproved(argsString);
        
        // 检查命令行长度，如果太长则使用响应文件
        const totalLength = executable.length + args.join(' ').length;
        this.logger.verbose(`Total command length: ${totalLength} characters`);
        
        // Windows 命令行限制通常是 8191 字符，我们设置为 7000 作为安全边际
        if (totalLength > 7000) {
          this.logger.verbose('Command line too long, using response file');
          
          // 创建响应文件
          const responseFilePath = path.join(path.dirname(cppFile), 'compile_args.txt');
          
          // 找到所有 -I 参数和 @ 参数并移动到响应文件
          const responseArgs: string[] = [];
          const filteredArgs: string[] = [];
          
          for (let i = 0; i < args.length; i++) {
            if (args[i].startsWith('-I') || args[i].startsWith('@')) {
              responseArgs.push(args[i]);
            } else {
              filteredArgs.push(args[i]);
            }
          }
          
          // 将所有参数写入响应文件
          const responseFileContent = responseArgs.join('\n');
          await fs.writeFile(responseFilePath, responseFileContent);
          
          // 添加我们的响应文件参数到过滤后的参数开头
          filteredArgs.unshift(`@${responseFilePath}`);
          
          args = filteredArgs;
          
          this.logger.verbose(`Created response file: ${responseFilePath}`);
          this.logger.verbose(`Response file contains ${responseArgs.length} arguments`);
          this.logger.verbose(`Response file first 5 lines:`);
          const firstLines = responseArgs.slice(0, 5);
          firstLines.forEach(line => this.logger.verbose(`  ${line}`));
          this.logger.verbose(`New command length: ${executable.length + args.join(' ').length} characters`);
        }
        
        this.logger.verbose(`Executable: ${executable}`);
        this.logger.verbose(`Args: ${JSON.stringify(args)}`);
        
        const { spawn } = require('child_process');
        const childProcess = spawn(executable, args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        
        childProcess.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        
        childProcess.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        childProcess.on('close', (code) => {
          // 调试信息
          this.logger.verbose(`Compiler exit code: ${code}`);
          this.logger.verbose(`Compiler stdout: ${stdout}`);
          this.logger.verbose(`Compiler stderr: ${stderr}`);
          
          // GCC 语法检查：code 0 = 成功，非0 = 有语法错误
          resolve(stderr || stdout); // 错误信息通常在 stderr
        });
        
        childProcess.on('error', (error) => {
          reject(new Error(`Failed to run compiler: ${error.message}`));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 改进的命令行参数解析
   */
  private parseCommandArgsImproved(argsString: string): string[] {
    const args: string[] = [];
    let currentArg = '';
    let inSingleQuotes = false;
    let inDoubleQuotes = false;
    let i = 0;
    
    while (i < argsString.length) {
      const char = argsString[i];
      
      if (char === "'" && !inDoubleQuotes) {
        inSingleQuotes = !inSingleQuotes;
      } else if (char === '"' && !inSingleQuotes) {
        inDoubleQuotes = !inDoubleQuotes;
      } else if (char === ' ' && !inSingleQuotes && !inDoubleQuotes) {
        if (currentArg.trim()) {
          args.push(currentArg.trim());
          currentArg = '';
        }
      } else {
        currentArg += char;
      }
      i++;
    }
    
    if (currentArg.trim()) {
      args.push(currentArg.trim());
    }
    
    return args;
  }

  /**
   * 解析命令行参数
   */
  // private parseCommandArgs(argsString: string): string[] {
  //   const args: string[] = [];
  //   let currentArg = '';
  //   let inQuotes = false;
  //   let i = 0;
    
  //   while (i < argsString.length) {
  //     const char = argsString[i];
      
  //     if (char === '"' && (i === 0 || argsString[i - 1] !== '\\')) {
  //       inQuotes = !inQuotes;
  //       // 对于路径参数，移除包围的引号，保留内容
  //       if (!inQuotes && currentArg.startsWith('"')) {
  //         // 结束引号，移除开始和结束的引号
  //         // 不添加结束引号
  //       } else if (inQuotes) {
  //         // 开始引号，不添加到结果中
  //       } else {
  //         currentArg += char;
  //       }
  //     } else if (char === "'" && !inQuotes) {
  //       // 处理单引号包围的参数（如 '-DUSB_MANUFACTURER="Arduino LLC"'）
  //       let j = i + 1;
  //       let singleQuotedArg = "";
        
  //       while (j < argsString.length && argsString[j] !== "'") {
  //         singleQuotedArg += argsString[j];
  //         j++;
  //       }
        
  //       if (j < argsString.length) {
  //         // 移除外层单引号，保留内容
  //         if (currentArg.trim()) {
  //           args.push(currentArg.trim());
  //           currentArg = '';
  //         }
  //         args.push(singleQuotedArg);
  //         i = j; // 跳过单引号区域
  //       } else {
  //         currentArg += char;
  //       }
  //     } else if (char === ' ' && !inQuotes) {
  //       if (currentArg.trim()) {
  //         args.push(currentArg.trim());
  //         currentArg = '';
  //       }
  //     } else {
  //       currentArg += char;
  //     }
  //     i++;
  //   }
    
  //   if (currentArg.trim()) {
  //     args.push(currentArg.trim());
  //   }
    
  //   return args;
  // }

  /**
   * 获取编译器路径
   * 参考 ArduinoConfigParser 中的做法：compiler.path + compiler.cpp.cmd
   */
  // private getCompilerPath(config: Record<string, any>): string {
  //   const compilerPath = config['compiler.path'] || '';
  //   const compilerCmd = config['compiler.cpp.cmd'] || 'g++';
    
  //   // 首先尝试使用 ArduinoConfigParser 设置的环境变量
  //   if (process.env['COMPILER_GPP_PATH']) {
  //     this.logger.verbose(`Using COMPILER_GPP_PATH from environment: ${process.env['COMPILER_GPP_PATH']}`);
  //     return process.env['COMPILER_GPP_PATH'];
  //   }
    
  //   // 如果有 compiler.path，直接拼接（这是 platform.txt 的标准方式）
  //   if (compilerPath) {
  //     // 正确处理路径分隔符，避免双斜杠问题
  //     let fullPath = compilerPath;
  //     if (!fullPath.endsWith('/') && !fullPath.endsWith('\\')) {
  //       fullPath += '/';
  //     }
  //     fullPath += compilerCmd;
      
  //     // 规范化路径，处理双斜杠等问题
  //     fullPath = path.normalize(fullPath);
      
  //     this.logger.verbose(`Constructed compiler path: ${fullPath}`);
      
  //     // 检查文件是否存在
  //     if (fs.existsSync(fullPath)) {
  //       return fullPath;
  //     } else {
  //       this.logger.verbose(`Compiler not found at: ${fullPath}`);
  //     }
  //   }
    
  //   // 尝试多种工具路径配置（后备方案）
  //   const possibleToolsPaths = [
  //     config['runtime.tools.arm-none-eabi-gcc.path'],
  //     config['runtime.tools.gcc-arm-none-eabi.path'],
  //     config['runtime.tools.xpack-arm-none-eabi-gcc-14.2.1-1.1.path']
  //   ].filter(Boolean);
    
  //   for (const toolsPath of possibleToolsPaths) {
  //     if (compilerCmd.includes('arm-none-eabi')) {
  //       // ARM 编译器通常在 bin 子目录
  //       const fullPath = path.join(toolsPath, 'bin', compilerCmd);
  //       if (fs.existsSync(fullPath)) {
  //         this.logger.verbose(`Found compiler at: ${fullPath}`);
  //         return fullPath;
  //       }
        
  //       // 有些版本可能直接在工具目录
  //       const directPath = path.join(toolsPath, compilerCmd);
  //       if (fs.existsSync(directPath)) {
  //         this.logger.verbose(`Found compiler at: ${directPath}`);
  //         return directPath;
  //       }
  //     } else {
  //       // 其他编译器
  //       const fullPath = path.join(toolsPath, compilerCmd);
  //       if (fs.existsSync(fullPath)) {
  //         this.logger.verbose(`Found compiler at: ${fullPath}`);
  //         return fullPath;
  //       }
  //     }
  //   }
    
  //   // 如果找不到完整路径，尝试使用系统 PATH
  //   this.logger.verbose(`Compiler not found in configured paths, using system PATH: ${compilerCmd}`);
  //   return compilerCmd;
  // }

  /**
   * 构建包含路径 - 使用 DependencyAnalyzer 动态分析依赖
   */
  private async buildIncludePaths(config: Record<string, any>, options: LintOptions, arduinoConfig: any): Promise<string[]> {
    const includes: string[] = [];
    
    try {
      // 设置 DependencyAnalyzer 需要的环境变量（参考 ArduinoCompiler）
      const sketchPath = path.resolve(options.sketchPath);
      const sketchName = path.basename(sketchPath, '.ino');
      
      process.env['SKETCH_PATH'] = sketchPath;
      process.env['SKETCH_NAME'] = sketchName;
      process.env['SKETCH_DIR_PATH'] = path.dirname(sketchPath);
      process.env['BUILD_PATH'] = options.buildPath;
      
      this.logger.verbose(`Set environment for DependencyAnalyzer:`);
      this.logger.verbose(`  SKETCH_PATH: ${process.env['SKETCH_PATH']}`);
      this.logger.verbose(`  SKETCH_NAME: ${process.env['SKETCH_NAME']}`);
      this.logger.verbose(`  BUILD_PATH: ${process.env['BUILD_PATH']}`);
      
      // 1. 首先添加核心SDK路径（Arduino.h所在位置）
      if (process.env['SDK_CORE_PATH'] && fs.existsSync(process.env['SDK_CORE_PATH'])) {
        includes.push(`-I"${process.env['SDK_CORE_PATH']}"`);
        this.logger.verbose(`Added core path: ${process.env['SDK_CORE_PATH']}`);
      }
      
      // 2. 添加变体路径
      if (process.env['SDK_VARIANT_PATH'] && fs.existsSync(process.env['SDK_VARIANT_PATH'])) {
        includes.push(`-I"${process.env['SDK_VARIANT_PATH']}"`);
        this.logger.verbose(`Added variant path: ${process.env['SDK_VARIANT_PATH']}`);
      }

      // 3. 使用 DependencyAnalyzer 分析库依赖
      const analyzer = new DependencyAnalyzer(this.logger);
      const allDependencies = await analyzer.preprocess(arduinoConfig);
      
      this.logger.verbose(`DependencyAnalyzer found ${allDependencies.length} dependencies before filtering`);
      
      // 4. 智能依赖过滤
      const filteredDependencies = this.filterSmartDependencies(allDependencies, options.sketchPath);
      
      this.logger.verbose(`After smart filtering: ${filteredDependencies.length} dependencies`);
      
      // 5. 从依赖分析结果中构建include路径（与NinjaCompilationPipeline保持一致）
      for (const dependency of filteredDependencies) {
        if (dependency.path && fs.existsSync(dependency.path)) {
          // 直接添加依赖路径（与compile功能保持一致）
          includes.push(`-I"${dependency.path}"`);
          this.logger.verbose(`Added library root path: ${dependency.path}`);
        }
      }
      
    } catch (error) {
      this.logger.error(`Dependency analysis failed: ${error}`);
      throw error;
    }
    
    this.logger.verbose(`Total include paths: ${includes.length}`);
    return includes;
  }

  /**
   * 智能依赖过滤 - 参考compile功能的方法，保持与ArduinoCompiler一致
   */
  private filterSmartDependencies(dependencies: any[], sketchPath: string): any[] {
    // 参考ArduinoCompiler的做法，不进行过激的过滤
    // DependencyAnalyzer已经做了合理的依赖分析，我们只做最小必要的过滤
    
    // 1. 只过滤明确会导致编译错误的库
    const knownProblematicLibraries = [
      // 只保留确实无法编译的库
    ];
    
    // 2. 保留核心依赖和所有库依赖（与compile功能保持一致）
    const filtered = dependencies.filter(dep => {
      // 保留所有核心和变体依赖
      if (dep.type === 'core' || dep.type === 'variant') {
        return true;
      }
      
      // 保留所有库依赖（除非明确有问题）
      if (dep.type === 'library') {
        if (knownProblematicLibraries.includes(dep.name)) {
          this.logger.verbose(`Skipping known problematic library: ${dep.name}`);
          return false;
        }
        return true;
      }
      
      return true;
    });
    
    this.logger.verbose(`After minimal filtering: ${filtered.length} dependencies (was ${dependencies.length})`);
    return filtered;
  }
  


  /**
   * 提取 sketch 中直接引用的头文件
   */
  // private extractDirectIncludes(sketchPath: string): string[] {
  //   try {
  //     const content = fs.readFileSync(sketchPath, 'utf-8');
  //     const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g;
  //     const includes: string[] = [];
  //     let match;
      
  //     while ((match = includeRegex.exec(content)) !== null) {
  //       includes.push(match[1]);
  //     }
      
  //     return includes;
  //   } catch (error) {
  //     this.logger.verbose(`Failed to read sketch file: ${error}`);
  //     return [];
  //   }
  // }
  
  /**
   * 判断是否是必需库（总是需要包含的核心库）
   */
  // private isEssentialLibrary(libraryName: string): boolean {
  //   const essentialLibraries = [
  //     'WiFi',           // WiFi 连接核心
  //     'Network',        // 网络基础
  //     'WebServer',      // Web 服务器
  //     'HTTPClient',     // HTTP 客户端
  //     'FS',             // 文件系统
  //     'EEPROM',         // EEPROM 存储
  //     'Ticker',         // 定时器
  //     'BLE',            // 蓝牙
  //     'NetworkClientSecure', // 安全网络客户端
  //     'DHT_sensor_library',  // DHT 传感器（常用）
  //     'Adafruit_Unified_Sensor' // Adafruit 传感器统一接口
  //   ];
    
  //   return essentialLibraries.includes(libraryName);
  // }

  /**
   * 添加库源目录，参考 DependencyAnalyzer.findSourceDirectories 的逻辑
   */
  // private addLibrarySourceDirectories(libraryBasePath: string, includes: string[]): void {
  //   try {
  //     // 递归查找所有包含头文件的目录
  //     const headerDirs = this.findHeaderDirectories(libraryBasePath);
      
  //     for (const dir of headerDirs) {
  //       if (!includes.includes(`-I"${dir}"`)) {
  //         includes.push(`-I"${dir}"`);
  //         this.logger.verbose(`Added library header directory: ${dir}`);
  //       }
  //     }
  //   } catch (error) {
  //     this.logger.verbose(`Warning: Could not scan library directory ${libraryBasePath}: ${error}`);
  //   }
  // }

  /**
   * 查找包含头文件的目录，简化版本的 DependencyAnalyzer.findSourceDirectories
   */
  // private findHeaderDirectories(basePath: string): string[] {
  //   const headerDirs = new Set<string>();
    
  //   try {
  //     // 递归查找所有头文件
  //     const entries = fs.readdirSync(basePath, { withFileTypes: true });
      
  //     for (const entry of entries) {
  //       const fullPath = path.join(basePath, entry.name);
        
  //       // 跳过示例、测试等目录
  //       if (entry.isDirectory() && !['examples', 'extras', 'test', 'tests', 'docs'].includes(entry.name)) {
  //         // 检查当前目录是否有头文件
  //         const hasHeaders = this.hasHeaderFiles(fullPath);
  //         if (hasHeaders) {
  //           headerDirs.add(fullPath);
  //         }
          
  //         // 递归查找子目录
  //         const subDirs = this.findHeaderDirectories(fullPath);
  //         subDirs.forEach(dir => headerDirs.add(dir));
  //       }
  //     }
  //   } catch (error) {
  //     // 忽略读取错误
  //   }
    
  //   return Array.from(headerDirs);
  // }

  /**
   * 检查目录是否包含头文件
   */
  // private hasHeaderFiles(dirPath: string): boolean {
  //   try {
  //     const files = fs.readdirSync(dirPath);
  //     return files.some(file => /\.(h|hpp)$/i.test(file));
  //   } catch {
  //     return false;
  //   }
  // }

  /**
   * 构建编译器定义
   */
  // private buildDefines(config: Record<string, any>): string[] {
  //   return [
  //     `-DARDUINO=${config['runtime.ide.version'] || '10607'}`,
  //     `-DARDUINO_${config['build.board'] || 'UNKNOWN'}`,
  //     `-DARDUINO_ARCH_${(config['build.arch'] || 'UNKNOWN').toUpperCase()}`,
  //     `-DF_CPU=${config['build.f_cpu'] || '16000000L'}`,
  //     `-DPROJECT_NAME="lint_check"`
  //   ];
  // }

  /**
   * 解析编译器错误输出
   */
  private parseCompilerErrors(compilerOutput: string, originalFile: string): {
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  } {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];
    
    if (!compilerOutput.trim()) {
      return { errors, warnings, notes };
    }
    
    this.logger.verbose(`Parsing compiler output: ${compilerOutput}`);
    
    // 解析 GCC 输出格式
    // 支持多种格式：
    // 1. file:line:column: severity: message
    // 2. file:line: fatal error: message
    // 3. In file included from file:line:
    const lines = compilerOutput.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // 尝试从行中提取编译器错误信息（可能嵌套在其他文本中）
      // 匹配格式：任何地方的 file:line:column: severity: message
      let match = line.match(/([^:\s]+):(\d+):(\d+):\s*(error|warning|note|fatal error):\s*(.+)$/);
      if (match) {
        const [, file, lineNum, colNum, severity, message] = match;
        
        // 计算正确的行号：需要减去添加的头文件行数
        // 我们在 convertSketchToCpp 中添加了 #include <Arduino.h> 和可能的函数声明
        // const originalLine = this.mapLineNumberToOriginal(parseInt(lineNum, 10));
        const originalLine = parseInt(lineNum, 10); // 简化处理，直接使用编译器行号
        
        const lintError: LintError = {
          file: originalFile, // 使用原始文件名而不是临时文件名
          line: originalLine,
          column: parseInt(colNum, 10),
          message: message.trim(),
          severity: severity.includes('error') ? 'error' : severity as 'error' | 'warning' | 'note'
        };
        
        switch (lintError.severity) {
          case 'error':
            errors.push(lintError);
            break;
          case 'warning':
            warnings.push(lintError);
            break;
          case 'note':
            notes.push(lintError);
            break;
        }
        continue;
      }
      
      // 匹配无行号格式：file: fatal error: message
      match = line.match(/^([^:]+):\s*(fatal error|error):\s*(.+)$/);
      if (match) {
        const [, file, severity, message] = match;
        
        const lintError: LintError = {
          file: originalFile,
          line: 1,
          column: 1,
          message: message.trim(),
          severity: 'error'
        };
        
        errors.push(lintError);
        continue;
      }
      
      // 匹配其他错误格式，如 "compilation terminated"
      if (line.includes('fatal error') || line.includes('error:')) {
        const lintError: LintError = {
          file: originalFile,
          line: 1,
          column: 1,
          message: line,
          severity: 'error'
        };
        
        errors.push(lintError);
      }
    }
    
    return { errors, warnings, notes };
  }

  /**
   * 将生成的 C++ 文件的行号映射回原始 sketch 文件的行号
   */
  private mapLineNumberToOriginal(cppLineNumber: number): number {
    // 在 convertSketchToCpp 中，我们添加了：
    // 1. #include <Arduino.h>  (第1行)
    // 2. 空行                  (第2行)  
    // 3. 可能的函数声明         (若干行)
    // 4. 空行                  (第n行)
    // 5. 原始代码开始           (第n+1行)
    
    // 简化处理：假设添加了2行头文件和声明
    // 实际应该根据 convertSketchToCpp 的具体实现来计算
    const headerLines = 2; // #include <Arduino.h> + 空行
    
    if (cppLineNumber <= headerLines) {
      // 错误在头文件部分，映射到第1行
      return 1;
    }
    
    // 错误在原始代码部分，减去头文件行数
    return Math.max(1, cppLineNumber - headerLines);
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(options: LintOptions): string {
    const keyData = {
      board: options.board,
      sdkPath: options.sdkPath,
      toolsPath: options.toolsPath,
      librariesPath: options.librariesPath,
      boardOptions: options.boardOptions,
      buildProperties: options.buildProperties
    };
    return Buffer.from(JSON.stringify(keyData)).toString('base64');
  }

  /**
   * 检查缓存是否过期
   */
  private isCacheExpired(cache: LintCache, options: LintOptions): boolean {
    if (!cache.lastModified) return true;
    
    // 缓存有效期：5分钟
    const cacheTimeout = 5 * 60 * 1000;
    if (Date.now() - cache.lastModified > cacheTimeout) {
      return true;
    }
    
    // 检查关键文件是否被修改
    try {
      const sketchStat = fs.statSync(options.sketchPath);
      return sketchStat.mtimeMs > cache.lastModified;
    } catch {
      return true;
    }
  }

  /**
   * 优化的依赖分析 - 使用 DependencyAnalyzer
   */
  private async performOptimizedDependencyAnalysis(options: LintOptions): Promise<any[]> {
    try {
      // 构建 FQBN 字符串
      const fqbn = options.board;
      const buildProperties = options.buildProperties || {};
      
      // 首先尝试从缓存获取配置解析结果
      let configResult = await this.getCachedConfigResult(options);
      
      if (!configResult) {
        // 缓存未命中，执行配置解析
        configResult = await this.configParser.parseByFQBN(fqbn, buildProperties);
        // 缓存配置结果
        await this.cacheConfigResult(options, configResult);
      }
      
      // 构建完整的 Arduino 配置对象（与 ArduinoCompiler 兼容）
      const arduinoConfig = {
        ...configResult.platform,
        ...configResult.board,
        ...configResult.buildProperties,
        fqbn: configResult.fqbn,
        fqbnObj: configResult.fqbnParsed
      };
      
      // 使用 DependencyAnalyzer 进行分析
      const dependencies = await this.dependencyAnalyzer.preprocess(arduinoConfig);
      
      this.logger.verbose(`Found ${dependencies.length} dependencies using optimized analysis`);
      return dependencies;
    } catch (error) {
      this.logger.verbose(`Dependency analysis failed, falling back to simple mode: ${error}`);
      return [];
    }
  }

  /**
   * 优化的编译器分析 - 使用缓存的依赖信息
   */
  private async performOptimizedCompilerAnalysis(
    options: LintOptions, 
    cachedData: LintCache, 
    startTime: number
  ): Promise<LintResult> {
    let result: LintResult;
    
    // 如果有缓存的依赖信息，使用更精确的包含路径
    if (cachedData.dependencies && cachedData.dependencies.length > 0) {
      this.logger.verbose('Using cached dependencies for optimized compiler analysis');
      
      // 使用依赖信息构建更精确的包含路径
      const optimizedOptions = {
        ...options,
        librariesPath: this.buildLibraryPathsFromDependencies(cachedData.dependencies)
      };
      
      result = await this.performCompilerAnalysis(optimizedOptions, startTime);
    } else {
      // 回退到标准编译器分析
      result = await this.performCompilerAnalysis(options, startTime);
    }
    
    // 缓存编译器分析结果（异步执行，不阻塞返回）
    this.cacheCompilerResult(options, result).catch(error => {
      this.logger.debug(`Failed to cache compiler result: ${error instanceof Error ? error.message : error}`);
    });
    
    return result;
  }

  /**
   * 从依赖信息构建库路径
   */
  private buildLibraryPathsFromDependencies(dependencies: any[]): string[] {
    const libraryPaths: string[] = [];
    
    for (const dep of dependencies) {
      if (dep.path && fs.existsSync(dep.path)) {
        libraryPaths.push(dep.path);
        
        // 添加 src 子目录
        const srcPath = path.join(dep.path, 'src');
        if (fs.existsSync(srcPath)) {
          libraryPaths.push(srcPath);
        }
      }
    }
    
    return libraryPaths;
  }

  /**
   * 创建 LintCacheKey
   */
  private async createLintCacheKey(options: LintOptions, operation: 'dependency' | 'compiler' | 'config'): Promise<LintCacheKey> {
    const librariesPath = Array.isArray(options.librariesPath) 
      ? options.librariesPath.join(';') 
      : (options.librariesPath || '');
    
    // 计算源文件内容的哈希值，确保文件变化时缓存失效
    let fileContentHash = '';
    try {
      const fileContent = await fs.readFile(options.sketchPath, 'utf-8');
      fileContentHash = crypto.createHash('md5').update(fileContent).digest('hex');
    } catch (error) {
      // 如果读取文件失败，使用文件路径和时间戳
      fileContentHash = crypto.createHash('md5').update(`${options.sketchPath}_${Date.now()}`).digest('hex');
    }
      
    return {
      operation,
      board: options.board,
      sdkPath: options.sdkPath || '',
      toolsPath: options.toolsPath || '',
      librariesPath,
      buildProperties: JSON.stringify(options.buildProperties || {}),
      boardOptions: JSON.stringify(options.boardOptions || {}),
      sourceFile: options.sketchPath,
      fileContentHash, // 新增：文件内容哈希
      mode: options.mode
    };
  }

  /**
   * 智能决策是否需要编译器检查
   */
  private shouldUseCompilerCheck(staticResult: StaticAnalysisResult, options: LintOptions): boolean {
    // 如果静态分析明确建议需要编译器检查，直接采纳
    if (staticResult.needsCompilerCheck) {
      return true;
    }

    // fast 模式优先：强制跳过编译器检查（即使有warnings）
    if (options.mode === 'fast') {
      return false;
    }

    // 如果发现严重错误或警告，需要编译器验证（auto/accurate模式）
    if (staticResult.errors.length > 0 || staticResult.warnings.length > 0) {
      return true;
    }

    if (options.mode === 'accurate') {
      return true; // accurate 模式强制使用编译器检查
    }

    // auto 模式的智能决策
    const warningCount = staticResult.warnings.length;
    
    // 如果静态分析置信度高且警告较少，跳过编译器检查
    if (staticResult.confidence === 'high' && warningCount <= 2) {
      return false;
    }

    // 如果静态分析置信度中等且警告很少，可能跳过编译器检查
    if (staticResult.confidence === 'medium' && warningCount <= 1) {
      return false;
    }

    // 其他情况都使用编译器检查
    return true;
  }

  /**
   * 并行准备配置和依赖分析
   */
  private async performParallelPreparation(options: LintOptions, cacheKey: string): Promise<{
    cachedData: LintCache;
    configResult: any;
    dependencies: any[];
  }> {
    // 首先尝试从缓存获取
    let dependencies = await this.getCachedDependencyResult(options);
    let cachedData = this.cache.get(cacheKey);
    
    if (!dependencies || !cachedData || this.isCacheExpired(cachedData, options)) {
      this.logger.verbose('Cache miss or expired, performing parallel preparation...');
      
      // 并行执行配置解析和依赖分析
      const [configResult, newDependencies] = await Promise.all([
        this.getOrParseConfig(options),
        this.performOptimizedDependencyAnalysis(options)
      ]);
      
      dependencies = newDependencies;
      
      // 构建 Arduino 配置对象
      const arduinoConfig = {
        ...configResult.platform,
        ...configResult.board,
        ...configResult.buildProperties,
        fqbn: configResult.fqbn,
        fqbnObj: configResult.fqbnParsed
      };
      
      cachedData = {
        config: arduinoConfig,
        dependencies,
        lastModified: Date.now()
      };
      
      // 并行缓存结果
      await Promise.all([
        this.cacheConfigResult(options, configResult),
        this.cacheDependencyResult(options, dependencies)
      ]);
      
      this.cache.set(cacheKey, cachedData);
      
      return { cachedData, configResult, dependencies };
    } else {
      this.logger.verbose('Using cached configuration and dependencies');
      
      // 从缓存获取配置结果
      const configResult = await this.getCachedConfigResult(options);
      
      return { cachedData, configResult: configResult || {}, dependencies };
    }
  }

  /**
   * 获取或解析配置（带缓存）
   */
  private async getOrParseConfig(options: LintOptions): Promise<any> {
    let configResult = await this.getCachedConfigResult(options);
    
    if (!configResult) {
      // 缓存未命中，执行配置解析
      configResult = await this.configParser.parseByFQBN(options.board, options.buildProperties || {});
    } else {
      this.logger.verbose('Using cached configuration result');
    }
    
    return configResult;
  }

  /**
   * 合并静态分析和编译器分析结果
   */
  private mergeAnalysisResults(staticResult: StaticAnalysisResult, compilerResult: LintResult): LintResult {
    // 优先使用编译器结果，但保留静态分析的独特发现
    const mergedErrors = [...compilerResult.errors];
    const mergedWarnings = [...compilerResult.warnings];
    const mergedNotes = [...compilerResult.notes];

    // 添加静态分析独有的错误（避免重复）
    staticResult.errors.forEach(error => {
      const isDuplicate = mergedErrors.some(existing => 
        existing.line === error.line && 
        existing.column === error.column && 
        existing.message === error.message
      );
      if (!isDuplicate) {
        mergedErrors.push(error);
      }
    });

    // 添加静态分析独有的警告
    staticResult.warnings.forEach(warning => {
      const isDuplicate = mergedWarnings.some(existing => 
        existing.line === warning.line && 
        existing.column === warning.column && 
        existing.message === warning.message
      );
      if (!isDuplicate) {
        mergedWarnings.push(warning);
      }
    });

    // 添加静态分析的注释
    staticResult.notes.forEach(note => {
      const isDuplicate = mergedNotes.some(existing => 
        existing.line === note.line && 
        existing.column === note.column && 
        existing.message === note.message
      );
      if (!isDuplicate) {
        mergedNotes.push(note);
      }
    });

    return {
      success: mergedErrors.length === 0,
      errors: mergedErrors,
      warnings: mergedWarnings,
      notes: mergedNotes,
      executionTime: compilerResult.executionTime
    };
  }

  /**
   * 缓存依赖分析结果
   */
  private async cacheDependencyResult(options: LintOptions, dependencies: any[]): Promise<void> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'dependency');
      await this.lintCacheManager.storeToCache(cacheKey, dependencies);
      this.logger.debug(`Cached dependency analysis result for ${path.basename(options.sketchPath)}`);
    } catch (error) {
      this.logger.debug(`Failed to cache dependency result: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 从缓存获取依赖分析结果
   */
  private async getCachedDependencyResult(options: LintOptions): Promise<any[] | null> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'dependency');
      const result = await this.lintCacheManager.getFromCache(cacheKey);
      if (result) {
        this.logger.debug(`Retrieved cached dependency analysis for ${path.basename(options.sketchPath)}`);
      }
      return result;
    } catch (error) {
      this.logger.debug(`Failed to retrieve cached dependency result: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 缓存编译器分析结果
   */
  private async cacheCompilerResult(options: LintOptions, result: LintResult): Promise<void> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'compiler');
      const cacheData = {
        success: result.success,
        errors: result.errors,
        warnings: result.warnings,
        notes: result.notes
      };
      await this.lintCacheManager.storeToCache(cacheKey, cacheData);
      this.logger.debug(`Cached compiler analysis result for ${path.basename(options.sketchPath)}`);
    } catch (error) {
      this.logger.debug(`Failed to cache compiler result: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 从缓存获取编译器分析结果
   */
  private async getCachedCompilerResult(options: LintOptions): Promise<LintResult | null> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'compiler');
      const cacheData = await this.lintCacheManager.getFromCache(cacheKey);
      
      if (cacheData) {
        this.logger.debug(`Retrieved cached compiler analysis for ${path.basename(options.sketchPath)}`);
        return {
          success: cacheData.success,
          errors: cacheData.errors || [],
          warnings: cacheData.warnings || [],
          notes: cacheData.notes || [],
          executionTime: 0 // 缓存结果不计算执行时间
        };
      }
      
      return null;
    } catch (error) {
      this.logger.debug(`Failed to retrieve cached compiler result: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 缓存配置解析结果
   */
  private async cacheConfigResult(options: LintOptions, config: any): Promise<void> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'config');
      await this.lintCacheManager.storeToCache(cacheKey, config);
      this.logger.debug(`Cached config analysis result for ${path.basename(options.sketchPath)}`);
    } catch (error) {
      this.logger.debug(`Failed to cache config result: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 从缓存获取配置解析结果
   */
  private async getCachedConfigResult(options: LintOptions): Promise<any | null> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'config');
      const result = await this.lintCacheManager.getFromCache(cacheKey);
      if (result) {
        this.logger.debug(`Retrieved cached config analysis for ${path.basename(options.sketchPath)}`);
      }
      return result;
    } catch (error) {
      this.logger.debug(`Failed to retrieve cached config result: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 规范化命令中的路径分隔符，修复混合斜杠问题
   */
  private normalizePathSeparators(command: string): string {
    // 在 Windows 上，将混合的路径分隔符统一为反斜杠
    if (process.platform === 'win32') {
      // 处理引号内的路径
      command = command.replace(/"([^"]*[/\\][^"]*)"/g, (match, path) => {
        // 统一为反斜杠，但避免双斜杠
        let normalized = path.replace(/[/\\]+/g, '\\');
        
        // 修复 ESP32 工具链的重复 /bin//bin/ 问题
        normalized = normalized.replace(/\\bin\\bin\\/, '\\bin\\');
        normalized = normalized.replace(/\/bin\/\/bin\//, '/bin/');
        
        return `"${normalized}"`;
      });
      
      // 处理不在引号内的路径（更谨慎的处理）
      command = command.replace(/(\s)([A-Za-z]:[/\\][^\s"]*)/g, (match, space, path) => {
        let normalized = path.replace(/[/\\]+/g, '\\');
        
        // 修复重复 bin 目录问题
        normalized = normalized.replace(/\\bin\\bin\\/, '\\bin\\');
        
        return space + normalized;
      });
    }
    
    return command;
  }
}
