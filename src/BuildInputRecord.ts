import { createHash } from 'node:crypto';

export interface BuildTargetSelection {
  schemaVersion: 1;
  requestedFqbn: string;
  effectiveFqbn: string;
  menuOptions: Record<string, string>;
  /** Arduino platform identity; not an npm SDK identity or content proof. */
  platform: { package: string; architecture: string; version: string | null };
  /** Bounded facts from the final resolved properties consumed by compilation. */
  resolvedBuildProperties: Record<string, string>;
}

export const RESOLVED_BUILD_PROPERTY_KEYS = [
  'build.arch', 'build.board', 'build.boot', 'build.boot_freq', 'build.bootloader_addr',
  'build.chip_variant', 'build.core', 'build.core.version', 'build.cpu', 'build.defines',
  'build.extra_flags', 'build.f_cpu',
  'build.f_crystal', 'build.flash_freq', 'build.flash_length', 'build.flash_mode',
  'build.flash_offset', 'build.flash_size', 'build.flash_total', 'build.float-abi',
  'build.fpu', 'build.hse', 'build.hse_value', 'build.img_freq', 'build.ldscript',
  'build.lse', 'build.lse_value', 'build.mcu', 'build.memory_type', 'build.partitions',
  'build.product_line', 'build.psram', 'build.psram_cs', 'build.psram_freq',
  'build.psram_length', 'build.psram_size', 'build.psram_type', 'build.series', 'build.st_extra_flags',
  'build.target', 'build.variant', 'build.variant.version',
  'upload.maximum_data_size', 'upload.maximum_size',
] as const;
export type ResolvedBuildPropertyKey = typeof RESOLVED_BUILD_PROPERTY_KEYS[number];
export const MAX_RESOLVED_BUILD_PROPERTY_LENGTH = 4096;
export const MAX_RESOLVED_BUILD_PROPERTIES_BYTES = 64 * 1024;
const resolvedBuildPropertyKeys = new Set<string>(RESOLVED_BUILD_PROPERTY_KEYS);

/** Relative SDK variant/script names are facts; machine paths and unresolved
 * property references are not portable target facts. Empty values are retained
 * because an explicitly disabled option is different from missing evidence. */
export function isSafeResolvedBuildProperty(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_RESOLVED_BUILD_PROPERTY_LENGTH
    && !/[\x00-\x1f\x7f{}]/.test(value) && !/%[A-Za-z0-9_]+%/.test(value)
    && !/[A-Za-z]:[\\/]|\\\\|(?:^|[^A-Za-z0-9_.\/-]|-[ILTB])\//.test(value)
    && !/(?:^|[^A-Za-z0-9_.-]|-[ILTB])\.\.(?:[\\/]|$)/.test(value);
}

export function isSafeArduinoPlatformVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(value);
}

export interface BuildInputRecord {
  schemaVersion: 1;
  kind: 'aily-build-input-record';
  scope: 'build-graph-facts';
  configurationSha256: string;
  /** Absent when the supplied parsed configuration did not record selection. */
  targetSelection?: BuildTargetSelection;
  steps: Array<{ kind: 'ninja-plan' | 'recipe-run'; name: string; sha256: string; commandCount?: number }>;
  digest: string;
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'BUILD_INPUT_RECORD_INVALID' });
};
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}

