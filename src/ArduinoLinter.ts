import { Logger } from './utils/Logger';
import { ArduinoConfigParser } from './ArduinoConfigParser';
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

export class ArduinoLinter {
  constructor(
    private logger: Logger,
    private configParser: ArduinoConfigParser
  ) {}

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

  /**
   * 获取预处理后的文件 - 简化版本，直接进行静态语法检查
   */
  private async getPreprocessedFile(options: LintOptions): Promise<string> {
    // 创建临时目录
    const tempDir = path.join(os.tmpdir(), `aily-lint-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    await fs.ensureDir(tempDir);
    
    const preprocessedPath = path.join(tempDir, 'sketch.cpp');
    
    try {
      this.logger.verbose(`Performing static syntax analysis...`);
      
      // 直接转换 sketch 为 C++ 并进行基本语法检查
      await this.createSimpleCppFile(options.sketchPath, preprocessedPath);
      
      return preprocessedPath;
    } catch (error) {
      // 清理临时目录
      await fs.remove(tempDir).catch(() => {});
      throw error;
    }
  }

  /**
   * 创建简单的 C++ 文件用于语法检查
   */
  private async createSimpleCppFile(
    sketchPath: string, 
    outputPath: string
  ): Promise<void> {
    // 读取原始 sketch 文件
    const sketchContent = await fs.readFile(sketchPath, 'utf-8');
    
    // 生成简化的 C++ 代码用于语法检查
    const cppContent = this.convertSketchToCpp(sketchContent);
    
    // 写入输出文件
    await fs.writeFile(outputPath, cppContent);
  }

  /**
   * 将 Arduino sketch 转换为标准 C++
   */
  private convertSketchToCpp(sketchContent: string): string {
    // 添加 Arduino 核心头文件
    let cppContent = '#include <Arduino.h>\n\n';
    
    // 简单的函数前向声明检测和添加
    const functionDeclarations = this.extractFunctionDeclarations(sketchContent);
    if (functionDeclarations.length > 0) {
      cppContent += functionDeclarations.join('\n') + '\n\n';
    }
    
    // 添加原始代码
    cppContent += sketchContent;
    
    return cppContent;
  }

  /**
   * 提取函数前向声明
   */
  private extractFunctionDeclarations(content: string): string[] {
    const declarations: string[] = [];
    
    // 简单的函数定义匹配（不包括 setup/loop）
    const functionRegex = /^((?:static\s+)?(?:inline\s+)?(?:const\s+)?[a-zA-Z_][a-zA-Z0-9_*&\s]+\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{/gm;
    
    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      const [, returnType, funcName] = match;
      
      // 跳过 setup 和 loop 函数
      if (funcName === 'setup' || funcName === 'loop') {
        continue;
      }
      
      // 提取参数列表
      const startPos = match.index + match[0].indexOf('(');
      const paramMatch = content.slice(startPos).match(/\([^)]*\)/);
      
      if (paramMatch) {
        const params = paramMatch[0];
        declarations.push(`${returnType.trim()}${funcName}${params};`);
      }
    }
    
    return declarations;
  }

  /**
   * 构建语法检查命令
   */
  private async buildSyntaxCheckCommand(
    preprocessedFile: string,
    options: LintOptions
  ): Promise<string> {
    // 获取平台配置
    const result = await this.configParser.parseByFQBN(options.board, {}, {});
    const config = { ...result.platform, ...result.board };
    
    // 获取编译器路径和基础参数
    let compileCmd = config['recipe.cpp.o.pattern'] || config['recipe.c.o.pattern'];
    
    if (!compileCmd) {
      throw new Error('Cannot find compiler recipe in platform configuration');
    }
    
    // 替换变量
    compileCmd = this.replaceVariables(compileCmd, {
      ...config,
      source_file: preprocessedFile,
      object_file: '' // 不需要输出文件
    });
    
    // 修改为语法检查模式
    compileCmd = compileCmd
      .replace(/-c\s+/g, '-fsyntax-only ')  // 替换 -c 为 -fsyntax-only
      .replace(/-o\s+[^\s]+/g, '')          // 移除 -o output.o
      .replace(/-MMD\s*/g, '')              // 移除依赖生成
      .replace(/-MP\s*/g, '');
    
    // 添加诊断选项
    compileCmd += ' -fdiagnostics-color=always';
    compileCmd += ' -fmax-errors=50'; // 限制错误数量，避免输出过多
    
    // 如果支持 JSON 输出格式（GCC 9+）
    if (options.format === 'json') {
      compileCmd += ' -fdiagnostics-format=json';
    }
    
    this.logger.verbose(`Syntax check command: ${compileCmd}`);
    
    return compileCmd;
  }

  /**
   * 替换命令中的变量
   */
  private replaceVariables(command: string, vars: Record<string, string>): string {
    let result = command;
    
    for (const [key, value] of Object.entries(vars)) {
      const pattern = new RegExp(`\\{${key}\\}`, 'g');
      result = result.replace(pattern, value || '');
    }
    
    return result;
  }

  /**
   * 执行语法检查命令
   */
  private async executeSyntaxCheck(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parts = command.split(/\s+/);
      const executable = parts[0];
      const args = parts.slice(1);
      
      let stdout = '';
      let stderr = '';
      
      const childProcess = spawn(executable, args, {
        shell: true,
        env: { ...process.env, LANG: 'en_US.UTF-8' } // 确保英文输出
      });
      
      childProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      childProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      childProcess.on('close', (code) => {
        // 语法检查即使有错误也会返回非0，这是正常的
        // 我们需要解析输出而不是依赖退出码
        resolve(stderr + stdout);
      });
      
      childProcess.on('error', (error) => {
        reject(new Error(`Failed to execute syntax check: ${error.message}`));
      });
    });
  }

  /**
   * 解析编译器输出
   */
  private parseCompilerOutput(
    output: string,
    format: 'vscode' | 'json' | 'human' = 'human'
  ): Omit<LintResult, 'success' | 'executionTime'> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];
    
    // 尝试 JSON 格式解析
    if (format === 'json') {
      try {
        const diagnostics = this.parseJsonOutput(output);
        return this.categorizeDiagnostics(diagnostics);
      } catch (e) {
        this.logger.debug('JSON parsing failed, falling back to text parsing');
      }
    }
    
    // 文本格式解析
    return this.parseTextOutput(output);
  }

  /**
   * 解析 JSON 格式输出（GCC 9+）
   */
  private parseJsonOutput(output: string): LintError[] {
    const diagnostics: LintError[] = [];
    
    // GCC JSON 输出是一行一个 JSON 对象
    const lines = output.split('\n').filter(line => line.trim().startsWith('{'));
    
    for (const line of lines) {
      try {
        const diag = JSON.parse(line);
        
        if (diag.kind && diag.locations && diag.message) {
          const location = diag.locations[0] || {};
          
          diagnostics.push({
            file: location.file || '',
            line: location.line || 0,
            column: location.column || 0,
            message: diag.message,
            severity: this.mapSeverity(diag.kind),
            code: diag.option || undefined
          });
        }
      } catch (e) {
        // 跳过无效的 JSON 行
        continue;
      }
    }
    
    return diagnostics;
  }

  /**
   * 解析文本格式输出
   */
  private parseTextOutput(output: string): Omit<LintResult, 'success' | 'executionTime'> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];
    
    // 匹配格式：
    // file.cpp:15:23: error: expected ';' before '}' token
    // file.cpp:20:5: warning: unused variable 'x' [-Wunused-variable]
    const diagnosticRegex = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+?)(?:\s+\[(.+?)\])?$/gm;
    
    let match;
    while ((match = diagnosticRegex.exec(output)) !== null) {
      const [, file, line, col, severity, message, code] = match;
      
      const diagnostic: LintError = {
        file: this.normalizeFilePath(file),
        line: parseInt(line),
        column: parseInt(col),
        message: message.trim(),
        severity: this.mapSeverity(severity),
        code: code || undefined
      };
      
      if (diagnostic.severity === 'error') {
        errors.push(diagnostic);
      } else if (diagnostic.severity === 'warning') {
        warnings.push(diagnostic);
      } else {
        notes.push(diagnostic);
      }
    }
    
    return { errors, warnings, notes };
  }

  /**
   * 分类诊断信息
   */
  private categorizeDiagnostics(
    diagnostics: LintError[]
  ): Omit<LintResult, 'success' | 'executionTime'> {
    const errors = diagnostics.filter(d => d.severity === 'error');
    const warnings = diagnostics.filter(d => d.severity === 'warning');
    const notes = diagnostics.filter(d => d.severity === 'note');
    
    return { errors, warnings, notes };
  }

  /**
   * 映射严重性级别
   */
  private mapSeverity(severity: string): 'error' | 'warning' | 'note' {
    switch (severity.toLowerCase()) {
      case 'error':
      case 'fatal error':
        return 'error';
      case 'warning':
        return 'warning';
      case 'note':
      case 'info':
        return 'note';
      default:
        return 'note';
    }
  }

  /**
   * 标准化文件路径
   */
  private normalizeFilePath(filePath: string): string {
    // 移除 Windows 盘符后的不必要前缀
    return path.normalize(filePath.trim());
  }

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
  private buildPreprocessorCommand(
    sketchPath: string,
    outputPath: string,
    config: Record<string, any>
  ): string {
    // 获取编译器路径 - 使用更完整的路径构建
    const compilerCmd = config['compiler.cpp.cmd'] || 'g++';
    const compilerPath = config['compiler.path'] || '';
    const toolsPath = config['runtime.tools.arm-none-eabi-gcc.path'] || '';
    
    // 尝试多种路径组合
    let fullCompilerPath: string;
    if (toolsPath && compilerCmd.includes('arm-none-eabi')) {
      fullCompilerPath = path.join(toolsPath, 'bin', compilerCmd);
    } else if (compilerPath) {
      fullCompilerPath = path.join(compilerPath, compilerCmd);
    } else {
      fullCompilerPath = compilerCmd;
    }
    
    // 构建预处理命令
    let cmd = `"${fullCompilerPath}" -E`; // -E 表示只进行预处理
    
    // 添加基本选项
    cmd += ` -w`; // 抑制警告
    cmd += ` -std=gnu++17`; // C++ 标准
    cmd += ` -fpermissive`; // 允许一些宽松的语法
    
    // 添加定义
    const defines = [
      `-DARDUINO=${config['runtime.ide.version'] || '10607'}`,
      `-DARDUINO_${config['build.board'] || 'UNKNOWN'}`,
      `-DARDUINO_ARCH_${config['build.arch']?.toUpperCase() || 'UNKNOWN'}`
    ];
    cmd += ` ${defines.join(' ')}`;
    
    // 添加核心头文件路径
    const corePath = config['runtime.platform.path'] ? 
      path.join(config['runtime.platform.path'], 'cores', config['build.core'] || 'arduino') :
      '';
    if (corePath && fs.existsSync(corePath)) {
      cmd += ` -I"${corePath}"`;
    }
    
    // 添加变体头文件路径
    const variantPath = config['runtime.platform.path'] ? 
      path.join(config['runtime.platform.path'], 'variants', config['build.variant'] || 'standard') :
      '';
    if (variantPath && fs.existsSync(variantPath)) {
      cmd += ` -I"${variantPath}"`;
    }
    
    return cmd;
  }

  /**
   * 运行预处理器
   */
  private async runPreprocessor(
    preprocessorCmd: string,
    inputFile: string,
    outputFile: string
  ): Promise<void> {
    const fullCmd = `${preprocessorCmd} "${inputFile}" -o "${outputFile}"`;
    
    return new Promise((resolve, reject) => {
      const childProcess = spawn(fullCmd, [], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      
      childProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      
      childProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Preprocessing failed: ${stderr}`));
        }
      });
      
      childProcess.on('error', (error) => {
        reject(new Error(`Failed to run preprocessor: ${error.message}`));
      });
    });
  }

  /**
   * 执行静态语法分析
   */
  private async performStaticSyntaxAnalysis(sketchPath: string): Promise<{
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  }> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];
    
    try {
      // 读取文件内容
      const content = await fs.readFile(sketchPath, 'utf-8');
      const lines = content.split('\n');
      
      // 执行各种语法检查
      this.checkBraces(lines, sketchPath, errors);
      this.checkSemicolons(lines, sketchPath, errors, warnings);
      this.checkVariableDeclarations(lines, sketchPath, warnings);
      this.checkFunctionSyntax(lines, sketchPath, errors, warnings);
      this.checkArduinoSpecific(lines, sketchPath, warnings, notes);
      
    } catch (error) {
      errors.push({
        file: sketchPath,
        line: 0,
        column: 0,
        message: `Failed to read file: ${error instanceof Error ? error.message : error}`,
        severity: 'error'
      });
    }
    
    return { errors, warnings, notes };
  }

  /**
   * 检查大括号匹配
   */
  private checkBraces(lines: string[], filePath: string, errors: LintError[]): void {
    const braceStack: { line: number; char: string; column: number }[] = [];
    
    lines.forEach((line, lineIndex) => {
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const prevChar = i > 0 ? line[i - 1] : '';
        const nextChar = i < line.length - 1 ? line[i + 1] : '';
        
        // 跳过字符串和注释中的括号
        if (this.isInStringOrComment(line, i)) continue;
        
        if (char === '{' || char === '(' || char === '[') {
          braceStack.push({ line: lineIndex + 1, char, column: i + 1 });
        } else if (char === '}' || char === ')' || char === ']') {
          const expected = char === '}' ? '{' : char === ')' ? '(' : '[';
          
          if (braceStack.length === 0) {
            errors.push({
              file: filePath,
              line: lineIndex + 1,
              column: i + 1,
              message: `Unexpected '${char}' - no matching opening bracket`,
              severity: 'error'
            });
          } else {
            const last = braceStack.pop()!;
            if (last.char !== expected) {
              errors.push({
                file: filePath,
                line: lineIndex + 1,
                column: i + 1,
                message: `Mismatched bracket: expected '${this.getClosingBrace(last.char)}' but found '${char}'`,
                severity: 'error'
              });
            }
          }
        }
      }
    });
    
    // 检查未关闭的括号
    braceStack.forEach(brace => {
      errors.push({
        file: filePath,
        line: brace.line,
        column: brace.column,
        message: `Unmatched '${brace.char}' - missing closing '${this.getClosingBrace(brace.char)}'`,
        severity: 'error'
      });
    });
  }

  /**
   * 检查分号
   */
  private checkSemicolons(lines: string[], filePath: string, errors: LintError[], warnings: LintError[]): void {
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // 跳过空行、注释行、预处理指令
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || 
          trimmed.startsWith('*') || trimmed.startsWith('#')) {
        return;
      }
      
      // 跳过控制结构、函数定义等不需要分号的行
      if (this.isControlStructure(trimmed) || this.isFunctionDefinition(trimmed) || 
          trimmed.endsWith('{') || trimmed.endsWith('}')) {
        return;
      }
      
      // 检查是否缺少分号
      if (this.shouldEndWithSemicolon(trimmed) && !trimmed.endsWith(';')) {
        errors.push({
          file: filePath,
          line: lineIndex + 1,
          column: line.length,
          message: `Expected ';' at end of statement`,
          severity: 'error'
        });
      }
    });
  }

  /**
   * 检查变量声明
   */
  private checkVariableDeclarations(lines: string[], filePath: string, warnings: LintError[]): void {
    const declaredVars = new Set<string>();
    const usedVars = new Set<string>();
    
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // 检查变量声明
      const varDecl = this.extractVariableDeclaration(trimmed);
      if (varDecl) {
        declaredVars.add(varDecl);
      }
      
      // 检查变量使用
      const usedVar = this.extractVariableUsage(trimmed);
      if (usedVar) {
        usedVars.add(usedVar);
      }
    });
    
    // 检查未声明的变量使用（基础检查）
    usedVars.forEach(varName => {
      if (!declaredVars.has(varName) && !this.isArduinoBuiltin(varName)) {
        warnings.push({
          file: filePath,
          line: 1, // 简化：标记在第一行
          column: 1,
          message: `Possibly undeclared variable: '${varName}'`,
          severity: 'warning'
        });
      }
    });
  }

  /**
   * 检查函数语法
   */
  private checkFunctionSyntax(lines: string[], filePath: string, errors: LintError[], warnings: LintError[]): void {
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // 检查函数调用语法
      const funcCallMatch = trimmed.match(/(\w+)\s*\(/);
      if (funcCallMatch) {
        const funcName = funcCallMatch[1];
        
        // 检查是否有匹配的右括号
        const openCount = (trimmed.match(/\(/g) || []).length;
        const closeCount = (trimmed.match(/\)/g) || []).length;
        
        if (openCount !== closeCount) {
          errors.push({
            file: filePath,
            line: lineIndex + 1,
            column: trimmed.indexOf('(') + 1,
            message: `Unmatched parentheses in function call '${funcName}'`,
            severity: 'error'
          });
        }
      }
    });
  }

  /**
   * 检查 Arduino 特定语法
   */
  private checkArduinoSpecific(lines: string[], filePath: string, warnings: LintError[], notes: LintError[]): void {
    let hasSetup = false;
    let hasLoop = false;
    
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      if (trimmed.includes('void setup(')) {
        hasSetup = true;
      }
      if (trimmed.includes('void loop(')) {
        hasLoop = true;
      }
    });
    
    if (!hasSetup) {
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Missing 'setup()' function - required for Arduino sketches`,
        severity: 'warning'
      });
    }
    
    if (!hasLoop) {
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Missing 'loop()' function - required for Arduino sketches`,
        severity: 'warning'
      });
    }
  }

  // 辅助方法
  private isInStringOrComment(line: string, position: number): boolean {
    // 简单实现：检查是否在字符串或单行注释中
    const beforePos = line.substring(0, position);
    const stringCount = (beforePos.match(/"/g) || []).length;
    const commentPos = line.indexOf('//');
    
    return (stringCount % 2 === 1) || (commentPos !== -1 && position >= commentPos);
  }

  private getClosingBrace(openBrace: string): string {
    switch (openBrace) {
      case '{': return '}';
      case '(': return ')';
      case '[': return ']';
      default: return '';
    }
  }

  private isControlStructure(line: string): boolean {
    const keywords = ['if', 'else', 'while', 'for', 'switch', 'case', 'default', 'do'];
    return keywords.some(keyword => 
      line.startsWith(keyword + ' ') || line.startsWith(keyword + '(')
    );
  }

  private isFunctionDefinition(line: string): boolean {
    return /^\s*\w+\s+\w+\s*\([^)]*\)\s*$/.test(line) || 
           /^\s*\w+\s+\w+\s*\([^)]*\)\s*\{/.test(line);
  }

  private shouldEndWithSemicolon(line: string): boolean {
    // 简单规则：赋值、函数调用、变量声明等应该以分号结尾
    return /^\s*\w/.test(line) && 
           !line.endsWith('{') && 
           !line.endsWith('}') &&
           !this.isControlStructure(line);
  }

  private extractVariableDeclaration(line: string): string | null {
    const match = line.match(/^\s*(int|float|double|char|bool|String|byte)\s+(\w+)/);
    return match ? match[2] : null;
  }

  private extractVariableUsage(line: string): string | null {
    const match = line.match(/\b(\w+)\s*[=+\-*/]/);
    return match ? match[1] : null;
  }

  private isArduinoBuiltin(varName: string): boolean {
    const builtins = [
      'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP',
      'LED_BUILTIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
      'Serial', 'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite',
      'delay', 'delayMicroseconds', 'millis', 'micros'
    ];
    return builtins.includes(varName);
  }

  /**
   * 格式化静态分析结果
   */
  private formatStaticAnalysisResults(
    issues: { errors: LintError[]; warnings: LintError[]; notes: LintError[] },
    format: string
  ): string {
    // 创建临时 LintResult 用于格式化
    const result: LintResult = {
      success: issues.errors.length === 0,
      errors: issues.errors,
      warnings: issues.warnings,
      notes: issues.notes,
      executionTime: 0 // 临时值
    };
    
    if (format === 'json') {
      return JSON.stringify(issues, null, 2);
    } else if (format === 'vscode') {
      return this.formatVSCode(result);
    } else {
      return this.formatHuman(result);
    }
  }

  /**
   * 快速静态分析模式
   */
  private async performFastAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    const issues = await this.performStaticSyntaxAnalysis(options.sketchPath);
    
    return {
      success: issues.errors.length === 0,
      errors: issues.errors,
      warnings: issues.warnings,
      notes: issues.notes || [],
      executionTime: Date.now() - startTime
    };
  }

  /**
   * 编译器精确分析模式
   */
  private async performCompilerAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
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
      const result = await this.configParser.parseByFQBN(options.board, buildProperties, toolVersions);
      const config = { ...result.platform, ...result.board };
      
      // 2. 创建临时目录
      const tempDir = path.join(os.tmpdir(), `aily-lint-compiler-${Date.now()}`);
      await fs.ensureDir(tempDir);
      
      try {
        // 3. 生成预处理后的 C++ 文件
        const cppFile = await this.generateCppFile(options.sketchPath, tempDir);
        
        // 4. 执行编译器语法检查
        const compilerResult = await this.executeCompilerSyntaxCheck(cppFile, config);
        
        // 5. 解析编译器输出
        const issues = this.parseCompilerErrors(compilerResult, options.sketchPath);
        
        return {
          success: issues.errors.length === 0,
          errors: issues.errors,
          warnings: issues.warnings,
          notes: issues.notes || [],
          executionTime: Date.now() - startTime
        };
        
      } finally {
        // 清理临时目录
        await fs.remove(tempDir).catch(() => {});
      }
      
    } catch (error) {
      throw new Error(`Compiler analysis failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 自动模式：先快速检查，如果发现问题再用编译器验证
   */
  private async performAutoAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    // 首先进行快速静态分析
    const fastResult = await this.performFastAnalysis(options, startTime);
    
    // 如果快速检查既没有错误也没有警告，直接返回
    // 现在要求：如果存在 errors 或 warnings，都需要使用准确模式进行进一步验证
    if (fastResult.errors.length === 0 && fastResult.warnings.length === 0) {
      return fastResult;
    }
    
    // 如果发现潜在问题，使用编译器进行精确验证
    this.logger.verbose('Fast analysis found issues, running compiler verification...');
    const resetStartTime = Date.now(); // 重置计时，只计算编译器检查时间
    
    try {
      const accurateResult = await this.performCompilerAnalysis(options, resetStartTime);
      
      // 合并执行时间信息
      accurateResult.executionTime = Date.now() - startTime; // 总时间
      
      return accurateResult;
    } catch (error) {
      // 如果编译器检查失败，回退到静态分析结果
      this.logger.verbose('Compiler analysis failed, using static analysis results');
      return fastResult;
    }
  }

  /**
   * 生成预处理后的 C++ 文件
   */
  private async generateCppFile(sketchPath: string, tempDir: string): Promise<string> {
    const sketchContent = await fs.readFile(sketchPath, 'utf-8');
    const cppContent = this.convertSketchToCpp(sketchContent);
    
    const cppFile = path.join(tempDir, 'sketch.cpp');
    await fs.writeFile(cppFile, cppContent, 'utf-8');
    
    return cppFile;
  }

  /**
   * 执行编译器语法检查
   * 使用 platform.txt 中的 recipe.cpp.o.pattern 来确保与实际编译一致
   */
  private async executeCompilerSyntaxCheck(cppFile: string, config: Record<string, any>): Promise<string> {
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
    const includePaths = this.buildIncludePaths(config).join(' ');
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
    
    this.logger.verbose(`Modified compile command: ${compileCmd}`);
    
    // 调试：显示生成的 C++ 文件内容
    const cppContent = await fs.readFile(cppFile, 'utf-8');
    this.logger.verbose('Generated C++ file content:');
    this.logger.verbose('------- START -------');
    this.logger.verbose(cppContent);
    this.logger.verbose('------- END -------');
    
    return new Promise((resolve, reject) => {
      // 解析编译命令，分离可执行文件和参数
      const cmdMatch = compileCmd.match(/^"([^"]+)"\s+(.*)$/) || compileCmd.match(/^(\S+)\s+(.*)$/);
      if (!cmdMatch) {
        reject(new Error('Invalid compile command format'));
        return;
      }
      
      const executable = cmdMatch[1];
      const argsString = cmdMatch[2];
      
      // 使用改进的参数解析方法
      const args = this.parseCommandArgsImproved(argsString);
      
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
  private parseCommandArgs(argsString: string): string[] {
    const args: string[] = [];
    let currentArg = '';
    let inQuotes = false;
    let i = 0;
    
    while (i < argsString.length) {
      const char = argsString[i];
      
      if (char === '"' && (i === 0 || argsString[i - 1] !== '\\')) {
        inQuotes = !inQuotes;
        // 对于路径参数，移除包围的引号，保留内容
        if (!inQuotes && currentArg.startsWith('"')) {
          // 结束引号，移除开始和结束的引号
          // 不添加结束引号
        } else if (inQuotes) {
          // 开始引号，不添加到结果中
        } else {
          currentArg += char;
        }
      } else if (char === "'" && !inQuotes) {
        // 处理单引号包围的参数（如 '-DUSB_MANUFACTURER="Arduino LLC"'）
        let j = i + 1;
        let singleQuotedArg = "";
        
        while (j < argsString.length && argsString[j] !== "'") {
          singleQuotedArg += argsString[j];
          j++;
        }
        
        if (j < argsString.length) {
          // 移除外层单引号，保留内容
          if (currentArg.trim()) {
            args.push(currentArg.trim());
            currentArg = '';
          }
          args.push(singleQuotedArg);
          i = j; // 跳过单引号区域
        } else {
          currentArg += char;
        }
      } else if (char === ' ' && !inQuotes) {
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
   * 获取编译器路径
   * 参考 ArduinoConfigParser 中的做法：compiler.path + compiler.cpp.cmd
   */
  private getCompilerPath(config: Record<string, any>): string {
    const compilerPath = config['compiler.path'] || '';
    const compilerCmd = config['compiler.cpp.cmd'] || 'g++';
    
    // 首先尝试使用 ArduinoConfigParser 设置的环境变量
    if (process.env['COMPILER_GPP_PATH']) {
      this.logger.verbose(`Using COMPILER_GPP_PATH from environment: ${process.env['COMPILER_GPP_PATH']}`);
      return process.env['COMPILER_GPP_PATH'];
    }
    
    // 如果有 compiler.path，直接拼接（这是 platform.txt 的标准方式）
    if (compilerPath) {
      const fullPath = compilerPath + compilerCmd;
      this.logger.verbose(`Constructed compiler path: ${fullPath}`);
      
      // 检查文件是否存在
      if (fs.existsSync(fullPath)) {
        return fullPath;
      } else {
        this.logger.verbose(`Compiler not found at: ${fullPath}`);
      }
    }
    
    // 尝试多种工具路径配置（后备方案）
    const possibleToolsPaths = [
      config['runtime.tools.arm-none-eabi-gcc.path'],
      config['runtime.tools.gcc-arm-none-eabi.path'],
      config['runtime.tools.xpack-arm-none-eabi-gcc-14.2.1-1.1.path']
    ].filter(Boolean);
    
    for (const toolsPath of possibleToolsPaths) {
      if (compilerCmd.includes('arm-none-eabi')) {
        // ARM 编译器通常在 bin 子目录
        const fullPath = path.join(toolsPath, 'bin', compilerCmd);
        if (fs.existsSync(fullPath)) {
          this.logger.verbose(`Found compiler at: ${fullPath}`);
          return fullPath;
        }
        
        // 有些版本可能直接在工具目录
        const directPath = path.join(toolsPath, compilerCmd);
        if (fs.existsSync(directPath)) {
          this.logger.verbose(`Found compiler at: ${directPath}`);
          return directPath;
        }
      } else {
        // 其他编译器
        const fullPath = path.join(toolsPath, compilerCmd);
        if (fs.existsSync(fullPath)) {
          this.logger.verbose(`Found compiler at: ${fullPath}`);
          return fullPath;
        }
      }
    }
    
    // 如果找不到完整路径，尝试使用系统 PATH
    this.logger.verbose(`Compiler not found in configured paths, using system PATH: ${compilerCmd}`);
    return compilerCmd;
  }

  /**
   * 构建包含路径
   * 参考 ArduinoConfigParser 和 CompileConfigManager 的设置
   */
  private buildIncludePaths(config: Record<string, any>): string[] {
    const includes: string[] = [];
    
    // 使用 ArduinoConfigParser 设置的环境变量（优先）
    if (process.env['SDK_CORE_PATH'] && fs.existsSync(process.env['SDK_CORE_PATH'])) {
      includes.push(`-I"${process.env['SDK_CORE_PATH']}"`);
      this.logger.verbose(`Added core path: ${process.env['SDK_CORE_PATH']}`);
    }
    
    if (process.env['SDK_VARIANT_PATH'] && fs.existsSync(process.env['SDK_VARIANT_PATH'])) {
      includes.push(`-I"${process.env['SDK_VARIANT_PATH']}"`);
      this.logger.verbose(`Added variant path: ${process.env['SDK_VARIANT_PATH']}`);
    }
    
    if (process.env['SDK_CORE_LIBRARIES_PATH'] && fs.existsSync(process.env['SDK_CORE_LIBRARIES_PATH'])) {
      includes.push(`-I"${process.env['SDK_CORE_LIBRARIES_PATH']}"`);
      this.logger.verbose(`Added core libraries path: ${process.env['SDK_CORE_LIBRARIES_PATH']}`);
    }
    
    // 编译器 SDK 路径（如果有）
    if (process.env['COMPILER_SDK_PATH'] && fs.existsSync(process.env['COMPILER_SDK_PATH'])) {
      includes.push(`-I"${process.env['COMPILER_SDK_PATH']}"`);
      this.logger.verbose(`Added compiler SDK path: ${process.env['COMPILER_SDK_PATH']}`);
    }
    
    // 添加外部库路径（与 ArduinoCompiler 保持一致）
    if (process.env['LIBRARIES_PATH']) {
      const pathSeparator = os.platform() === 'win32' ? ';' : ':';
      const libraryPaths = process.env['LIBRARIES_PATH'].split(pathSeparator);
      
      for (const libPath of libraryPaths) {
        if (libPath && fs.existsSync(libPath)) {
          includes.push(`-I"${libPath}"`);
          this.logger.verbose(`Added library path: ${libPath}`);
          
          // 递归添加库子目录（模拟 Arduino IDE 的行为）
          try {
            const entries = fs.readdirSync(libPath, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                const subLibPath = path.join(libPath, entry.name);
                if (fs.existsSync(subLibPath)) {
                  includes.push(`-I"${subLibPath}"`);
                  this.logger.verbose(`Added sub-library path: ${subLibPath}`);
                  
                  // 添加 src 子目录（Arduino 库的标准结构）
                  const srcPath = path.join(subLibPath, 'src');
                  if (fs.existsSync(srcPath)) {
                    includes.push(`-I"${srcPath}"`);
                    this.logger.verbose(`Added library src path: ${srcPath}`);
                  }
                }
              }
            }
          } catch (error) {
            this.logger.verbose(`Warning: Could not scan library directory ${libPath}: ${error}`);
          }
        }
      }
    }
    
    // 后备方案：从配置中解析路径（只在没有任何SDK路径时使用）
    if (includes.length === 0) {
      this.logger.verbose('Using fallback include path resolution...');
      
      // Arduino 核心路径
      const corePath = config['build.core.path'] || 
        (config['runtime.platform.path'] ? 
          path.join(config['runtime.platform.path'], 'cores', config['build.core'] || 'arduino') : null);
      if (corePath && fs.existsSync(corePath)) {
        includes.push(`-I"${corePath}"`);
        this.logger.verbose(`Added fallback core path: ${corePath}`);
      }
      
      // 变体路径
      const variantPath = config['build.variant.path'] ||
        (config['runtime.platform.path'] ? 
          path.join(config['runtime.platform.path'], 'variants', config['build.variant'] || 'standard') : null);
      if (variantPath && fs.existsSync(variantPath)) {
        includes.push(`-I"${variantPath}"`);
        this.logger.verbose(`Added fallback variant path: ${variantPath}`);
      }
    }
    
    this.logger.verbose(`Total include paths: ${includes.length}`);
    return includes;
  }

  /**
   * 构建编译器定义
   */
  private buildDefines(config: Record<string, any>): string[] {
    return [
      `-DARDUINO=${config['runtime.ide.version'] || '10607'}`,
      `-DARDUINO_${config['build.board'] || 'UNKNOWN'}`,
      `-DARDUINO_ARCH_${(config['build.arch'] || 'UNKNOWN').toUpperCase()}`,
      `-DF_CPU=${config['build.f_cpu'] || '16000000L'}`,
      `-DPROJECT_NAME="lint_check"`
    ];
  }

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
      
      // 匹配标准格式：file:line:column: severity: message
      let match = line.match(/^([^:]+):(\d+):(\d+):\s*(error|warning|note|fatal error):\s*(.+)$/);
      if (match) {
        const [, file, lineNum, colNum, severity, message] = match;
        
        const lintError: LintError = {
          file: originalFile, // 使用原始文件名而不是临时文件名
          line: parseInt(lineNum, 10),
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
}
