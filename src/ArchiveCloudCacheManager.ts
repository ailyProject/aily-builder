/**
 * ArchiveCloudCacheManager restores and stores whole `.a` archives across
 * projects. It is intentionally separate from CacheManager, which caches
 * individual `.o` files with a different key and lifecycle.
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { Logger } from './utils/Logger';
import { Dependency } from './DependencyAnalyzer';
import { collectPackageIdentitiesFromPaths, extractPackageIdentityFromPath } from './utils/PackageIdentity';

const CACHE_SCHEMA = 'aily.archive-cache.v1';
const INPUT_SCHEMA = 'aily.archive-build-inputs.v1';
const FETCH_REQUEST_SCHEMA = 'aily.archive-fetch-request.v1';
const KEY_VERSION = 'archive-cloud-cache-v1';
const DEFAULT_REMOTE_BASE_URL = 'https://cache.aily.pro/v1';
const DEFAULT_REMOTE_TIMEOUT_MS = 1500;
const LIBRARY_ARCHIVE_CACHE_MIN_COMPILE_FILES = 20;
const LIBRARY_ARCHIVE_CACHE_MIN_COMPILE_BYTES = 300 * 1024;

export type ArchiveDependencyType = 'core' | 'library';
export type ArchiveCacheSource = 'local' | 'remote';

export interface ArchiveCacheHit {
  dependencyName: string;
  dependencyType: ArchiveDependencyType;
  archiveName: string;
  buildArchivePath: string;
  cacheKey: string;
  source: ArchiveCacheSource;
  fetch?: ArchiveCacheFetchRequest;
}

export interface ArchiveCacheFetchRequest {
  schema: string;
  key: string;
  archiveName: string;
  dependencyName: string;
  dependencyType: ArchiveDependencyType;
  artifactUrl: string;
  artifactSha256: string;
  artifactSize: number;
  timeoutMs: number;
  cacheDir: string;
  cacheSchema: string;
  keyVersion: string;
  inputsJson: string;
  builderVersion: string;
}

export interface ArchiveCacheFetchResult {
  key: string;
  hit: ArchiveCacheHit;
  success: boolean;
  error?: string;
}

interface ArchiveTarget {
  dependency: Dependency;
  dependencyName: string;
  dependencyType: ArchiveDependencyType;
  archiveName: string;
}

interface ArchiveBuildInputs {
  schema: string;
  target: {
    kind: ArchiveDependencyType;
    name: string;
    archiveName: string;
  };
  builder: {
    keyVersion: string;
  };
  board: Record<string, any>;
  toolchain: Record<string, any>;
  sdk: Record<string, any>;
  compile: Record<string, any>;
  sources: Record<string, any>;
}

interface ArchiveManifest {
  schema: string;
  keyAlgorithm: 'sha256';
  key: string;
  createdAt: string;
  origin: 'local-build' | 'cloud-download';
  target: {
    kind: ArchiveDependencyType;
    name: string;
    archiveName: string;
  };
  artifact: {
    file: string;
    sha256: string;
    size: number;
  };
  inputs: {
    file: 'inputs.json';
    sha256: string;
  };
  builder: {
    ailyBuilderVersion: string;
    keyVersion: string;
  };
}

export function getArchiveDependencyKey(type: string | undefined, name: string): string {
  return `${type || ''}:${name}`;
}

export class ArchiveCloudCacheManager {
  private logger: Logger;
  private cacheDir: string;
  private remoteDisabledForRun = false;
  private compilerVersionCache = new Map<string, string>();
  private fileHashCache = new Map<string, string>();
  private packageVersion?: string;

  constructor(logger: Logger) {
    this.logger = logger;
    this.cacheDir = this.getConfiguredCacheDir();
    fs.ensureDirSync(this.cacheDir);
  }

  isEnabled(): boolean {
    return this.readBooleanEnv('AILY_BUILDER_ARCHIVE_CLOUD_CACHE', true);
  }

  shouldGenerate(): boolean {
    return this.readBooleanEnv('AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE', false);
  }

  startRemoteFetches(archiveHits: Map<string, ArchiveCacheHit>): Map<string, Promise<ArchiveCacheFetchResult>> {
    const fetches = new Map<string, Promise<ArchiveCacheFetchResult>>();

    for (const [key, hit] of archiveHits) {
      if (hit.source !== 'remote' || !hit.fetch) {
        continue;
      }

      fetches.set(key, this.fetchRemoteArchive(hit));
    }

    if (fetches.size > 0) {
      this.logger.info(`[ARCHIVE_CLOUD_CACHE] scheduled remote downloads=${fetches.size}`);
    }

    return fetches;
  }

  async restoreArchives(dependencies: Dependency[], compileConfig: any): Promise<Map<string, ArchiveCacheHit>> {
    const hits = new Map<string, ArchiveCacheHit>();
    if (!this.isEnabled()) {
      this.logger.debug('[ARCHIVE_CLOUD_CACHE] disabled');
      return hits;
    }

    let localHits = 0;
    let remoteHits = 0;
    let misses = 0;

    for (const target of await this.collectTargets(dependencies)) {
      try {
        const inputs = await this.computeInputs(target, dependencies, compileConfig);
        const key = this.computeKey(inputs);
        const buildArchivePath = path.join(process.env['BUILD_PATH'] || '', target.archiveName);
        const hit = await this.restoreOne(target, inputs, key, buildArchivePath);

        if (hit) {
          hits.set(getArchiveDependencyKey(target.dependencyType, target.dependencyName), hit);
          if (hit.source === 'local') {
            localHits++;
          } else {
            remoteHits++;
          }
        } else {
          misses++;
        }
      } catch (error) {
        misses++;
        this.logger.debug(`[ARCHIVE_CLOUD_CACHE] restore skipped for ${target.archiveName}: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (localHits || remoteHits) {
      this.logger.info(`[ARCHIVE_CLOUD_CACHE] local hits=${localHits} remote hits=${remoteHits} misses=${misses}`);
    } else {
      this.logger.debug(`[ARCHIVE_CLOUD_CACHE] local hits=0 remote hits=0 misses=${misses}`);
    }

    return hits;
  }

  async storeArchives(
    dependencies: Dependency[],
    compileConfig: any,
    archiveHits: Map<string, ArchiveCacheHit>
  ): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    if (!this.shouldGenerate()) {
      this.logger.info('[ARCHIVE_CLOUD_CACHE] generate=off stored archives=0');
      return;
    }

    let stored = 0;
    let skipped = 0;
    let totalSize = 0;
    const buildPath = process.env['BUILD_PATH'] || '';

    for (const target of await this.collectTargets(dependencies)) {
      const hitKey = getArchiveDependencyKey(target.dependencyType, target.dependencyName);
      if (archiveHits.has(hitKey)) {
        skipped++;
        continue;
      }

      const sourceArchivePath = path.join(buildPath, target.archiveName);
      if (!await fs.pathExists(sourceArchivePath)) {
        skipped++;
        continue;
      }

      try {
        const inputs = await this.computeInputs(target, dependencies, compileConfig);
        const storedSize = await this.storeOne(target, inputs, sourceArchivePath, 'local-build');
        if (storedSize > 0) {
          stored++;
          totalSize += storedSize;
        } else {
          skipped++;
        }
      } catch (error) {
        skipped++;
        this.logger.debug(`[ARCHIVE_CLOUD_CACHE] store skipped for ${target.archiveName}: ${error instanceof Error ? error.message : error}`);
      }
    }

    this.logger.info(`[ARCHIVE_CLOUD_CACHE] stored archives=${stored} skipped=${skipped} size=${this.formatFileSize(totalSize)}`);
  }

  computeKey(inputs: ArchiveBuildInputs): string {
    return this.sha256String(this.canonicalJson(inputs));
  }

  getEntryDir(key: string): string {
    return path.join(this.cacheDir, 'v1', key.substring(0, 2), key.substring(2, 4), key);
  }

  private async restoreOne(
    target: ArchiveTarget,
    inputs: ArchiveBuildInputs,
    key: string,
    buildArchivePath: string
  ): Promise<ArchiveCacheHit | null> {
    const localHit = await this.restoreLocal(target, key, buildArchivePath);
    if (localHit) {
      return localHit;
    }

    if (!this.shouldFetchRemote()) {
      this.logger.debug(`[ARCHIVE_CLOUD_CACHE] remote fetch disabled, local miss ${target.archiveName} ${key}`);
      return null;
    }

    if (this.remoteDisabledForRun) {
      this.logger.debug(`[ARCHIVE_CLOUD_CACHE] miss ${target.archiveName} ${key}`);
      return null;
    }

    return await this.restoreRemote(target, inputs, key, buildArchivePath);
  }

  private async restoreLocal(target: ArchiveTarget, key: string, buildArchivePath: string): Promise<ArchiveCacheHit | null> {
    const entryDir = this.getEntryDir(key);
    const manifestPath = path.join(entryDir, 'manifest.json');
    const archivePath = path.join(entryDir, target.archiveName);

    if (!await fs.pathExists(manifestPath) || !await fs.pathExists(archivePath)) {
      return null;
    }

    if (!await this.verifyLocalEntry(entryDir, key, target)) {
      this.logger.warn(`[ARCHIVE_CLOUD_CACHE] local verify failed ${target.archiveName} ${key}`);
      return null;
    }

    await this.linkOrCopy(archivePath, buildArchivePath);
    this.logger.debug(`[ARCHIVE_CLOUD_CACHE] local hit ${target.archiveName} ${key}`);
    return {
      dependencyName: target.dependencyName,
      dependencyType: target.dependencyType,
      archiveName: target.archiveName,
      buildArchivePath,
      cacheKey: key,
      source: 'local'
    };
  }

  private async restoreRemote(
    target: ArchiveTarget,
    inputs: ArchiveBuildInputs,
    key: string,
    buildArchivePath: string
  ): Promise<ArchiveCacheHit | null> {
    const baseUrl = this.getRemoteBaseUrl();
    if (!baseUrl) {
      return null;
    }

    const manifestUrl = this.joinRemoteUrl(baseUrl, key, 'manifest.json');
    let manifestResponse: FetchResponse;
    try {
      manifestResponse = await this.fetchRemote(manifestUrl, DEFAULT_REMOTE_TIMEOUT_MS);
    } catch (error) {
      this.remoteDisabledForRun = true;
      this.logger.debug(`[ARCHIVE_CLOUD_CACHE] remote disabled for this run: ${error instanceof Error ? error.message : error}`);
      return null;
    }

    if (manifestResponse.statusCode === 404) {
      this.logger.debug(`[ARCHIVE_CLOUD_CACHE] remote miss ${target.archiveName} ${key}`);
      return null;
    }

    if (manifestResponse.statusCode !== 200) {
      this.remoteDisabledForRun = true;
      this.logger.debug(`[ARCHIVE_CLOUD_CACHE] remote status ${manifestResponse.statusCode}, disabled for this run`);
      return null;
    }

    let manifest: ArchiveManifest;
    try {
      manifest = JSON.parse(manifestResponse.body.toString('utf8'));
    } catch (error) {
      this.logger.warn(`[ARCHIVE_CLOUD_CACHE] invalid remote manifest ${target.archiveName} ${key}`);
      return null;
    }

    if (!this.isManifestUsable(manifest, key, target)) {
      this.logger.warn(`[ARCHIVE_CLOUD_CACHE] remote manifest mismatch ${target.archiveName} ${key}`);
      return null;
    }

    const artifactUrl = this.joinRemoteUrl(baseUrl, key, manifest.artifact.file);
    await fs.remove(buildArchivePath).catch(() => undefined);
    this.logger.debug(`[ARCHIVE_CLOUD_CACHE] remote hit scheduled ${target.archiveName} ${key}`);

    return {
      dependencyName: target.dependencyName,
      dependencyType: target.dependencyType,
      archiveName: target.archiveName,
      buildArchivePath,
      cacheKey: key,
      source: 'remote',
      fetch: {
        schema: FETCH_REQUEST_SCHEMA,
        key,
        archiveName: target.archiveName,
        dependencyName: target.dependencyName,
        dependencyType: target.dependencyType,
        artifactUrl,
        artifactSha256: manifest.artifact.sha256,
        artifactSize: manifest.artifact.size,
        timeoutMs: this.getArtifactTimeoutMs(manifest.artifact.size),
        cacheDir: this.cacheDir,
        cacheSchema: CACHE_SCHEMA,
        keyVersion: KEY_VERSION,
        inputsJson: this.canonicalJson(inputs),
        builderVersion: await this.getAilyBuilderVersion()
      }
    };
  }

  private async fetchRemoteArchive(hit: ArchiveCacheHit): Promise<ArchiveCacheFetchResult> {
    const fetch = hit.fetch;
    if (!fetch || fetch.schema !== FETCH_REQUEST_SCHEMA) {
      return {
        key: hit.cacheKey,
        hit,
        success: false,
        error: 'missing or invalid fetch request'
      };
    }

    try {
      const artifactResponse = await this.fetchRemote(fetch.artifactUrl, fetch.timeoutMs);
      if (artifactResponse.statusCode !== 200) {
        return {
          key: hit.cacheKey,
          hit,
          success: false,
          error: `remote artifact status ${artifactResponse.statusCode}`
        };
      }

      const artifactHash = this.sha256Buffer(artifactResponse.body);
      if (artifactHash !== fetch.artifactSha256 || artifactResponse.body.length !== fetch.artifactSize) {
        return {
          key: hit.cacheKey,
          hit,
          success: false,
          error: 'remote artifact verify failed'
        };
      }

      const inputs = JSON.parse(fetch.inputsJson) as ArchiveBuildInputs;
      const target = this.createTargetFromFetch(fetch);
      await this.writeEntryFromBuffer(target, inputs, fetch.key, artifactResponse.body, 'cloud-download');

      if (!await this.verifyLocalEntry(this.getEntryDir(fetch.key), fetch.key, target)) {
        return {
          key: hit.cacheKey,
          hit,
          success: false,
          error: 'downloaded entry failed local verification'
        };
      }

      const localArchivePath = path.join(this.getEntryDir(fetch.key), fetch.archiveName);
      await this.linkOrCopy(localArchivePath, hit.buildArchivePath);
      this.logger.debug(`[ARCHIVE_CLOUD_CACHE] remote download ready ${fetch.archiveName} ${fetch.key}`);

      return {
        key: hit.cacheKey,
        hit,
        success: true
      };
    } catch (error) {
      this.remoteDisabledForRun = true;
      return {
        key: hit.cacheKey,
        hit,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private createTargetFromFetch(fetch: ArchiveCacheFetchRequest): ArchiveTarget {
    return {
      dependency: undefined as any,
      dependencyName: fetch.dependencyName,
      dependencyType: fetch.dependencyType,
      archiveName: fetch.archiveName
    };
  }

  private async storeOne(
    target: ArchiveTarget,
    inputs: ArchiveBuildInputs,
    sourceArchivePath: string,
    origin: 'local-build'
  ): Promise<number> {
    const key = this.computeKey(inputs);
    const entryDir = this.getEntryDir(key);
    const manifestPath = path.join(entryDir, 'manifest.json');

    if (await fs.pathExists(manifestPath)) {
      if (await this.verifyLocalEntry(entryDir, key, target)) {
        return 0;
      }
      this.logger.warn(`[ARCHIVE_CLOUD_CACHE] existing entry mismatch, keeping old entry ${target.archiveName} ${key}`);
      return 0;
    }

    const stat = await fs.stat(sourceArchivePath);
    await this.writeEntryFromFile(target, inputs, key, sourceArchivePath, origin);
    this.logger.debug(`[ARCHIVE_CLOUD_CACHE] stored ${target.archiveName} ${key}`);
    return stat.size;
  }

  private async computeInputs(target: ArchiveTarget, dependencies: Dependency[], compileConfig: any): Promise<ArchiveBuildInputs> {
    const platform = compileConfig?.arduino?.platform || {};
    const sourceFiles = await this.collectSourceFiles(target.dependency);
    const sourceRoot = target.dependency.path || '';
    const projectConfigFiles = await this.collectProjectConfigFiles();
    const responseFiles = await this.collectResponseFiles(compileConfig);
    const compileArgs = this.createCompileSignature(dependencies, compileConfig);

    return {
      schema: INPUT_SCHEMA,
      target: {
        kind: target.dependencyType,
        name: target.dependencyName,
        archiveName: target.archiveName
      },
      builder: {
        keyVersion: KEY_VERSION
      },
      board: this.createBoardSignature(platform),
      toolchain: await this.createToolchainSignature(compileConfig),
      sdk: await this.createSdkSignature(platform, compileConfig),
      compile: {
        effectiveCompileArgs: compileArgs,
        responseFilesHash: await this.hashFilesByNameAndContent(responseFiles)
      },
      sources: {
        sourceHash: await this.hashFiles(sourceFiles, sourceRoot),
        projectConfigHeaderHash: await this.hashFilesByNameAndContent(projectConfigFiles)
      }
    };
  }

  private async collectTargets(dependencies: Dependency[]): Promise<ArchiveTarget[]> {
    const targets: ArchiveTarget[] = [];
    for (const dependency of dependencies) {
      if (!dependency.includes || dependency.includes.length === 0) {
        continue;
      }

      if (dependency.type === 'core' || dependency.name === 'core') {
        targets.push({
          dependency,
          dependencyName: dependency.name,
          dependencyType: 'core',
          archiveName: 'core.a'
        });
      } else if (dependency.type === 'library') {
        const eligibility = await this.getLibraryArchiveEligibility(dependency);
        if (!eligibility.eligible) {
          this.logger.debug(
            `[ARCHIVE_CLOUD_CACHE] skip ${dependency.name}.a: ` +
            `compiled files=${eligibility.sourceFileCount}, ` +
            `compiled size=${this.formatFileSize(eligibility.sourceFileSize)} ` +
            `(requires >${LIBRARY_ARCHIVE_CACHE_MIN_COMPILE_FILES} files or >=${this.formatFileSize(LIBRARY_ARCHIVE_CACHE_MIN_COMPILE_BYTES)})`
          );
          continue;
        }

        targets.push({
          dependency,
          dependencyName: dependency.name,
          dependencyType: 'library',
          archiveName: `${dependency.name}.a`
        });
      }
    }
    return targets;
  }

  private async getLibraryArchiveEligibility(dependency: Dependency): Promise<{
    eligible: boolean;
    sourceFileCount: number;
    sourceFileSize: number;
  }> {
    const sourceFiles = this.collectCompiledSourceFiles(dependency.includes || []);
    let sourceFileSize = 0;

    for (const sourceFile of sourceFiles) {
      try {
        const stat = await fs.stat(sourceFile);
        if (stat.isFile()) {
          sourceFileSize += stat.size;
        }
      } catch {
        // Missing source files will fail the normal build path; keep cache filtering non-fatal.
      }
    }

    return {
      eligible:
        sourceFiles.length > LIBRARY_ARCHIVE_CACHE_MIN_COMPILE_FILES ||
        sourceFileSize >= LIBRARY_ARCHIVE_CACHE_MIN_COMPILE_BYTES,
      sourceFileCount: sourceFiles.length,
      sourceFileSize
    };
  }

  private collectCompiledSourceFiles(files: string[]): string[] {
    return Array.from(new Set(
      files
        .filter(file => this.isCompiledSourceFile(file))
        .map(file => path.resolve(file))
    )).sort((a, b) => this.normalizePath(a).localeCompare(this.normalizePath(b)));
  }

  private isCompiledSourceFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.c' || ext === '.cpp' || ext === '.s';
  }

  private async collectSourceFiles(dependency: Dependency): Promise<string[]> {
    const files = new Set<string>();
    for (const file of dependency.includes || []) {
      files.add(path.resolve(file));
    }

    if (dependency.path && await fs.pathExists(dependency.path)) {
      try {
        const scanned = await glob(['**/*.{h,hpp,hh,c,cpp,S,s}', 'library.properties'], {
          cwd: dependency.path,
          absolute: true,
          nodir: true,
          ignore: ['**/examples/**', '**/extras/**']
        });
        for (const file of scanned) {
          files.add(path.resolve(file));
        }
      } catch (error) {
        this.logger.debug(`[ARCHIVE_CLOUD_CACHE] failed to scan ${dependency.name}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return Array.from(files).sort((a, b) => this.normalizePath(a).localeCompare(this.normalizePath(b)));
  }

  private async collectProjectConfigFiles(): Promise<string[]> {
    const names = [
      'lv_conf.h',
      'User_Setup.h',
      'config.h',
      'sdkconfig.h',
      'build_opt.h',
      'file_opts'
    ];
    const dirs = [
      process.env['SKETCH_DIR_PATH'],
      process.env['BUILD_PATH'],
      process.cwd()
    ].filter(Boolean) as string[];

    const result = new Set<string>();
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.resolve(dir, name);
        if (await fs.pathExists(candidate)) {
          result.add(candidate);
        }
      }
    }

    return Array.from(result).sort((a, b) => this.normalizePath(a).localeCompare(this.normalizePath(b)));
  }

  private async collectResponseFiles(compileConfig: any): Promise<string[]> {
    const args = [
      compileConfig?.args?.c,
      compileConfig?.args?.cpp,
      compileConfig?.args?.s
    ].filter(Boolean) as string[];

    const files = new Set<string>();
    const responsePattern = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
    for (const argString of args) {
      let match: RegExpExecArray | null;
      while ((match = responsePattern.exec(argString)) !== null) {
        const rawPath = match[1] || match[2] || match[3];
        const resolved = path.resolve(rawPath);
        if (await fs.pathExists(resolved)) {
          files.add(resolved);
        }
      }
    }

    return Array.from(files).sort((a, b) => this.normalizePath(a).localeCompare(this.normalizePath(b)));
  }

  private createCompileSignature(dependencies: Dependency[], compileConfig: any): Record<string, any> {
    return {
      c: this.normalizeCompileString(compileConfig?.args?.c || '', dependencies),
      cpp: this.normalizeCompileString(compileConfig?.args?.cpp || '', dependencies),
      s: this.normalizeCompileString(compileConfig?.args?.s || '', dependencies)
    };
  }

  private createBoardSignature(platform: Record<string, any>): Record<string, any> {
    return {
      fqbn: platform['build.fqbn'] || '',
      build: this.pickPrefix(platform, 'build.')
    };
  }

  private async createToolchainSignature(compileConfig: any): Promise<Record<string, any>> {
    const compiler = compileConfig?.compiler || {};
    const cppCommand = compiler.cpp || '';
    const cCommand = compiler.c || '';
    const arCommand = compiler.ar || '';

    return {
      c: this.getCommandIdentity(cCommand),
      cpp: this.getCommandIdentity(cppCommand),
      ar: this.getCommandIdentity(arCommand),
      cppVersion: await this.getCommandVersion(cppCommand),
      cVersion: await this.getCommandVersion(cCommand),
      arVersion: await this.getCommandVersion(arCommand)
    };
  }

  private async createSdkSignature(platform: Record<string, any>, compileConfig: any): Promise<Record<string, any>> {
    const cacheIdentity = compileConfig?.cacheIdentity || {};
    const runtimePlatformPath = platform['runtime.platform.path'] || process.env['SDK_PATH'] || '';
    const sdkIdentity = typeof cacheIdentity.sdkIdentity === 'string' && cacheIdentity.sdkIdentity
      ? cacheIdentity.sdkIdentity
      : extractPackageIdentityFromPath(runtimePlatformPath || process.env['SDK_PATH'] || '', process.env['platform']);
    const toolPackages = Array.isArray(cacheIdentity.toolPackages) && cacheIdentity.toolPackages.length > 0
      ? Array.from(new Set(cacheIdentity.toolPackages.filter((value: any) => typeof value === 'string' && value))).sort()
      : this.collectCompileRelevantToolPackages(platform, compileConfig);

    const signature: Record<string, any> = {};
    if (sdkIdentity) {
      signature.identity = sdkIdentity;
    }
    if (toolPackages.length > 0) {
      signature.toolPackages = toolPackages;
    }

    if (sdkIdentity) {
      return signature;
    }

    const files = [
      runtimePlatformPath ? path.join(runtimePlatformPath, 'platform.txt') : '',
      runtimePlatformPath ? path.join(runtimePlatformPath, 'boards.txt') : '',
      process.env['SDK_PATH'] ? path.join(process.env['SDK_PATH']!, 'platform.txt') : '',
      process.env['SDK_PATH'] ? path.join(process.env['SDK_PATH']!, 'boards.txt') : ''
    ].filter(Boolean);

    signature.manifestHash = await this.hashFilesByNameAndContent(files);
    return signature;
  }

  private collectCompileRelevantToolPackages(platform: Record<string, any>, compileConfig: any): string[] {
    const compileText = [
      compileConfig?.args?.c,
      compileConfig?.args?.cpp,
      compileConfig?.args?.s,
      compileConfig?.compiler?.c,
      compileConfig?.compiler?.cpp,
      compileConfig?.compiler?.ar
    ].filter(Boolean).join('\n').replace(/\\/g, '/');

    const paths: string[] = [];
    for (const [key, value] of Object.entries(platform || {})) {
      if (typeof value !== 'string') {
        continue;
      }

      const normalized = value.replace(/\\/g, '/');
      if (key === 'compiler.sdk.path' || (key.startsWith('runtime.tools.') && compileText.includes(normalized))) {
        paths.push(value);
      }
    }

    return collectPackageIdentitiesFromPaths(paths);
  }

  private pickPrefix(source: Record<string, any>, prefix: string): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith(prefix) && typeof value !== 'function') {
        result[key] = this.normalizeValue(value);
      }
    }
    return result;
  }

  private normalizeCompileString(value: string, dependencies: Dependency[]): string {
    let result = this.normalizePath(value || '');
    const replacements: Array<[string | undefined, string]> = [
      [process.env['BUILD_PATH'], '$BUILD_PATH'],
      [process.env['SKETCH_DIR_PATH'], '$SKETCH_DIR_PATH'],
      [process.env['SKETCH_PATH'], '$SKETCH_PATH'],
      [process.env['SDK_PATH'], '$SDK_PATH'],
      [process.env['TOOLS_PATH'], '$TOOLS_PATH'],
      [process.env['COMPILER_PATH'], '$COMPILER_PATH'],
      [os.homedir(), '~']
    ];

    for (const dep of dependencies) {
      replacements.push([dep.path, `$DEP_${dep.name.replace(/[^a-zA-Z0-9]/g, '_')}`]);
    }

    for (const [from, to] of replacements) {
      if (!from) continue;
      result = result.split(this.normalizePath(from)).join(to);
    }

    return result;
  }

  private normalizeValue(value: any): any {
    if (typeof value === 'string') {
      return this.normalizeCompileString(value, []);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.normalizeValue(item));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, any> = {};
      for (const [key, child] of Object.entries(value)) {
        result[key] = this.normalizeValue(child);
      }
      return result;
    }
    return value;
  }

  private normalizeIdentity(value: string): string {
    if (!value) return '';
    return this.normalizeCompileString(value, []);
  }

  private normalizePath(value: string): string {
    return value.replace(/\\/g, '/');
  }

  private async verifyLocalEntry(entryDir: string, key: string, target: ArchiveTarget): Promise<boolean> {
    try {
      const manifestPath = path.join(entryDir, 'manifest.json');
      const archivePath = path.join(entryDir, target.archiveName);
      const manifest = await fs.readJson(manifestPath) as ArchiveManifest;

      if (!this.isManifestUsable(manifest, key, target)) {
        return false;
      }

      const stat = await fs.stat(archivePath);
      if (stat.size !== manifest.artifact.size) {
        return false;
      }

      const artifactHash = await this.hashFile(archivePath);
      return artifactHash === manifest.artifact.sha256;
    } catch (error) {
      return false;
    }
  }

  private isManifestUsable(manifest: ArchiveManifest, key: string, target: ArchiveTarget): boolean {
    return !!manifest &&
      manifest.schema === CACHE_SCHEMA &&
      manifest.keyAlgorithm === 'sha256' &&
      manifest.key === key &&
      manifest.target?.kind === target.dependencyType &&
      manifest.target?.name === target.dependencyName &&
      manifest.target?.archiveName === target.archiveName &&
      manifest.artifact?.file === target.archiveName &&
      typeof manifest.artifact?.sha256 === 'string' &&
      typeof manifest.artifact?.size === 'number' &&
      manifest.builder?.keyVersion === KEY_VERSION;
  }

  private async writeEntryFromFile(
    target: ArchiveTarget,
    inputs: ArchiveBuildInputs,
    key: string,
    sourceArchivePath: string,
    origin: 'local-build' | 'cloud-download'
  ): Promise<void> {
    const artifactHash = await this.hashFile(sourceArchivePath);
    const stat = await fs.stat(sourceArchivePath);
    await this.writeEntry(target, inputs, key, origin, artifactHash, stat.size, async (archivePath) => {
      try {
        await fs.link(sourceArchivePath, archivePath);
      } catch {
        await fs.copy(sourceArchivePath, archivePath);
      }
    });
  }

  private async writeEntryFromBuffer(
    target: ArchiveTarget,
    inputs: ArchiveBuildInputs,
    key: string,
    archiveBuffer: Buffer,
    origin: 'local-build' | 'cloud-download'
  ): Promise<void> {
    const artifactHash = this.sha256Buffer(archiveBuffer);
    await this.writeEntry(target, inputs, key, origin, artifactHash, archiveBuffer.length, async (archivePath) => {
      await fs.writeFile(archivePath, archiveBuffer);
    });
  }

  private async writeEntry(
    target: ArchiveTarget,
    inputs: ArchiveBuildInputs,
    key: string,
    origin: 'local-build' | 'cloud-download',
    artifactHash: string,
    artifactSize: number,
    writeArchive: (archivePath: string) => Promise<void>
  ): Promise<void> {
    const entryDir = this.getEntryDir(key);
    const tmpDir = path.join(this.cacheDir, '.tmp', `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const archivePath = path.join(tmpDir, target.archiveName);
    const inputsPath = path.join(tmpDir, 'inputs.json');
    const manifestPath = path.join(tmpDir, 'manifest.json');

    await fs.ensureDir(tmpDir);
    try {
      await writeArchive(archivePath);

      const inputsJson = this.canonicalJson(inputs);
      const inputsHash = this.sha256String(inputsJson);
      await fs.writeFile(inputsPath, inputsJson, 'utf8');

      const manifest: ArchiveManifest = {
        schema: CACHE_SCHEMA,
        keyAlgorithm: 'sha256',
        key,
        createdAt: new Date().toISOString(),
        origin,
        target: {
          kind: target.dependencyType,
          name: target.dependencyName,
          archiveName: target.archiveName
        },
        artifact: {
          file: target.archiveName,
          sha256: artifactHash,
          size: artifactSize
        },
        inputs: {
          file: 'inputs.json',
          sha256: inputsHash
        },
        builder: {
          ailyBuilderVersion: await this.getAilyBuilderVersion(),
          keyVersion: KEY_VERSION
        }
      };

      await fs.writeFile(manifestPath, this.canonicalJson(manifest), 'utf8');
      await fs.ensureDir(path.dirname(entryDir));

      if (await fs.pathExists(entryDir)) {
        await fs.remove(tmpDir);
        return;
      }

      await fs.move(tmpDir, entryDir, { overwrite: false });
    } catch (error) {
      await fs.remove(tmpDir).catch(() => undefined);
      throw error;
    }
  }

  private async linkOrCopy(sourcePath: string, targetPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(targetPath));
    await fs.remove(targetPath).catch(() => undefined);
    try {
      await fs.link(sourcePath, targetPath);
    } catch {
      await fs.copy(sourcePath, targetPath);
    }
  }

  private async hashFiles(files: string[], baseDir?: string): Promise<string> {
    const normalized = Array.from(new Set(files.filter(Boolean).map(file => path.resolve(file))))
      .sort((a, b) => this.normalizePath(a).localeCompare(this.normalizePath(b)));
    const hash = createHash('sha256');
    const resolvedBaseDir = baseDir ? path.resolve(baseDir) : '';
    for (const file of normalized) {
      const identity = resolvedBaseDir && this.isPathInside(file, resolvedBaseDir)
        ? this.normalizePath(path.relative(resolvedBaseDir, file))
        : this.normalizeIdentity(file);
      hash.update(identity);
      hash.update('\0');
      if (await fs.pathExists(file)) {
        hash.update(await this.hashFile(file));
      } else {
        hash.update('<missing>');
      }
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  private async hashFilesByNameAndContent(files: string[]): Promise<string> {
    const entries: Array<{ name: string; hash: string; size: number }> = [];
    const normalized = Array.from(new Set(files.filter(Boolean).map(file => path.resolve(file))))
      .sort((a, b) => this.normalizePath(a).localeCompare(this.normalizePath(b)));

    for (const file of normalized) {
      if (!await fs.pathExists(file)) {
        entries.push({ name: path.basename(file), hash: '<missing>', size: 0 });
        continue;
      }

      const stat = await fs.stat(file);
      entries.push({
        name: path.basename(file),
        hash: await this.hashFile(file),
        size: stat.size
      });
    }

    entries.sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      return nameCompare || a.hash.localeCompare(b.hash) || a.size - b.size;
    });

    return this.sha256String(this.canonicalJson(entries));
  }

  private isPathInside(filePath: string, dirPath: string): boolean {
    const relative = path.relative(dirPath, filePath);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private async hashFile(filePath: string): Promise<string> {
    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved);
    const cached = this.fileHashCache.get(`${resolved}:${stat.size}:${stat.mtimeMs}`);
    if (cached) {
      return cached;
    }

    const buffer = await fs.readFile(resolved);
    const hash = this.sha256Buffer(buffer);
    this.fileHashCache.set(`${resolved}:${stat.size}:${stat.mtimeMs}`, hash);
    return hash;
  }

  private async getCommandVersion(command: string): Promise<string> {
    if (!command) return '';
    if (this.compilerVersionCache.has(command)) {
      return this.compilerVersionCache.get(command)!;
    }

    try {
      const result = spawnSync(command, ['--version'], {
        encoding: 'utf8',
        timeout: 1500,
        env: this.createToolEnv()
      });
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).slice(0, 3).join('\n');
      this.compilerVersionCache.set(command, output);
      return output;
    } catch {
      this.compilerVersionCache.set(command, '');
      return '';
    }
  }

  private getCommandIdentity(command: string): string {
    const cleaned = command.replace(/^["']|["']$/g, '');
    if (!cleaned) {
      return '';
    }
    return path.basename(cleaned);
  }

  private createToolEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: [
        process.env['COMPILER_PATH'],
        process.env['ESPTOOL_PY_PATH'],
        process.env['PATH']
      ].filter(Boolean).join(path.delimiter)
    };
  }

  private async getAilyBuilderVersion(): Promise<string> {
    if (this.packageVersion) {
      return this.packageVersion;
    }

    const candidates = [
      path.resolve(__dirname, '..', 'package.json'),
      path.resolve(__dirname, '..', '..', 'package.json'),
      path.resolve(process.cwd(), 'package.json')
    ];

    for (const candidate of candidates) {
      try {
        if (await fs.pathExists(candidate)) {
          const pkg = await fs.readJson(candidate);
          if (pkg?.version) {
            this.packageVersion = String(pkg.version);
            return this.packageVersion;
          }
        }
      } catch {
        // Try the next candidate.
      }
    }

    this.packageVersion = 'unknown';
    return this.packageVersion;
  }

  private async fetchRemote(url: string, timeoutMs: number): Promise<FetchResponse> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const request = client.get(url, { timeout: timeoutMs }, (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;
        if (location && [301, 302, 307, 308].includes(statusCode)) {
          request.destroy();
          const redirected = new URL(location, url).toString();
          this.fetchRemote(redirected, timeoutMs).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          resolve({ statusCode, body: Buffer.concat(chunks) });
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
      request.on('error', reject);
    });
  }

  private joinRemoteUrl(baseUrl: string, key: string, fileName: string): string {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    return `${cleanBase}/${key.substring(0, 2)}/${key.substring(2, 4)}/${key}/${encodeURIComponent(fileName)}`;
  }

  private getRemoteBaseUrl(): string {
    return (process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE_URL'] || DEFAULT_REMOTE_BASE_URL).replace(/\/+$/, '');
  }

  private getConfiguredCacheDir(): string {
    if (process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR']) {
      return path.resolve(process.env['AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR']);
    }

    if (os.platform() === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Local', 'aily-builder', 'archive-cloud-cache');
    }
    if (os.platform() === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Caches', 'aily-builder', 'archive-cloud-cache');
    }
    return path.join(os.homedir(), '.cache', 'aily-builder', 'archive-cloud-cache');
  }

  private isLocalOnly(): boolean {
    return this.readBooleanEnv('AILY_BUILDER_ARCHIVE_CLOUD_CACHE_LOCAL_ONLY', false);
  }

  private shouldFetchRemote(): boolean {
    return !this.isLocalOnly() && this.readBooleanEnv('AILY_BUILDER_FETCH_ARCHIVE_CLOUD_CACHE', true);
  }

  private readBooleanEnv(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];
    if (value === undefined || value === '') {
      return defaultValue;
    }
    return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
  }

  private getArtifactTimeoutMs(size: number): number {
    const sizeMb = Math.max(1, Math.ceil(size / (1024 * 1024)));
    return Math.max(DEFAULT_REMOTE_TIMEOUT_MS, Math.min(30000, sizeMb * 2000));
  }

  private sha256String(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private sha256Buffer(value: Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private canonicalJson(value: any): string {
    return JSON.stringify(this.sortForJson(value));
  }

  private sortForJson(value: any): any {
    if (Array.isArray(value)) {
      return value.map(item => this.sortForJson(item));
    }
    if (value && typeof value === 'object') {
      const sorted: Record<string, any> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = this.sortForJson(value[key]);
      }
      return sorted;
    }
    return value;
  }

  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index++;
    }
    return `${size.toFixed(1)}${units[index]}`;
  }
}

interface FetchResponse {
  statusCode: number;
  body: Buffer;
}
