/**
 * Allocation-light scanner for C/C++ preprocessing directives.
 *
 * The scanner reads Buffer bytes (or string UTF-16 code units) directly and only
 * decodes the text belonging to preprocessing directives. Ordinary C/C++ tokens
 * are skipped; no syntax tree and no whole-file normalized copy are produced.
 */

export enum PreprocessorDirectiveOpcode {
    Unknown = 0,
    Include = 1,
    IncludeNext = 2,
    Import = 3,
    Define = 4,
    Undef = 5,
    If = 6,
    Ifdef = 7,
    Ifndef = 8,
    Elif = 9,
    Elifdef = 10,
    Elifndef = 11,
    Else = 12,
    Endif = 13,
    PragmaOnce = 14
}

export enum PreprocessorDirectiveFlags {
    None = 0,
    IncludeQuoted = 1 << 0,
    IncludeAngled = 1 << 1,
    IncludeMacro = 1 << 2,
    FunctionLikeMacro = 1 << 3
}

export type PreprocessorScannerDiagnosticCode =
    | 'unknown-directive'
    | 'malformed-directive'
    | 'unmatched-elif'
    | 'unmatched-else'
    | 'unmatched-endif'
    | 'elif-after-else'
    | 'duplicate-else'
    | 'unterminated-conditional'
    | 'unterminated-comment'
    | 'unterminated-string'
    | 'unterminated-raw-string';

export interface PreprocessorScannerDiagnostic {
    code: PreprocessorScannerDiagnosticCode;
    severity: 'warning' | 'error';
    message: string;
    line: number;
    sourceOffset: number;
    directiveIndex: number;
}

/**
 * Structure-of-arrays tape. A payload index of -1 means that the directive has
 * no operand. For direct includes the payload is the path without delimiters;
 * macro includes retain the complete operand for expansion at replay time.
 *
 * jumpIndices:
 * - if/elif: the next elif/else/endif directive when the branch is false
 * - else: matching endif
 * - endif: matching opening if
 *
 * endIndices is the matching endif for every branch directive. Unclosed chains
 * use opcodes.length as an end sentinel.
 */
export interface PreprocessorDirectiveTape {
    opcodes: Uint8Array;
    flags: Uint8Array;
    payloadIndices: Int32Array;
    lineNumbers: Uint32Array;
    sourceOffsets: Uint32Array;
    jumpIndices: Int32Array;
    endIndices: Int32Array;
    payloads: readonly string[];
    diagnostics: readonly PreprocessorScannerDiagnostic[];
    hasPragmaOnce: boolean;
}

const enum LexicalState {
    Normal,
    LineComment,
    BlockComment
}

interface ConditionalFrame {
    opener: number;
    branches: number[];
    lastBranch: number;
    seenElse: boolean;
    line: number;
    sourceOffset: number;
}

interface CollectedDirective {
    text: string;
    nextIndex: number;
    nextLine: number;
    resumeState: LexicalState;
}

interface RawStringStart {
    delimiterStart: number;
    delimiterLength: number;
    contentStart: number;
}

interface SkipResult {
    nextIndex: number;
    nextLine: number;
    endedAtNewline: boolean;
    terminated: boolean;
}

class SourceView {
    readonly length: number;
    readonly isBuffer: boolean;
    private readonly buffer?: Buffer;
    private readonly text?: string;

    constructor(source: Buffer | string) {
        this.isBuffer = Buffer.isBuffer(source);
        this.buffer = this.isBuffer ? source as Buffer : undefined;
        this.text = this.isBuffer ? undefined : source as string;
        this.length = source.length;
    }

    at(index: number): number {
        if (index < 0 || index >= this.length) return -1;
        return this.buffer ? this.buffer[index] : this.text!.charCodeAt(index);
    }

    decode(units: number[]): string {
        if (units.length === 0) return '';
        if (this.isBuffer) return Buffer.from(units).toString('utf8');

        let result = '';
        const chunkSize = 0x2000;
        for (let index = 0; index < units.length; index += chunkSize) {
            result += String.fromCharCode(...units.slice(index, index + chunkSize));
        }
        return result;
    }

    lastIndexOfAscii(text: string): number {
        return this.buffer
            ? this.buffer.lastIndexOf(Buffer.from(text, 'ascii'))
            : this.text!.lastIndexOf(text);
    }
}

