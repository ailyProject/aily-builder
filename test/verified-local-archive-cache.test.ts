import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArchiveCloudCacheManager, getArchiveDependencyKey } from '../src/ArchiveCloudCacheManager';
import type { Dependency } from '../src/DependencyAnalyzer';
import { parseNinjaArchiveDependencies } from '../src/VerifiedArchiveInputs';
import { Logger } from '../src/utils/Logger';

test('verified archives move across frozen roots and reject changed or uncovered native inputs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-verified-archive-'));
  const env = [
    'AILY_BUILDER_ARCHIVE_CLOUD_CACHE',
    'AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR',
    'AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE',
    'AILY_BUILDER_VERIFIED_LOCAL_ARCHIVE_CACHE',
    'AILY_BUILDER_VERIFIED_ARCHIVE_PATH_MAP',
    'BUILD_PATH',
    'SKETCH_DIR_PATH',
    'SKETCH_PATH'
  ];
  const original = Object.fromEntries(env.map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE = '1';
  process.env.AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR = path.join(root, 'archives');
  process.env.AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE = '0';
  process.env.AILY_BUILDER_VERIFIED_LOCAL_ARCHIVE_CACHE = '1';
  const compilerProbe = path.join(root, 'include-search.cjs');
  await fs.writeFile(compilerProbe, [
    'process.stderr.write(\'#include <...> search starts here:\\n\');',
    'const args = process.argv.slice(2);',
    'for (const arg of args) {',
    '  if (arg.startsWith(\'-I\')) process.stderr.write(\' \'+arg.slice(2)+\'\\n\');',
    '}',
    'process.stderr.write(\'End of search list.\\n\');',
    'const input = require(\'node:fs\').readFileSync(0, \'utf8\');',
    'for (const [, spelling] of input.matchAll(/^#line 1 (.*)$/gm)) {',
    '  const file = JSON.parse(spelling);',
    '  const [from, to] = args.filter(arg => arg.startsWith(\'-ffile-prefix-map=\')).map(arg => arg.split(\'=\').slice(1)).find(([from]) => file.startsWith(from)) || [];',
    '  if (from) process.stdout.write(JSON.stringify(to + file.slice(from.length)) + \'\\n\');',
    '}'
  ].join('\n'));
  const archiver = path.join(root, 'archiver-fixture.exe');
  await fs.writeFile(archiver, 'archiver-v1');
  const key = getArchiveDependencyKey('library', 'Panel');

  async function prepare(
    name: string, spi: string, generated: string, sketchText = 'void setup() {}',
    logicalRoot: string | null = path.join(root, 'original')
  ) {
    const project = path.join(root, name);
    const build = path.join(project, 'build');
    const sketch = path.join(project, 'sketch');
    const panel = path.join(project, 'Panel', 'src');
    const spiDirectory = path.join(project, 'SPI', 'src');
    const generatedDirectory = path.join(build, 'generated');
    await Promise.all([sketch, panel, spiDirectory, generatedDirectory].map(dir => fs.mkdir(dir, { recursive: true })));
    const sketchPath = path.join(sketch, 'project.ino');
    const spiPath = path.join(spiDirectory, 'SPI.h');
    const generatedPath = path.join(generatedDirectory, 'generated.h');
    await fs.writeFile(sketchPath, sketchText);
    await fs.writeFile(spiPath, spi);
    await fs.writeFile(generatedPath, generated);
    await fs.writeFile(path.join(build, 'outer.rsp'), '@include.rsp');
    await fs.writeFile(path.join(build, 'include.rsp'), '"-Igenerated"');
    const sources = Array.from({ length: 21 }, (_, index) => path.join(panel, `panel${index}.cpp`));
    await Promise.all(sources.map(source => fs.writeFile(source, '#include <SPI.h>\n#include <generated.h>\n')));
    const dependencies: Dependency[] = [
      { type: 'library', name: 'Panel', path: panel, includes: sources },
      { type: 'library', name: 'SPI', path: spiDirectory, includes: [] }
    ];
    const compileConfig = {
      compiler: { cpp: process.execPath, ar: archiver },
      args: { cpp: `"${compilerProbe}" -c %INCLUDE_PATHS% @outer.rsp "%SOURCE_FILE_PATH%" -o "%OBJECT_FILE_PATH%"` }
    };
    process.env.BUILD_PATH = build;
    process.env.SKETCH_DIR_PATH = sketch;
    process.env.SKETCH_PATH = sketchPath;
    if (logicalRoot) {
      process.env.AILY_BUILDER_VERIFIED_ARCHIVE_PATH_MAP = JSON.stringify({ physicalRoot: project, logicalRoot });
    } else {
      delete process.env.AILY_BUILDER_VERIFIED_ARCHIVE_PATH_MAP;
    }
    const manager = new ArchiveCloudCacheManager(new Logger());
    const verified = await manager.prepareVerifiedBuild(dependencies, compileConfig);
    assert.ok(verified);
    const hits = await manager.restoreArchives(dependencies, compileConfig, verified);
    return { build, manager, verified, dependencies, compileConfig, hits, spiPath, generatedPath, sources };
  }

  const first = await prepare('first', '#define SPI_MODE 0', '#define PANEL_IO 1');
  assert.equal(first.hits.size, 0);
  assert.ok(first.manager.needsVerifiedArchiveReceipts());
  assert.ok(first.verified.covers(first.spiPath));
  assert.ok(first.verified.covers(first.generatedPath));
  const archive = path.join(first.build, 'Panel.a');
  await fs.writeFile(archive, 'panel-archive');
  await first.manager.storeArchives(first.dependencies, first.compileConfig, first.hits);
  await first.manager.storeArchives(first.dependencies, first.compileConfig, first.hits, new Map([
    [key, [...first.sources, path.join(root, 'unknown.h')]]
  ]));

  const uncovered = await prepare('uncovered', '#define SPI_MODE 0', '#define PANEL_IO 1');
  assert.equal(uncovered.hits.size, 0);
  await fs.writeFile(path.join(uncovered.build, 'Panel.a'), 'archive-stale');
  await fs.writeFile(uncovered.generatedPath, '#define PANEL_IO 2');
  await uncovered.manager.storeArchives(uncovered.dependencies, uncovered.compileConfig, uncovered.hits, new Map([
    [key, [...uncovered.sources, uncovered.spiPath, uncovered.generatedPath]]
  ]));
  await fs.writeFile(uncovered.generatedPath, '#define PANEL_IO 1');
  const cold = await prepare('cold', '#define SPI_MODE 0', '#define PANEL_IO 1');
  assert.equal(cold.hits.size, 0);
  await fs.writeFile(path.join(cold.build, 'Panel.a'), 'panel-archive');
  await cold.manager.storeArchives(cold.dependencies, cold.compileConfig, cold.hits, new Map([
    [key, [...cold.sources, cold.spiPath, cold.generatedPath]]
  ]));

  const warm = await prepare('warm', '#define SPI_MODE 0', '#define PANEL_IO 1', 'void setup() { changed(); }');
  assert.equal(warm.verified.fingerprint, cold.verified.fingerprint);
  assert.equal(warm.hits.get(key)?.source, 'local');
  assert.equal(await fs.readFile(path.join(warm.build, 'Panel.a'), 'utf8'), 'panel-archive');
  assert.equal(warm.manager.needsVerifiedArchiveReceipts(), false);
  assert.match(warm.manager.getEntryDir(warm.hits.get(key)!.cacheKey), /verified-local-v1/);
  assert.equal(await warm.manager.verifyBuildInputs(warm.dependencies, warm.compileConfig), true);
  await fs.writeFile(warm.spiPath, '#define SPI_MODE 1');
  assert.equal(await warm.manager.verifyBuildInputs(warm.dependencies, warm.compileConfig), false);
  assert.equal(await warm.manager.prepareVerifiedBuild([
    { ...warm.dependencies[0], type: 'core', name: 'core' }
  ], {}), undefined);

  const toolRace = await prepare('changed-tool', '#define SPI_MODE 0', '#define PANEL_IO 1');
  assert.equal(toolRace.hits.get(key)?.source, 'local');
  await fs.writeFile(archiver, 'archiver-v2');
  assert.equal(await toolRace.manager.verifyBuildInputs(toolRace.dependencies, toolRace.compileConfig), false);
  await fs.writeFile(archiver, 'archiver-v1');

  const changedHeader = await prepare('changed-spi', '#define SPI_MODE 1', '#define PANEL_IO 1');
  assert.equal(changedHeader.hits.size, 0);
  assert.notEqual(changedHeader.verified.fingerprint, cold.verified.fingerprint);
  const changedGenerated = await prepare('changed-generated', '#define SPI_MODE 0', '#define PANEL_IO 2');
  assert.equal(changedGenerated.hits.size, 0);
  assert.notEqual(changedGenerated.verified.fingerprint, cold.verified.fingerprint);
  const otherProject = await prepare('other-project', '#define SPI_MODE 0', '#define PANEL_IO 1', '', path.join(root, 'another'));
  assert.equal(otherProject.hits.size, 0);
  assert.notEqual(otherProject.verified.fingerprint, cold.verified.fingerprint);

  const unmapped = await prepare('physical', '#define SPI_MODE 0', '#define PANEL_IO 1', '', null);
  assert.deepEqual(unmapped.verified.compilerPathMapFlags, []);
  await fs.writeFile(path.join(unmapped.build, 'Panel.a'), 'physical-panel-archive');
  await unmapped.manager.storeArchives(unmapped.dependencies, unmapped.compileConfig, unmapped.hits, new Map([
    [key, [...unmapped.sources, unmapped.spiPath, unmapped.generatedPath]]
  ]));
  const samePath = await prepare('physical', '#define SPI_MODE 0', '#define PANEL_IO 1', '', null);
  assert.equal(samePath.hits.get(key)?.source, 'local');
  const otherPath = await prepare('other-physical', '#define SPI_MODE 0', '#define PANEL_IO 1', '', null);
  assert.equal(otherPath.hits.size, 0);
  process.env.AILY_BUILDER_VERIFIED_ARCHIVE_PATH_MAP = JSON.stringify({
    physicalRoot: path.dirname(otherPath.build), logicalRoot: path.join(root, 'unsafe%path')
  });
  assert.equal(await otherPath.manager.prepareVerifiedBuild(otherPath.dependencies, otherPath.compileConfig), undefined);

  delete process.env.AILY_BUILDER_VERIFIED_LOCAL_ARCHIVE_CACHE;
  const legacy = new ArchiveCloudCacheManager(new Logger());
  assert.equal(legacy.shouldGenerate(), false);
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(legacy.getEntryDir('abcde'))))), 'v2');
});

test('only complete valid native receipts can attest archive inputs', () => {
  const deps = parseNinjaArchiveDependencies([
    'library/Panel/panel.cpp.o: #deps 2, deps mtime 10 (VALID)',
    '    D:/source path/panel.cpp',
    '    D:/other library/SPI.h',
    '',
    'core/old.c.o: #deps 1, deps mtime 10 (STALE)',
    '    D:/core/old.c',
    '',
    'core/partial.c.o: #deps 2, deps mtime 10 (VALID)',
    '    D:/core/partial.c'
  ].join('\r\n'));
  assert.deepEqual([...deps], [
    ['library/Panel/panel.cpp.o', ['D:/source path/panel.cpp', 'D:/other library/SPI.h']]
  ]);
});
