import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { glob } from 'glob';
import {
  AilyBuilderProgressStage,
  AilyBuilderProgressStatus,
  Logger
} from './utils/Logger';
import { Dependency } from './DependencyAnalyzer';
import { CacheManager, CacheKey } from './CacheManager';
import { NinjaGenerator, NinjaOptions } from './NinjaGenerator';
import { ArchiveCacheFetchResult, ArchiveCacheHit, ArchiveCloudCacheManager, getArchiveDependencyKey } from './ArchiveCloudCacheManager';
import { sanitizeNonAsciiPaths } from './utils/ShortPath';
import { isMacOSHost, isWindowsHost, toHostPathKey } from './utils/HostPlatform';
import { RecipeExecutionResult, RecipeRunner, RecipeRunnerError } from './RecipeRunner';
import {
  collectGeneratedSketchSources,
  GENERATED_SKETCH_DEPENDENCY_NAME,
  getGeneratedSketchSourceRoot
} from './GeneratedSketchSources';

export interface NinjaPipelineOptions {
  dependencies: Dependency[];
  compileConfig: any;
}

export interface NinjaCompilationResult {
  success: boolean;
  outFilePath?: string;
  warnings?: string[];
  buildTime?: number;
  error?: string;
}

interface NinjaStageProgressRange {
  stage: AilyBuilderProgressStage;
  start: number;
  end: number;
  message: string;
}

export class NinjaCompilationPipeline {
  private logger: Logger;
  private dependencies: Dependency[];
  private compileConfig: any;
  private cacheManager: CacheManager;
  private archiveCloudCacheManager: ArchiveCloudCacheManager;
  private ninjaGenerator: NinjaGenerator;
  private readonly arduinoCoreBuildFlag = '-DARDUINO_CORE_BUILD';
  private cacheContextFingerprint = '';
  private lastReportedProgress = -1;
  private lastReportedStage: AilyBuilderProgressStage | undefined;
  private lastReportedStatus: AilyBuilderProgressStatus | undefined;

  constructor(logger: Logger) {
    this.logger = logger;
    this.cacheManager = new CacheManager(logger);
    this.archiveCloudCacheManager = new ArchiveCloudCacheManager(logger);
    this.ninjaGenerator = new NinjaGenerator(logger);
  }

