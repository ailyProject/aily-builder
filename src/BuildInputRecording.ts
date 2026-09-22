import { createHash } from 'crypto';
import fs from 'node:fs/promises';
import { BuildInputRecord, BuildInputSelection, BuildInputSnapshot, captureBuildInputs, confirmBuildInputs } from './BuildInputRecord';
import { capturePackageInputs, confirmPackageInputs, confirmPackageInputState, type PackageInputSelection, type PackageInputSnapshot } from './PackageBuildInputs';
import type { BuildInputContext } from './BuildInputVerification';

const PHASES = ['sketch', 'libraries', 'core', 'link', 'objcopy'] as const;
export type BuildInputPhase = typeof PHASES[number];
const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'BUILD_INPUTS_CHANGED' }); };

// Hooks own response-file transitions, not project trees, tools or SDK link inputs.
// Each action is checked BEFORE its posthook can restore a transient input.
function fixedInputs(snapshot: BuildInputSnapshot): string {
  const { record, fileStates } = snapshot;
  const fixedFiles = (record.external?.files || []).filter(file => file.roles.some(role => role !== 'response'))
    .map(({ id, ...file }) => ({ ...file, state: fileStates.find(value => value.startsWith(`${id}:`))?.slice(id.length) }))
    .sort((a, b) => a.locationSha256.localeCompare(b.locationSha256));
  return JSON.stringify({ configuration: record.configurationSha256, roots: record.roots,
    states: fileStates.filter(value => !value.startsWith('external-')), fixedFiles, linkSearch: record.external?.linkSearch,
    packages: record.packages });
}

export class BuildInputRecording {
  private readonly phases: NonNullable<BuildInputRecord['phases']> = [];
  private finalSnapshot?: BuildInputSnapshot;
  private finalContext?: BuildInputContext;
  private active = false;

  private constructor(private readonly select: () => BuildInputSelection, private readonly initial: BuildInputSnapshot,
    private readonly packages?: { initial: PackageInputSnapshot; select: () => PackageInputSelection }) {}

  static async open(select: () => BuildInputSelection, selectPackages?: () => PackageInputSelection): Promise<BuildInputRecording> {
    const packages = selectPackages ? { initial: await capturePackageInputs(selectPackages()), select: selectPackages } : undefined;
    const selectBoundInputs = packages ? () => ({ ...select(), packages: packages.initial.record }) : select;
    return new BuildInputRecording(selectBoundInputs, await captureBuildInputs(selectBoundInputs()), packages);
  }

  get inputIdentity(): string { return this.initial.record.digest; }

  private confirmFixed(snapshot: BuildInputSnapshot): void {
    if (fixedInputs(this.initial) !== fixedInputs(snapshot)) fail('Project trees, configuration, tools or SDK link inputs changed across build phases.');
  }

  async beginPhase(name: string): Promise<{ phase: BuildInputPhase; identity: string; confirm: () => Promise<void> }> {
    if (this.active || name !== PHASES[this.phases.length] || this.finalSnapshot) fail('Invalid recorded build phase order.');
    const before = await captureBuildInputs(this.select());
    this.confirmFixed(before);
    this.active = true;
    let confirmed = false;
    return { phase: name as BuildInputPhase, identity: before.record.digest, confirm: async () => {
      if (confirmed || !this.active || name !== PHASES[this.phases.length]) fail('Build phase already confirmed.');
      const verified = await confirmBuildInputs(before, this.select());
      this.phases.push({ phase: name as BuildInputPhase,
        external: verified.external || { scope: 'recipe-response-files-and-tools', files: [] } });
      this.active = false;
      confirmed = true;
    } };
  }

  async finish(): Promise<BuildInputRecord> {
    if (this.active || this.phases.length !== PHASES.length || this.finalSnapshot) fail('Incomplete recorded build phases.');
    if (this.packages) await confirmPackageInputs(this.packages.initial, this.packages.select());
    const selection = JSON.parse(JSON.stringify(this.select())) as BuildInputSelection;
    const snapshot = await captureBuildInputs(selection);
    this.confirmFixed(snapshot);
    this.finalSnapshot = snapshot;
    const { digest: _digest, ...initialBody } = snapshot.record;
    const body = { ...initialBody, phases: this.phases };
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 1024 * 1024) fail('Build phase input record exceeds 1 MiB.');
    const record = { ...body, digest: createHash('sha256').update(encoded).digest('hex') };
    if (this.packages) {
      const packageSelection = this.packages.select();
      const buildPath = await fs.realpath(packageSelection.buildPath);
      this.finalContext = JSON.parse(JSON.stringify({ schemaVersion: 1, kind: 'aily-build-input-context',
        buildPath, preparedInputsDigest: record.digest,
        selection: { ...selection, exclude: await Promise.all(selection.exclude.map(value => fs.realpath(value))) }, snapshot, phases: this.phases,
        packages: { selection: { ...packageSelection, buildPath }, snapshot: this.packages.initial } }));
    }
    return record;
  }

  getVerificationContext(): BuildInputContext {
    if (!this.finalContext) fail('Final SDK/tool input recording is required for consumption verification.');
    return JSON.parse(JSON.stringify(this.finalContext));
  }

  async confirmFinal(): Promise<void> {
    if (!this.finalSnapshot) fail('Build input record has not been finalized.');
    await confirmBuildInputs(this.finalSnapshot, this.select());
    if (this.packages) await confirmPackageInputState(this.packages.initial, this.packages.select());
  }
}
