import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
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
    /** Receives discovery errors while preserving already resolved paths. */
    onWarning?: (message: string) => void;
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

export class RequiredArduinoToolError extends Error {
    constructor(toolName: string, version: string, toolsBasePath: string) {
        super(`Required Arduino tool ${toolName}@${version} was not found in ${toolsBasePath}`);
    }
}

export function isPinnedArduinoToolVersion(version: unknown): version is string {
    return typeof version === 'string' && /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version);
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
 * Pinned requests search supported versioned layouts. Unpinned requests
 * retain the legacy name-based discovery order.
 */
export async function findArduinoToolPath(
    options: FindArduinoToolPathOptions
): Promise<string | null> {
    const toolsBasePath = resolveArduinoToolsBasePath(options);
    if (isPinnedArduinoToolVersion(options.version)) {
        return findPinnedArduinoToolPath(path.resolve(toolsBasePath), options.toolName, options.version);
    }
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
        if (candidates.length > 0) {
            return candidates[0];
        }
    }

    return null;
}

async function findPinnedArduinoToolPath(
    toolsBasePath: string,
    toolName: string,
    version: string
): Promise<string | null> {
    if ([toolName, version].some(part => !/^[\w.+-]+$/.test(part) || part === '.' || part === '..')) {
        return null;
    }
    const names = [toolName, xpackToolAlias(toolName)];
    const stems = names.flatMap(name => [
        path.join(toolsBasePath, `${name}@`),
        path.join(toolsBasePath, name) + path.sep,
        path.join(toolsBasePath, `${name}_`)
    ]);
    for (const stem of stems) {
        const directory = stem + version;
        if ((await stat(directory).catch(() => null))?.isDirectory()) {
            return toGlobPath(directory);
        }
    }

    // Some Pico tool archives retain the upstream distribution revision.
    const picoVersion = version === '4.1.0' && /^(pqt-picotool|pqt-pioasm|pqt-mklittlefs)$/.test(toolName)
        ? '4.1.0-1aec55e'
        : toolName === 'pqt-python3' && version === '1.0.1' ? '1.0.1-base-3a57aed-1' : '';
    if (picoVersion) {
        for (const stem of stems) {
            const directory = stem + picoVersion;
            if ((await stat(directory).catch(() => null))?.isDirectory()) {
                return toGlobPath(directory);
            }
        }
    }

    // Older Arduino distributions append -arduinoN to the upstream release.
    // Some omit the zero patch component (for example, ctags 5.8-arduino11).
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) {
        return null;
    }
    const legacyVersions = [version, version.replace(/^(\d+\.\d+)\.0$/, '$1')];
    for (const legacyVersion of new Set(legacyVersions)) {
        for (const stem of stems) {
            const prefix = stem + legacyVersion + '-arduino';
            const matches = await glob(toGlobPath(prefix + '*'), { absolute: true });
            for (const directory of matches.sort()) {
                if (/^\d+$/.test(path.basename(directory).slice(path.basename(prefix).length))
                    && (await stat(directory).catch(() => null))?.isDirectory()) {
                    return toGlobPath(directory);
                }
            }
        }
    }
    return null;
}

export function xpackToolAlias(toolName: string): string {
    return toolName.startsWith('xpack-') ? toolName.slice('xpack-'.length) : `xpack-${toolName}`;
}

export async function resolveRequiredArduinoToolPath(
    options: FindArduinoToolPathOptions
): Promise<string | null> {
    const toolPath = await findArduinoToolPath(options);
    if (!toolPath && isPinnedArduinoToolVersion(options.version)) {
        throw new RequiredArduinoToolError(
            options.toolName, options.version, resolveArduinoToolsBasePath(options)
        );
    }
    return toolPath;
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
                const alternateName = xpackToolAlias(baseName);
                const requestedName = options.toolVersions?.[baseName] ? baseName
                    : options.toolVersions?.[alternateName] ? alternateName : baseName;
                const toolPath = await resolveRequiredArduinoToolPath({
                    toolName: requestedName,
                    version: options.toolVersions?.[requestedName] || '',
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
        if (error instanceof RequiredArduinoToolError) {
            throw error;
        }
        options.onWarning?.(`解析工具路径失败: ${error}`);
    }

    return result;
}
