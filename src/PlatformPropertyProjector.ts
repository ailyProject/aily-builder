import { parseArduinoHostPropertyKey } from './utils/HostPlatform';

export type PlatformProperties = Readonly<Record<string, string>>;

/**
 * Properties read directly after ArduinoConfigParser has finished resolving the
 * platform. Keep this list small: intermediate properties referenced by these
 * values are added automatically by collectReferenceClosure().
 */
const DIRECT_BUILD_PROPERTY_KEYS = new Set([
  'compiler.path',
  'compiler.c.cmd',
  'compiler.cpp.cmd',
  'compiler.ar.cmd',
  'compiler.size.cmd',
  'compiler.c.elf.cmd',
  'compiler.c.elf.flags',
  'compiler.c.elf.extra_flags',
  'compiler.c.flags',
  'compiler.cpp.flags',
  'compiler.S.flags',
  'compiler.ldflags',
  'compiler.libraries.ldflags',
  'compiler.libbearssl',
  'compiler.sdk.path',
  'runtime.platform.path',
  'upload.maximum_size',
  'upload.maximum_data_size',
]);

function isCurrentBuildRoot(key: string): boolean {
  if (parseArduinoHostPropertyKey(key)) {
    return false;
  }

  return DIRECT_BUILD_PROPERTY_KEYS.has(key)
    // Archive cache board signatures intentionally include every effective
    // build property, so the complete build.* group is live data.
    || key.startsWith('build.')
    // Tool package identities are discovered from these paths dynamically.
    || key.startsWith('runtime.tools.')
    // Saved preprocess results are also the upload contract consumed by
    // aily-blockly. Keep the complete Arduino tool namespace so the selected
    // board's upload/program/debug patterns and vendor-defined helper values
    // remain available after preprocessing.
    || key.startsWith('tools.')
    // Recipes are the executable build contract of a platform. Preserve the
    // complete namespace so vendor-defined phases and future Arduino recipe
    // types do not require another projector whitelist update.
    || key.startsWith('recipe.');
}

function collectReferenceClosure(
  properties: PlatformProperties,
  retainedKeys: Set<string>
): void {
  const pending = [...retainedKeys];
  const referencePattern = /\{([^{}]+)\}/g;

  while (pending.length > 0) {
    const key = pending.pop()!;
    const value = properties[key];
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    referencePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = referencePattern.exec(value)) !== null) {
      const referencedKey = match[1];
      if (!Object.prototype.hasOwnProperty.call(properties, referencedKey)
        || retainedKeys.has(referencedKey)) {
        continue;
      }
      retainedKeys.add(referencedKey);
      pending.push(referencedKey);
    }
  }
}

/**
 * Project the fully resolved platform property bag to the properties consumed
 * by preprocessing, compilation and downstream upload tooling.
 *
 * This deliberately runs after platform/board/local/OS expansion. It removes
 * menu definitions, inactive host variants and unrelated helper properties
 * whose resolved values have already been embedded in live recipes.
 */
export function projectPlatformBuildProperties(
  properties: PlatformProperties
): Record<string, string> {
  const retainedKeys = new Set<string>();

  for (const key of Object.keys(properties)) {
    if (isCurrentBuildRoot(key)) {
      retainedKeys.add(key);
    }
  }

  collectReferenceClosure(properties, retainedKeys);

  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (retainedKeys.has(key)) {
      projected[key] = value;
    }
  }
  return projected;
}
