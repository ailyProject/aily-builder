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
        // 修复：匹配所有标识符，不仅仅是全大写的
        this.macroRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
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

            // Debug: 打印处理后的表达式
            if (process.env.DEBUG_EXPR) {
                console.log(`[DEBUG] 原始条件: ${conditionText}`);
                console.log(`[DEBUG] 宏替换后: ${processed}`);
            }

            // 处理逻辑运算符
            processed = processed
                .replace(/&&/g, '&')
                .replace(/\|\|/g, '|')
                .replace(/!/g, '~');

            // 使用更安全的表达式评估
            const result = this.safeEvaluate(processed);
            
            if (process.env.DEBUG_EXPR) {
                console.log(`[DEBUG] 评估结果: ${result}`);
            }
            
            return result;
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
            // 处理比较运算符 - 注意顺序！先处理复合运算符，再处理单个运算符
            let processedExpr = expression
                .replace(/&/g, ' && ')
                .replace(/\|/g, ' || ')
                .replace(/~/g, ' !');

            // 不需要再处理比较运算符，因为原始表达式中已经是正确的格式
            // 之前的replace会破坏 >= 和 <= 等复合运算符

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
        if (!currentFrame) {
            return true;
        }

        // 如果之前有分支为真，else不会被执行
        if (currentFrame.hadTrueBranch) {
            currentFrame.active = false;
        } else {
            // 否则，else分支激活状态取决于父条件
            currentFrame.active = currentFrame.parentActive;
            currentFrame.hadTrueBranch = true;
        }

        return currentFrame.active;
    }

    /**
     * 处理 #elif 指令
     */
    handleElif(conditionMet: boolean): boolean {
        const currentFrame = this.getCurrentFrame();
        if (!currentFrame) {
            return false;
        }

        // 如果之前的分支已经为真，则elif不会被执行
        if (currentFrame.hadTrueBranch) {
            currentFrame.active = false;
            return false;
        }

        // 计算elif条件是否激活：父条件必须激活且当前条件满足
        const newActive = currentFrame.parentActive && conditionMet;
        currentFrame.active = newActive;
        
        if (conditionMet) {
            currentFrame.hadTrueBranch = true;
        }

        return newActive;
    }
}

/**
 * 预处理源代码，将续行符转换为单行
 * @param sourceCode - 原始源代码
 * @returns 处理后的源代码
 */