class TapeBuilder {
    readonly opcodes: number[] = [];
    readonly flags: number[] = [];
    readonly payloadIndices: number[] = [];
    readonly lineNumbers: number[] = [];
    readonly sourceOffsets: number[] = [];
    readonly jumpIndices: number[] = [];
    readonly endIndices: number[] = [];
    readonly payloads: string[] = [];
    readonly diagnostics: PreprocessorScannerDiagnostic[] = [];
    readonly conditionalStack: ConditionalFrame[] = [];
    private readonly payloadLookup = new Map<string, number>();
    hasPragmaOnce = false;

    add(
        opcode: PreprocessorDirectiveOpcode,
        flags: PreprocessorDirectiveFlags,
        payload: string | null,
        line: number,
        sourceOffset: number
    ): number {
        const index = this.opcodes.length;
        this.opcodes.push(opcode);
        this.flags.push(flags);
        this.payloadIndices.push(payload === null ? -1 : this.internPayload(payload));
        this.lineNumbers.push(line);
        this.sourceOffsets.push(sourceOffset);
        this.jumpIndices.push(-1);
        this.endIndices.push(-1);
        return index;
    }

    diagnostic(
        code: PreprocessorScannerDiagnosticCode,
        message: string,
        line: number,
        sourceOffset: number,
        directiveIndex = -1,
        severity: 'warning' | 'error' = 'error'
    ): void {
        this.diagnostics.push({ code, severity, message, line, sourceOffset, directiveIndex });
    }

    finalize(): PreprocessorDirectiveTape {
        const endSentinel = this.opcodes.length;
        while (this.conditionalStack.length > 0) {
            const frame = this.conditionalStack.pop()!;
            this.jumpIndices[frame.lastBranch] = endSentinel;
            for (const branch of frame.branches) this.endIndices[branch] = endSentinel;
            this.diagnostic(
                'unterminated-conditional',
                'Conditional directive is missing #endif',
                frame.line,
                frame.sourceOffset,
                frame.opener
            );
        }

        return {
            opcodes: Uint8Array.from(this.opcodes),
            flags: Uint8Array.from(this.flags),
            payloadIndices: Int32Array.from(this.payloadIndices),
            lineNumbers: Uint32Array.from(this.lineNumbers),
            sourceOffsets: Uint32Array.from(this.sourceOffsets),
            jumpIndices: Int32Array.from(this.jumpIndices),
            endIndices: Int32Array.from(this.endIndices),
            payloads: this.payloads,
            diagnostics: this.diagnostics,
            hasPragmaOnce: this.hasPragmaOnce
        };
    }

    private internPayload(payload: string): number {
        const existing = this.payloadLookup.get(payload);
        if (existing !== undefined) return existing;
        const index = this.payloads.length;
        this.payloads.push(payload);
        this.payloadLookup.set(payload, index);
        return index;
    }
}

function isHorizontalWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c;
}

function newlineLength(source: SourceView, index: number): number {
    const code = source.at(index);
    if (code === 0x0a) return 1;
    if (code === 0x0d) return source.at(index + 1) === 0x0a ? 2 : 1;
    return 0;
}

function spliceLength(source: SourceView, index: number): number {
    if (source.at(index) !== 0x5c) return 0;
    const length = newlineLength(source, index + 1);
    return length === 0 ? 0 : 1 + length;
}

function isIdentifierStart(code: number): boolean {
    return code === 0x5f
        || (code >= 0x41 && code <= 0x5a)
        || (code >= 0x61 && code <= 0x7a);
}

function isIdentifierContinue(code: number): boolean {
    return isIdentifierStart(code) || (code >= 0x30 && code <= 0x39) || code > 0x7f;
}

function directiveIntroducerLength(source: SourceView, index: number): number {
    if (source.at(index) === 0x23) return 1; // #
    if (source.at(index) === 0x25 && source.at(index + 1) === 0x3a) return 2; // %:
    return 0;
}

