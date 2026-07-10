import Parser, { SyntaxNode, Tree } from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { promises as fs } from 'fs';
import {
    ExpressionEvaluator,
    MacroExpander,
    MacroDefinition,
    stripDirectiveComments
} from './PreprocessorExpression';

export type { MacroDefinition } from './PreprocessorExpression';

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
export interface AnalysisOptions {
    throwOnError?: boolean;
    // Runs at the include location so nested files can update macros before parsing continues.
    onInclude?: (includePath: string) => void;
}

/**
 * 分析结果接口
 */
export interface AnalysisResult {
    includes: string[];
    defines: Map<string, MacroDefinition>;
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
    return sourceCode.replace(/\\(?:\r\n|\n|\r)/g, '');
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
    private onInclude?: (includePath: string) => void;

    constructor(
        sourceCode: string,
        defines: Map<string, MacroDefinition>,
        onInclude?: (includePath: string) => void
    ) {
        this.sourceCode = sourceCode;
        this.defines = defines;
        this.expressionEvaluator = new ExpressionEvaluator(defines);
        this.conditionManager = new ConditionalCompilationManager();
        this.actualIncludes = new Set();
        this.onInclude = onInclude;
    }

    private refreshExpressionEvaluator(): void {
        this.expressionEvaluator = new ExpressionEvaluator(this.defines);
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
        const directive = stripDirectiveComments(this.getNodeText(node));
        const match = directive.match(/^\s*#\s*include\s+(.+?)\s*$/);
        if (!match) return null;

        const expanded = new MacroExpander(this.defines).expand(match[1]).trim();
        const systemHeader = expanded.match(/^<([^>\r\n]+)>$/);
        if (systemHeader) return systemHeader[1].trim();

        const quotedHeader = expanded.match(/^"((?:\\.|[^"\\])*)"$/);
        if (!quotedHeader) return null;
        return quotedHeader[1].replace(/\\([\\"])/g, '$1');
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
        const firstLine = this.getNodeText(node).split(/\r?\n/)[0];
        const match = firstLine.match(/^\s*#\s*(?:if|elif)\b(.*)$/);
        return match ? stripDirectiveComments(match[1]).trim() : '';
    }

    /**
     * 处理预处理指令节点
     */
    private processPreprocessorNode(node: SyntaxNode, parentConditionActive: boolean): boolean {
        switch (node.type) {
            case 'preproc_include':
                return this.processInclude(node, parentConditionActive);

            case 'preproc_def':
            case 'preproc_function_def':
                return this.processDefine(node, parentConditionActive);

            case 'preproc_call':
                return this.processUndef(node, parentConditionActive);

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
                if (this.onInclude) {
                    this.onInclude(includePath);
                    this.refreshExpressionEvaluator();
                }
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
        const isIfndef = !!firstChild && this.getNodeText(firstChild).replace(/\s+/g, '') === '#ifndef';

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
            const macroInfo = this.extractMacroDefinition(this.getNodeText(node));
            if (macroInfo) {
                this.defines.set(macroInfo.name, macroInfo);
                this.refreshExpressionEvaluator();
            }
        }
        return isActive;
    }

    private processUndef(node: SyntaxNode, isActive: boolean): boolean {
        if (!isActive) return false;

        const match = stripDirectiveComments(this.getNodeText(node))
            .match(/^\s*#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (match) {
            this.defines.set(match[1], {
                name: match[1],
                isDefined: false
            });
            this.refreshExpressionEvaluator();
        }
        return true;
    }

    /**
     * 从 #define 节点中提取宏定义信息
     */
    private extractMacroDefinition(text: string): MacroDefinition | null {
        const directive = stripDirectiveComments(text);
        const prefix = directive.match(/^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (!prefix) return null;

        const name = prefix[1];
        let remainder = directive.slice(prefix.index! + prefix[0].length);
        if (!remainder.startsWith('(')) {
            return {
                name,
                value: remainder.trim(),
                isDefined: true,
                functionLike: false
            };
        }

        const closingParen = remainder.indexOf(')');
        if (closingParen < 0) return null;

        const parameterText = remainder.slice(1, closingParen).trim();
        const parameters: string[] = [];
        let variadic = false;
        if (parameterText) {
            const rawParameters = parameterText.split(',');
            for (let parameterIndex = 0; parameterIndex < rawParameters.length; parameterIndex++) {
                const rawParameter = rawParameters[parameterIndex];
                const parameter = rawParameter.trim();
                if (parameter === '...') {
                    if (parameterIndex !== rawParameters.length - 1) return null;
                    parameters.push('__VA_ARGS__');
                    variadic = true;
                } else if (/^[A-Za-z_][A-Za-z0-9_]*\.\.\.$/.test(parameter)) {
                    if (parameterIndex !== rawParameters.length - 1) return null;
                    parameters.push(parameter.slice(0, -3));
                    variadic = true;
                } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) {
                    parameters.push(parameter);
                } else {
                    return null;
                }
            }
        }

        remainder = remainder.slice(closingParen + 1);
        return {
            name,
            value: remainder.trim(),
            isDefined: true,
            functionLike: true,
            parameters,
            variadic
        };
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
                const isIfndef = !!firstChild && this.getNodeText(firstChild).replace(/\s+/g, '') === '#ifndef';
                
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

export function analyzeSourceWithDefines(
    sourceCode: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): AnalysisResult {
    sourceCode = preprocessSourceCode(sourceCode);

    const parser = getParser();
    let tree: Tree;
    try {
        tree = parser.parse(sourceCode);
    } catch (e) {
        throw new Error(`Failed to parse source: ${(e as Error).message}`);
    }

    const processor = new ASTNodeProcessor(sourceCode, defines, options.onInclude);
    processor.walkNode(tree.rootNode);

    return {
        includes: processor.getResults(),
        defines
    };
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

        return analyzeSourceWithDefines(sourceCode, defines, options);

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
