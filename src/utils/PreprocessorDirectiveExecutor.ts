import {
    ExpressionEvaluator,
    MacroDefinition,
    MacroExpander
} from './PreprocessorExpression';
import {
    PreprocessorDirectiveFlags,
    PreprocessorDirectiveOpcode,
    PreprocessorDirectiveTape,
    PreprocessorScannerDiagnostic
} from './PreprocessorDirectiveScanner';

export type IncludeDelimiter = 'quote' | 'angle';

export interface DirectiveSourceLocation {
    offset: number;
    endOffset: number;
    line?: number;
    column?: number;
}

export interface PreprocessorIncludeEvent {
    target: string;
    delimiter: IncludeDelimiter;
    macroExpanded: boolean;
    includeNext: boolean;
    directive: 'include' | 'include_next' | 'import';
    location: DirectiveSourceLocation;
}

export type PreprocessorExecutionDiagnosticCode =
    | 'indeterminate-condition'
    | 'malformed-conditional'
    | 'malformed-define'
    | 'malformed-undef'
    | 'malformed-include'
    | 'unclosed-conditional';

export interface PreprocessorExecutionDiagnostic {
    code: PreprocessorExecutionDiagnosticCode;
    severity: 'warning' | 'error';
    message: string;
    location: DirectiveSourceLocation;
    directiveIndex: number;
}

export interface DirectiveExecutionOptions {
    /** Runs synchronously at the include location. */
    onInclude?: (includePath: string, event: PreprocessorIncludeEvent) => void;
    onPragmaOnce?: (location: DirectiveSourceLocation) => void;
    onDiagnostic?: (diagnostic: PreprocessorExecutionDiagnostic) => void;
    /** Returns undefined when the current include search context cannot decide. */
    hasInclude?: (
        includePath: string,
        delimiter: IncludeDelimiter,
        includeNext: boolean
    ) => boolean | undefined;
}

export interface DirectiveExecutionResult {
    includes: string[];
    includeEvents: PreprocessorIncludeEvent[];
    diagnostics: PreprocessorExecutionDiagnostic[];
    scannerDiagnostics: readonly PreprocessorScannerDiagnostic[];
    /** The exact Map supplied by the caller, mutated in directive order. */
    defines: Map<string, MacroDefinition>;
    pragmaOnce: boolean;
    indeterminate: boolean;
    /** Results must not be consumed as complete when this is true. */
    fallbackRequired: boolean;
}

interface ConditionalFrame {
    parentActive: boolean;
    currentActive: boolean;
    branchTaken: boolean;
    seenElse: boolean;
    indeterminate: boolean;
}