function tryRawStringStart(source: SourceView, index: number): RawStringStart | null {
    let quoteIndex = -1;
    const first = source.at(index);
    // This helper is reached from hot lexical loops. Reject the overwhelmingly
    // common non-prefix byte before reading behind/ahead in the source.
    if (first !== 0x52 && first !== 0x75 && first !== 0x55 && first !== 0x4c) return null;
    if (index > 0 && isIdentifierContinue(source.at(index - 1))) return null;

    if (first === 0x52 && source.at(index + 1) === 0x22) { // R"
        quoteIndex = index + 1;
    } else if ((first === 0x75 || first === 0x55 || first === 0x4c)
        && source.at(index + 1) === 0x52
        && source.at(index + 2) === 0x22) { // uR", UR", LR"
        quoteIndex = index + 2;
    } else if (first === 0x75
        && source.at(index + 1) === 0x38
        && source.at(index + 2) === 0x52
        && source.at(index + 3) === 0x22) { // u8R"
        quoteIndex = index + 3;
    } else {
        return null;
    }

    const delimiterStart = quoteIndex + 1;
    let cursor = delimiterStart;
    while (cursor < source.length && cursor - delimiterStart <= 16) {
        const code = source.at(cursor);
        if (code === 0x28) { // (
            return {
                delimiterStart,
                delimiterLength: cursor - delimiterStart,
                contentStart: cursor + 1
            };
        }
        if (code < 0x20 || code === 0x7f || code === 0x20
            || code === 0x29 || code === 0x5c) {
            return null;
        }
        cursor++;
    }
    return null;
}

function rawTerminatorMatches(source: SourceView, closeParen: number, raw: RawStringStart): boolean {
    for (let index = 0; index < raw.delimiterLength; index++) {
        if (source.at(closeParen + 1 + index) !== source.at(raw.delimiterStart + index)) return false;
    }
    return source.at(closeParen + 1 + raw.delimiterLength) === 0x22;
}

function skipRawString(source: SourceView, raw: RawStringStart, line: number): SkipResult {
    let cursor = raw.contentStart;
    let currentLine = line;
    while (cursor < source.length) {
        const code = source.at(cursor);
        if (code === 0x0a || code === 0x0d) {
            const nl = code === 0x0d && source.at(cursor + 1) === 0x0a ? 2 : 1;
            currentLine++;
            cursor += nl;
            continue;
        }
        if (code === 0x29 && rawTerminatorMatches(source, cursor, raw)) {
            return {
                nextIndex: cursor + raw.delimiterLength + 2,
                nextLine: currentLine,
                endedAtNewline: false,
                terminated: true
            };
        }
        cursor++;
    }
    return {
        nextIndex: source.length,
        nextLine: currentLine,
        endedAtNewline: false,
        terminated: false
    };
}

function skipQuoted(source: SourceView, start: number, line: number): SkipResult {
    const quote = source.at(start);
    let cursor = start + 1;
    let currentLine = line;
    while (cursor < source.length) {
        const code = source.at(cursor);
        if (code === 0x5c) {
            const splice = spliceLength(source, cursor);
            if (splice > 0) {
                currentLine++;
                cursor += splice;
                continue;
            }
        }
        if (code === quote) {
            return { nextIndex: cursor + 1, nextLine: currentLine, endedAtNewline: false, terminated: true };
        }
        if (code === 0x5c) {
            cursor += Math.min(2, source.length - cursor);
            continue;
        }
        if (code === 0x0a || code === 0x0d) {
            const nl = code === 0x0d && source.at(cursor + 1) === 0x0a ? 2 : 1;
            return {
                nextIndex: cursor + nl,
                nextLine: currentLine + 1,
                endedAtNewline: true,
                terminated: false
            };
        }
        cursor++;
    }
    return { nextIndex: cursor, nextLine: currentLine, endedAtNewline: false, terminated: false };
}

function appendRange(source: SourceView, units: number[], start: number, end: number): void {
    for (let index = start; index < end; index++) units.push(source.at(index));
}

