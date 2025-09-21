import Parser, { SyntaxNode, Tree } from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { promises as fs } from 'fs';

// 全局 Parser 实例，避免重复创建
let globalParser: Parser | null = null;

/**
 * 获取或创建 Parser 实例
 */
function getParser(): Parser {
    if (!globalParser) {
        globalParser = new Parser();
        globalParser.setLanguage(Cpp);
    }
    return globalParser;
}

/**
 * 分析选项接口
 */
interface AnalysisOptions {
    throwOnError?: boolean;
}

/**
 * 分析结果接口
 */
export interface AnalysisResult {
    includes: string[];
    defines: Map<string, MacroDefinition>;
}

/**
 * 宏定义接口
 */
export interface MacroDefinition {
    name: string;
    value?: string;
    isDefined: boolean;
}

/**
 * 条件编译帧接口
 */
interface ConditionalFrame {
    type: string;
    active: boolean;
    parentActive: boolean;
    hadTrueBranch: boolean;
}

/**
 * 将MacroDefinition Map转换为评估器需要的Map类型
 * @param defines - 宏定义Map
 * @returns Map<string, string | number>
 */
function convertMacroDefinitions(defines: Map<string, MacroDefinition>): Map<string, string | number> {
    const result = new Map<string, string | number>();

    for (const [name, macroDef] of defines) {
        if (macroDef.isDefined) {
            const value = macroDef.value !== undefined ? macroDef.value : '1';
            // 尝试将值转换为数字，如果失败则保持字符串
            const numValue = Number(value);
            result.set(name, isNaN(numValue) ? value : numValue);
        }
    }

    return result;
}

/**
 * 安全的表达式评估器
 */
class ExpressionEvaluator {
    private definedMacros: Map<string, string | number>;
    // 预编译正则表达式以提高性能
    private definedRegex: RegExp;
    private macroRegex: RegExp;
    private numberRegex: RegExp;

    constructor(definedMacros: Map<string, string | number>) {
        this.definedMacros = definedMacros;
        this.definedRegex = /defined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|defined\s+([A-Za-z_][A-Za-z0-9_]*)/g;
        this.macroRegex = /\b([A-Z_][A-Z0-9_]*)\b/g;
        this.numberRegex = /^\d+$/;
    }

    /**
     * 评估预处理条件表达式
     * @param conditionText - 条件表达式文本
     * @returns 评估结果
     */
    evaluate(conditionText: string): boolean {
        if (!conditionText || typeof conditionText !== 'string') {
            return false;
        }

        try {
            // 处理 defined(MACRO) 或 defined MACRO
            let processed = conditionText.replace(this.definedRegex, (match, macro1, macro2) => {
                const macro = macro1 || macro2;
                return this.definedMacros.has(macro) ? '1' : '0';
            });

            // 处理宏替换（支持嵌套宏）
            processed = this.resolveMacros(processed);

            // 处理逻辑运算符
            processed = processed
                .replace(/&&/g, '&')
                .replace(/\|\|/g, '|')
                .replace(/!/g, '~');

            // 使用更安全的表达式评估
            return this.safeEvaluate(processed);
        } catch (e) {
            console.warn(`无法评估条件: ${conditionText}`, (e as Error).message);
            return false;
        }
    }

    /**
     * 检查宏是否已定义
     * @param macroName - 宏名称
     * @returns 是否已定义
     */
    hasMacro(macroName: string): boolean {
        return this.definedMacros.has(macroName);
    }

    /**
     * 解析宏嵌套和宏值替换
     * @param text - 要处理的文本
     * @returns 解析后的文本
     */
    private resolveMacros(text: string): string {
        let processed = text;
        let maxIterations = 10; // 防止无限递归
        let changed = true;

        while (changed && maxIterations > 0) {
            changed = false;
            maxIterations--;

            processed = processed.replace(this.macroRegex, (match) => {
                if (this.definedMacros.has(match)) {
                    const value = this.definedMacros.get(match);
                    const stringValue = String(value);
                    if (stringValue !== match) {
                        changed = true;
                        return stringValue;
                    }
                }
                // 保留数字，其他未定义的标识符替换为0
                return this.numberRegex.test(match) ? match : '0';
            });
        }

        return processed;
    }

    /**
     * 安全地评估数值表达式
     * @param expression - 处理后的表达式
     * @returns 评估结果
     */
    private safeEvaluate(expression: string): boolean {
        // 支持数字、基本运算符、比较运算符和括号
        if (!/^[0-9&|~()><!=\s]+$/.test(expression)) {
            return false;
        }

        try {
            // 处理比较运算符
            let processedExpr = expression
                .replace(/>/g, ' > ')
                .replace(/</g, ' < ')
                .replace(/==/g, ' == ')
                .replace(/!=/g, ' != ')
                .replace(/&/g, ' && ')
                .replace(/\|/g, ' || ')
                .replace(/~/g, ' !');

            // 使用 Function 构造器，但限制在安全的数值运算范围内
            const result = new Function('return (' + processedExpr + ')')();
            return result !== 0 && result !== false;
        } catch (e) {
            return false;
        }
    }
}

