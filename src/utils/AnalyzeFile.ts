import { promises as fs } from 'fs';
import {
    PreprocessorDirectiveTape,
    PreprocessorScannerDiagnostic,
    scanPreprocessorDirectives
} from './PreprocessorDirectiveScanner';
import {
    DirectiveExecutionOptions,
    PreprocessorExecutionDiagnostic,
    PreprocessorIncludeEvent,
    executeDirectiveTape
} from './PreprocessorDirectiveExecutor';
import type { MacroDefinition } from './PreprocessorExpression';

export type { MacroDefinition } from './PreprocessorExpression';
export type {
    PreprocessorDirectiveTape,
    PreprocessorScannerDiagnostic
} from './PreprocessorDirectiveScanner';
export type {
    PreprocessorExecutionDiagnostic,
    PreprocessorIncludeEvent
} from './PreprocessorDirectiveExecutor';

export type AnalysisDiagnostic =
    | PreprocessorScannerDiagnostic
    | PreprocessorExecutionDiagnostic;

export interface AnalysisOptions {
    throwOnError?: boolean;
    /**
     * Runs synchronously at the include location. Nested files may mutate the
     * supplied macro Map before execution continues in the including file.
     */
    onInclude?: (includePath: string, event?: PreprocessorIncludeEvent) => void;
    onPragmaOnce?: () => void;
    onDiagnostic?: (diagnostic: AnalysisDiagnostic) => void;
    hasInclude?: DirectiveExecutionOptions['hasInclude'];
    /** Reuse a macro-independent scan result in another translation-unit state. */
    tape?: PreprocessorDirectiveTape;
    /**
     * Migration/debug escape hatch. Production dependency analysis should keep
     * this false so an unsupported active construct cannot silently lose edges.
     */
    allowIndeterminate?: boolean;
}

export interface AnalysisResult {
    includes: string[];
    defines: Map<string, MacroDefinition>;
    includeEvents: PreprocessorIncludeEvent[];
    diagnostics: AnalysisDiagnostic[];
    fallbackRequired: boolean;
    pragmaOnce: boolean;
    tape: PreprocessorDirectiveTape;
}

function createFallbackError(
    diagnostics: readonly AnalysisDiagnostic[],
    sourceDescription: string
): Error {
    const first = diagnostics.find(diagnostic => diagnostic.severity === 'error')
        || diagnostics[0];
    const detail = first ? ': ' + first.message : '';
    return new Error(
        'Preprocessor dependency analysis requires a fallback for '
        + sourceDescription
        + detail
    );
}

export function analyzeDirectiveTapeWithDefines(
    tape: PreprocessorDirectiveTape,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {},
    sourceDescription = '<memory>'
): AnalysisResult {
    const execution = executeDirectiveTape(tape, defines, {
        onInclude: (includePath, event) => options.onInclude?.(includePath, event),
        onPragmaOnce: () => options.onPragmaOnce?.(),
        onDiagnostic: diagnostic => options.onDiagnostic?.(diagnostic),
        hasInclude: options.hasInclude
    });
    for (const diagnostic of tape.diagnostics) {
        options.onDiagnostic?.(diagnostic);
    }

    const diagnostics: AnalysisDiagnostic[] = [
        ...tape.diagnostics,
        ...execution.diagnostics
    ];
    if (execution.fallbackRequired
        && !options.allowIndeterminate
        && options.throwOnError !== false) {
        throw createFallbackError(diagnostics, sourceDescription);
    }

    return {
        includes: execution.includes,
        defines,
        includeEvents: execution.includeEvents,
        diagnostics,
        fallbackRequired: execution.fallbackRequired,
        pragmaOnce: execution.pragmaOnce,
        tape
    };
}

export function analyzeSourceWithDefines(
    sourceCode: string | Buffer,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): AnalysisResult {
    const tape = options.tape || scanPreprocessorDirectives(sourceCode);
    return analyzeDirectiveTapeWithDefines(tape, defines, options);
}

export async function analyzeFile(
    filePath: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): Promise<string[]> {
    const result = await analyzeFileWithDefines(filePath, defines, options);
    return result.includes;
}

export async function analyzeFileWithDefines(
    filePath: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): Promise<AnalysisResult> {
    try {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('File path must not be empty');
        }

        const source = await fs.readFile(filePath);
        const tape = options.tape || scanPreprocessorDirectives(source);
        return analyzeDirectiveTapeWithDefines(tape, defines, options, filePath);
    } catch (error) {
        if (options.throwOnError !== false) {
            throw error;
        }

        const tape = options.tape || scanPreprocessorDirectives(Buffer.alloc(0));
        return {
            includes: [],
            defines,
            includeEvents: [],
            diagnostics: [],
            fallbackRequired: true,
            pragmaOnce: false,
            tape
        };
    }
}