function preprocessSourceCode(sourceCode: string): string {
    // 将反斜杠续行符（\ + 换行）替换为空格
    // 同时移除续行后的前导空白，保持代码的可读性
    return sourceCode.replace(/\\\s*[\r\n]+\s*/g, ' ');
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
                return this.getNodeText(child).replace(/[<">]/g, '').trim();
            }
        }

        // 备选方案：正则表达式提取
        const text = this.getNodeText(node);
        const match = text.match(/#include\s*([<"].*?[>"])/);
        return match ? match[1].replace(/[<">]/g, '').trim() : null;
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
        // 条件表达式应该在第一行（到第一个真正的换行符之前）
        // 处理 Windows 和 Unix 风格的换行符
        const firstLine = text.split(/\r?\n/)[0];
        
        // 提取条件表达式（#if 或 #elif 后面的内容，到注释或行尾）
        // 修复：支持 #if(...) 这种没有空格的格式
        const match = firstLine.match(/#(?:el)?if\s*(.+?)(?:\/\/|\/\*|$)/);
        return match ? match[1].trim() : '';
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
        const conditionText = this.extractCondition(node);
        if (!conditionText) {
            return false;
        }

        const conditionMet = this.expressionEvaluator.evaluate(conditionText);
        return this.conditionManager.handleElif(conditionMet);
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
                }
            }
        }
        return isActive;
    }

    /**
     * 从 #define 节点中提取宏定义信息
     */
    private extractMacroDefinition(text: string): MacroDefinition | null {
        // 支持多种宏定义格式：
        // #define MACRO_NAME
        // #define MACRO_NAME value
        // #define MACRO_NAME(args) value
        const match = text.match(/#define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?(?:\s+(.*))?/);

        if (match) {
            const name = match[1];
            let value = match[2] ? match[2].trim() : '1';

            // 如果值是另一个宏名，尝试解析它的值
            // 这里做简单的宏值查找和替换
            if (value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
                // 值看起来是一个标识符（可能是另一个宏）
                if (this.defines.has(value)) {
                    const referencedMacro = this.defines.get(value)!;
                    if (referencedMacro.value !== undefined) {
                        value = referencedMacro.value;
                    }
                }
            }

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
        // 特殊处理条件编译节点
        if (node.type === 'preproc_if' || node.type === 'preproc_ifdef') {
            this.processConditionalBlock(node, parentConditionActive);
            return;
        }

        // 对于其他预处理指令
        if (node.type.startsWith('preproc_')) {
            const localConditionActive = this.processPreprocessorNode(node, parentConditionActive);
            
            // 递归遍历子节点
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) {
                    this.walkNode(child, localConditionActive);
                }
            }
            return;
        }

        // 对于非预处理节点，递归遍历子节点
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                this.walkNode(child, parentConditionActive);
            }
        }
    }

    /**
     * 处理完整的条件编译块（#if ... #elif ... #else ... #endif）
     */
    private processConditionalBlock(node: SyntaxNode, parentConditionActive: boolean): void {
        // 首先处理 #if 或 #ifdef
        let isIfdef = node.type === 'preproc_ifdef';
        let conditionMet = false;
        
        if (isIfdef) {
            const macroName = this.extractMacroName(node);
            if (macroName) {
                const firstChild = node.child(0);
                const isIfndef = firstChild && this.getNodeText(firstChild).trim() === '#ifndef';
                
                if (isIfndef) {
                    conditionMet = !this.expressionEvaluator.hasMacro(macroName);
                } else {
                    conditionMet = this.expressionEvaluator.hasMacro(macroName);
                }
            }
        } else {
            const conditionText = this.extractCondition(node);
            if (conditionText) {
                conditionMet = this.expressionEvaluator.evaluate(conditionText);
            }
        }

        // 推入条件栈
        this.conditionManager.push(
            isIfdef ? 'ifdef' : 'if',
            parentConditionActive && conditionMet,
            parentConditionActive,
            conditionMet
        );

        // 获取当前激活状态
        let currentActive = this.conditionManager.getCurrentActive();

        // 遍历子节点，特殊处理 elif 和 else
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (!child) continue;

            if (child.type === 'preproc_elif') {
                // 处理 #elif 前，先处理之前的 #define（在父条件为 true 时定义的宏）
                // 但 elif 的条件评估应该使用当前的宏状态
                
                const elifCondition = this.extractCondition(child);
                const elifConditionMet = elifCondition ? 
                    this.expressionEvaluator.evaluate(elifCondition) : false;
                
                currentActive = this.conditionManager.handleElif(elifConditionMet);

                // 遍历 elif 的子节点（不包括嵌套的 else）
                for (let j = 0; j < child.childCount; j++) {
                    const elifChild = child.child(j);
                    if (elifChild) {
                        if (elifChild.type === 'preproc_else') {
                            // else 是 elif 的子节点，需要特殊处理
                            currentActive = this.conditionManager.handleElse();
                            
                            // 遍历 else 的内容
                            for (let k = 0; k < elifChild.childCount; k++) {
                                const elseChild = elifChild.child(k);
                                if (elseChild && !elseChild.type.startsWith('#')) {
                                    this.walkNode(elseChild, currentActive);
                                }
                            }
                        } else if (!elifChild.type.startsWith('#')) {
                            // elif 分支的内容
                            this.walkNode(elifChild, currentActive);
                        }
                    }
                }
            } else if (child.type === 'preproc_else') {
                // 处理独立的 #else（不在 elif 内部）
                currentActive = this.conditionManager.handleElse();
                
                // 遍历 else 的内容
                for (let j = 0; j < child.childCount; j++) {
                    const elseChild = child.child(j);
                    if (elseChild && !elseChild.type.startsWith('#')) {
                        this.walkNode(elseChild, currentActive);
                    }
                }
            } else if (!child.type.startsWith('#')) {
                // #if 分支的内容（排除 # 开头的节点，如 #if, #endif 等）
                // 这里会处理 #define，从而更新 expressionEvaluator
                this.walkNode(child, currentActive);
            }
        }

        // 弹出条件栈
        this.conditionManager.pop();
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

        // 修复续行符造成的问题
        sourceCode = preprocessSourceCode(sourceCode);

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