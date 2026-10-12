import {
  BuildTargetSelection,
  isSafeArduinoPlatformVersion,
  isSafeResolvedBuildProperty,
  RESOLVED_BUILD_PROPERTY_KEYS,
  MAX_RESOLVED_BUILD_PROPERTIES_BYTES,
} from './BuildInputRecord';

/** Project only normal Parser output. No SDK reads, MCU guessing, simulation
 * package lookup, or cache identity are introduced here. Missing/unsafe facts
 * stay missing so ordinary compilation remains independent of simulation. */
export function projectResolvedBuildTargetSelection(options: {
  requestedFqbn: string;
  effectiveFqbn: string;
  packageName: string;
  architecture: string;
  selectedMenus: ReadonlyMap<string, string>;
  resolvedProperties: Readonly<Record<string, string>>;
}): BuildTargetSelection {
  const facts: Record<string, string> = {};
  for (const key of RESOLVED_BUILD_PROPERTY_KEYS) {
    const value = options.resolvedProperties[key];
    if (!isSafeResolvedBuildProperty(value)) continue;
    facts[key] = value;
    if (Buffer.byteLength(JSON.stringify(facts)) > MAX_RESOLVED_BUILD_PROPERTIES_BYTES) delete facts[key];
  }
  const version = options.resolvedProperties.version;
  return {
    schemaVersion: 1,
    requestedFqbn: options.requestedFqbn,
    effectiveFqbn: options.effectiveFqbn,
    menuOptions: Object.fromEntries(Array.from(options.selectedMenus)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    platform: { package: options.packageName, architecture: options.architecture,
      version: isSafeArduinoPlatformVersion(version) ? version : null },
    resolvedBuildProperties: facts,
  };
}
