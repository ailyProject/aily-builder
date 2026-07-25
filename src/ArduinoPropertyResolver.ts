import type { ArduinoProperties } from './ArduinoPropertyFile';

export const ARDUINO_PROPERTY_EXPANSION_PASSES = 10;

export type ArduinoPropertyValue = string | number | boolean | null | undefined;

export type ArduinoPropertySource =
  | ReadonlyMap<string, ArduinoPropertyValue>
  | Readonly<Record<string, ArduinoPropertyValue>>;

export interface ResolveArduinoPropertyOptions {
  /** Maximum whole-map passes. Defaults to Arduino's conventional ten passes. */
  maxPasses?: number;
  /** Maximum expanded value length before treating a reference as circular. */
  maxValueLength?: number;
  /** Receives diagnostics without coupling the resolver to a logger. */
  onWarning?: (message: string) => void;
}

export interface ResolveArduinoPlatformPropertyOptions {
  platformProperties: Readonly<ArduinoProperties>;
  boardProperties?: Readonly<ArduinoProperties>;
  generatedProperties?: Readonly<ArduinoProperties>;
  onWarning?: (message: string) => void;
}

function normalizeArduinoProperties(properties: ArduinoPropertySource): Map<string, string> {
  const normalized = new Map<string, string>();
  const entries = properties instanceof Map
    ? properties.entries()
    : Object.entries(properties);

  for (const [key, value] of entries) {
    normalized.set(key, value == null ? '' : String(value));
  }
  return normalized;
}

/**
 * Expand `{property}` markers using Arduino's repeated property substitution.
 * Unknown markers remain unchanged, input properties are never mutated, and
 * expansion stops after ten passes by default to bound circular references.
 */
export function expandArduinoProperty(
  input: string,
  properties: ArduinoPropertySource,
  maxPasses = ARDUINO_PROPERTY_EXPANSION_PASSES
): string {
  const normalized = normalizeArduinoProperties(properties);
  let result = input;

  for (let pass = 0; pass < maxPasses; pass++) {
    let expanded = result;
    for (const [key, value] of normalized) {
      expanded = expanded.split(`{${key}}`).join(value);
    }

    if (expanded === result) {
      break;
    }
    result = expanded;
  }

  return result;
}

/**
 * Resolve references across a complete Arduino property map.
 *
 * A new object is returned and the input is not modified. Values are revisited
 * because expanding one property can make another resolvable. Direct cycles
 * and values exceeding `maxValueLength` are left at their last safe value and
 * reported through the optional warning callback.
 */
export function resolveArduinoPropertyMap(
  properties: Readonly<ArduinoProperties>,
  options: ResolveArduinoPropertyOptions = {}
): ArduinoProperties {
  const maxPasses = options.maxPasses ?? ARDUINO_PROPERTY_EXPANSION_PASSES;
  const maxValueLength = options.maxValueLength ?? 500_000;
  const resolved: ArduinoProperties = { ...properties };
  const circularProperties = new Set<string>();
  let changed = true;
  let pass = 0;

  while (changed && pass < maxPasses) {
    changed = false;
    pass++;

    for (const key of Object.keys(resolved)) {
      if (circularProperties.has(key)) {
        continue;
      }

      const original = resolved[key];
      if (!original) {
        continue;
      }

      if (original.includes(`{${key}}`)) {
        circularProperties.add(key);
        options.onWarning?.(`检测到直接循环引用: ${key}`);
        continue;
      }

      const expanded = expandArduinoProperty(original, resolved);
      if (expanded.length > maxValueLength) {
        circularProperties.add(key);
        options.onWarning?.(`检测到可能的间接循环引用: ${key}`);
        continue;
      }

      if (expanded !== original) {
        resolved[key] = expanded;
        changed = true;
      }
    }
  }

  if (pass >= maxPasses && changed) {
    options.onWarning?.(`变量解析达到最大迭代次数 ${maxPasses}`);
  }

  return resolved;
}

/**
 * Merge and expand one complete Arduino platform property set.
 *
 * Platform properties establish key order. Missing values are filled first
 * from board properties and then generated runtime properties; board values
 * subsequently override platform keys, matching the legacy parser. The input
 * objects are not modified and diagnostics are forwarded through `onWarning`.
 */
export function resolveArduinoPlatformProperties(
  options: ResolveArduinoPlatformPropertyOptions
): ArduinoProperties {
  const platformProperties: ArduinoProperties = { ...options.platformProperties };
  const boardProperties = options.boardProperties || {};
  const generatedProperties = options.generatedProperties || {};

  if (Object.prototype.hasOwnProperty.call(platformProperties, 'compiler.libraries.ldflags')
      && !platformProperties['compiler.libraries.ldflags'].includes('%LD_FLAGS%')) {
    platformProperties['compiler.libraries.ldflags'] =
      `%LD_FLAGS%${platformProperties['compiler.libraries.ldflags']}`;
  }

  for (const source of [boardProperties, generatedProperties]) {
    for (const [key, value] of Object.entries(source)) {
      if (!platformProperties[key]) {
        platformProperties[key] = value;
      }
    }
  }

  for (const [key, value] of Object.entries(boardProperties)) {
    if (Object.prototype.hasOwnProperty.call(platformProperties, key)
        && platformProperties[key] !== value) {
      platformProperties[key] = value;
    }
  }

  return resolveArduinoPropertyMap(platformProperties, {
    onWarning: options.onWarning
  });
}