function collectDirective(
    source: SourceView,
    start: number,
    line: number,
    builder: TapeBuilder,
    directiveOffset: number
): CollectedDirective {
    const units: number[] = [];
    let cursor = start;
    let currentLine = line;

    while (cursor < source.length) {
        const code = source.at(cursor);
        if (code === 0x5c) {
            const splice = spliceLength(source, cursor);
            if (splice > 0) {
                cursor += splice;
                currentLine++;
                continue;
            }
        }

        if (code === 0x0a || code === 0x0d) {
            const nl = code === 0x0d && source.at(cursor + 1) === 0x0a ? 2 : 1;
            return {
                text: source.decode(units),
                nextIndex: cursor + nl,
                nextLine: currentLine + 1,
                resumeState: LexicalState.Normal
            };
        }

        if (code === 0x2f && source.at(cursor + 1) === 0x2f) {
            cursor += 2;
            while (cursor < source.length) {
                const commentCode = source.at(cursor);
                if (commentCode === 0x5c) {
                    const continued = spliceLength(source, cursor);
                    if (continued > 0) {
                        cursor += continued;
                        currentLine++;
                        continue;
                    }
                }
                if (commentCode === 0x0a || commentCode === 0x0d) {
                    const commentNl = commentCode === 0x0d && source.at(cursor + 1) === 0x0a ? 2 : 1;
                    return {
                        text: source.decode(units),
                        nextIndex: cursor + commentNl,
                        nextLine: currentLine + 1,
                        resumeState: LexicalState.Normal
                    };
                }
                cursor++;
            }
            break;
        }

        if (code === 0x2f && source.at(cursor + 1) === 0x2a) {
            units.push(0x20);
            cursor += 2;
            let closed = false;
            while (cursor < source.length) {
                const commentCode = source.at(cursor);
                if (commentCode === 0x5c) {
                    const continued = spliceLength(source, cursor);
                    if (continued > 0) {
                        cursor += continued;
                        currentLine++;
                        continue;
                    }
                }
                if (commentCode === 0x2a && source.at(cursor + 1) === 0x2f) {
                    cursor += 2;
                    closed = true;
                    break;
                }
                if (commentCode === 0x0a || commentCode === 0x0d) {
                    const commentNl = commentCode === 0x0d && source.at(cursor + 1) === 0x0a ? 2 : 1;
                    return {
                        text: source.decode(units),
                        nextIndex: cursor + commentNl,
                        nextLine: currentLine + 1,
                        resumeState: LexicalState.BlockComment
                    };
                }
                cursor++;
            }
            if (!closed && cursor >= source.length) {
                builder.diagnostic(
                    'unterminated-comment',
                    'Unterminated block comment in preprocessing directive',
                    currentLine,
                    directiveOffset,
                    -1
                );
                break;
            }
            continue;
        }

        const raw = (code === 0x52 || code === 0x75 || code === 0x55 || code === 0x4c)
            ? tryRawStringStart(source, cursor)
            : null;
        if (raw) {
            const skipped = skipRawString(source, raw, currentLine);
            appendRange(source, units, cursor, skipped.nextIndex);
            currentLine = skipped.nextLine;
            cursor = skipped.nextIndex;
            if (!skipped.terminated) {
                builder.diagnostic(
                    'unterminated-raw-string',
                    'Unterminated raw string in preprocessing directive',
                    currentLine,
                    directiveOffset,
                    -1
                );
            }
            continue;
        }

        if (code === 0x22 || code === 0x27) {
            const quoteStart = cursor;
            const skipped = skipQuoted(source, cursor, currentLine);
            // Preserve the token spelling but omit phase-2 splice sequences.
            let copy = quoteStart;
            while (copy < skipped.nextIndex) {
                const continued = spliceLength(source, copy);
                if (continued > 0) {
                    copy += continued;
                    continue;
                }
                if (newlineLength(source, copy) > 0) break;
                units.push(source.at(copy++));
            }
            currentLine = skipped.nextLine;
            cursor = skipped.nextIndex;
            if (!skipped.terminated) {
                builder.diagnostic(
                    'unterminated-string',
                    'Unterminated string or character literal in preprocessing directive',
                    currentLine,
                    directiveOffset,
                    -1
                );
            }
            if (skipped.endedAtNewline) {
                return {
                    text: source.decode(units),
                    nextIndex: cursor,
                    nextLine: currentLine,
                    resumeState: LexicalState.Normal
                };
            }
            continue;
        }

        units.push(code);
        cursor++;
    }

    return {
        text: source.decode(units),
        nextIndex: cursor,
        nextLine: currentLine,
        resumeState: LexicalState.Normal
    };
}

function skipSpaces(text: string, index: number): number {
    while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code !== 0x20 && code !== 0x09 && code !== 0x0b && code !== 0x0c) break;
        index++;
    }
    return index;
}

function unescapeQuotedHeader(path: string): string {
    let result = '';
    for (let index = 0; index < path.length; index++) {
        if (path[index] === '\\' && (path[index + 1] === '\\' || path[index + 1] === '"')) {
            result += path[++index];
        } else {
            result += path[index];
        }
    }
    return result;
}

