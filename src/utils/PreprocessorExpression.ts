export interface MacroDefinition {
    name: string;
    value?: string;
    isDefined: boolean;
    functionLike?: boolean;
    parameters?: string[];
    variadic?: boolean;
}

const INTEGER_BITS = 64;
const MAX_EXPANSION_DEPTH = 64;

interface MacroInvocation {
    args: string[];
    endIndex: number;
}

interface PPInteger {
    value: bigint;
    unsigned: boolean;
}

interface Token {
    type: 'number' | 'character' | 'identifier' | 'operator' | 'end' | 'invalid';
    text: string;
    value?: PPInteger;
}

type ExpressionNode =
    | { type: 'literal'; value: PPInteger }
    | { type: 'identifier' }
    | { type: 'unary'; operator: string; operand: ExpressionNode }
    | { type: 'binary'; operator: string; left: ExpressionNode; right: ExpressionNode }
    | { type: 'conditional'; condition: ExpressionNode; whenTrue: ExpressionNode; whenFalse: ExpressionNode }
    | { type: 'comma'; left: ExpressionNode; right: ExpressionNode };

export function stripDirectiveComments(text: string): string {
    let result = '';
    let quote: string | null = null;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];

        if (quote) {
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            result += char;
            continue;
        }

        if (char === '/' && next === '/') {
            break;
        }

        if (char === '/' && next === '*') {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) {
                break;
            }
            result += ' ';
            i = end + 1;
            continue;
        }

        result += char;
    }

    return result;
}

function readQuotedSegment(text: string, startIndex: number): number {
    const quote = text[startIndex];
    let escaped = false;
    for (let i = startIndex + 1; i < text.length; i++) {
        const char = text[i];
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === quote) {
            return i + 1;
        }
    }
    return text.length;
}

function parseMacroInvocation(text: string, openParenIndex: number): MacroInvocation | null {
    let depth = 1;
    let argumentStart = openParenIndex + 1;
    const args: string[] = [];

    for (let i = openParenIndex + 1; i < text.length; i++) {
        const char = text[i];
        if (char === '"' || char === "'") {
            i = readQuotedSegment(text, i) - 1;
            continue;
        }
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                const finalArgument = text.slice(argumentStart, i);
                if (args.length > 0 || finalArgument.trim().length > 0) {
                    args.push(finalArgument);
                }
                return { args, endIndex: i + 1 };
            }
        } else if (char === ',' && depth === 1) {
            args.push(text.slice(argumentStart, i));
            argumentStart = i + 1;
        }
    }

    return null;
}

export class MacroExpander {
    constructor(private defines: Map<string, MacroDefinition>) {}

    expand(text: string): string {
        return this.expandInternal(text, new Set<string>(), 0);
    }

    private expandInternal(text: string, disabled: Set<string>, depth: number): string {
        if (depth >= MAX_EXPANSION_DEPTH) {
            return text;
        }

        let result = '';
        for (let i = 0; i < text.length;) {
            const char = text[i];
            if (char === '"' || char === "'") {
                const end = readQuotedSegment(text, i);
                result += text.slice(i, end);
                i = end;
                continue;
            }

            if (!/[A-Za-z_]/.test(char)) {
                result += char;
                i++;
                continue;
            }

            let identifierEnd = i + 1;
            while (identifierEnd < text.length && /[A-Za-z0-9_]/.test(text[identifierEnd])) {
                identifierEnd++;
            }

            const name = text.slice(i, identifierEnd);
            const macro = this.defines.get(name);
            if (!macro?.isDefined || disabled.has(name)) {
                result += name;
                i = identifierEnd;
                continue;
            }

            const nextDisabled = new Set(disabled);
            nextDisabled.add(name);

            if (macro.functionLike) {
                let openParenIndex = identifierEnd;
                while (/\s/.test(text[openParenIndex] || '')) {
                    openParenIndex++;
                }
                if (text[openParenIndex] !== '(') {
                    result += name;
                    i = identifierEnd;
                    continue;
                }

                const invocation = parseMacroInvocation(text, openParenIndex);
                if (!invocation) {
                    result += text.slice(i);
                    break;
                }

                const parameters = macro.parameters || [];
                const invocationArgs = invocation.args.length === 0 && parameters.length > 0
                    ? ['']
                    : invocation.args;
                const minimumArguments = macro.variadic ? Math.max(parameters.length - 1, 0) : parameters.length;
                if (invocationArgs.length < minimumArguments || (!macro.variadic && invocationArgs.length !== parameters.length)) {
                    result += text.slice(i, invocation.endIndex);
                    i = invocation.endIndex;
                    continue;
                }

                const rawArguments = new Map<string, string>();
                const expandedArguments = new Map<string, string>();
                for (let parameterIndex = 0; parameterIndex < parameters.length; parameterIndex++) {
                    const parameter = parameters[parameterIndex];
                    const rawArgument = macro.variadic && parameterIndex === parameters.length - 1
                        ? invocationArgs.slice(parameterIndex).join(',')
                        : (invocationArgs[parameterIndex] || '');
                    rawArguments.set(parameter, rawArgument);
                    expandedArguments.set(parameter, this.expandInternal(rawArgument, disabled, depth + 1));
                }

                const replacement = this.replaceFunctionParameters(
                    macro.value || '',
                    rawArguments,
                    expandedArguments
                );
                const expandedReplacement = this.expandReplacementAtBoundary(
                    replacement,
                    text,
                    invocation.endIndex,
                    nextDisabled,
                    depth + 1
                );
                result += expandedReplacement.text;
                i = expandedReplacement.endIndex;
                continue;
            }

            const expandedReplacement = this.expandReplacementAtBoundary(
                macro.value ?? '1',
                text,
                identifierEnd,
                nextDisabled,
                depth + 1
            );
            result += expandedReplacement.text;
            i = expandedReplacement.endIndex;
        }

        return result;
    }