export function normalizeBuildTargetSelection(value: BuildTargetSelection): BuildTargetSelection {
  const plain = (item: unknown) => item && typeof item === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(item));
  const identifier = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/;
  const menuIdentifier = /^[A-Za-z0-9_-]{1,128}$/;
  if (!plain(value) || Object.keys(value).some(key => !['schemaVersion', 'requestedFqbn', 'effectiveFqbn',
    'menuOptions', 'platform', 'resolvedBuildProperties'].includes(key)) || value.schemaVersion !== 1
    || typeof value.requestedFqbn !== 'string' || value.requestedFqbn.split(':').length !== 3
    || !value.requestedFqbn.split(':').every(part => identifier.test(part))
    || typeof value.effectiveFqbn !== 'string' || value.effectiveFqbn.length > 16 * 1024
    || !plain(value.menuOptions) || !plain(value.platform) || !plain(value.resolvedBuildProperties)) {
    fail('Invalid target selection.');
  }
  const menus = Object.entries(value.menuOptions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (menus.length > 64 || menus.some(([key, option]) => !menuIdentifier.test(key)
    || typeof option !== 'string' || !menuIdentifier.test(option))) fail('Invalid target selection menus.');
  const choices = value.effectiveFqbn === value.requestedFqbn ? []
    : value.effectiveFqbn.startsWith(`${value.requestedFqbn}:`)
      ? value.effectiveFqbn.slice(value.requestedFqbn.length + 1).split(',') : [];
  if (choices.length !== menus.length || !menus.every(([key, option]) => choices.includes(`${key}=${option}`))
    || (menus.length === 0 && value.effectiveFqbn !== value.requestedFqbn)) fail('Inconsistent target selection.');
  const [packageName, architecture] = value.requestedFqbn.split(':');
  if (Object.keys(value.platform).some(key => !['package', 'architecture', 'version'].includes(key))
    || value.platform.package !== packageName || value.platform.architecture !== architecture
    || (value.platform.version !== null && !isSafeArduinoPlatformVersion(value.platform.version))) {
    fail('Invalid target selection platform.');
  }
  const facts = Object.entries(value.resolvedBuildProperties).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (facts.some(([key, property]) => !resolvedBuildPropertyKeys.has(key) || !isSafeResolvedBuildProperty(property))
    || Buffer.byteLength(JSON.stringify(value.resolvedBuildProperties)) > MAX_RESOLVED_BUILD_PROPERTIES_BYTES) {
    fail('Invalid resolved build properties.');
  }
  return { schemaVersion: 1, requestedFqbn: value.requestedFqbn, effectiveFqbn: value.effectiveFqbn,
    menuOptions: Object.fromEntries(menus),
    platform: { package: packageName, architecture, version: value.platform.version },
    resolvedBuildProperties: Object.fromEntries(facts) };
}

/** Observe existing build facts, never scan inputs or change compilation/cache
 * policy. A Ninja plan includes cached/up-to-date edges, not proof that every
 * command ran. Recipe commands are recorded only after successful execution.
 * Digests identify metadata; they do NOT prove source/SDK bytes or freshness.
 */
export class BuildInputRecording {
  private readonly configurationSha256: string;
  private readonly targetSelection?: BuildTargetSelection;
  private readonly steps: BuildInputRecord['steps'] = [];
  private finished = false;

  constructor(configuration: unknown, targetSelection?: BuildTargetSelection) {
    const encoded = JSON.stringify(stable(configuration));
    if (!encoded || Buffer.byteLength(encoded) > 16 * 1024 * 1024) fail('Build configuration exceeds record budget.');
    this.configurationSha256 = sha(encoded);
    if (targetSelection !== undefined) this.targetSelection = normalizeBuildTargetSelection(targetSelection);
  }

  recordNinja(stage: string, graph: Buffer): void {
    const expected = ['sketch', 'libraries', 'core', 'linking'];
    const count = this.steps.filter(step => step.kind === 'ninja-plan').length;
    if (stage !== expected[count] || !graph.length || graph.length > 8 * 1024 * 1024) fail('Invalid Ninja plan record.');
    this.append({ kind: 'ninja-plan', name: stage, sha256: sha(graph) });
  }

  recordRecipes(group: string, commands: string[]): void {
    if (!commands.length) return;
    const encoded = JSON.stringify(commands);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) fail('Recipe record exceeds budget.');
    this.append({ kind: 'recipe-run', name: group, sha256: sha(encoded), commandCount: commands.length });
  }

  finish(): BuildInputRecord {
    if (this.finished || this.steps.filter(step => step.kind === 'ninja-plan').length !== 4) {
      fail('Cannot publish an incomplete or already finalized build record.');
    }
    this.finished = true;
    const body = { schemaVersion: 1 as const, kind: 'aily-build-input-record' as const,
      scope: 'build-graph-facts' as const, configurationSha256: this.configurationSha256,
      ...(this.targetSelection ? { targetSelection: normalizeBuildTargetSelection(this.targetSelection) } : {}),
      steps: this.steps.map(step => ({ ...step })) };
    return { ...body, digest: sha(JSON.stringify(body)) };
  }

  private append(step: BuildInputRecord['steps'][number]): void {
    if (this.finished || this.steps.length >= 128 || !step.name || step.name.length > 256) fail('Invalid build record step.');
    this.steps.push(step);
  }
}