  async compile({ dependencies, compileConfig }: NinjaPipelineOptions): Promise<NinjaCompilationResult> {
    this.dependencies = dependencies;
    this.compileConfig = compileConfig;
    let remoteFetches = new Map<string, Promise<ArchiveCacheFetchResult>>();
    let archiveCacheHits = new Map<string, ArchiveCacheHit>();

    this.lastReportedProgress = -1;
    this.lastReportedStage = undefined;
    this.lastReportedStatus = undefined;
    this.reportProgress('preparing', 1, 'Preparing build');

    try {
      const startTime = Date.now();
      const warnings: string[] = [];
      const buildPath = process.env['BUILD_PATH'] || '';
      const recipeRunner = compileConfig?.arduino?.platform
        ? new RecipeRunner(compileConfig.arduino.platform, {
          cwd: buildPath,
          env: process.env,
          windowsHide: true
        })
        : undefined;

      const ninjaOptions: NinjaOptions = {
        dependencies,
        compileConfig,
        buildPath,
        jobs: parseInt(process.env['BUILD_JOBS'] || '4'),
        archiveCacheHits
      };

      const hasSketchPrebuild = this.hasRecipeGroup(recipeRunner, 'recipe.hooks.sketch.prebuild');
      const hasLibrariesPrebuild = this.hasRecipeGroup(recipeRunner, 'recipe.hooks.libraries.prebuild');
      const hasCorePrebuild = this.hasRecipeGroup(recipeRunner, 'recipe.hooks.core.prebuild');
      const hasLinkPrebuild = this.hasRecipeGroup(recipeRunner, 'recipe.hooks.linking.prelink');
      const dynamicLibrariesPrebuild = hasLibrariesPrebuild;
      const dynamicCorePrebuild = hasCorePrebuild && !this.isKnownArduinoCoreBuildHook(recipeRunner);

      let ninjaFilePath = '';
      // Snapshot before entering the phase because the generic phase runner
      // executes the prehook before its action.
      const sourcesBeforeSketchHook = hasSketchPrebuild
        ? await this.snapshotDependencySources()
        : undefined;
      const sketchSucceeded = await this.runRecipePhase(
        recipeRunner,
        'recipe.hooks.sketch.prebuild',
        'recipe.hooks.sketch.postbuild',
        'Sketch',
        async () => {
          if (sourcesBeforeSketchHook) {
            await this.refreshHookGeneratedSources(sourcesBeforeSketchHook);
            // A sketch hook may use an opaque response file whose contents are
            // not represented in the Ninja command. Sketch objects are small;
            // rebuilding them gives generic hooks correct semantics.
            await this.invalidatePhaseOutputs('sketch');
          }

          // Invalidate build-local objects when generated configuration changes.
          // Cache-key misses alone are insufficient because an old object may
          // already be present in this build directory.
          await this.refreshCacheContextFingerprint();
          await this.invalidateLocalOutputsForChangedContext();

          this.logger.verbose('Checking archive cloud cache for compiled archives...');
          archiveCacheHits = await this.archiveCloudCacheManager.restoreArchives(dependencies, compileConfig);
          this.dropUnsafePhaseArchiveHits(
            archiveCacheHits,
            dynamicLibrariesPrebuild,
            dynamicCorePrebuild
          );
          ninjaOptions.archiveCacheHits = archiveCacheHits;
          remoteFetches = this.archiveCloudCacheManager.startRemoteFetches(archiveCacheHits);

          this.logger.verbose('Checking cache for compiled objects...');
          await this.restoreFromCache(dependencies, archiveCacheHits);

          ninjaFilePath = await this.ninjaGenerator.generateNinjaFile(ninjaOptions);
          this.logger.verbose(`Ninja file generated: ${ninjaFilePath}`);
          return await this.runNinjaStage(
            ninjaFilePath,
            NinjaGenerator.SKETCH_TARGET,
            warnings,
            {
              stage: 'sketch',
              start: 5,
              end: 15,
              message: 'Compiling sketch'
            }
          );
        }
      );

      if (!sketchSucceeded) {
        await this.settleRemoteFetches(remoteFetches);
        return { success: false, warnings, error: 'Sketch compilation failed' };
      }

      // Remote downloads overlap the sketch stage. Settle them before archive
      // phases and transparently regenerate the graph for any failed fetch.
      if (remoteFetches.size > 0) {
        const failedRemoteKeys = await this.collectFailedRemoteFetches(remoteFetches);
        if (failedRemoteKeys.length > 0) {
          for (const key of failedRemoteKeys) {
            archiveCacheHits.delete(key);
          }

          this.logger.info(`[ARCHIVE_CLOUD_CACHE] falling back to source archives=${failedRemoteKeys.length}`);
          await this.restoreFromCache(dependencies, archiveCacheHits);
          ninjaFilePath = await this.ninjaGenerator.generateNinjaFile({
            ...ninjaOptions,
            archiveCacheHits
          });
          this.logger.verbose(`Ninja file regenerated: ${ninjaFilePath}`);
        }
      }

      const sourcesBeforeLibrariesHook = dynamicLibrariesPrebuild
        ? await this.snapshotDependencySources()
        : undefined;
      const librariesSucceeded = await this.runNinjaPhase(
        recipeRunner,
        'recipe.hooks.libraries.prebuild',
        'recipe.hooks.libraries.postbuild',
        'Libraries',
        async () => {
          if (sourcesBeforeLibrariesHook) {
            await this.refreshHookGeneratedSources(sourcesBeforeLibrariesHook);
            await this.invalidatePhaseOutputs('libraries');
            ninjaFilePath = await this.ninjaGenerator.generateNinjaFile(ninjaOptions);
          }
          return await this.runNinjaStage(
            ninjaFilePath,
            NinjaGenerator.LIBRARIES_TARGET,
            warnings,
            {
              stage: 'libraries',
              start: 15,
              end: 50,
              message: 'Compiling libraries'
            }
          );
        }
      );
      if (!librariesSucceeded) {
        return { success: false, warnings, error: 'Library compilation failed' };
      }

      const sourcesBeforeCoreHook = dynamicCorePrebuild
        ? await this.snapshotDependencySources()
        : undefined;
      const coreSucceeded = await this.runNinjaPhase(
        recipeRunner,
        'recipe.hooks.core.prebuild',
        'recipe.hooks.core.postbuild',
        'Core',
        async () => {
          if (sourcesBeforeCoreHook) {
            await this.refreshHookGeneratedSources(sourcesBeforeCoreHook);
            await this.invalidatePhaseOutputs('core');
            ninjaFilePath = await this.ninjaGenerator.generateNinjaFile(ninjaOptions);
          }
          return await this.runNinjaStage(
            ninjaFilePath,
            NinjaGenerator.CORE_TARGET,
            warnings,
            {
              stage: 'core',
              start: 50,
              end: 85,
              message: 'Compiling core'
            }
          );
        }
      );
      if (!coreSucceeded) {
        return { success: false, warnings, error: 'Core compilation failed' };
      }

      const elfTarget = `${path.basename(process.env['SKETCH_NAME'] || 'sketch')}.elf`;
      const linkingSucceeded = await this.runNinjaPhase(
        recipeRunner,
        'recipe.hooks.linking.prelink',
        'recipe.hooks.linking.postlink',
        'Link',
        async () => {
          // Prelink hooks may rewrite linker scripts without changing the
          // textual link command. Arduino CLI invokes the link recipe every
          // time; removing only the derived ELF gives Ninja the same semantic
          // guarantee while retaining incremental object compilation.
          if (hasLinkPrebuild) {
            await fs.remove(path.join(buildPath, elfTarget));
          }
          return await this.runNinjaStage(
            ninjaFilePath,
            elfTarget,
            warnings,
            {
              stage: 'linking',
              start: 85,
              end: 93,
              message: 'Linking firmware'
            }
          );
        }
      );
      if (!linkingSucceeded) {
        return { success: false, warnings, error: 'Linking failed' };
      }

      const artifactSnapshot = await this.snapshotBuildArtifacts(recipeRunner);
      await this.removeDeclaredObjcopyOutput(recipeRunner, elfTarget);
      this.reportProgress('objcopy', 93, 'Generating firmware');
      await this.runRecipePhase(
        recipeRunner,
        'recipe.hooks.objcopy.preobjcopy',
        'recipe.hooks.objcopy.postobjcopy',
        'Objcopy',
        async () => {
          await this.runRecipeGroup(recipeRunner, 'recipe.objcopy', 'Objcopy');
        }
      );
      this.reportProgress('objcopy', 98, 'Generating firmware');
      this.reportProgress('finalizing', 99, 'Finalizing build');
      await this.runRecipeGroup(recipeRunner, 'recipe.hooks.postbuild', 'Postbuild');

      const cacheableArchiveDependencies = dependencies.filter(dependency =>
        !(dynamicLibrariesPrebuild && dependency.type === 'library')
        && !(dynamicCorePrebuild && dependency.type === 'core')
      );
      await this.archiveCloudCacheManager.storeArchives(
        cacheableArchiveDependencies,
        compileConfig,
        archiveCacheHits
      );

      const outFilePath = await this.getExistingOutputFilePath(recipeRunner, artifactSnapshot);
      this.reportProgress('complete', 100, 'Build complete', 'complete');

      return {
        success: true,
        outFilePath,
        buildTime: Date.now() - startTime,
        warnings: warnings.length > 0 ? warnings : undefined
      };
    } catch (error) {
      await this.settleRemoteFetches(remoteFetches);
      const errorMessage = this.formatCompilationError(error);
      this.logger.error(`Ninja compilation failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        warnings: [`Compilation error: ${errorMessage}`]
      };
    }
  }

  private formatCompilationError(error: unknown): string {
    if (!(error instanceof RecipeRunnerError)) {
      return error instanceof Error ? error.message : String(error);
    }

    const recipeKey = error.details.recipeKey || 'unknown recipe';
    const stdout = error.details.stdout?.trim();
    const stderr = error.details.stderr?.trim();
    const expandedCommand = error.details.expandedCommand;
    if (expandedCommand) {
      this.logger.verbose(`Failed recipe command (${recipeKey}): ${expandedCommand}`);
    }
    if (stderr) {
      this.logger.error(`${recipeKey} stderr: ${stderr}`);
    }
    if (stdout) {
      this.logger.error(`${recipeKey} stdout: ${stdout}`);
    }

    return [
      `${error.message} [${recipeKey}]`,
      stderr ? `stderr: ${stderr.slice(0, 4000)}` : undefined,
      stdout ? `stdout: ${stdout.slice(0, 4000)}` : undefined
    ].filter(Boolean).join('\n');
  }

  private async runNinjaStage(
    ninjaFilePath: string,
    target: string,
    warnings: string[],
    progressRange: NinjaStageProgressRange
  ): Promise<boolean> {
    this.reportProgress(progressRange.stage, progressRange.start, progressRange.message);
    this.logger.info(`Starting ninja stage: ${target}`);
    const result = await this.executeNinjaBuild(ninjaFilePath, [target], progressRange);
    if (result.warnings) {
      warnings.push(...result.warnings);
    }
    if (result.success) {
      this.reportProgress(progressRange.stage, progressRange.end, progressRange.message);
    }
    return result.success;
  }

  private reportProgress(
    stage: AilyBuilderProgressStage,
    percent: number,
    message: string,
    status: AilyBuilderProgressStatus = 'running'
  ): void {
    const normalizedPercent = Math.max(
      this.lastReportedProgress,
      Math.max(0, Math.min(100, Math.round(percent)))
    );
    if (
      normalizedPercent === this.lastReportedProgress
      && stage === this.lastReportedStage
      && status === this.lastReportedStatus
    ) {
      return;
    }

    this.lastReportedProgress = normalizedPercent;
    this.lastReportedStage = stage;
    this.lastReportedStatus = status;
    this.logger.progress({
      stage,
      percent: normalizedPercent,
      status,
      message
    });
  }

  private reportNinjaProgress(
    progressLine: string,
    progressRange: NinjaStageProgressRange | undefined
  ): void {
    if (!progressRange) {
      return;
    }

    const match = progressLine.match(/\[(\d+)\/(\d+)\]/);
    if (!match) {
      return;
    }

    const current = Number.parseInt(match[1], 10);
    const total = Number.parseInt(match[2], 10);
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
      return;
    }

    const localRatio = Math.max(0, Math.min(1, current / total));
    const globalPercent = progressRange.start
      + localRatio * (progressRange.end - progressRange.start);
    this.reportProgress(progressRange.stage, globalPercent, progressRange.message);
  }

  private async runNinjaPhase(
    runner: RecipeRunner | undefined,
    prebuildPrefix: string,
    postbuildPrefix: string,
    label: string,
    build: () => Promise<boolean>
  ): Promise<boolean> {
    return await this.runRecipePhase(
      runner,
      prebuildPrefix,
      postbuildPrefix,
      label,
      build
    );
  }

  private async runRecipePhase<T>(
    runner: RecipeRunner | undefined,
    prebuildPrefix: string,
    postbuildPrefix: string,
    label: string,
    action: () => Promise<T>
  ): Promise<T> {
    let primaryError: unknown;
    try {
      await this.runRecipeGroup(runner, prebuildPrefix, `${label} prebuild`);
      return await action();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      // Phase posthooks commonly reset response files. Always run them after a
      // partially entered phase so a failed build cannot poison the next run.
      try {
        await this.runRecipeGroup(runner, postbuildPrefix, `${label} postbuild`);
      } catch (postbuildError) {
        if (primaryError === undefined) {
          throw postbuildError;
        }

        const cleanupMessage = postbuildError instanceof Error
          ? postbuildError.message
          : String(postbuildError);
        this.logger.error(`${label} postbuild also failed: ${cleanupMessage}`);
        if (primaryError instanceof Error) {
          primaryError.message = `${primaryError.message}\n${label} postbuild also failed: ${cleanupMessage}`;
        }
      }
    }
  }

  private async runRecipeGroup(
    runner: RecipeRunner | undefined,
    prefix: string,
    label: string
  ): Promise<RecipeExecutionResult[]> {
    if (!runner) {
      return [];
    }

    const recipeKeys = runner.findRecipes(prefix, '.pattern');
    if (recipeKeys.length === 0) {
      return [];
    }

    this.logger.info(`${label}: ${recipeKeys.length} recipe(s)`);
    for (const recipeKey of recipeKeys) {
      this.logger.verbose(`Running recipe: ${recipeKey}`);
    }

    const results = await runner.runRecipes(prefix, '.pattern');
    for (const result of results) {
      if (result.stdout.trim()) {
        this.logger.verbose(`${result.recipeKey} stdout: ${result.stdout.trim()}`);
      }
      if (result.stderr.trim()) {
        this.logger.verbose(`${result.recipeKey} stderr: ${result.stderr.trim()}`);
      }
    }
    return results;
  }

  private hasRecipeGroup(runner: RecipeRunner | undefined, prefix: string): boolean {
    return (runner?.findRecipes(prefix, '.pattern').length || 0) > 0;
  }

  private isKnownArduinoCoreBuildHook(runner: RecipeRunner | undefined): boolean {
    if (!runner) {
      return false;
    }
    const recipeKeys = runner.findRecipes('recipe.hooks.core.prebuild', '.pattern');
    return recipeKeys.length > 0 && recipeKeys.every(recipeKey => {
      const pattern = runner.getProperties().get(recipeKey) || '';
      return runner.expand(pattern).includes(this.arduinoCoreBuildFlag);
    });
  }

  private dropUnsafePhaseArchiveHits(
    archiveCacheHits: Map<string, ArchiveCacheHit>,
    librariesAreDynamic: boolean,
    coreIsDynamic: boolean
  ): void {
    if (!librariesAreDynamic && !coreIsDynamic) {
      return;
    }

    for (const dependency of this.dependencies) {
      if ((librariesAreDynamic && dependency.type === 'library')
        || (coreIsDynamic && dependency.type === 'core')) {
        archiveCacheHits.delete(getArchiveDependencyKey(dependency.type, dependency.name));
      }
    }
  }

  private normalizeSourceKey(sourcePath: string): string {
    const resolved = path.resolve(sourcePath);
    return toHostPathKey(resolved);
  }

  private async snapshotDependencySources(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const roots = new Set<string>();
    for (const dependency of this.dependencies) {
      if (dependency.path) {
        roots.add(path.resolve(dependency.path));
      }
    }
    const generatedRoot = getGeneratedSketchSourceRoot();
    if (generatedRoot) {
      roots.add(generatedRoot);
    }

    for (const root of roots) {
      if (!await fs.pathExists(root)) {
        continue;
      }
      const sources = await glob([
        '**/*.c', '**/*.cc', '**/*.cpp', '**/*.cxx', '**/*.s', '**/*.S'
      ], {
        cwd: root,
        absolute: true,
        nodir: true,
        follow: false,
        ignore: [
          '**/examples/**', '**/extras/**', '**/test/**', '**/tests/**', '**/docs/**'
        ]
      });
      for (const source of sources) {
        result.set(this.normalizeSourceKey(source), path.resolve(source));
      }
    }
    return result;
  }

  private async refreshHookGeneratedSources(before: Map<string, string>): Promise<number> {
    const after = await this.snapshotDependencySources();
    const generatedRoot = getGeneratedSketchSourceRoot();
    const generatedSources = await collectGeneratedSketchSources();

    let removedSources = 0;
    for (const dependency of this.dependencies) {
      const existingSources = dependency.includes || [];
      const retainedSources: string[] = [];
      for (const source of existingSources) {
        if (await fs.pathExists(source)) {
          retainedSources.push(source);
        } else {
          removedSources++;
        }
      }
      dependency.includes = retainedSources;
    }

    const generatedDependency = this.dependencies.find(dep => dep.name === GENERATED_SKETCH_DEPENDENCY_NAME);
    if (generatedRoot && generatedSources.length > 0) {
      let dependency = generatedDependency;
      if (!dependency) {
        dependency = {
          name: GENERATED_SKETCH_DEPENDENCY_NAME,
          path: generatedRoot,
          type: 'sketch',
          includes: [],
          others: []
        };
        this.dependencies.push(dependency);
      }
      dependency.includes = generatedSources;
    } else if (generatedDependency) {
      this.dependencies.splice(this.dependencies.indexOf(generatedDependency), 1);
    }

    let additions = 0;
    for (const [key, source] of after) {
      if (before.has(key)) {
        continue;
      }
      if (generatedRoot && this.isPathWithin(generatedRoot, source)) {
        additions++;
        continue;
      }

      const dependency = this.dependencies
        .filter(dep => dep.name !== GENERATED_SKETCH_DEPENDENCY_NAME && this.isPathWithin(dep.path, source))
        .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length)[0];
      if (!dependency) {
        this.logger.warn(`Hook generated source is outside known dependency roots: ${source}`);
        continue;
      }
      dependency.includes = dependency.includes || [];
      if (!dependency.includes.some(existing => this.normalizeSourceKey(existing) === key)) {
        dependency.includes.push(source);
        dependency.includes.sort((left, right) => left.localeCompare(right, 'en'));
        additions++;
      }
    }

    if (additions > 0 || removedSources > 0) {
      this.logger.info(`Phase hook source changes: added=${additions} removed=${removedSources}`);
    }
    return additions;
  }

  private isPathWithin(parentPath: string, candidatePath: string): boolean {
    if (!parentPath || !candidatePath) {
      return false;
    }
    const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
    return relative === ''
      || (relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative));
  }

  private async invalidatePhaseOutputs(phase: 'sketch' | 'libraries' | 'core'): Promise<void> {
    const buildPath = this.getValidatedBuildPath();
    const filesToRemove = new Set<string>();

    const collectObjects = async (directory: string) => {
      if (!await fs.pathExists(directory)) {
        return;
      }
      for (const filePath of await glob(['**/*.o', '**/*.o.d'], {
        cwd: directory,
        absolute: true,
        nodir: true,
        follow: false
      })) {
        filesToRemove.add(filePath);
      }
    };

    if (phase === 'sketch') {
      await collectObjects(path.join(buildPath, 'sketch'));
    } else if (phase === 'libraries') {
      await collectObjects(path.join(buildPath, 'library'));
      for (const dependency of this.dependencies) {
        if (dependency.type === 'library') {
          const archivePath = path.resolve(buildPath, `${dependency.name}.a`);
          if (this.isPathWithin(buildPath, archivePath) && archivePath !== buildPath) {
            filesToRemove.add(archivePath);
          }
        }
      }
    } else {
      await collectObjects(path.join(buildPath, 'core'));
      filesToRemove.add(path.join(buildPath, 'core.a'));
    }

    await Promise.all(Array.from(filesToRemove, filePath => fs.remove(filePath)));
  }

  private getValidatedBuildPath(): string {
    const configuredPath = process.env['BUILD_PATH'];
    if (!configuredPath) {
      throw new Error('BUILD_PATH is required for compilation output invalidation');
    }
    const resolvedPath = path.resolve(configuredPath);
    if (resolvedPath === path.parse(resolvedPath).root) {
      throw new Error(`Refusing to invalidate filesystem root: ${resolvedPath}`);
    }
    return resolvedPath;
  }

  private async settleRemoteFetches(
    remoteFetches: Map<string, Promise<ArchiveCacheFetchResult>>
  ): Promise<void> {
    if (remoteFetches.size > 0) {
      await Promise.allSettled(remoteFetches.values());
    }
  }

  private async snapshotBuildArtifacts(runner?: RecipeRunner): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    const buildPath = process.env['BUILD_PATH'] || '';
    if (!buildPath || !await fs.pathExists(buildPath)) {
      return snapshot;
    }

    for (const entry of await fs.readdir(buildPath, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(buildPath, entry.name);
      const stat = await fs.stat(filePath);
      snapshot.set(entry.name, `${stat.size}:${stat.mtimeMs}`);
    }
    const declaredPath = this.getDeclaredOutputPath(runner);
    if (declaredPath && await fs.pathExists(declaredPath)) {
      const stat = await fs.stat(declaredPath);
      snapshot.set(this.declaredArtifactSnapshotKey(declaredPath), `${stat.size}:${stat.mtimeMs}`);
    }
    return snapshot;
  }

  private async getExistingOutputFilePath(
    runner: RecipeRunner | undefined,
    beforeObjcopy: Map<string, string>
  ): Promise<string> {
    const sketchName = process.env['SKETCH_NAME'] || 'sketch';
    const buildPath = process.env['BUILD_PATH'] || '';

    // This is the primary artifact declared by the platform specification.
    // It matters for platforms that deliberately emit both BIN and HEX.
    const declaredOutput = runner?.getProperties().get('recipe.output.tmp_file');
    if (declaredOutput) {
      const declaredPath = this.getDeclaredOutputPath(runner)!;
      if (await fs.pathExists(declaredPath)) {
        const stat = await fs.stat(declaredPath);
        const signature = `${stat.size}:${stat.mtimeMs}`;
        const relativeName = path.relative(buildPath, declaredPath);
        const previousSignature = beforeObjcopy.get(this.declaredArtifactSnapshotKey(declaredPath))
          ?? beforeObjcopy.get(relativeName);
        if (path.extname(declaredPath).toLowerCase() === '.elf'
          || previousSignature !== signature) {
          return declaredPath;
        }
      }

      throw new Error(`Declared output was not generated by objcopy: ${declaredPath}`);
    }

    const candidates = [
      `${sketchName}.zip`,
      `${sketchName}.uf2`,
      `${sketchName}.merged.bin`,
      `${sketchName}.hex`,
      `${sketchName}.bin`,
      `${sketchName}.elf`
    ];

    for (const candidate of candidates) {
      const candidatePath = path.join(buildPath, candidate);
      if (!await fs.pathExists(candidatePath)) {
        continue;
      }
      const stat = await fs.stat(candidatePath);
      const currentSignature = `${stat.size}:${stat.mtimeMs}`;
      if (candidate.endsWith('.elf') || beforeObjcopy.get(candidate) !== currentSignature) {
        return candidatePath;
      }
    }

    return path.join(buildPath, `${sketchName}.elf`);
  }

  private async removeDeclaredObjcopyOutput(
    runner: RecipeRunner | undefined,
    elfTarget: string
  ): Promise<void> {
    const declaredPath = this.getDeclaredOutputPath(runner);
    if (!declaredPath) {
      return;
    }

    const buildPath = process.env['BUILD_PATH'] || '';
    if (path.resolve(declaredPath) === path.resolve(buildPath, elfTarget)) {
      return;
    }

    const relativeOutput = path.relative(path.resolve(buildPath), path.resolve(declaredPath));
    if (!relativeOutput
      || relativeOutput === '..'
      || relativeOutput.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeOutput)) {
      this.logger.warn(`Not removing declared output outside build directory: ${declaredPath}`);
      return;
    }

    // A stale primary artifact must not make an incomplete objcopy phase look
    // successful. It is derived and will be recreated by the platform recipe.
    await fs.remove(declaredPath);
  }

  private getDeclaredOutputPath(runner: RecipeRunner | undefined): string | undefined {
    const declaredOutput = runner?.getProperties().get('recipe.output.tmp_file');
    if (!runner || !declaredOutput) {
      return undefined;
    }
    const buildPath = process.env['BUILD_PATH'] || '';
    const expandedOutput = runner.expand(declaredOutput).replace(/^(["'])(.*)\1$/, '$2');
    return path.resolve(path.isAbsolute(expandedOutput)
      ? expandedOutput
      : path.join(buildPath, expandedOutput));
  }

  private declaredArtifactSnapshotKey(filePath: string): string {
    return `@declared:${path.resolve(filePath)}`;
  }

  private async collectFailedRemoteFetches(
    remoteFetches: Map<string, Promise<ArchiveCacheFetchResult>>
  ): Promise<string[]> {
    const failedKeys: string[] = [];

    for (const [key, fetchPromise] of remoteFetches) {
      const result = await fetchPromise;
      if (!result.success) {
        failedKeys.push(key);
        this.logger.warn(
          `[ARCHIVE_CLOUD_CACHE] remote download failed ${result.hit.archiveName} ${result.hit.cacheKey}: ${result.error || 'unknown error'}`
        );
      }
    }

    return failedKeys;
  }

  private async executeNinjaBuild(
    ninjaFilePath: string,
    targets: string[] = [],
    progressRange?: NinjaStageProgressRange
  ): Promise<{ success: boolean; warnings?: string[] }> {
    return new Promise((resolve, reject) => {
      const ninjaPath = this.getNinjaExecutablePath();
      const buildDir = sanitizeNonAsciiPaths(path.dirname(ninjaFilePath));
      const jobs = parseInt(process.env['BUILD_JOBS'] || '4');

      const args = [
        '-f', path.basename(ninjaFilePath),
        '-j', jobs.toString(),
        '-v' // verbose模式显示执行的命令
      ];

      args.push(...targets);

      this.logger.verbose(`Executing: ${ninjaPath} ${args.join(' ')}`);
      this.logger.verbose(`Working directory: ${buildDir}`);

      // 清洗所有环境变量中的非 ASCII 路径
      const sanitizedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          sanitizedEnv[key] = sanitizeNonAsciiPaths(value);
        }
      }
      sanitizedEnv['PATH'] = [
        sanitizedEnv['COMPILER_PATH'],
        sanitizedEnv['ESPTOOL_PY_PATH'],
        sanitizedEnv['PATH']
      ].filter(Boolean).join(path.delimiter);

      const childProcess = spawn(ninjaPath, args, {
        cwd: buildDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedEnv
      });

      let stdout = '';
      let stderr = '';
      const warnings: string[] = [];
      let isInFailureMode = false; // 标识是否处于失败模式

      childProcess.stdout?.on('data', (data: any) => {
        const output = data.toString('utf8');
        stdout += output;

        // 实时输出编译信息
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            if (/\[\d+\/\d+\]/.test(line)) {
              // 这是ninja的进度信息，重置失败模式
              isInFailureMode = false;
              this.logger.info(line.trim());
              this.reportNinjaProgress(line.trim(), progressRange);
              // 检查是否是编译完成的消息，立即存储到缓存
              this.handleCompilationProgress(line.trim(), buildDir);
            } else if (line.startsWith('FAILED:')) {
              // 编译失败信息，进入失败模式
              isInFailureMode = true;
              this.logger.error(line.trim());
            } else if (isInFailureMode) {
              // 在失败模式下，所有后续行都作为错误信息
              // 但隐藏 ninja 的构建停止消息
              if (line.includes('ninja: build stopped') || line.includes('subcommand failed')) {
                isInFailureMode = false;
                // 不输出这个消息，只是退出失败模式
              } else {
                this.logger.error(line.trim());
              }
            } else {
              // 其他输出
              this.logger.verbose(line.trim());
            }
          }
        }
      });

      childProcess.stderr?.on('data', (data: any) => {
        const output = data.toString('utf8');
        stderr += output;

        // 检查是否是警告
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            if (line.toLowerCase().includes('warning')) {
              warnings.push(line.trim());
              this.logger.debug(line.trim());
            } else {
              this.logger.error(line.trim());
            }
          }
        }
      });

      childProcess.on('close', (code) => {
        if (code === 0) {
          this.logger.info('Ninja build completed successfully');
          resolve({ success: true, warnings: warnings.length > 0 ? warnings : undefined });
        } else {
          // this.logger.error(`Ninja build failed with exit code ${code}`);
          // if (stderr) {
          //   this.logger.error(`stderr: ${stderr}`);
          // }
          resolve({ success: false, warnings: warnings.length > 0 ? warnings : undefined });
        }
      });

      childProcess.on('error', (error) => {
        this.logger.error(`Failed to start ninja: ${error.message}`);
        reject(new Error(`Failed to start ninja: ${error.message}`));
      });
    });
  }

  /**
   * 处理编译进度并立即存储缓存
   */
  private async handleCompilationProgress(progressLine: string, buildDir: string): Promise<void> {
    // 解析ninja的进度信息，查找编译完成的文件

    let objectFileName: string | null = null; // 輸出的文件
    let sourceFileName: string | null = null; // 源文件
    let compileCommand: string | null = null; // 编译命令

    // 匹配 -o <path>.o 格式，这表示编译器的输出文件
    const outputMatch = progressLine.match(/-o\s+([^\s]+\.o)/);
    if (outputMatch) {
      objectFileName = outputMatch[1];
      if (objectFileName) {
        const objectFilePath = path.join(buildDir, objectFileName);

        // 检查对象文件是否确实存在
        if (await fs.pathExists(objectFilePath)) {
          // 根据对象文件路径找到对应的源文件和依赖信息
          await this.storeSingleFileToCache(objectFileName, objectFilePath);
        }
      }
    }
  }

  /**
   * 存储单个编译文件到缓存
   */
  private async storeSingleFileToCache(objectFileName: string, objectFilePath: string): Promise<void> {
    try {
      // 从对象文件名解析出源文件信息
      const pathParts = objectFileName.split('/');
      let dependencyType: string;
      let dependencyName: string;
      let baseName: string;

      if (pathParts.length === 3) {
        // library/libraryName/file.ext.o 或 variant/variantName/file.ext.o
        [dependencyType, dependencyName, baseName] = pathParts;
        // 移除 .o 扩展名，保留原始文件的扩展名
        if (baseName.endsWith('.o')) {
          baseName = baseName.slice(0, -2); // 移除 '.o'
        }
        // 再移除原始文件的扩展名以获得基本名称
        baseName = path.basename(baseName, path.extname(baseName));
      } else if (pathParts.length === 2) {
        // core/file.ext.o 或 sketch/file.ext.o
        [dependencyType, baseName] = pathParts;
        // 移除 .o 扩展名，保留原始文件的扩展名
        if (baseName.endsWith('.o')) {
          baseName = baseName.slice(0, -2); // 移除 '.o'
        }
        // 再移除原始文件的扩展名以获得基本名称
        baseName = path.basename(baseName, path.extname(baseName));
        dependencyName = dependencyType;
      } else {
        // file.ext.o (直接在构建根目录)
        baseName = pathParts[0];
        // 移除 .o 扩展名
        if (baseName.endsWith('.o')) {
          baseName = baseName.slice(0, -2); // 移除 '.o'
        }
        // 再移除原始文件的扩展名以获得基本名称
        baseName = path.basename(baseName, path.extname(baseName));
        dependencyType = 'sketch';
        dependencyName = 'sketch';
      }

      // 跳过sketch文件的缓存，因为sketch文件经常变化
      if (dependencyType === 'sketch') {
        this.logger.debug(`Skipping cache for sketch file: ${objectFileName}`);
        return;
      }

      // 查找对应的依赖和源文件
      const dependency = this.dependencies.find(dep =>
        dep.type === dependencyType &&
        (dep.name === dependencyName || dependencyType === dep.type)
      );

      if (!dependency) {
        this.logger.debug(`Cannot find dependency for object file: ${objectFileName}`);
        return;
      }

      // 查找对应的源文件
      const sourceFile = dependency.includes?.find(file => {
        const sourceBaseName = path.basename(file, path.extname(file));
        return sourceBaseName === baseName;
      });

      if (!sourceFile) {
        // this.logger.debug(`Cannot find source file for object: ${objectFileName} in dependency ${dependency.name}`);
        // this.logger.debug(`Looking for baseName: ${baseName}`);
        // this.logger.debug(`Available source files: ${dependency.includes?.map(f => path.basename(f, path.extname(f))).join(', ')}`);
        return;
      }

      // 确定编译器和参数模板
      const ext = path.extname(sourceFile);
      let compiler: string;
      let argsTemplate: string;

      switch (ext) {
        case '.ino':
        case '.cpp':
          compiler = this.compileConfig.compiler.cpp;
          argsTemplate = this.compileConfig.args.cpp;
          break;
        case '.c':
          compiler = this.compileConfig.compiler.c;
          argsTemplate = this.compileConfig.args.c;
          break;
        case '.s':
        case '.S':
          compiler = this.compileConfig.compiler.c;
          argsTemplate = this.compileConfig.args.s;
          break;
        default:
          return; // 跳过不支持的文件类型
      }

      // 创建缓存键
      const cacheKey: CacheKey = {
        command: compiler,
        args: this.getCacheKeyArgs(argsTemplate, dependency.type, sourceFile),
        sourceFile: sourceFile
      };

      // 存储到缓存
      await this.cacheManager.storeToCache(cacheKey, objectFilePath);
    } catch (error) {
      this.logger.debug(`Failed to cache single file ${objectFileName}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private getNinjaExecutablePath(): string {
    const executableName = this.getNinjaExecutableName();
    const candidatePaths = [
      path.join(__dirname, 'ninja', executableName),
      path.resolve(__dirname, '..', 'ninja', executableName),
      path.join(process.cwd(), 'ninja', executableName)
    ];

    for (const candidatePath of candidatePaths) {
      if (fs.existsSync(candidatePath)) {
        if (isMacOSHost() && (fs.statSync(candidatePath).mode & 0o111) === 0) {
          fs.chmodSync(candidatePath, 0o755);
        }
        return candidatePath;
      }
    }

    throw new Error(
      `Ninja executable not found. Checked: ${candidatePaths.join(', ')}`,
    );
  }

  private getNinjaExecutableName(): string {
    if (isWindowsHost()) {
      return 'ninja.exe';
    }
    if (isMacOSHost()) {
      return 'ninja';
    }

    throw new Error(`Bundled Ninja is not available for platform: ${process.platform}`);
  }

  /**
   * 清理ninja构建文件
   */
  async cleanNinjaBuild(): Promise<void> {
    const buildPath = process.env['BUILD_PATH'] || '';
    const ninjaFilePath = path.join(buildPath, 'build.ninja');
    const ninjaDepsPath = path.join(buildPath, '.ninja_deps');
    const ninjaLogPath = path.join(buildPath, '.ninja_log');

    try {
      await Promise.all([
        fs.remove(ninjaFilePath).catch(() => { }),
        fs.remove(ninjaDepsPath).catch(() => { }),
        fs.remove(ninjaLogPath).catch(() => { })
      ]);
      this.logger.debug('Cleaned ninja build files');
    } catch (error) {
      this.logger.debug(`Failed to clean ninja files: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 获取缓存统计信息
   */
  async getCacheStats() {
    return await this.cacheManager.getCacheStats();
  }

  /**
   * 显示缓存统计信息
   */
  async showCacheStats(): Promise<void> {
    const stats = await this.getCacheStats();
    this.logger.info(`📊 Cache Statistics:`);
    this.logger.info(`   Files: ${stats.totalFiles}`);
    this.logger.info(`   Size: ${stats.totalSizeFormatted}`);
    this.logger.info(`   Location: ${stats.cacheDir}`);

    const totalOps = (stats.hardLinksUsed || 0) + (stats.copiesUsed || 0);
    if (totalOps > 0) {
      const hardPercent = (((stats.hardLinksUsed || 0) / totalOps) * 100).toFixed(1);
      const copyPercent = (((stats.copiesUsed || 0) / totalOps) * 100).toFixed(1);

      this.logger.info(`   Performance:`);
      this.logger.info(`     Hard links: ${stats.hardLinksUsed || 0} (${hardPercent}%)`);
      this.logger.info(`     File copies: ${stats.copiesUsed || 0} (${copyPercent}%)`);

      const linkRate = ((stats.hardLinksUsed || 0) / totalOps * 100).toFixed(1);
      this.logger.info(`     Hard link success rate: ${linkRate}%`);
    }
  }

  /**
   * 清除编译缓存
   */
  async clearCache(options?: { olderThanDays?: number; pattern?: string }) {
    return await this.cacheManager.clearCache(options);
  }

  /**
   * 清除所有编译缓存
   */
  async clearAllCache() {
    return await this.cacheManager.clearAllCache();
  }

  /**
   * 从缓存中恢复对象文件
   */
  private async refreshCacheContextFingerprint(): Promise<void> {
    const buildPath = process.env['BUILD_PATH'] || '';
    const hash = createHash('sha256');
    const files = new Set<string>();
    const configNames = new Set(['file_opts', 'sdkconfig']);
    const configExtensions = new Set([
      '.h', '.hh', '.hpp', '.inc', '.opt', '.cfg', '.json', '.csv', '.rsp', '.ld', '.lds'
    ]);
    const derivedExtensions = new Set([
      '.o', '.a', '.elf', '.bin', '.hex', '.eep', '.uf2', '.zip', '.map', '.d'
    ]);
    const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.cxx', '.s']);
    const platform = this.compileConfig?.arduino?.platform || {};
    const hasInputGeneratingHooks = Object.keys(platform).some(key =>
      key.startsWith('recipe.hooks.prebuild')
      || key.startsWith('recipe.hooks.sketch.prebuild')
    );
    const ignoredNames = new Set([
      'build.ninja', '.ninja_deps', '.ninja_log', '.aily-build-context-v1'
    ]);

    if (buildPath && await fs.pathExists(buildPath)) {
      const candidates = await glob('**/*', {
        cwd: buildPath,
        absolute: true,
        nodir: true,
        follow: false
      });
      for (const candidate of candidates) {
        const name = path.basename(candidate);
        const extension = path.extname(candidate).toLowerCase();
        const isKnownConfig = configNames.has(name) || configExtensions.has(extension);
        const isOpaqueHookOutput = hasInputGeneratingHooks
          && !ignoredNames.has(name)
          && !derivedExtensions.has(extension)
          && !sourceExtensions.has(extension);
        if (isKnownConfig || isOpaqueHookOutput) {
          files.add(path.resolve(candidate));
        }
      }
    }

    for (const filePath of await this.collectReferencedBuildInputFiles()) {
      files.add(filePath);
    }

    const sortedFiles = Array.from(files).sort((left, right) => left.localeCompare(right, 'en'));
    for (const filePath of sortedFiles) {
      try {
        hash.update(path.relative(buildPath, filePath).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(await fs.readFile(filePath));
        hash.update('\0');
      } catch (error) {
        this.logger.debug(`Unable to fingerprint generated build input ${filePath}: ${error instanceof Error ? error.message : error}`);
      }
    }
    this.cacheContextFingerprint = hash.digest('hex');
  }

  private async collectReferencedBuildInputFiles(): Promise<string[]> {
    const buildPath = process.env['BUILD_PATH'] || process.cwd();
    const args = this.compileConfig?.args || {};
    const pending = [args.c, args.cpp, args.s, args.ld]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const files = new Set<string>();
    const visitedTexts = new Set<string>();

    while (pending.length > 0 && visitedTexts.size < 64) {
      const text = pending.shift()!;
      if (visitedTexts.has(text)) {
        continue;
      }
      visitedTexts.add(text);

      const responseCandidates = new Set<string>();
      const candidates = new Set<string>();
      const responsePattern = /(?:"@([^"]+)"|'@([^']+)'|@"([^"]+)"|@'([^']+)'|@([^\s"']+))/g;
      let match: RegExpExecArray | null;
      while ((match = responsePattern.exec(text)) !== null) {
        const candidate = match[1] || match[2] || match[3] || match[4] || match[5];
        responseCandidates.add(candidate);
        candidates.add(candidate);
      }

      const linkerScriptPattern = /(?:^|\s|["'])(?:-Wl,)?-T(?:,|\s*)(?:"([^"]+)"|'([^']+)'|([^\s,"']+))/g;
      while ((match = linkerScriptPattern.exec(text)) !== null) {
        candidates.add(match[1] || match[2] || match[3]);
      }

      for (const candidate of candidates) {
        const resolved = path.resolve(buildPath, candidate);
        if (!await fs.pathExists(resolved) || (await fs.stat(resolved)).isDirectory()) {
          continue;
        }
        if (files.has(resolved)) {
          continue;
        }
        files.add(resolved);
        // Response files may reference another response file or linker script.
        if (responseCandidates.has(candidate)) {
          try {
            pending.push(await fs.readFile(resolved, 'utf8'));
          } catch {
            // Binary/non-text linker inputs are still hashed below.
          }
        }
      }
    }

    return Array.from(files);
  }

  private async invalidateLocalOutputsForChangedContext(): Promise<boolean> {
    const buildPath = this.getValidatedBuildPath();

    const markerPath = path.join(buildPath, '.aily-build-context-v1');
    let previousFingerprint: string | undefined;
    try {
      if (await fs.pathExists(markerPath)) {
        previousFingerprint = (await fs.readFile(markerPath, 'utf8')).trim();
      }
    } catch (error) {
      this.logger.debug(`Unable to read build context marker: ${error instanceof Error ? error.message : error}`);
    }

    if (previousFingerprint === this.cacheContextFingerprint) {
      return false;
    }

    const derivedFiles = await glob([
      '**/*.o', '**/*.o.d', '*.a', '*.elf'
    ], {
      cwd: buildPath,
      absolute: true,
      nodir: true,
      follow: false
    });
    derivedFiles.push(
      path.join(buildPath, '.ninja_deps'),
      path.join(buildPath, '.ninja_log')
    );
    await Promise.all(derivedFiles.map(filePath => fs.remove(filePath)));
    await fs.outputFile(markerPath, this.cacheContextFingerprint, 'utf8');

    this.logger.info('Generated build configuration changed; invalidated local objects and archives');
    return true;
  }

  private getCacheKeyArgs(
    argsTemplate: string,
    dependencyType: string | undefined,
    sourceFile: string
  ): string[] {
    const args = this.parseCompileArgs(
      this.getEffectiveArgsTemplate(argsTemplate, dependencyType),
      sourceFile
    );
    return [...args, `__aily_build_context=${this.cacheContextFingerprint}`];
  }

  private async restoreFromCache(
    dependencies: Dependency[],
    archiveCacheHits: Map<string, ArchiveCacheHit> = new Map()
  ): Promise<number> {
    let cacheHits = 0;
    const buildPath = process.env['BUILD_PATH'] || '';

    // 处理依赖文件，跳过sketch文件
    for (const dependency of dependencies) {
      // 跳过sketch类型的依赖
      if (dependency.type === 'sketch') {
        continue;
      }

      if (archiveCacheHits.has(getArchiveDependencyKey(dependency.type, dependency.name))) {
        this.logger.debug(`Skipping object cache restore for archive hit: ${dependency.type}/${dependency.name}`);
        continue;
      }

      for (const sourceFile of dependency.includes) {
        const ext = path.extname(sourceFile);
        let compiler: string;
        let argsTemplate: string;

        // 确定编译器和参数模板
        switch (ext) {
          case '.ino':
          case '.cpp':
            compiler = this.compileConfig.compiler.cpp;
            argsTemplate = this.compileConfig.args.cpp;
            break;
          case '.c':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.c;
            break;
          case '.s':
          case '.S':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.s;
            break;
          default:
            continue; // 跳过不支持的文件类型
        }

        const cacheKey: CacheKey = {
          command: compiler,
          args: this.getCacheKeyArgs(argsTemplate, dependency.type, sourceFile),
          sourceFile: sourceFile
        };

        // 确定对象文件路径
        const fileName = path.basename(sourceFile);
        const baseName = path.basename(sourceFile, ext);
        let objectPath: string;

        if (dependency.type === 'variant') {
          objectPath = path.join(buildPath, 'core', `${fileName}.o`);
        } else if (dependency.type === 'library') {
          objectPath = path.join(buildPath, dependency.type, dependency.name, `${baseName}.o`);
        } else {
          objectPath = path.join(buildPath, dependency.type, `${fileName}.o`);
        }

        // 检查缓存并恢复
        // Keep build-local objects attached to Ninja's deps/log state. Cache
        // extraction is only for a missing target; replacing an existing
        // object changes its mtime and makes Ninja rebuild it needlessly.
        if (await fs.pathExists(objectPath)) {
          continue;
        }

        if (await this.cacheManager.hasCache(cacheKey)) {
          await fs.ensureDir(path.dirname(objectPath));
          if (await this.cacheManager.extractFromCache(cacheKey, objectPath)) {
            cacheHits++;
            this.logger.debug(`Cache hit for ${dependency.type}/${dependency.name}: ${baseName}${ext}`);
          }
        }
      }
    }

    return cacheHits;
  }

  /**
   * 将新编译的对象文件存储到缓存
   */
  private async storeToCache(dependencies: Dependency[]): Promise<void> {
    const buildPath = process.env['BUILD_PATH'] || '';

    // 只处理依赖文件，跳过sketch文件缓存

    // 处理依赖文件
    for (const dependency of dependencies) {
      // 跳过sketch类型的依赖
      if (dependency.type === 'sketch') {
        continue;
      }

      for (const sourceFile of dependency.includes) {
        const ext = path.extname(sourceFile);
        let compiler: string;
        let argsTemplate: string;

        // 确定编译器和参数模板
        switch (ext) {
          case '.ino':
          case '.cpp':
            compiler = this.compileConfig.compiler.cpp;
            argsTemplate = this.compileConfig.args.cpp;
            break;
          case '.c':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.c;
            break;
          case '.s':
          case '.S':
            compiler = this.compileConfig.compiler.c;
            argsTemplate = this.compileConfig.args.s;
            break;
          default:
            continue; // 跳过不支持的文件类型
        }

        const cacheKey: CacheKey = {
          command: compiler,
          args: this.getCacheKeyArgs(argsTemplate, dependency.type, sourceFile),
          sourceFile: sourceFile
        };

        // 确定对象文件路径
        const fileName = path.basename(sourceFile);
        const baseName = path.basename(sourceFile, ext);
        let objectPath: string;

        if (dependency.type === 'variant') {
          objectPath = path.join(buildPath, 'core', `${fileName}.o`);
        } else if (dependency.type === 'library') {
          objectPath = path.join(buildPath, dependency.type, dependency.name, `${baseName}.o`);
        } else {
          objectPath = path.join(buildPath, dependency.type, `${fileName}.o`);
        }

        // 存储到缓存
        if (await fs.pathExists(objectPath)) {
          try {
            await this.cacheManager.storeToCache(cacheKey, objectPath);
            this.logger.debug(`Cached ${dependency.type}/${dependency.name}: ${baseName}${ext}`);
          } catch (error) {
            this.logger.debug(`Failed to cache ${baseName}${ext}: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }
  }

  /**
   * 解析编译参数
   */
  private getEffectiveArgsTemplate(argsTemplate: string, dependencyType?: string): string {
    if (!this.isCoreBuildDependency(dependencyType) || !this.platformUsesArduinoCoreBuildHook() || !argsTemplate || argsTemplate.includes(this.arduinoCoreBuildFlag)) {
      return argsTemplate;
    }

    return this.insertCompileFlagBeforeSource(argsTemplate, this.arduinoCoreBuildFlag);
  }

  private isCoreBuildDependency(dependencyType?: string): boolean {
    return dependencyType === 'core' || dependencyType === 'variant';
  }

  private platformUsesArduinoCoreBuildHook(): boolean {
    const platform = this.compileConfig?.arduino?.platform || {};
    return Object.entries(platform).some(([key, value]) => {
      return key.startsWith('recipe.hooks.core.prebuild.')
        && key.includes('pattern')
        && typeof value === 'string'
        && value.includes('ARDUINO_CORE_BUILD');
    });
  }

  private insertCompileFlagBeforeSource(argsTemplate: string, flag: string): string {
    const quotedSourcePlaceholder = '"%SOURCE_FILE_PATH%"';
    if (argsTemplate.includes(quotedSourcePlaceholder)) {
      return argsTemplate.replace(quotedSourcePlaceholder, `${flag} ${quotedSourcePlaceholder}`);
    }

    const sourcePlaceholder = '%SOURCE_FILE_PATH%';
    if (argsTemplate.includes(sourcePlaceholder)) {
      return argsTemplate.replace(sourcePlaceholder, `${flag} ${sourcePlaceholder}`);
    }

    return `${argsTemplate} ${flag}`;
  }

  private parseCompileArgs(argsTemplate: string, sourceFile: string): string[] {
    // 简化参数解析，将模板转换为实际的编译参数
    let args = argsTemplate;

    // 替换include路径
    if (args.includes('%INCLUDE_PATHS%')) {
      const includeArgs = this.dependencies
        .map(dep => `-I"${dep.path}"`)
        .join(' ');
      args = args.replace(/%INCLUDE_PATHS%/g, includeArgs);
    }

    // 替换源文件路径
    args = args.replace(/"%SOURCE_FILE_PATH%"/g, `"${sourceFile}"`);

    // 移除输出文件参数（缓存键不需要包含输出路径）
    args = args.replace(/"-o"\s*"%OBJECT_FILE_PATH%"/g, '');
    args = args.replace(/%OBJECT_FILE_PATH%/g, '');

    // 添加编译器版本信息到缓存键中（确保编译器更新时缓存失效）
    const compilerVersion = this.getCompilerVersion();
    if (compilerVersion) {
      args += ` --compiler-version=${compilerVersion}`;
    }

    // 分割参数并清理
    return args
      .split(/\s+/)
      .filter(arg => arg.trim() && !arg.includes('%'))
      .map(arg => arg.replace(/"/g, ''))
      .sort(); // 排序参数以确保一致性
  }

  /**
   * 获取编译器版本（用于缓存键）
   */
  private getCompilerVersion(): string {
    try {
      // 这里可以根据需要实现编译器版本检测
      // 简单起见，我们使用编译器路径的修改时间作为版本标识
      const compilerPath = this.compileConfig.compiler.cpp;
      if (fs.existsSync(compilerPath)) {
        const stat = fs.statSync(compilerPath);
        return stat.mtime.getTime().toString();
      }
    } catch (error) {
      this.logger.debug(`Cannot get compiler version: ${error}`);
    }
    return '';
  }

}