    private expandReplacementAtBoundary(
        replacement: string,
        originalText: string,
        restIndex: number,
        disabled: Set<string>,
        depth: number
    ): { text: string; endIndex: number } {
        const expanded = this.expandInternal(replacement, disabled, depth);
        const trailingIdentifier = expanded.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        if (!trailingIdentifier) return { text: expanded, endIndex: restIndex };

        const functionName = trailingIdentifier[1];
        const functionMacro = this.defines.get(functionName);
        if (!functionMacro?.isDefined || !functionMacro.functionLike || disabled.has(functionName)) {
            return { text: expanded, endIndex: restIndex };
        }

        let openParenIndex = restIndex;
        while (/\s/.test(originalText[openParenIndex] || '')) openParenIndex++;
        if (originalText[openParenIndex] !== '(') return { text: expanded, endIndex: restIndex };

        const invocation = parseMacroInvocation(originalText, openParenIndex);
        if (!invocation) return { text: expanded, endIndex: restIndex };

        const prefix = expanded.slice(0, trailingIdentifier.index);
        const call = `${functionName}${originalText.slice(openParenIndex, invocation.endIndex)}`;
        return {
            text: prefix + this.expandInternal(call, disabled, depth + 1),
            endIndex: invocation.endIndex
        };
    }