/**
 * 条件编译状态管理器
 */
class ConditionalCompilationManager {
    private stack: ConditionalFrame[];

    constructor() {
        this.stack = [];
    }

    /**
     * 推入新的条件状态
     */
    push(type: string, active: boolean, parentActive: boolean, hadTrueBranch = false): boolean {
        this.stack.push({
            type,
            active,
            parentActive,
            hadTrueBranch
        });
        return active;
    }

    /**
     * 弹出条件状态
     */
    pop(): boolean {
        if (this.stack.length > 0) {
            this.stack.pop();
        }
        return this.getCurrentActive();
    }

    /**
     * 获取当前活动状态
     */
    getCurrentActive(): boolean {
        if (this.stack.length === 0) {
            return true;
        }
        return this.stack[this.stack.length - 1].active;
    }

    /**
     * 获取当前栈顶帧
     */
    getCurrentFrame(): ConditionalFrame | null {
        return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    }

    /**
     * 处理 #else 指令
     */
    handleElse(): boolean {
        const currentFrame = this.getCurrentFrame();
        if (currentFrame && !currentFrame.hadTrueBranch) {
            currentFrame.active = currentFrame.parentActive;
            currentFrame.hadTrueBranch = true;
        } else if (currentFrame) {
            currentFrame.active = false;
        }
        return this.getCurrentActive();
    }

    /**
     * 处理 #elif 指令
     */
    handleElif(conditionMet: boolean, parentActive: boolean): boolean {
        // 修复复杂嵌套结构中的 #elif 处理
        // 找到正确的 #if 条件帧，跳过可能的嵌套 #if
        let targetFrameIndex = this.stack.length - 1;

        // console.log(`DEBUG: #elif conditionMet=${conditionMet}, parentActive=${parentActive}, stackLength=${this.stack.length}`);

        // 如果栈中有多个条件，#elif 通常对应倒数第二个（跳过最内层的嵌套）
        // 检查栈顶帧是否为false且hadTrueBranch为false，如果是则查找上一层
        if (this.stack.length >= 2) {
            const topFrame = this.stack[this.stack.length - 1];
            // console.log(`  栈顶帧: active=${topFrame.active}, hadTrueBranch=${topFrame.hadTrueBranch}`);
            if (!topFrame.active && !topFrame.hadTrueBranch) {
                targetFrameIndex = this.stack.length - 2;
                // console.log(`  选择上一层帧，targetFrameIndex=${targetFrameIndex}`);
            }
        }

        if (targetFrameIndex >= 0) {
            const targetFrame = this.stack[targetFrameIndex];
            // console.log(`  目标帧: type=${targetFrame.type}, active=${targetFrame.active}, parentActive=${targetFrame.parentActive}, hadTrueBranch=${targetFrame.hadTrueBranch}`);

            if (!targetFrame.hadTrueBranch) {
                const newActive = targetFrame.parentActive && conditionMet;
                targetFrame.active = newActive;
                if (conditionMet) {
                    targetFrame.hadTrueBranch = true;
                }
                // console.log(`  elif结果: newActive=${newActive}`);
                return newActive;
            } else {
                targetFrame.active = false;
                // console.log(`  elif被跳过 (已有真分支)`);
                return false;
            }
        }
        // console.log(`  elif失败: targetFrameIndex=${targetFrameIndex}`);
        return false;
    }
}

/**
 * AST 节点处理器
 */
class ASTNodeProcessor {
    private sourceCode: string;
    private expressionEvaluator: ExpressionEvaluator;
    private conditionManager: ConditionalCompilationManager;
    private actualIncludes: Set<string>;
    private defines: Map<string, MacroDefinition>;

    constructor(sourceCode: string, defines: Map<string, MacroDefinition>) {
        this.sourceCode = sourceCode;
        this.defines = defines;
        const definedMacros = convertMacroDefinitions(defines);
        this.expressionEvaluator = new ExpressionEvaluator(definedMacros);
        this.conditionManager = new ConditionalCompilationManager();
        this.actualIncludes = new Set();
    }

    /**
     * 获取节点的文本内容
     */
    private getNodeText(node: SyntaxNode): string {
        return this.sourceCode.substring(node.startIndex, node.endIndex);
    }

