import fs from 'fs';
import path from 'path';
import type { ArduinoProperties } from './ArduinoPropertyFile';

export interface ArduinoUploadCommand {
  command: string;
  toolName: string;
  use1200bpsTouch: boolean;
  waitForUploadPort: boolean;
}

export interface ArduinoUploadCommandSource {
  board: Readonly<ArduinoProperties>;
  platform: Readonly<ArduinoProperties>;
}

export interface ArduinoUploadCommandResolveOptions {
  onWarning?: (message: string) => void;
}

const SERIAL_PLACEHOLDERS: Readonly<Record<string, string>> = {
  'serial.port': '${serial}',
  'serial.port.file': '${serial}',
  'serial.port.label': '${serial}'
};

function parseArduinoBoolean(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function reportUnavailableUploadCommand(
  reason: string,
  options: ArduinoUploadCommandResolveOptions
): undefined {
  options.onWarning?.(
    `Upload command is unavailable: ${reason}. Preprocessing will continue without upload metadata.`
  );
  return undefined;
}

function resolveBundledRuntimeToolPath(
  propertyKey: string,
  platform: Readonly<ArduinoProperties>
): string | undefined {
  const match = propertyKey.match(/^runtime\.tools\.([^.]+)\.path$/);
  const platformPath = platform['runtime.platform.path'];
  if (!match || !platformPath) {
    return undefined;
  }

  const toolRoot = path.join(platformPath, 'tools', match[1]);
  if (!fs.existsSync(toolRoot)) {
    return undefined;
  }

  const versionDirectories = fs.readdirSync(toolRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  return versionDirectories.length > 0
    ? path.join(toolRoot, versionDirectories[0])
    : toolRoot;
}

/**
 * Resolve the selected board's Arduino upload recipe during preprocessing.
 *
 * Arduino tool recipes use a scoped shorthand: `{path}` inside
 * `tools.<tool>.upload.pattern` refers to `tools.<tool>.path`. The generic
 * platform property resolver intentionally does not guess that scope, so the
 * upload recipe is finalized here while the selected board and tool are known.
 * Only serial-port placeholders survive because the port is selected later by
 * the application at upload time. Callers that treat upload metadata as
 * optional can provide `onWarning`; unresolved upload-only properties are then
 * reported without interrupting preprocessing.
 */
export function resolveArduinoUploadCommand(
  arduinoConfig: ArduinoUploadCommandSource,
  options: ArduinoUploadCommandResolveOptions = {}
): ArduinoUploadCommand | undefined {
  const board = arduinoConfig?.board || {};
  const platform = arduinoConfig?.platform || {};
  const configuredToolName = board['upload.tool.default'] || board['upload.tool'];
  if (!configuredToolName) {
    return reportUnavailableUploadCommand(
      'the board does not define upload.tool.default or upload.tool',
      options
    );
  }
  // Arduino permits package-qualified tool references such as
  // `sandeepmistry:openocd`; platform.txt still declares the recipe as
  // `tools.openocd.*` in the active platform.
  const toolName = configuredToolName.split(':').pop() || configuredToolName;

  const toolPrefix = `tools.${toolName}.`;
  const patternKey = `${toolPrefix}upload.pattern`;
  const pattern = platform[patternKey];
  if (!pattern) {
    return reportUnavailableUploadCommand(
      `the platform does not define ${patternKey}`,
      options
    );
  }

  const specialValues: Readonly<Record<string, string>> = {
    ...SERIAL_PLACEHOLDERS,
    'serial.port.protocol': board['upload.protocol'] || '',
    'upload.verbose': platform[`${toolPrefix}upload.params.verbose`] || '',
    'upload.quiet': platform[`${toolPrefix}upload.params.quiet`] || '',
    'upload.verify': platform[`${toolPrefix}upload.params.verify`] || ''
  };

  let command = pattern;
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    command = command.replace(/\{([^{}]+)\}/g, (match, rawKey: string) => {
      const key = rawKey.trim();
      let replacement: string | undefined;

      if (Object.prototype.hasOwnProperty.call(specialValues, key)) {
        replacement = specialValues[key];
      } else {
        replacement = platform[`${toolPrefix}${key}`]
          ?? board[key]
          ?? platform[key]
          ?? resolveBundledRuntimeToolPath(key, platform);
      }

      if (replacement === undefined || replacement === null) {
        return match;
      }
      changed = true;
      return String(replacement);
    });

    if (!changed) {
      break;
    }
  }

  command = command.trim().replace(/;+$/, '').trim();
  if (!command) {
    return reportUnavailableUploadCommand(
      `${patternKey} resolves to an empty command`,
      options
    );
  }

  const unresolvedProperties = [...command.matchAll(/\{([^{}]+)\}/g)]
    .map(match => match[1])
    // OpenOCD recipes intentionally use literal braces around a resolved
    // firmware path (for example `program {{build.path}/app.hex}`). Once the
    // inner Arduino properties are expanded, the remaining value contains a
    // path separator and is no longer an Arduino property placeholder.
    .filter(key => /^[A-Za-z0-9_.:-]+$/.test(key))
    // `${serial}` is the only application-time placeholder in the contract.
    .filter(key => key !== 'serial');
  if (unresolvedProperties.length > 0) {
    const uniqueUnresolvedProperties = [...new Set(unresolvedProperties)];
    if (!options.onWarning) {
      throw new Error(
        `上传命令仍包含未解析属性: ${uniqueUnresolvedProperties.join(', ')}`
      );
    }
    return reportUnavailableUploadCommand(
      `${patternKey} contains unresolved properties: ${uniqueUnresolvedProperties.join(', ')}`,
      options
    );
  }

  return {
    command,
    toolName,
    use1200bpsTouch: parseArduinoBoolean(board['upload.use_1200bps_touch']),
    waitForUploadPort: parseArduinoBoolean(board['upload.wait_for_upload_port'])
  };
}