    private replaceFunctionParameters(
        replacement: string,
        rawArguments: Map<string, string>,
        expandedArguments: Map<string, string>
    ): string {
        let preparedReplacement = replacement;
        const pastedTokens = new Map<string, string>();
        const pastePattern = /(?:[A-Za-z_][A-Za-z0-9_]*|[0-9][A-Za-z0-9_']*)(?:\s*##\s*(?:[A-Za-z_][A-Za-z0-9_]*|[0-9][A-Za-z0-9_']*))+/;
        for (let pasteCount = 0; pasteCount < 32; pasteCount++) {
            const paste = preparedReplacement.match(pastePattern);
            if (!paste) break;
            const pastedValue = paste[0].split(/\s*##\s*/)
                .map(token => (rawArguments.get(token) ?? token).trim())
                .join('');
            const marker = `\uE000${pasteCount}\uE001`;
            pastedTokens.set(marker, pastedValue);
            preparedReplacement = preparedReplacement.slice(0, paste.index)
                + marker
                + preparedReplacement.slice(paste.index! + paste[0].length);
        }

        let result = '';
        for (let i = 0; i < preparedReplacement.length;) {
            const char = preparedReplacement[i];
            if (char === '"' || char === "'") {
                const end = readQuotedSegment(preparedReplacement, i);
                result += preparedReplacement.slice(i, end);
                i = end;
                continue;
            }

            if (char === '#') {
                if (preparedReplacement[i + 1] === '#') {
                    result += '##';
                    i += 2;
                    continue;
                }
                let parameterStart = i + 1;
                while (/\s/.test(preparedReplacement[parameterStart] || '')) {
                    parameterStart++;
                }
                const match = preparedReplacement.slice(parameterStart).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
                if (match && rawArguments.has(match[1])) {
                    const stringized = (rawArguments.get(match[1]) || '').trim().replace(/\s+/g, ' ')
                        .replace(/\\/g, '\\\\')
                        .replace(/"/g, '\\"');
                    result += `"${stringized}"`;
                    i = parameterStart + match[1].length;
                    continue;
                }
            }

            if (/[A-Za-z_]/.test(char)) {
                let identifierEnd = i + 1;
                while (identifierEnd < preparedReplacement.length && /[A-Za-z0-9_]/.test(preparedReplacement[identifierEnd])) {
                    identifierEnd++;
                }
                const name = preparedReplacement.slice(i, identifierEnd);
                result += expandedArguments.get(name) ?? name;
                i = identifierEnd;
                continue;
            }

            result += char;
            i++;
        }

        for (const [marker, pastedValue] of pastedTokens) {
            result = result.split(marker).join(pastedValue);
        }
        return result;
    }
}

function normalizeInteger(value: bigint, unsigned: boolean): PPInteger {
    return {
        value: unsigned ? BigInt.asUintN(INTEGER_BITS, value) : BigInt.asIntN(INTEGER_BITS, value),
        unsigned
    };
}

function booleanInteger(value: boolean): PPInteger {
    return { value: value ? 1n : 0n, unsigned: false };
}

function isTruthy(value: PPInteger): boolean {
    return value.value !== 0n;
}

function convertOperands(left: PPInteger, right: PPInteger): [PPInteger, PPInteger, boolean] {
    const unsigned = left.unsigned || right.unsigned;
    return [normalizeInteger(left.value, unsigned), normalizeInteger(right.value, unsigned), unsigned];
}

function parseIntegerLiteral(text: string): PPInteger | null {
    const normalized = text.replace(/'/g, '');
    const suffixMatch = normalized.match(/([uUlLzZ]+)$/);
    const suffix = suffixMatch?.[1] || '';
    const digits = suffix ? normalized.slice(0, -suffix.length) : normalized;
    const unsigned = /u/i.test(suffix);

    try {
        let value: bigint;
        if (/^0[xX][0-9a-fA-F]+$/.test(digits) || /^0[bB][01]+$/.test(digits)) {
            value = BigInt(digits);
        } else if (/^0[0-7]+$/.test(digits)) {
            value = BigInt(`0o${digits.slice(1)}`);
        } else if (/^(?:0|[1-9][0-9]*)$/.test(digits)) {
            value = BigInt(digits);
        } else {
            return null;
        }

        return normalizeInteger(value, unsigned || value > ((1n << 63n) - 1n));
    } catch {
        return null;
    }
}

function parseCharacterLiteral(text: string): PPInteger | null {
    const quoteIndex = text.indexOf("'");
    if (quoteIndex < 0 || !text.endsWith("'")) return null;

    const content = text.slice(quoteIndex + 1, -1);
    const values: bigint[] = [];
    for (let i = 0; i < content.length;) {
        if (content[i] !== '\\') {
            const codePoint = content.codePointAt(i) || 0;
            values.push(BigInt(codePoint));
            i += codePoint > 0xffff ? 2 : 1;
            continue;
        }

        i++;
        if (i >= content.length) return null;
        const escape = content[i++];
        const simpleEscapes: Record<string, number> = {
            "'": 0x27, '"': 0x22, '?': 0x3f, '\\': 0x5c,
            a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b
        };
        if (simpleEscapes[escape] !== undefined) {
            values.push(BigInt(simpleEscapes[escape]));
            continue;
        }
        if (escape === 'x') {
            const match = content.slice(i).match(/^[0-9a-fA-F]+/);
            if (!match) return null;
            values.push(BigInt(`0x${match[0]}`));
            i += match[0].length;
            continue;
        }
        if (escape === 'u' || escape === 'U') {
            const length = escape === 'u' ? 4 : 8;
            const digits = content.slice(i, i + length);
            if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) return null;
            values.push(BigInt(`0x${digits}`));
            i += length;
            continue;
        }
        if (/[0-7]/.test(escape)) {
            const octal = (escape + content.slice(i)).match(/^[0-7]{1,3}/)![0];
            values.push(BigInt(`0o${octal}`));
            i += octal.length - 1;
            continue;
        }
        values.push(BigInt(escape.codePointAt(0) || 0));
    }

    if (values.length === 0) return null;
    let value = 0n;
    for (const part of values) value = (value << 8n) | (part & 0xffn);
    return normalizeInteger(value, false);
}

class Lexer {
    private index = 0;