function classifyIncludeOperand(operand: string): { flags: PreprocessorDirectiveFlags; payload: string } {
    if (operand.startsWith('<')) {
        const closing = operand.indexOf('>', 1);
        if (closing > 0 && operand.slice(closing + 1).trim().length === 0) {
            return {
                flags: PreprocessorDirectiveFlags.IncludeAngled,
                payload: operand.slice(1, closing).trim()
            };
        }
    } else if (operand.startsWith('"')) {
        let escaped = false;
        for (let index = 1; index < operand.length; index++) {
            const char = operand[index];
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                if (operand.slice(index + 1).trim().length === 0) {
                    return {
                        flags: PreprocessorDirectiveFlags.IncludeQuoted,
                        payload: unescapeQuotedHeader(operand.slice(1, index))
                    };
                }
                break;
            }
        }
    }

    return { flags: PreprocessorDirectiveFlags.IncludeMacro, payload: operand };
}

function isFunctionLikeDefine(operand: string): boolean {
    let index = skipSpaces(operand, 0);
    if (!isIdentifierStart(operand.charCodeAt(index))) return false;
    index++;
    while (index < operand.length && isIdentifierContinue(operand.charCodeAt(index))) index++;
    return operand.charCodeAt(index) === 0x28;
}

function addConditionalStart(
    builder: TapeBuilder,
    opcode: PreprocessorDirectiveOpcode,
    payload: string,
    line: number,
    sourceOffset: number
): void {
    const index = builder.add(opcode, PreprocessorDirectiveFlags.None, payload, line, sourceOffset);
    builder.conditionalStack.push({
        opener: index,
        branches: [index],
        lastBranch: index,
        seenElse: false,
        line,
        sourceOffset
    });
}

function addConditionalAlternative(
    builder: TapeBuilder,
    opcode: PreprocessorDirectiveOpcode,
    payload: string | null,
    line: number,
    sourceOffset: number
): void {
    const index = builder.add(opcode, PreprocessorDirectiveFlags.None, payload, line, sourceOffset);
    const frame = builder.conditionalStack[builder.conditionalStack.length - 1];
    if (!frame) {
        builder.diagnostic(
            opcode === PreprocessorDirectiveOpcode.Else ? 'unmatched-else' : 'unmatched-elif',
            `Unmatched #${opcode === PreprocessorDirectiveOpcode.Else ? 'else' : 'elif'}`,
            line,
            sourceOffset,
            index
        );
        return;
    }

    if (opcode === PreprocessorDirectiveOpcode.Else) {
        if (frame.seenElse) {
            builder.diagnostic('duplicate-else', 'Duplicate #else', line, sourceOffset, index);
        }
        frame.seenElse = true;
    } else if (frame.seenElse) {
        builder.diagnostic('elif-after-else', '#elif appears after #else', line, sourceOffset, index);
    }

    builder.jumpIndices[frame.lastBranch] = index;
    frame.lastBranch = index;
    frame.branches.push(index);
}

function addEndif(builder: TapeBuilder, line: number, sourceOffset: number): void {
    const index = builder.add(
        PreprocessorDirectiveOpcode.Endif,
        PreprocessorDirectiveFlags.None,
        null,
        line,
        sourceOffset
    );
    const frame = builder.conditionalStack.pop();
    if (!frame) {
        builder.diagnostic('unmatched-endif', 'Unmatched #endif', line, sourceOffset, index);
        return;
    }

    builder.jumpIndices[frame.lastBranch] = index;
    for (const branch of frame.branches) builder.endIndices[branch] = index;
    builder.jumpIndices[index] = frame.opener;
    builder.endIndices[index] = frame.opener;
}

