import * as fs from 'fs-extra';
import { Logger } from './utils/Logger';

export interface StaticAnalysisResult {
  errors: LintError[];
  warnings: LintError[];
  notes: LintError[];
  confidence: 'high' | 'medium' | 'low'; // 分析置信度
  needsCompilerCheck: boolean; // 是否需要编译器检查
}

export interface LintError {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
}

export interface AnalysisTask {
  name: string;
  analyze: (lines: string[], filePath: string) => Promise<{
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  }>;
}

export class ParallelStaticAnalyzer {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * 并行执行静态分析
   */
  async analyzeFile(sketchPath: string): Promise<StaticAnalysisResult> {
    const startTime = Date.now();
    
    try {
      // 读取文件内容
      const content = await fs.readFile(sketchPath, 'utf-8');
      const lines = content.split('\n');

      // 定义并行分析任务
      const analysisTasks: AnalysisTask[] = [
        {
          name: 'syntax-basic',
          analyze: async (lines, path) => this.analyzeSyntaxBasics(lines, path)
        },
        {
          name: 'variables',
          analyze: async (lines, path) => this.analyzeVariables(lines, path)
        },
        {
          name: 'functions',
          analyze: async (lines, path) => this.analyzeFunctions(lines, path)
        },
        {
          name: 'arduino-specific',
          analyze: async (lines, path) => this.analyzeArduinoSpecific(lines, path)
        },
        {
          name: 'includes-dependencies',
          analyze: async (lines, path) => this.analyzeIncludes(lines, path)
        }
      ];

      // 并行执行所有分析任务
      const results = await Promise.all(
        analysisTasks.map(async (task) => {
          const taskStart = Date.now();
          try {
            const result = await task.analyze(lines, sketchPath);
            this.logger.debug(`Analysis task '${task.name}' completed in ${Date.now() - taskStart}ms`);
            return { task: task.name, result, success: true };
          } catch (error) {
            this.logger.debug(`Analysis task '${task.name}' failed: ${error}`);
            return { 
              task: task.name, 
              result: { errors: [], warnings: [], notes: [] }, 
              success: false 
            };
          }
        })
      );

      // 合并结果
      const allErrors: LintError[] = [];
      const allWarnings: LintError[] = [];
      const allNotes: LintError[] = [];

      results.forEach(({ result }) => {
        allErrors.push(...result.errors);
        allWarnings.push(...result.warnings);
        allNotes.push(...result.notes);
      });

      // 计算分析置信度和是否需要编译器检查
      const analysisQuality = this.calculateAnalysisQuality(allErrors, allWarnings, content);

      const totalTime = Date.now() - startTime;
      this.logger.debug(`Parallel static analysis completed in ${totalTime}ms`);

      return {
        errors: allErrors,
        warnings: allWarnings,
        notes: allNotes,
        confidence: analysisQuality.confidence,
        needsCompilerCheck: analysisQuality.needsCompilerCheck
      };

    } catch (error) {
      this.logger.error(`Static analysis failed: ${error}`);
      return {
        errors: [{
          file: sketchPath,
          line: 0,
          column: 0,
          message: `Failed to analyze file: ${error instanceof Error ? error.message : error}`,
          severity: 'error'
        }],
        warnings: [],
        notes: [],
        confidence: 'low',
        needsCompilerCheck: true
      };
    }
  }