    constructor(private expression: string) {}

    tokenize(): Token[] {
        const tokens: Token[] = [];
        while (this.index < this.expression.length) {
            if (/\s/.test(this.expression[this.index])) {
                this.index++;
                continue;
            }

            const characterMatch = this.expression.slice(this.index).match(/^(?:u8|u|U|L)?'(?:\\.|[^'\\])*'/);
            if (characterMatch) {
                const value = parseCharacterLiteral(characterMatch[0]);
                tokens.push(value
                    ? { type: 'character', text: characterMatch[0], value }
                    : { type: 'invalid', text: characterMatch[0] });
                this.index += characterMatch[0].length;
                continue;
            }

            if (/[0-9]/.test(this.expression[this.index])) {
                const match = this.expression.slice(this.index).match(/^[0-9][A-Za-z0-9_']*/)!;
                const value = parseIntegerLiteral(match[0]);
                tokens.push(value
                    ? { type: 'number', text: match[0], value }
                    : { type: 'invalid', text: match[0] });
                this.index += match[0].length;
                continue;
            }

            if (/[A-Za-z_]/.test(this.expression[this.index])) {
                const match = this.expression.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
                tokens.push({ type: 'identifier', text: match[0] });
                this.index += match[0].length;
                continue;
            }

            const doubleOperator = this.expression.slice(this.index, this.index + 2);
            if (['&&', '||', '<<', '>>', '<=', '>=', '==', '!='].includes(doubleOperator)) {
                tokens.push({ type: 'operator', text: doubleOperator });
                this.index += 2;
                continue;
            }

            const operator = this.expression[this.index++];
            tokens.push('+-*/%<>&^|!~?:(),'.includes(operator)
                ? { type: 'operator', text: operator }
                : { type: 'invalid', text: operator });
        }
        tokens.push({ type: 'end', text: '' });
        return tokens;
    }
}

const BINARY_PRECEDENCE: Record<string, number> = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
    '==': 6, '!=': 6,
    '<': 7, '<=': 7, '>': 7, '>=': 7,
    '<<': 8, '>>': 8,
    '+': 9, '-': 9,
    '*': 10, '/': 10, '%': 10
};

class Parser {
    private position = 0;
    private invalid = false;

    constructor(private tokens: Token[]) {}

    parse(): ExpressionNode | null {
        const expression = this.parseComma();
        if (this.current().type !== 'end') this.invalid = true;
        return this.invalid ? null : expression;
    }

    private current(): Token {
        return this.tokens[this.position] || { type: 'end', text: '' };
    }

    private consume(expected?: string): Token {
        const token = this.current();
        if (expected !== undefined && token.text !== expected) {
            this.invalid = true;
            return token;
        }
        this.position++;
        return token;
    }

    private parseComma(): ExpressionNode {
        let expression = this.parseConditional();
        while (this.current().text === ',') {
            this.consume(',');
            expression = { type: 'comma', left: expression, right: this.parseConditional() };
        }
        return expression;
    }

    private parseConditional(): ExpressionNode {
        const condition = this.parseBinary(1);
        if (this.current().text !== '?') return condition;
        this.consume('?');
        const whenTrue = this.parseComma();
        this.consume(':');
        return { type: 'conditional', condition, whenTrue, whenFalse: this.parseConditional() };
    }

    private parseBinary(minimumPrecedence: number): ExpressionNode {
        let left = this.parseUnary();
        while (true) {
            const operator = this.current().text;
            const precedence = BINARY_PRECEDENCE[operator] || 0;
            if (precedence < minimumPrecedence) break;
            this.consume();
            const right = this.parseBinary(precedence + 1);
            left = { type: 'binary', operator, left, right };
        }
        return left;
    }

    private parseUnary(): ExpressionNode {
        if (['+', '-', '!', '~'].includes(this.current().text)) {
            const operator = this.consume().text;
            return { type: 'unary', operator, operand: this.parseUnary() };
        }
        return this.parsePrimary();
    }

