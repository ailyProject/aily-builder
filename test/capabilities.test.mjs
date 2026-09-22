import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cliEntryPath = path.join(repositoryRoot, 'dist', 'main.js');
assert.ok(
  readFileSync(cliEntryPath, 'utf8').startsWith('#!/usr/bin/env node\n'),
  'dist/main.js must retain a Node shebang so npm-generated CLI shims invoke Node',
);
const result = spawnSync(
  process.execPath,
  [cliEntryPath, 'capabilities', '--json'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  },
);

assert.equal(result.status, 0, result.stderr);
const capabilities = JSON.parse(result.stdout);
assert.deepEqual(capabilities.capabilities.buildPackageInputs, {
  schemaVersion: 1, enabledBy: '--record-build-inputs', scope: 'resolved-sdk-tool-trees',
  verification: 'content-and-state-at-build-boundaries', manifestField: 'build.inputs', currentProjectFreshness: false,
});
assert.deepEqual(capabilities.capabilities.buildWorkspaceLease, {
  schemaVersion: 1, ownerFileName: 'aily-workspace.lock', delegateFileName: 'aily-builder.lock',
  delegationEnvironment: 'AILY_BUILDER_WORKSPACE', operations: ['compile', 'preprocess', 'clean', 'verify'],
});
assert.deepEqual(capabilities.capabilities.buildInputVerification, {
  schemaVersion: 1, command: 'verify-build-inputs', contextFileName: 'aily-build-input-context.json',
  contextStorage: 'host-private', scope: 'prepared-dependency-trees-and-sdk-tools', currentProjectFreshness: false,
});
assert.deepEqual(capabilities.capabilities.buildInputRecord, {
  schemaVersion: 1, cliOption: '--record-build-inputs', manifestField: 'build.inputs',
  storage: 'sidecar-reference', defaultFileName: 'aily-build-inputs.json',
  scope: 'prepared-dependency-trees', currentProjectFreshness: false,
});
assert.equal(capabilities.schemaVersion, 1);
assert.equal(capabilities.service, 'aily-builder');
assert.equal(capabilities.version, JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version);
assert.deepEqual(
  capabilities.capabilities.simulationArtifactManifest,
  {
    schemaVersion: 1,
    cliOption: '--emit-artifact-manifest',
    defaultFileName: 'aily-artifact-manifest.json',
  },
);
assert.deepEqual(
  capabilities.capabilities.sceneGraphProvenance,
  {
    schemaVersion: 1,
    cliOption: '--graph-semantic-revision',
    sourceDocumentSchemaOption: '--scene-document-schema-version',
    gpioDirectionsOption: '--scene-gpio-directions',
    gpioPullsOption: '--scene-gpio-pulls',
    manifestField: 'build.graph',
  },
);
assert.deepEqual(
  capabilities.capabilities.blockSourceMap,
  {
    schemaVersion: 1,
    inputFileName: 'aily-block-source-map.json',
    artifactRole: 'source-map',
  },
);
assert.deepEqual(
  capabilities.capabilities.debugSourceSnapshot,
  {
    schemaVersion: 1,
    outputFileName: 'aily-debug-source.txt',
    artifactRole: 'debug-source',
    maxSizeBytes: 2 * 1024 * 1024,
  },
);
assert.deepEqual(
  capabilities.capabilities.debugInstrumentation,
  {
    schemaVersion: 1,
    detection: 'linked-symbol',
    outputFileName: 'aily-debug-instrumentation.json',
    artifactRole: 'debug-instrumentation',
    supportedAbis: [{
      name: 'aily.freertos-object-registry',
      version: 1,
    }],
  },
);
assert.deepEqual(
  capabilities.capabilities.debugMemoryMap,
  {
    schemaVersion: 1,
    outputFileName: 'aily-debug-memory-map.json',
    artifactRole: 'memory-map',
    source: 'gnu-linker-memory-configuration',
  },
);

console.log('builder capabilities contract: ok');
