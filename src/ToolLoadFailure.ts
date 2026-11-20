export type ToolLoadStage = 'prebuild' | 'compile' | 'objcopy' | 'upload' | 'recipe';

export interface ToolLoadFailure {
  version: 1;
  code: 'TOOL_LOAD_PYTHON_DLL' | 'TOOL_LOAD_XTENSA_CONFIG';
  stage: ToolLoadStage;
  executable?: string;
  resource?: string;
  win32Error?: number;
}

export function reportToolLoadFailure(failure: ToolLoadFailure): void {
  process.stderr.write(`\n[AILY_TOOL_LOAD_FAILURE] ${JSON.stringify(failure)}\n`);
}