    private parsePrimary(): ExpressionNode {
        const token = this.current();
        if (token.type === 'number' || token.type === 'character') {
            this.consume();
            return { type: 'literal', value: token.value! };
        }
        if (token.type === 'identifier') {
            this.consume();
            return { type: 'identifier' };
        }
        if (token.text === '(') {
            this.consume('(');
            const expression = this.parseComma();
            this.consume(')');
            return expression;
        }

        this.invalid = true;
        this.consume();
        return { type: 'literal', value: normalizeInteger(0n, false) };
    }
}

function evaluateBinary(operator: string, left: PPInteger, right: PPInteger): PPInteger | null {
    const [convertedLeft, convertedRight, unsigned] = convertOperands(left, right);
    const leftValue = convertedLeft.value;
    const rightValue = convertedRight.value;

    switch (operator) {
        case '+': return normalizeInteger(leftValue + rightValue, unsigned);
        case '-': return normalizeInteger(leftValue - rightValue, unsigned);
        case '*': return normalizeInteger(leftValue * rightValue, unsigned);
        case '/': return rightValue === 0n ? null : normalizeInteger(leftValue / rightValue, unsigned);
        case '%': return rightValue === 0n ? null : normalizeInteger(leftValue % rightValue, unsigned);
        case '<<':
        case '>>': {
            const shift = Number(rightValue);
            if (!Number.isInteger(shift) || shift < 0 || shift >= INTEGER_BITS) return null;
            const source = normalizeInteger(left.value, left.unsigned);
            return operator === '<<'
                ? normalizeInteger(source.value << BigInt(shift), left.unsigned)
                : normalizeInteger(source.value >> BigInt(shift), left.unsigned);
        }
        case '<': return booleanInteger(leftValue < rightValue);
        case '<=': return booleanInteger(leftValue <= rightValue);
        case '>': return booleanInteger(leftValue > rightValue);
        case '>=': return booleanInteger(leftValue >= rightValue);
        case '==': return booleanInteger(leftValue === rightValue);
        case '!=': return booleanInteger(leftValue !== rightValue);
        case '&': return normalizeInteger(leftValue & rightValue, unsigned);
        case '^': return normalizeInteger(leftValue ^ rightValue, unsigned);
        case '|': return normalizeInteger(leftValue | rightValue, unsigned);
        default: return null;
    }
}

function evaluateNode(node: ExpressionNode): PPInteger | null {
    switch (node.type) {
        case 'literal': return node.value;
        case 'identifier': return normalizeInteger(0n, false);
        case 'comma': return evaluateNode(node.left) ? evaluateNode(node.right) : null;
        case 'conditional': {
            const condition = evaluateNode(node.condition);
            if (!condition) return null;
            return evaluateNode(isTruthy(condition) ? node.whenTrue : node.whenFalse);
        }
        case 'unary': {
            const operand = evaluateNode(node.operand);
            if (!operand) return null;
            if (node.operator === '+') return operand;
            if (node.operator === '-') return normalizeInteger(-operand.value, operand.unsigned);
            if (node.operator === '!') return booleanInteger(!isTruthy(operand));
            return normalizeInteger(~operand.value, operand.unsigned);
        }
        case 'binary': {
            const left = evaluateNode(node.left);
            if (!left) return null;
            if (node.operator === '&&' && !isTruthy(left)) return booleanInteger(false);
            if (node.operator === '||' && isTruthy(left)) return booleanInteger(true);
            const right = evaluateNode(node.right);
            if (!right) return null;
            if (node.operator === '&&') return booleanInteger(isTruthy(right));
            if (node.operator === '||') return booleanInteger(isTruthy(right));
            return evaluateBinary(node.operator, left, right);
        }
    }
}

export class ExpressionEvaluator {
    private definedRegex = /\bdefined\b\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|\bdefined\b\s+([A-Za-z_][A-Za-z0-9_]*)/g;

    constructor(private definedMacros: Map<string, MacroDefinition>) {}

    evaluate(conditionText: string): boolean {
        if (!conditionText || typeof conditionText !== 'string') return false;

        let expanded = stripDirectiveComments(conditionText).replace(this.definedRegex, (_match, first, second) => {
            return this.hasMacro(first || second) ? '1' : '0';
        });
        expanded = new MacroExpander(this.definedMacros).expand(expanded);

        if (process.env.DEBUG_EXPR) {
            console.log(`[DEBUG] condition: ${conditionText}`);
            console.log(`[DEBUG] expanded: ${expanded}`);
        }

        const tree = new Parser(new Lexer(expanded).tokenize()).parse();
        const result = tree ? evaluateNode(tree) : null;
        return result ? isTruthy(result) : false;
    }

    hasMacro(name: string): boolean {
        return this.definedMacros.get(name)?.isDefined === true;
    }
}