function recordDirective(
    builder: TapeBuilder,
    directiveText: string,
    line: number,
    sourceOffset: number
): void {
    let index = skipSpaces(directiveText, 0);
    if (index >= directiveText.length) return; // null directive

    const keywordStart = index;
    while (index < directiveText.length && isIdentifierContinue(directiveText.charCodeAt(index))) index++;
    if (index === keywordStart) {
        builder.diagnostic('malformed-directive', 'Expected a preprocessing directive name', line, sourceOffset);
        return;
    }

    const keyword = directiveText.slice(keywordStart, index);
    const operand = directiveText.slice(skipSpaces(directiveText, index)).trim();

    switch (keyword) {
        case 'include':
        case 'include_next':
        case 'import': {
            const include = classifyIncludeOperand(operand);
            const opcode = keyword === 'include'
                ? PreprocessorDirectiveOpcode.Include
                : keyword === 'include_next'
                    ? PreprocessorDirectiveOpcode.IncludeNext
                    : PreprocessorDirectiveOpcode.Import;
            const directiveIndex = builder.add(opcode, include.flags, include.payload, line, sourceOffset);
            if (operand.length === 0) {
                builder.diagnostic('malformed-directive', `#${keyword} requires an operand`, line, sourceOffset, directiveIndex);
            }
            return;
        }

        case 'define': {
            const flags = isFunctionLikeDefine(operand)
                ? PreprocessorDirectiveFlags.FunctionLikeMacro
                : PreprocessorDirectiveFlags.None;
            const directiveIndex = builder.add(PreprocessorDirectiveOpcode.Define, flags, operand, line, sourceOffset);
            if (!isIdentifierStart(operand.charCodeAt(skipSpaces(operand, 0)))) {
                builder.diagnostic('malformed-directive', '#define requires a macro name', line, sourceOffset, directiveIndex);
            }
            return;
        }

        case 'undef':
            builder.add(PreprocessorDirectiveOpcode.Undef, PreprocessorDirectiveFlags.None, operand, line, sourceOffset);
            return;
        case 'if':
            addConditionalStart(builder, PreprocessorDirectiveOpcode.If, operand, line, sourceOffset);
            return;
        case 'ifdef':
            addConditionalStart(builder, PreprocessorDirectiveOpcode.Ifdef, operand, line, sourceOffset);
            return;
        case 'ifndef':
            addConditionalStart(builder, PreprocessorDirectiveOpcode.Ifndef, operand, line, sourceOffset);
            return;
        case 'elif':
            addConditionalAlternative(builder, PreprocessorDirectiveOpcode.Elif, operand, line, sourceOffset);
            return;
        case 'elifdef':
            addConditionalAlternative(builder, PreprocessorDirectiveOpcode.Elifdef, operand, line, sourceOffset);
            return;
        case 'elifndef':
            addConditionalAlternative(builder, PreprocessorDirectiveOpcode.Elifndef, operand, line, sourceOffset);
            return;
        case 'else': {
            const directiveIndexBefore = builder.opcodes.length;
            addConditionalAlternative(builder, PreprocessorDirectiveOpcode.Else, null, line, sourceOffset);
            if (operand.length > 0) {
                builder.diagnostic('malformed-directive', '#else does not accept an operand', line, sourceOffset, directiveIndexBefore);
            }
            return;
        }
        case 'endif': {
            const directiveIndexBefore = builder.opcodes.length;
            addEndif(builder, line, sourceOffset);
            if (operand.length > 0) {
                builder.diagnostic('malformed-directive', '#endif does not accept an operand', line, sourceOffset, directiveIndexBefore);
            }
            return;
        }
        case 'pragma':
            if (operand === 'once') {
                builder.add(
                    PreprocessorDirectiveOpcode.PragmaOnce,
                    PreprocessorDirectiveFlags.None,
                    null,
                    line,
                    sourceOffset
                );
                builder.hasPragmaOnce = true;
                return;
            }
            break;
    }

    const directiveIndex = builder.add(
        PreprocessorDirectiveOpcode.Unknown,
        PreprocessorDirectiveFlags.None,
        operand.length > 0 ? operand : null,
        line,
        sourceOffset
    );
    builder.diagnostic(
        'unknown-directive',
        `Unsupported preprocessing directive #${keyword}`,
        line,
        sourceOffset,
        directiveIndex,
        'warning'
    );
}

/**
 * Scan C/C++ preprocessing directives without decoding or normalizing the full
 * source file. Buffer offsets are byte offsets; string offsets are UTF-16 code
 * unit offsets.
 */