  /**
   * 分析基础语法（大括号、分号等）
   */
  private async analyzeSyntaxBasics(lines: string[], filePath: string): Promise<{
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  }> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];

    // 检查大括号匹配
    this.checkBraces(lines, filePath, errors);
    
    // 检查分号
    this.checkSemicolons(lines, filePath, errors, warnings);

    return { errors, warnings, notes };
  }

  /**
   * 分析变量声明和使用
   */
  private async analyzeVariables(lines: string[], filePath: string): Promise<{
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  }> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];

    const declaredVars = new Set<string>();
    const usedVars = new Map<string, { line: number; column: number }>(); // 记录变量使用位置
    const globalVars = new Set<string>();
    
    // 分析变量声明和使用
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // 跳过预处理指令和注释
      if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        return;
      }
      
      // 检查变量声明
      const varDecl = this.extractVariableDeclaration(trimmed);
      if (varDecl) {
        declaredVars.add(varDecl);
        if (this.isGlobalScope(lines, lineIndex)) {
          globalVars.add(varDecl);
        }
      }
      
      // 检查变量使用
      const usedVarsInLine = this.extractVariableUsages(trimmed, lineIndex + 1);
      usedVarsInLine.forEach(({ varName, line, column }) => {
        if (!usedVars.has(varName)) {
          usedVars.set(varName, { line, column });
        }
      });
    });
    
    // 检查未声明的变量使用
    usedVars.forEach(({ line, column }, varName) => {
      if (!declaredVars.has(varName) && !this.isArduinoBuiltin(varName) && !this.isKeyword(varName)) {
        warnings.push({
          file: filePath,
          line,
          column,
          message: `Possibly undeclared variable: '${varName}'`,
          severity: 'warning',
          code: 'UNDECLARED_VAR'
        });
      }
    });

    return { errors, warnings, notes };
  }

  /**
   * 分析函数定义和调用
   */
  private async analyzeFunctions(lines: string[], filePath: string): Promise<{
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  }> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];

    const functions = new Set<string>();
    const functionCalls = new Set<string>();

    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // 检查函数定义
      const funcDef = this.extractFunctionDefinition(trimmed);
      if (funcDef) {
        functions.add(funcDef);
      }
      
      // 检查函数调用
      const funcCalls = this.extractFunctionCalls(trimmed);
      funcCalls.forEach(call => functionCalls.add(call));
      
      // 检查必需的Arduino函数
      if (this.isRequiredArduinoFunction(trimmed)) {
        notes.push({
          file: filePath,
          line: lineIndex + 1,
          column: 1,
          message: `Found required Arduino function: ${this.extractFunctionName(trimmed)}`,
          severity: 'note',
          code: 'ARDUINO_FUNCTION'
        });
      }
    });

    // 检查缺少的必需函数
    if (!functions.has('setup')) {
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: 'Missing required setup() function',
        severity: 'warning',
        code: 'MISSING_SETUP'
      });
    }

    if (!functions.has('loop')) {
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: 'Missing required loop() function',
        severity: 'warning',
        code: 'MISSING_LOOP'
      });
    }

    return { errors, warnings, notes };
  }

  /**
   * 分析Arduino特定语法
   */
  private async analyzeArduinoSpecific(lines: string[], filePath: string): Promise<{
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  }> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];

    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // 检查常见的Arduino错误
      if (trimmed.includes('Serial.begin') && !trimmed.includes('setup')) {
        // 这个检查需要更复杂的逻辑，这里简化
        notes.push({
          file: filePath,
          line: lineIndex + 1,
          column: 1,
          message: 'Serial.begin() should typically be called in setup()',
          severity: 'note',
          code: 'SERIAL_PLACEMENT'
        });
      }

      // 检查引脚模式设置
      if (trimmed.includes('digitalWrite') || trimmed.includes('digitalRead')) {
        const pinMatch = trimmed.match(/digital(?:Write|Read)\s*\(\s*(\d+)/);
        if (pinMatch) {
          notes.push({
            file: filePath,
            line: lineIndex + 1,
            column: trimmed.indexOf(pinMatch[0]) + 1,
            message: `Using pin ${pinMatch[1]} - ensure pinMode() is set`,
            severity: 'note',
            code: 'PIN_MODE_CHECK'
          });
        }
      }
    });

    return { errors, warnings, notes };
  }

  /**
   * 分析包含文件和依赖
   */
  private async analyzeIncludes(lines: string[], filePath: string): Promise<{
    errors: LintError[];
    warnings: LintError[];
    notes: LintError[];
  }> {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];

    const includes: string[] = [];

    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // 检查 #include 语句
      if (trimmed.startsWith('#include')) {
        const includeMatch = trimmed.match(/#include\s*[<"](.*?)[>"]/);//
        if (includeMatch) {
          const includeName = includeMatch[1];
          includes.push(includeName);
          
          notes.push({
            file: filePath,
            line: lineIndex + 1,
            column: 1,
            message: `Include dependency: ${includeName}`,
            severity: 'note',
            code: 'INCLUDE_FOUND'
          });
        }
      }
    });

    // 检查常见的缺失包含
    const hasArduinoInclude = includes.some(inc => inc.includes('Arduino.h'));
    if (!hasArduinoInclude && lines.some(line => 
      line.includes('pinMode') || line.includes('digitalWrite') || line.includes('Serial')
    )) {
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: 'Arduino functions used but Arduino.h not explicitly included (may be auto-included)',
        severity: 'warning',
        code: 'MISSING_ARDUINO_H'
      });
    }

    return { errors, warnings, notes };
  }

  /**
   * 计算分析质量和是否需要编译器检查
   */
  private calculateAnalysisQuality(errors: LintError[], warnings: LintError[], content: string): {
    confidence: 'high' | 'medium' | 'low';
    needsCompilerCheck: boolean;
  } {
    // 如果发现明显的语法错误，置信度高，但仍需编译器验证
    if (errors.length > 0) {
      return { confidence: 'high', needsCompilerCheck: true };
    }

    // 检查代码复杂度
    const complexity = this.calculateCodeComplexity(content);
    const warningCount = warnings.length;

    // 基于复杂度和警告数量决策
    if (complexity < 50 && warningCount <= 2) {
      return { confidence: 'high', needsCompilerCheck: false };
    } else if (complexity < 100 && warningCount <= 5) {
      return { confidence: 'medium', needsCompilerCheck: warningCount > 3 };
    } else {
      return { confidence: 'low', needsCompilerCheck: true };
    }
  }

  /**
   * 计算代码复杂度（简化版）
   */
  private calculateCodeComplexity(content: string): number {
    let complexity = 0;
    
    // 基于代码行数
    complexity += content.split('\n').length * 0.1;
    
    // 基于控制结构数量
    const controlStructures = content.match(/\b(if|for|while|switch|case)\b/g);
    complexity += (controlStructures?.length || 0) * 2;
    
    // 基于函数数量
    const functions = content.match(/\w+\s*\([^)]*\)\s*{/g);
    complexity += (functions?.length || 0) * 3;
    
    // 基于包含数量
    const includes = content.match(/#include/g);
    complexity += (includes?.length || 0) * 1;

    return complexity;
  }

  // === 辅助方法（从原有代码迁移和增强）===

  /**
   * 检查大括号匹配
   */
  private checkBraces(lines: string[], filePath: string, errors: LintError[]): void {
    const braceStack: { line: number; char: string; column: number }[] = [];
    
    lines.forEach((line, lineIndex) => {
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
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
              severity: 'error',
              code: 'UNMATCHED_BRACKET'
            });
          } else {
            const last = braceStack.pop()!;
            if (last.char !== expected) {
              errors.push({
                file: filePath,
                line: lineIndex + 1,
                column: i + 1,
                message: `Mismatched bracket: expected '${this.getClosingBrace(last.char)}' but found '${char}'`,
                severity: 'error',
                code: 'MISMATCHED_BRACKET'
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
        severity: 'error',
        code: 'UNCLOSED_BRACKET'
      });
    });
  }

  /**
   * 检查分号
   */
  private checkSemicolons(lines: string[], filePath: string, errors: LintError[], warnings: LintError[]): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // 跳过空行、注释行、预处理指令
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || 
          trimmed.startsWith('*') || trimmed.startsWith('#')) {
        continue;
      }
      
      // 跳过控制结构、函数定义等不需要分号的行
      if (this.isControlStructure(trimmed) || this.isFunctionDefinition(trimmed) || 
          trimmed.endsWith('{') || trimmed.endsWith('}')) {
        continue;
      }
      
      // 检查是否是链式调用的一部分
      if (this.isPartOfChainedCall(lines, i)) {
        continue;
      }
      
      // 检查是否缺少分号
      if (this.shouldEndWithSemicolon(trimmed) && !trimmed.endsWith(';')) {
        errors.push({
          file: filePath,
          line: i + 1,
          column: line.length,
          message: `Expected ';' at end of statement`,
          severity: 'error',
          code: 'MISSING_SEMICOLON'
        });
      }
    }
  }

  // === 辅助方法 ===

  private isInStringOrComment(line: string, pos: number): boolean {
    // 简化版本：检查是否在字符串或注释中
    const beforePos = line.substring(0, pos);
    const quotes = (beforePos.match(/"/g) || []).length;
    const singleQuotes = (beforePos.match(/'/g) || []).length;
    const commentStart = beforePos.indexOf('//');
    
    return (quotes % 2 === 1) || (singleQuotes % 2 === 1) || (commentStart !== -1 && commentStart < pos);
  }

  private getClosingBrace(openBrace: string): string {
    const mapping: { [key: string]: string } = { '{': '}', '(': ')', '[': ']' };
    return mapping[openBrace] || openBrace;
  }

  private isControlStructure(line: string): boolean {
    return /^\s*(if|else|for|while|switch|case|do)\b/.test(line);
  }

  private isFunctionDefinition(line: string): boolean {
    return /\w+\s*\([^)]*\)\s*\{?\s*$/.test(line) && !line.includes('=');
  }

  private isPartOfChainedCall(lines: string[], currentLine: number): boolean {
    const line = lines[currentLine].trim();
    
    // 检查当前行是否以 . 开始（链式调用的中间部分）
    if (line.startsWith('.')) {
      return true;
    }
    
    // 检查下一行是否以 . 开始（当前行是链式调用的开始）
    if (currentLine + 1 < lines.length) {
      const nextLine = lines[currentLine + 1].trim();
      if (nextLine.startsWith('.')) {
        return true;
      }
    }
    
    return false;
  }

  private shouldEndWithSemicolon(line: string): boolean {
    // 简化检查：大部分语句都应该以分号结尾
    return !line.endsWith('{') && !line.endsWith('}') && 
           !this.isControlStructure(line) && 
           !line.includes('#') && line.length > 0;
  }

  private extractVariableDeclaration(line: string): string | null {
    // 简化版本：提取变量声明
    const matches = line.match(/\b(int|float|double|char|bool|String|byte|long)\s+(\w+)/);
    return matches ? matches[2] : null;
  }

  private extractVariableUsages(line: string, lineNumber: number): Array<{ varName: string; line: number; column: number }> {
    const variables: Array<{ varName: string; line: number; column: number }> = [];
    
    // 跳过预处理指令
    if (line.trim().startsWith('#')) {
      return variables;
    }
    
    // 使用正则表达式匹配变量名，但要更精确
    const varPattern = /\b[a-zA-Z_]\w*\b/g;
    let match;
    
    while ((match = varPattern.exec(line)) !== null) {
      const varName = match[0];
      const column = match.index + 1;
      
      // 过滤掉关键字、Arduino 内置函数和类型
      if (!this.isKeyword(varName) && !this.isArduinoBuiltin(varName) && !this.isType(varName)) {
        // 进一步检查：避免把函数调用、属性访问等当作变量
        if (this.isValidVariableUsage(line, match.index, varName)) {
          variables.push({ varName, line: lineNumber, column });
        }
      }
    }
    
    return variables;
  }
  
  private isValidVariableUsage(line: string, index: number, varName: string): boolean {
    // 检查是否是赋值语句左侧的变量（可能是未声明变量的使用）
    const afterVar = line.substring(index + varName.length);
    const beforeVar = line.substring(0, index);
    
    // 如果后面紧跟着 '('，这是函数调用，不是变量使用
    if (afterVar.trim().startsWith('(')) {
      return false;
    }
    
    // 如果前面是 '.'，这是属性访问，不是独立变量
    if (beforeVar.trim().endsWith('.')) {
      return false;
    }
    
    // 如果是 #include 语句中的内容，跳过
    if (beforeVar.includes('#include')) {
      return false;
    }
    
    // 如果是字符串字面量中的内容，跳过
    const quoteBefore = beforeVar.split('"').length - 1;
    const quoteAfter = afterVar.split('"').length - 1;
    if (quoteBefore % 2 === 1) {
      return false;
    }
    
    return true;
  }
  
  private isType(word: string): boolean {
    const types = [
      'int', 'float', 'double', 'char', 'byte', 'boolean', 'String',
      'void', 'long', 'short', 'unsigned', 'signed', 'const', 'static',
      'uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t'
    ];
    return types.includes(word);
  }

  private isGlobalScope(lines: string[], lineIndex: number): boolean {
    // 简化版本：检查是否在全局作用域
    for (let i = 0; i < lineIndex; i++) {
      if (lines[i].includes('{')) {
        return false;
      }
    }
    return true;
  }

  private extractFunctionDefinition(line: string): string | null {
    const match = line.match(/(\w+)\s*\([^)]*\)\s*\{?/);
    return match ? match[1] : null;
  }

  private extractFunctionCalls(line: string): string[] {
    const calls: string[] = [];
    const matches = line.match(/(\w+)\s*\(/g);
    if (matches) {
      matches.forEach(match => {
        const funcName = match.replace(/\s*\(/, '');
        calls.push(funcName);
      });
    }
    return calls;
  }

  private isRequiredArduinoFunction(line: string): boolean {
    return line.includes('void setup()') || line.includes('void loop()');
  }

  private extractFunctionName(line: string): string {
    const match = line.match(/void\s+(\w+)\s*\(/);
    return match ? match[1] : '';
  }

  private isKeyword(word: string): boolean {
    const keywords = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 
                     'return', 'int', 'float', 'double', 'char', 'bool', 'void', 'true', 'false'];
    return keywords.includes(word);
  }

  private isArduinoBuiltin(word: string): boolean {
    const builtins = ['pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 
                     'Serial', 'delay', 'millis', 'micros', 'HIGH', 'LOW', 'INPUT', 'OUTPUT', 
                     'INPUT_PULLUP', 'LED_BUILTIN', 'setup', 'loop'];
    return builtins.includes(word);
  }
}