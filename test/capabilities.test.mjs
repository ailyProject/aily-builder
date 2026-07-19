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
assert.equal(capabilities.schemaVersion, 1);
assert.equal(capabilities.service, 'aily-builder');
assert.equal(capabilities.version, '1.3.0');
assert.deepEqual(
  capabilities.capabilities.simulationArtifactManifest,
  {
    schemaVersion: 1,
    cliOption: '--emit-artifact-manifest',
    defaultFileName: 'aily-artifact-manifest.json',
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
  capabilities.capabilities.debugMemoryMap,
  {
    schemaVersion: 1,
    outputFileName: 'aily-debug-memory-map.json',
    artifactRole: 'memory-map',
    source: 'gnu-linker-memory-configuration',
  },
);

console.log('builder capabilities contract: ok');