    /**
     * 提取 include 路径（优化版）
     */
    private extractIncludePath(node: SyntaxNode): string | null {
        // 首先尝试通过子节点直接获取
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && (child.type === 'string_literal' || child.type === 'system_lib_string')) {
                return this.getNodeText(child).replace(/[<">]/g, '');
            }
        }

        // 备选方案：正则表达式提取
        const text = this.getNodeText(node);
        const match = text.match(/#include\s*([<"].*?[>"])/);
        return match ? match[1].replace(/[<">]/g, '') : null;
    }

    /**
     * 提取宏名称（优化版）
     */
    private extractMacroName(node: SyntaxNode): string | null {
        // 首先尝试通过子节点获取标识符
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && child.type === 'identifier') {
                return this.getNodeText(child);
            }
        }

        // 备选方案：正则表达式提取
        const text = this.getNodeText(node);
        const match = text.match(/#if(?:n)?def\s+(\w+)/);
        return match ? match[1] : null;
    }

    /**
     * 提取条件表达式
     */
    private extractCondition(node: SyntaxNode): string {
        const text = this.getNodeText(node);
        // console.log(`DEBUG: extractCondition - 节点文本: "${text}"`);

        // 修复正则表达式，支持多行匹配
        const match = text.match(/#(?:el)?if\s+([^\r\n]+)/);
        const result = match ? match[1].trim() : '';
        // console.log(`DEBUG: extractCondition - 匹配结果: "${result}"`);
        return result;
    }

    /**
     * 处理预处理指令节点
     */
    private processPreprocessorNode(node: SyntaxNode, parentConditionActive: boolean): boolean {
        switch (node.type) {
            case 'preproc_include':
                return this.processInclude(node, parentConditionActive);

            case 'preproc_def':
                return this.processDefine(node, parentConditionActive);

            case 'preproc_ifdef':
                return this.processIfdef(node, parentConditionActive);

            case 'preproc_if':
                return this.processIf(node, parentConditionActive);

            case 'preproc_elif':
                return this.processElif(node, parentConditionActive);

            case 'preproc_else':
                return this.processElse();

            case 'preproc_endif':
                return this.processEndif();

            default:
                return parentConditionActive;
        }
    }

    private processInclude(node: SyntaxNode, isActive: boolean): boolean {
        if (isActive) {
            const includePath = this.extractIncludePath(node);
            if (includePath) {
                this.actualIncludes.add(includePath);
            }
        }
        return isActive;
    }

    private processIfdef(node: SyntaxNode, parentConditionActive: boolean): boolean {
        const macroName = this.extractMacroName(node);
        if (!macroName) {
            return parentConditionActive;
        }

        // 检查第一个子节点的文本来区分 #ifdef 和 #ifndef
        // tree-sitter-cpp 对两者使用相同的节点类型 preproc_ifdef
        const firstChild = node.child(0);
        const isIfndef = firstChild && this.getNodeText(firstChild).trim() === '#ifndef';

        let conditionMet;
        if (isIfndef) {
            // #ifndef - 当宏未定义时为真
            conditionMet = !this.expressionEvaluator.hasMacro(macroName);
        } else {
            // #ifdef - 当宏定义时为真
            conditionMet = this.expressionEvaluator.hasMacro(macroName);
        }

        return this.conditionManager.push(
            isIfndef ? 'ifndef' : 'ifdef',
            parentConditionActive && conditionMet,
            parentConditionActive,
            conditionMet
        );
    }

    private processIf(node: SyntaxNode, parentConditionActive: boolean): boolean {
        const conditionText = this.extractCondition(node);
        if (!conditionText) {
            return parentConditionActive;
        }

        const conditionMet = this.expressionEvaluator.evaluate(conditionText);
        return this.conditionManager.push(
            'if',
            parentConditionActive && conditionMet,
            parentConditionActive,
            conditionMet
        );
    }

    private processElif(node: SyntaxNode, parentConditionActive: boolean): boolean {
        // console.log('DEBUG: processElif被调用');
        const conditionText = this.extractCondition(node);
        if (!conditionText) {
            // console.log('DEBUG: processElif - 没有条件文本');
            return false;
        }

        // console.log(`DEBUG: processElif - 条件: ${conditionText}`);
        const conditionMet = this.expressionEvaluator.evaluate(conditionText);
        // console.log(`DEBUG: processElif - 条件评估结果: ${conditionMet}`);
        // 使用修复后的 handleElif 方法处理复杂嵌套情况
        return this.conditionManager.handleElif(conditionMet, parentConditionActive);
    }

    private processElse(): boolean {
        return this.conditionManager.handleElse();
    }

    private processEndif(): boolean {
        return this.conditionManager.pop();
    }

    private processDefine(node: SyntaxNode, isActive: boolean): boolean {
        if (isActive) {
            const text = this.getNodeText(node);
            const lines = text.split('\n');
            for (const line of lines) {
                const macroInfo = this.extractMacroDefinition(line);
                if (macroInfo) {
                    // 更新宏定义集合
                    this.defines.set(macroInfo.name, macroInfo);
                    // 重新创建 ExpressionEvaluator 以包含新的宏定义
                    const definedMacros = convertMacroDefinitions(this.defines);
                    this.expressionEvaluator = new ExpressionEvaluator(definedMacros);
                    // console.log(`DEBUG: 新增宏定义 ${macroInfo.name}=${macroInfo.value || '1'}`);
                }
            }
        }
        return isActive;
    }

    /**
     * 从 #define 节点中提取宏定义信息
     */
    private extractMacroDefinition(text: string): MacroDefinition | null {
        // const text = this.getNodeText(node);

        // 支持多种宏定义格式：
        // #define MACRO_NAME
        // #define MACRO_NAME value
        // #define MACRO_NAME(args) value
        const match = text.match(/#define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?(?:\s+(.*))?/);

        if (match) {
            const name = match[1];
            // 如果没有明确的值，对于简单宏定义默认为 '1'
            const value = match[2] ? match[2].trim() : '1';

            return {
                name,
                value,
                isDefined: true
            };
        }

        return null;
    }

    /**
     * 递归遍历 AST 节点
     */
    walkNode(node: SyntaxNode, parentConditionActive = true): void {
        let localConditionActive = parentConditionActive;

        // 处理预处理指令
        if (node.type.startsWith('preproc_')) {
            if (node.type === 'preproc_include') {
                // 直接处理包含文件
                this.processInclude(node, parentConditionActive);
                return;
            } else {
                // 处理其他预处理指令
                localConditionActive = this.processPreprocessorNode(node, parentConditionActive);
            }
        }

        // 递归遍历子节点
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                // 对于子节点，传递当前的活动条件
                // 但对于同一个 #if 块内的 #elif，它们应该使用相同的父条件
                let effectiveParentCondition = localConditionActive;

                // 如果子节点是 #elif，且当前节点是 #if，
                // #elif 应该使用 #if 的父条件，而不是 #if 的结果
                if (child.type === 'preproc_elif' && node.type === 'preproc_if') {
                    effectiveParentCondition = parentConditionActive;
                }

                this.walkNode(child, effectiveParentCondition);
            }
        }
    }

    /**
     * 获取分析结果
     */
    getResults(): string[] {
        return [...this.actualIncludes];
    }
}

/**
 * 分析 C++ 文件，根据宏定义提取实际包含的头文件（优化版）
 * @param filePath - C++ 文件路径
 * @param defines - 当前定义的宏集合
 * @param options - 可选配置
 * @returns Promise<string[]>
 */
export async function analyzeFile(
    filePath: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): Promise<string[]> {
    const result = await analyzeFileWithDefines(filePath, defines, options);
    return result.includes;
}

/**
 * 分析 C++ 文件，返回包含文件和更新后的宏定义
 * @param filePath - C++ 文件路径
 * @param defines - 当前定义的宏集合
 * @param options - 可选配置
 * @returns Promise<AnalysisResult>
 */
export async function analyzeFileWithDefines(
    filePath: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): Promise<AnalysisResult> {
    try {
        // 参数验证
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('文件路径不能为空');
        }

        // 读取文件内容
        let sourceCode: string;
        try {
            sourceCode = await fs.readFile(filePath, 'utf8');
        } catch (e) {
            throw new Error(`无法读取文件 ${filePath}: ${(e as Error).message}`);
        }

        // 获取 Parser 实例
        const parser = getParser();

        // 解析代码生成 AST
        let tree: Tree;
        try {
            tree = parser.parse(sourceCode);
        } catch (e) {
            throw new Error(`解析文件失败: ${(e as Error).message}`);
        }

        // 创建节点处理器并处理 AST
        const processor = new ASTNodeProcessor(sourceCode, defines);
        processor.walkNode(tree.rootNode);

        return {
            includes: processor.getResults(),
            defines: defines // 返回更新后的 defines
        };

    } catch (error) {
        if (options.throwOnError !== false) {
            throw error;
        }
        console.error(`分析文件 ${filePath} 时出错:`, (error as Error).message);
        return {
            includes: [],
            defines: defines
        };
    }
}

/**
 * 批量分析多个 C++ 文件
 * @param filePaths - 文件路径数组
 * @param defines - 当前定义的宏集合
 * @param options - 可选配置
 * @returns Promise<Record<string, string[]>> - 文件路径到包含列表的映射
 */
export async function analyzeCppIncludesBatch(
    filePaths: string[],
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): Promise<Record<string, string[]>> {
    const results: Record<string, string[]> = {};
    const promises = filePaths.map(async (filePath) => {
        try {
            const includes = await analyzeFile(filePath, defines, { throwOnError: false });
            results[filePath] = includes;
        } catch (error) {
            console.error(`处理文件 ${filePath} 失败:`, (error as Error).message);
            results[filePath] = [];
        }
    });

    await Promise.all(promises);
    return results;
}