export function scanPreprocessorDirectives(source: Buffer | string): PreprocessorDirectiveTape {
    const view = new SourceView(source);
    const builder = new TapeBuilder();
    // Buffer.lastIndexOf runs in native code. Once the final possible #/%:
    // introducer has been classified, ordinary data tails cannot create a
    // preprocessing directive and do not need a JavaScript byte walk.
    const lastPotentialIntroducer = Math.max(
        view.lastIndexOfAscii('#'),
        view.lastIndexOfAscii('%:')
    );
    let index = 0;
    let line = 1;
    let state = LexicalState.Normal;
    let lineHasPPToken = false;

    if (view.isBuffer
        && view.at(0) === 0xef && view.at(1) === 0xbb && view.at(2) === 0xbf) {
        index = 3;
    } else if (!view.isBuffer && view.at(0) === 0xfeff) {
        index = 1;
    }

    if (lastPotentialIntroducer < index) {
        return builder.finalize();
    }

    while (index < view.length) {
        if (index > lastPotentialIntroducer) break;
        if (state === LexicalState.LineComment) {
            const code = view.at(index);
            if (code === 0x5c) {
                const splice = spliceLength(view, index);
                if (splice > 0) {
                    index += splice;
                    line++;
                    continue;
                }
            }
            if (code === 0x0a || code === 0x0d) {
                const nl = code === 0x0d && view.at(index + 1) === 0x0a ? 2 : 1;
                index += nl;
                line++;
                lineHasPPToken = false;
                state = LexicalState.Normal;
            } else {
                index++;
            }
            continue;
        }

        if (state === LexicalState.BlockComment) {
            const code = view.at(index);
            if (code === 0x5c) {
                const splice = spliceLength(view, index);
                if (splice > 0) {
                    index += splice;
                    line++;
                    continue;
                }
            }
            if (code === 0x2a && view.at(index + 1) === 0x2f) {
                index += 2;
                state = LexicalState.Normal;
                continue;
            }
            if (code === 0x0a || code === 0x0d) {
                const nl = code === 0x0d && view.at(index + 1) === 0x0a ? 2 : 1;
                index += nl;
                line++;
                lineHasPPToken = false;
            } else {
                index++;
            }
            continue;
        }

        const code = view.at(index);
        if (code === 0x5c) {
            const splice = spliceLength(view, index);
            if (splice > 0) {
                index += splice;
                line++;
                continue;
            }
        }

        if (code === 0x0a || code === 0x0d) {
            const nl = code === 0x0d && view.at(index + 1) === 0x0a ? 2 : 1;
            index += nl;
            line++;
            lineHasPPToken = false;
            continue;
        }

        if (code === 0x2f && view.at(index + 1) === 0x2f) {
            index += 2;
            state = LexicalState.LineComment;
            continue;
        }
        if (code === 0x2f && view.at(index + 1) === 0x2a) {
            index += 2;
            state = LexicalState.BlockComment;
            continue;
        }

        if (!lineHasPPToken && isHorizontalWhitespace(code)) {
            index++;
            continue;
        }

        const introducerLength = !lineHasPPToken
            ? (code === 0x23 ? 1 : code === 0x25 && view.at(index + 1) === 0x3a ? 2 : 0)
            : 0;
        if (introducerLength > 0) {
            const directiveLine = line;
            const directiveOffset = index;
            const collected = collectDirective(
                view,
                index + introducerLength,
                line,
                builder,
                directiveOffset
            );
            recordDirective(builder, collected.text, directiveLine, directiveOffset);
            index = collected.nextIndex;
            line = collected.nextLine;
            state = collected.resumeState;
            lineHasPPToken = false;
            continue;
        }

        const raw = (code === 0x52 || code === 0x75 || code === 0x55 || code === 0x4c)
            ? tryRawStringStart(view, index)
            : null;
        if (raw) {
            lineHasPPToken = true;
            const skipped = skipRawString(view, raw, line);
            if (!skipped.terminated) {
                builder.diagnostic(
                    'unterminated-raw-string',
                    'Unterminated raw string literal',
                    line,
                    index
                );
            }
            index = skipped.nextIndex;
            line = skipped.nextLine;
            continue;
        }

        if (code === 0x22 || code === 0x27) {
            lineHasPPToken = true;
            const skipped = skipQuoted(view, index, line);
            if (!skipped.terminated) {
                builder.diagnostic(
                    'unterminated-string',
                    'Unterminated string or character literal',
                    line,
                    index,
                    -1,
                    'warning'
                );
            }
            index = skipped.nextIndex;
            line = skipped.nextLine;
            if (skipped.endedAtNewline) lineHasPPToken = false;
            continue;
        }

        lineHasPPToken = true;
        index++;
    }

    if (state === LexicalState.BlockComment && index >= view.length) {
        builder.diagnostic(
            'unterminated-comment',
            'Unterminated block comment',
            line,
            Math.max(index - 1, 0),
            -1,
            'warning'
        );
    }

    return builder.finalize();
}
