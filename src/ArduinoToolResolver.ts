import os from 'node:os';
import path from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { glob } from 'glob';
import type { ArduinoProperties } from './ArduinoPropertyFile';
import { expandArduinoProperty } from './ArduinoPropertyResolver';

/** Parameters that locate an Arduino package's tool directory. */
export interface ArduinoToolLocation {
    /** Optional aily-project tool directory. When present, it takes precedence. */
    toolsPath?: string;
    /** Arduino package name used by the standard Arduino15 directory layout. */
    packageName: string;
    /** Arduino15 root used when no custom tools directory is supplied. */
    arduino15BasePath: string;
}

/** Parameters used to locate one installed Arduino tool. */
export interface FindArduinoToolPathOptions extends ArduinoToolLocation {
    /** Tool name without an embedded version suffix. */
    toolName: string;
    /** Optional version requested by the platform metadata. */
    version?: string;
}

export interface ResolveArduinoToolPathsOptions extends ArduinoToolLocation {
    /** Raw platform properties whose values may reference runtime tools. */
    platformProperties: Readonly<ArduinoProperties>;
    /** Board properties used to expand dynamic tool identifiers. */
    boardProperties?: Readonly<ArduinoProperties>;
    /** Explicit tool versions keyed by versionless tool name. */
    toolVersions?: Readonly<ArduinoProperties>;
    /** Receives discovery errors; already-resolved paths are preserved unless a selected tool is unreadable. */
    onWarning?: (message: string) => void;
}

/** A selected tool cannot safely be used; discovery must not report partial success. */
export class ArduinoSelectedToolPathError extends Error {
    readonly code = 'ARDUINO_SELECTED_TOOL_PATH_UNREADABLE';

    constructor(readonly selectedPath: string, readonly cause: unknown) {
        super(`The selected Arduino tool is unavailable: ${selectedPath}`);
        this.name = 'ArduinoSelectedToolPathError';
    }
}

/**
 * Returns the Arduino15 root used by the legacy parser on the requested host.
 * Every non-Windows host intentionally uses the macOS-style path to preserve
 * the parser's existing behavior; callers can pass another root explicitly.
 */
export function getDefaultArduino15BasePath(
    runtimePlatform: NodeJS.Platform = os.platform(),
    homeDirectory: string = os.homedir()
): string {
    return runtimePlatform === 'win32'
        ? path.join(homeDirectory, 'AppData', 'Local', 'Arduino15')
        : path.join(homeDirectory, 'Library', 'Arduino15');
}

/**
 * Removes the version-like suffix that starts at the first hyphen-delimited
 * segment beginning with a digit.
 */
export function stripToolVersion(toolId: string): string {
    const parts = toolId.split('-');
    for (let index = 1; index < parts.length; index++) {
        if (/^\d/.test(parts[index])) {
            return parts.slice(0, index).join('-');
        }
    }
    return toolId;
}

/**
 * Converts a host path to the forward-slash form accepted consistently by
 * glob on Windows and POSIX hosts.
 */
export function toGlobPath(value: string): string {
    return value.replace(/\\/g, '/');
}

/**
 * Selects a path using the parser's existing version rule. A requested
 * version is considered only when multiple candidates exist and is matched
 * against the suffix following `@`; otherwise the first candidate wins.
 */
export function selectToolMatch(
    candidates: readonly string[],
    version: string = ''
): string | null {
    if (candidates.length === 0) {
        return null;
    }

    if (candidates.length > 1 && version) {
        const versionMatch = candidates.find(candidate => {
            const candidateVersion = path.basename(candidate).split('@')[1];
            return candidateVersion === version;
        });
        if (versionMatch) {
            return versionMatch;
        }
    }

    return candidates[0];
}

/**
 * Resolves the directory searched for tools. A custom aily-project tools
 * directory takes precedence over the standard Arduino15 package layout.
 */
export function resolveArduinoToolsBasePath(location: ArduinoToolLocation): string {
    if (location.toolsPath) {
        return location.toolsPath;
    }

    return path.join(
        location.arduino15BasePath,
        'packages',
        location.packageName,
        'tools'
    );
}

/**
 * Finds an installed Arduino tool without reading process-global state.
 * Search order is exact `tool@version`, exact traditional `tool/version`,
 * fuzzy names in the `name@version` layout, then fuzzy traditional directory
 * names. Within a matching pattern, the existing version-selection and
 * first-item fallback semantics are preserved. Returns `null` when no
 * candidate exists. A selected directory must exist and be readable; its
 * physical location avoids repeated junction traversal during compilation.
 */
export async function findArduinoToolPath(
    options: FindArduinoToolPathOptions
): Promise<string | null> {
    const toolsBasePath = resolveArduinoToolsBasePath(options);
    const exactPatterns = [
        path.join(toolsBasePath, `${options.toolName}@*`),
        path.join(toolsBasePath, options.toolName, '*')
    ];
    const fuzzyPatterns = [
        path.join(toolsBasePath, `*${options.toolName}@*`),
        path.join(toolsBasePath, `*${options.toolName}*`, '*')
    ];

    for (const pattern of [...exactPatterns, ...fuzzyPatterns]) {
        const candidates = await glob(toGlobPath(pattern), { absolute: true });
        const match = selectToolMatch(candidates, options.version);
        if (match) {
            try {
                const physicalPath = await realpath(match);
                await access(physicalPath, constants.R_OK);
                if (!(await stat(physicalPath)).isDirectory()) {
                    throw new TypeError('The selected Arduino tool is not a directory.');
                }
                return physicalPath;
            } catch (error) {
                throw new ArduinoSelectedToolPathError(match, error);
            }
        }
    }

    return null;
}

/**
 * Resolve every `runtime.tools.<name>.path` reference used by a platform.
 *
 * Tool references are discovered from property values in source insertion
 * order. Dynamic identifiers such as `runtime.tools.{build.tarch}-gcc.path`
 * are expanded from board properties. The returned map contains real paths,
 * inputs and process state are not modified, and duplicate references are
 * resolved only once.
 */
export async function resolveArduinoToolPaths(
    options: ResolveArduinoToolPathsOptions
): Promise<ArduinoProperties> {
    const result: ArduinoProperties = {};
    const seen = new Set<string>();
    const templateProperties = { ...(options.boardProperties || {}) };
    if (!templateProperties['build.chip_variant'] && templateProperties['build.mcu']) {
        templateProperties['build.chip_variant'] = templateProperties['build.mcu'];
    }

    try {
        for (const value of Object.values(options.platformProperties)) {
            const toolReference = /runtime\.tools\.([^\s=]+?)\.path/g;
            let match: RegExpExecArray | null;
            while ((match = toolReference.exec(value)) !== null) {
                const toolId = expandArduinoProperty(match[1], templateProperties);
                if (!toolId || toolId.includes('{')) {
                    continue;
                }

                const fullKey = `runtime.tools.${toolId}.path`;
                if (seen.has(fullKey)) {
                    continue;
                }
                seen.add(fullKey);

                const baseName = stripToolVersion(toolId);
                const toolPath = await findArduinoToolPath({
                    toolName: baseName,
                    version: options.toolVersions?.[baseName] || '',
                    toolsPath: options.toolsPath,
                    packageName: options.packageName,
                    arduino15BasePath: options.arduino15BasePath
                });
                if (toolPath) {
                    result[fullKey] = toolPath;
                }
            }
        }
    } catch (error) {
        options.onWarning?.(`解析工具路径失败: ${error}`);
        if (error instanceof ArduinoSelectedToolPathError) {
            throw error;
        }
    }

    return result;
}