interface ParsedInclude {
    target: string;
    delimiter: IncludeDelimiter;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;

function getPayload(tape: PreprocessorDirectiveTape, directiveIndex: number): string {
    const payloadIndex = tape.payloadIndices[directiveIndex];
    return payloadIndex >= 0 ? (tape.payloads[payloadIndex] ?? '') : '';
}

function getLocation(tape: PreprocessorDirectiveTape, directiveIndex: number): DirectiveSourceLocation {
    const offset = tape.sourceOffsets[directiveIndex] ?? 0;
    const line = tape.lineNumbers[directiveIndex];
    return {
        offset,
        endOffset: offset,
        line: line === undefined ? undefined : line,
        column: undefined
    };
}

function parseDirectInclude(argument: string): ParsedInclude | null {
    const text = argument.trim();
    if (text.length < 3) return null;

    if (text.charCodeAt(0) === 60) { // <
        const closing = text.indexOf('>', 1);
        if (closing <= 1 || text.slice(closing + 1).trim().length !== 0) return null;
        return {
            target: text.slice(1, closing).trim(),
            delimiter: 'angle'
        };
    }

    if (text.charCodeAt(0) !== 34) return null; // "
    let escaped = false;
    for (let index = 1; index < text.length; index++) {
        const char = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char !== '"') continue;
        if (text.slice(index + 1).trim().length !== 0) return null;
        return {
            target: text.slice(1, index).replace(/\\([\\"])/g, '$1'),
            delimiter: 'quote'
        };
    }

    return null;
}

function findMatchingParenthesis(text: string, openIndex: number): number {
    let depth = 1;
    let quote: string | null = null;
    let escaped = false;
    for (let index = openIndex + 1; index < text.length; index++) {
        const char = text[index];
        if (quote) {
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
        } else if (char === '(') {
            depth++;
        } else if (char === ')' && --depth === 0) {
            return index;
        }
    }
    return -1;
}

function expandHasIncludeOperators(
    expression: string,
    defines: Map<string, MacroDefinition>,
    resolver: DirectiveExecutionOptions['hasInclude']
): { expression: string; reason?: string } {
    // Compilers expose these operators to `defined(...)` even though they are
    // not ordinary entries in the command-line macro map.
    expression = expression.replace(
        /\bdefined\s*(?:\(\s*)?(__has_include_next|__has_include)(?:\s*\))?/g,
        resolver ? '1' : '0'
    );
    const builtin = /\b(__has_include_next|__has_include)\b/g;
    let result = '';
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = builtin.exec(expression)) !== null) {
        let openIndex = match.index + match[0].length;
        while (/\s/.test(expression[openIndex] || '')) openIndex++;
        if (expression[openIndex] !== '(') {
            return { expression, reason: `${match[1]} requires a parenthesized header operand` };
        }
        const closeIndex = findMatchingParenthesis(expression, openIndex);
        if (closeIndex < 0) {
            return { expression, reason: `unterminated ${match[1]} operand` };
        }

        const expandedOperand = new MacroExpander(defines)
            .expand(expression.slice(openIndex + 1, closeIndex))
            .trim();
        const include = parseDirectInclude(expandedOperand);
        if (!include) {
            return { expression, reason: `unable to parse ${match[1]} operand: ${expandedOperand}` };
        }
        if (!resolver) {
            return { expression, reason: `${match[1]} requires an include resolver` };
        }
        const available = resolver(
            include.target,
            include.delimiter,
            match[1] === '__has_include_next'
        );
        if (available === undefined) {
            return { expression, reason: `${match[1]} could not resolve ${include.target}` };
        }

        result += expression.slice(cursor, match.index);
        result += available ? '1' : '0';
        cursor = closeIndex + 1;
        builtin.lastIndex = cursor;
    }

    return { expression: result + expression.slice(cursor) };
}

function findParameterListEnd(text: string): number {
    for (let index = 1; index < text.length; index++) {
        if (text[index] === ')') return index;
    }
    return -1;
}

function parseMacroDefinition(argument: string, functionLike: boolean): MacroDefinition | null {
    const normalized = argument.trimStart();
    const nameMatch = normalized.match(IDENTIFIER_PATTERN);
    if (!nameMatch) return null;

    const name = nameMatch[0];
    let remainder = normalized.slice(name.length);
    if (!functionLike) {
        return {
            name,
            value: remainder.trim(),
            isDefined: true,
            functionLike: false
        };
    }

    if (!remainder.startsWith('(')) return null;
    const closingParen = findParameterListEnd(remainder);
    if (closingParen < 0) return null;

    const parameterText = remainder.slice(1, closingParen).trim();
    const parameters: string[] = [];
    const parameterNames = new Set<string>();
    let variadic = false;

    if (parameterText.length > 0) {
        const rawParameters = parameterText.split(',');
        for (let index = 0; index < rawParameters.length; index++) {
            const parameter = rawParameters[index].trim();
            const last = index === rawParameters.length - 1;
            let parameterName: string;

            if (parameter === '...') {
                if (!last) return null;
                parameterName = '__VA_ARGS__';
                variadic = true;
            } else if (/^[A-Za-z_][A-Za-z0-9_]*\.\.\.$/.test(parameter)) {
                if (!last) return null;
                parameterName = parameter.slice(0, -3);
                variadic = true;
            } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) {
                parameterName = parameter;
            } else {
                return null;
            }

            if (parameterNames.has(parameterName)) return null;
            parameterNames.add(parameterName);
            parameters.push(parameterName);
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

function parseSingleMacroName(argument: string): string | null {
    const normalized = argument.trim();
    const match = normalized.match(IDENTIFIER_PATTERN);
    if (!match || normalized.slice(match[0].length).trim().length !== 0) return null;
    return match[0];
}

function currentActive(frames: readonly ConditionalFrame[]): boolean {
    return frames.length === 0 ? true : frames[frames.length - 1].currentActive;
}

function isConditionalStart(opcode: PreprocessorDirectiveOpcode): boolean {
    return opcode === PreprocessorDirectiveOpcode.If
        || opcode === PreprocessorDirectiveOpcode.Ifdef
        || opcode === PreprocessorDirectiveOpcode.Ifndef;
}

function isConditionalElif(opcode: PreprocessorDirectiveOpcode): boolean {
    return opcode === PreprocessorDirectiveOpcode.Elif
        || opcode === PreprocessorDirectiveOpcode.Elifdef
        || opcode === PreprocessorDirectiveOpcode.Elifndef;
}

/**
 * Executes a macro-independent directive tape. Execution is synchronous so a
 * nested include callback can mutate `defines` before the next condition is
 * evaluated. An indeterminate condition marks the result as requiring fallback
 * and skips that conditional chain instead of silently choosing a branch.
 */
export function executeDirectiveTape(
    tape: PreprocessorDirectiveTape,
    defines: Map<string, MacroDefinition>,
    options: DirectiveExecutionOptions = {}
): DirectiveExecutionResult {
    const directiveCount = tape.opcodes.length;
    const includes = new Set<string>();
    const includeEvents: PreprocessorIncludeEvent[] = [];
    const diagnostics: PreprocessorExecutionDiagnostic[] = [];
    const conditionalFrames: ConditionalFrame[] = [];
    // Scanner errors mean the tape is structurally incomplete. Warnings such as
    // unrelated/unknown pragmas remain observable but do not force fallback.
    let fallbackRequired = tape.diagnostics.some(diagnostic => diagnostic.severity === 'error');
    let indeterminate = false;
    let pragmaOnce = false;

    const report = (
        code: PreprocessorExecutionDiagnosticCode,
        message: string,
        directiveIndex: number,
        severity: 'warning' | 'error' = 'error'
    ): void => {
        const diagnostic: PreprocessorExecutionDiagnostic = {
            code,
            severity,
            message,
            location: getLocation(tape, directiveIndex),
            directiveIndex
        };
        diagnostics.push(diagnostic);
        options.onDiagnostic?.(diagnostic);
    };

    const requireFallback = (
        code: PreprocessorExecutionDiagnosticCode,
        message: string,
        directiveIndex: number
    ): void => {
        fallbackRequired = true;
        report(code, message, directiveIndex);
    };

    const conditionalChainHasDependencyEffects = (directiveIndex: number): boolean => {
        const endIndex = tape.endIndices[directiveIndex];
        const limit = endIndex > directiveIndex && endIndex <= directiveCount
            ? endIndex
            : directiveCount;
        for (let index = directiveIndex + 1; index < limit; index++) {
            const opcode = tape.opcodes[index] as PreprocessorDirectiveOpcode;
            if (opcode === PreprocessorDirectiveOpcode.Include
                || opcode === PreprocessorDirectiveOpcode.IncludeNext
                || opcode === PreprocessorDirectiveOpcode.Import
                || opcode === PreprocessorDirectiveOpcode.Define
                || opcode === PreprocessorDirectiveOpcode.Undef
                || opcode === PreprocessorDirectiveOpcode.PragmaOnce) {
                return true;
            }
        }
        return false;
    };

    const evaluateCondition = (expression: string, directiveIndex: number): boolean | null => {
        const expandedBuiltins = expandHasIncludeOperators(expression, defines, options.hasInclude);
        if (expandedBuiltins.reason) {
            indeterminate = true;
            requireFallback('indeterminate-condition', expandedBuiltins.reason, directiveIndex);
            return null;
        }
        const result = new ExpressionEvaluator(defines).evaluateDetailed(expandedBuiltins.expression);
        if (result.kind === 'indeterminate') {
            // Unsupported conditions around ordinary declarations/data cannot
            // change the dependency graph or macro state, so skipping that
            // branch is exact for this specialized analyzer.
            if (!conditionalChainHasDependencyEffects(directiveIndex)) {
                return false;
            }
            indeterminate = true;
            requireFallback('indeterminate-condition', result.reason, directiveIndex);
            return null;
        }
        return result.value;
    };

    const skipTo = (targetIndex: number, currentIndex: number): number => {
        return targetIndex > currentIndex && targetIndex < directiveCount
            ? targetIndex - 1
            : currentIndex;
    };

    for (let index = 0; index < directiveCount; index++) {
        const opcode = tape.opcodes[index] as PreprocessorDirectiveOpcode;
        const flags = tape.flags[index] as PreprocessorDirectiveFlags;
        let active = currentActive(conditionalFrames);

        if (isConditionalStart(opcode)) {
            const parentActive = active;
            let condition: boolean | null = false;
            if (parentActive) {
                if (opcode === PreprocessorDirectiveOpcode.Ifdef
                    || opcode === PreprocessorDirectiveOpcode.Ifndef) {
                    const macroName = parseSingleMacroName(getPayload(tape, index));
                    if (!macroName) {
                        requireFallback(
                            'malformed-conditional',
                            `Missing or malformed macro name in #${opcode === PreprocessorDirectiveOpcode.Ifndef ? 'ifndef' : 'ifdef'}`,
                            index
                        );
                        condition = null;
                    } else {
                        const defined = defines.get(macroName)?.isDefined === true;
                        condition = opcode === PreprocessorDirectiveOpcode.Ifndef ? !defined : defined;
                    }
                } else {
                    condition = evaluateCondition(getPayload(tape, index), index);
                }
            }

            const frameIndeterminate = parentActive && condition === null;
            const frame: ConditionalFrame = {
                parentActive,
                currentActive: parentActive && condition === true,
                branchTaken: parentActive && condition === true,
                seenElse: false,
                indeterminate: frameIndeterminate
            };
            conditionalFrames.push(frame);

            if (!frame.currentActive) {
                const target = frameIndeterminate || !parentActive
                    ? tape.endIndices[index]
                    : tape.jumpIndices[index];
                index = skipTo(target, index);
            }
            continue;
        }

        if (isConditionalElif(opcode)) {
            const frame = conditionalFrames[conditionalFrames.length - 1];
            if (!frame) {
                requireFallback('malformed-conditional', 'Unmatched #elif', index);
                continue;
            }
            if (frame.seenElse) {
                requireFallback('malformed-conditional', '#elif after #else', index);
                frame.currentActive = false;
                continue;
            }

            if (frame.indeterminate || !frame.parentActive || frame.branchTaken) {
                frame.currentActive = false;
                index = skipTo(tape.endIndices[index], index);
                continue;
            }

            let condition: boolean | null;
            if (opcode === PreprocessorDirectiveOpcode.Elif) {
                condition = evaluateCondition(getPayload(tape, index), index);
            } else {
                const macroName = parseSingleMacroName(getPayload(tape, index));
                if (!macroName) {
                    requireFallback('malformed-conditional', 'Missing or malformed macro name in #elif', index);
                    condition = null;
                } else {
                    const defined = defines.get(macroName)?.isDefined === true;
                    condition = opcode === PreprocessorDirectiveOpcode.Elifndef ? !defined : defined;
                }
            }

            if (condition === null) {
                frame.indeterminate = true;
                frame.currentActive = false;
                index = skipTo(tape.endIndices[index], index);
                continue;
            }

            frame.currentActive = condition;
            frame.branchTaken = condition;
            if (!condition) {
                index = skipTo(tape.jumpIndices[index], index);
            }
            continue;
        }

        if (opcode === PreprocessorDirectiveOpcode.Else) {
            const frame = conditionalFrames[conditionalFrames.length - 1];
            if (!frame) {
                requireFallback('malformed-conditional', 'Unmatched #else', index);
                continue;
            }
            if (frame.seenElse) {
                requireFallback('malformed-conditional', 'Duplicate #else', index);
                frame.currentActive = false;
                continue;
            }

            frame.seenElse = true;
            frame.currentActive = frame.parentActive && !frame.branchTaken && !frame.indeterminate;
            frame.branchTaken = frame.branchTaken || frame.currentActive;
            if (!frame.currentActive) {
                index = skipTo(tape.endIndices[index], index);
            }
            continue;
        }

        if (opcode === PreprocessorDirectiveOpcode.Endif) {
            if (conditionalFrames.length === 0) {
                requireFallback('malformed-conditional', 'Unmatched #endif', index);
            } else {
                conditionalFrames.pop();
            }
            continue;
        }

        active = currentActive(conditionalFrames);
        if (!active) continue;

        if (opcode === PreprocessorDirectiveOpcode.Define) {
            const macro = parseMacroDefinition(
                getPayload(tape, index),
                (flags & PreprocessorDirectiveFlags.FunctionLikeMacro) !== 0
            );
            if (!macro) {
                requireFallback('malformed-define', 'Unable to parse active #define', index);
            } else {
                defines.set(macro.name, macro);
            }
            continue;
        }

        if (opcode === PreprocessorDirectiveOpcode.Undef) {
            const macroName = parseSingleMacroName(getPayload(tape, index));
            if (!macroName) {
                requireFallback('malformed-undef', 'Unable to parse active #undef', index);
            } else {
                defines.set(macroName, { name: macroName, isDefined: false });
            }
            continue;
        }

        if (opcode === PreprocessorDirectiveOpcode.Include
            || opcode === PreprocessorDirectiveOpcode.IncludeNext
            || opcode === PreprocessorDirectiveOpcode.Import) {
            const payload = getPayload(tape, index);
            const macroExpanded = (flags & PreprocessorDirectiveFlags.IncludeMacro) !== 0;
            let parsedInclude: ParsedInclude | null;

            if (macroExpanded) {
                parsedInclude = parseDirectInclude(new MacroExpander(defines).expand(payload));
            } else if ((flags & PreprocessorDirectiveFlags.IncludeQuoted) !== 0) {
                parsedInclude = { target: payload, delimiter: 'quote' };
            } else if ((flags & PreprocessorDirectiveFlags.IncludeAngled) !== 0) {
                parsedInclude = { target: payload, delimiter: 'angle' };
            } else {
                parsedInclude = parseDirectInclude(payload);
            }

            if (!parsedInclude || parsedInclude.target.length === 0) {
                const directiveName = opcode === PreprocessorDirectiveOpcode.IncludeNext
                    ? 'include_next'
                    : opcode === PreprocessorDirectiveOpcode.Import ? 'import' : 'include';
                requireFallback('malformed-include', `Unable to resolve active #${directiveName}`, index);
                continue;
            }

            const directive = opcode === PreprocessorDirectiveOpcode.IncludeNext
                ? 'include_next'
                : opcode === PreprocessorDirectiveOpcode.Import ? 'import' : 'include';
            const event: PreprocessorIncludeEvent = {
                target: parsedInclude.target,
                delimiter: parsedInclude.delimiter,
                macroExpanded,
                includeNext: opcode === PreprocessorDirectiveOpcode.IncludeNext,
                directive,
                location: getLocation(tape, index)
            };
            includes.add(event.target);
            includeEvents.push(event);
            options.onInclude?.(event.target, event);
            continue;
        }

        if (opcode === PreprocessorDirectiveOpcode.PragmaOnce) {
            pragmaOnce = true;
            options.onPragmaOnce?.(getLocation(tape, index));
        }
    }

    if (conditionalFrames.length > 0) {
        fallbackRequired = true;
        const diagnosticIndex = Math.max(directiveCount - 1, 0);
        report(
            'unclosed-conditional',
            `${conditionalFrames.length} unterminated conditional block(s)`,
            diagnosticIndex
        );
    }

    return {
        includes: [...includes],
        includeEvents,
        diagnostics,
        scannerDiagnostics: tape.diagnostics,
        defines,
        pragmaOnce,
        indeterminate,
        fallbackRequired
    };
}
