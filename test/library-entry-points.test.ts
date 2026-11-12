import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { TestContext } from 'node:test';
import { getArchiveDependencyKey } from '../src/ArchiveCloudCacheManager';
import { Dependency, DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { LibraryIndexCache } from '../src/LibraryIndexCache';
import { NinjaGenerator } from '../src/NinjaGenerator';
import { Logger } from '../src/utils/Logger';

class QuietLogger extends Logger {
  readonly messages: string[] = [];
  debug(message: string): void { this.messages.push(message); }
  info(): void {}
  verbose(): void {}
  warn(): void {}
  error(): void {}
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-library-entry-'));
  const sketch = path.join(root, 'Sketch', 'Sketch.ino');
  const libraries = path.join(root, 'libraries');
  await fs.mkdir(path.dirname(sketch), { recursive: true });
  await fs.mkdir(libraries);
  const environment = {
    SKETCH_PATH: sketch,
    SKETCH_DIR_PATH: path.dirname(sketch),
    LIBRARIES_PATH: libraries,
    BUILD_PATH: path.join(root, 'build'),
    SDK_CORE_PATH: undefined,
    SDK_VARIANT_PATH: undefined,
    SDK_CORE_LIBRARIES_PATH: undefined,
    SDK_PATH: undefined,
    BUILD_MCU: undefined,
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const logger = new QuietLogger();
  // Keep both constructors' default user-cache creation out of these fixtures.
  const cache: LibraryIndexCache = Object.assign(Object.create(LibraryIndexCache.prototype), {
    logger,
    cacheDir: path.join(root, 'index-cache'),
  });
  const cacheReads: Array<{ name: string; hit: boolean }> = [];
  const getOrCreate = cache.getOrCreate.bind(cache);
  cache.getOrCreate = async (...args: Parameters<LibraryIndexCache['getOrCreate']>) => {
    const result = await getOrCreate(...args);
    cacheReads.push({ name: args[0], hit: result.cacheHit });
    return result;
  };
  const analyzer: DependencyAnalyzer = Object.assign(Object.create(DependencyAnalyzer.prototype), {
    logger,
    dependencyList: new Map(),
    macroDefinitions: new Map(),
    configuredMacros: new Map(),
    libraryMap: new Map(),
    libraryEntryPoints: new Map(),
    libraryIndexCache: cache,
    platformHeaderRoots: [],
    platformContextKey: '',
    compilerSearch: {},
    projectAndLibraryRoots: [],
  });

  return {
    root,
    analyzer,
    logger,
    cacheReads,
    async library(name: string, contents: Record<string, string>) {
      const sourceRoot = path.join(libraries, name, 'src');
      for (const [relative, content] of Object.entries(contents)) {
        const filename = path.join(sourceRoot, relative);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, content);
      }
      return sourceRoot;
    },
    async preprocess(
      includes: string,
      extraDefines = '',
      platformOverrides: Record<string, string> = {},
      compilerArguments?: { cpp?: string; c?: string }
    ) {
      // Exactly one ino and no companion C/C++ files: exercise the production
      // directive/index route, not the separate native-compiler sketch route.
      await fs.writeFile(sketch, `${includes}\nvoid setup() {}\nvoid loop() {}\n`);
      cacheReads.length = 0;
      logger.messages.length = 0;
      const result: Dependency[] = await analyzer.preprocess({
        fqbn: 'fixture:fixture:board',
        fqbnParsed: { package: 'fixture', platform: 'fixture', boardId: 'board' },
        platform: { 'recipe.cpp.o.pattern': `g++ -DARDUINO_ARCH_FIXTURE=1 ${extraDefines} %INCLUDE_PATHS%`, ...platformOverrides },
        board: {},
      }, compilerArguments);
      assert.equal(result.some(dependency => dependency.type === 'sketch'), false);
      return result.filter(dependency => dependency.type === 'library');
    },
    async read(
      includes: string,
      extraDefines = '',
      platformOverrides: Record<string, string> = {},
      compilerArguments?: { cpp?: string; c?: string }
    ) {
      return (await this.preprocess(includes, extraDefines, platformOverrides, compilerArguments)).map(dependency => dependency.name).sort();
    },
  };
}

async function selectableLibrary(f: Awaited<ReturnType<typeof fixture>>) {
  await f.library('Selectable', {
    'Local.h': '#pragma once\n#include <LocalClient.h>\n',
    'Cloud.h': '#pragma once\n#include <CloudClient.h>\n',
  });
  await f.library('LocalClient', { 'LocalClient.h': '#pragma once\n' });
  await f.library('CloudClient', { 'CloudClient.h': '#pragma once\n' });
}

async function buildFile(root: string, relative: string, contents: string) {
  const filename = path.join(root, 'build', relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
}

test('dependency analysis resolves SDK headers through nested compiler responses in the build directory', async t => {
  const f = await fixture(t);
  await f.library('Radio', {
    'Radio.h': [
      '#include <device/capabilities.h>',
      '#if DEVICE_HAS_RADIO',
      '#include <Transport.h>',
      '#endif'
    ].join('\n'),
    'UnusedEntry.h': '#include <Unused.h>\n',
  });
  await f.library('Transport', { 'Transport.h': '#pragma once\n' });
  await f.library('Unused', { 'Unused.h': '#pragma once\n' });
  await buildFile(f.root, 'flags/outer.rsp', '-iprefix "toolchain folder/" @flags/nested.rsp\n');
  await buildFile(f.root, 'flags/nested.rsp', '-iwithprefixbefore "headers/soc include"\n');
  await buildFile(f.root, 'toolchain folder/headers/soc include/device/capabilities.h', '#define DEVICE_HAS_RADIO 1\n');

  const platform = {
    'recipe.cpp.o.pattern': 'g++ {compiler.cpp.flags} {includes}',
    'compiler.cpp.flags': '@flags/outer.rsp',
    includes: '%INCLUDE_PATHS%',
  };
  assert.deepEqual(await f.read('#include <Radio.h>', '', platform), ['Radio', 'Transport']);
});

test('dependency analysis respects quote, user, system and after search order and separates reordered contexts', async t => {
  const f = await fixture(t);
  await f.library('SearchOrder', {
    'SearchOrder.h': [
      '#include <selection.h>',
      '#if SELECTION == 1',
      '#include <First.h>',
      '#elif SELECTION == 2',
      '#include <Second.h>',
      '#endif',
      '#undef SELECTION',
      '#include "selection.h"',
      '#if SELECTION == 3',
      '#include <Quote.h>',
      '#endif',
      '#include <fallback.h>',
      '#if FALLBACK == 4',
      '#include <System.h>',
      '#endif',
      '#if __has_include(<quote_only.h>)',
      '#include <Unexpected.h>',
      '#endif',
    ].join('\n'),
  });
  for (const library of ['First', 'Second', 'Quote', 'System', 'Unexpected']) {
    await f.library(library, { [library + '.h']: '#pragma once\n' });
  }
  await buildFile(f.root, 'user one/selection.h', '#define SELECTION 1\n');
  await buildFile(f.root, 'user two/selection.h', '#define SELECTION 2\n');
  await buildFile(f.root, 'quote/selection.h', '#define SELECTION 3\n');
  await buildFile(f.root, 'quote/quote_only.h', '#pragma once\n');
  await buildFile(f.root, 'system/selection.h', '#define SELECTION 5\n');
  await buildFile(f.root, 'system/fallback.h', '#define FALLBACK 4\n');
  await buildFile(f.root, 'after/fallback.h', '#define FALLBACK 5\n');

  const includes = '#include <SearchOrder.h>';
  const platform = { 'recipe.cpp.o.pattern': 'g++ -I after' };
  const compilerArguments = { cpp: '@paths.rsp' };
  const options = '-isystem system -idirafter after -iquote quote';
  const read = async (expected: string[], cacheHit: boolean) => {
    assert.deepEqual(await f.read(includes, '', platform, compilerArguments), expected);
    const indexed = f.cacheReads.filter(read => read.name === 'SearchOrder');
    assert.ok(indexed.length > 0);
    assert.ok(indexed.every(read => read.hit === cacheHit));
  };
  await buildFile(f.root, 'paths.rsp', `${options} -I"user one" -I "user two"\n`);
  await read(['First', 'Quote', 'SearchOrder', 'System'], false);
  await read(['First', 'Quote', 'SearchOrder', 'System'], true);

  await buildFile(f.root, 'paths.rsp', `${options} -I"user two" -I "user one"\n`);
  await read(['Quote', 'SearchOrder', 'Second', 'System'], false);
  await read(['Quote', 'SearchOrder', 'Second', 'System'], true);
});

for (const change of ['a changed external header', 'an earlier header appearing']) {
  test(`persistent library indexes recheck ${change} under compiler include roots`, async t => {
    const f = await fixture(t);
    await f.library('Feature', {
      'Feature.h': [
        '#include <PlatformFlag.h>',
        '#if PLATFORM_FEATURE',
        '#include <Enabled.h>',
        '#else',
        '#include <Disabled.h>',
        '#endif',
      ].join('\n'),
    });
    await f.library('Enabled', { 'Enabled.h': '#pragma once\n' });
    await f.library('Disabled', { 'Disabled.h': '#pragma once\n' });
    await buildFile(f.root, 'fallback/PlatformFlag.h', '#define PLATFORM_FEATURE 0\n');
    // Keep both search roots present before the first run so the compiler
    // context stays identical when the earlier lookup starts finding a file.
    await fs.mkdir(path.join(f.root, 'build', 'primary'));
    const compilerArguments = { cpp: '-I primary -I fallback' };
    const read = async (library: string, cacheHit: boolean) => {
      assert.deepEqual(await f.read('#include <Feature.h>', '', {}, compilerArguments), [library, 'Feature']);
      assert.equal(f.cacheReads.find(entry => entry.name === 'Feature')?.hit, cacheHit);
    };

    await read('Disabled', false);
    await read('Disabled', true);
    const changedRoot = change === 'a changed external header' ? 'fallback' : 'primary';
    await buildFile(f.root, changedRoot + '/PlatformFlag.h', '#define PLATFORM_FEATURE 1\n');
    await read('Enabled', false);
    await read('Enabled', true);
  });
}

for (const [header, client] of [['Local.h', 'LocalClient'], ['Cloud.h', 'CloudClient']]) {
  test(`preprocess selects only the requested public entry ${header}`, async t => {
    const f = await fixture(t);
    await selectableLibrary(f);
    assert.deepEqual(await f.read(`#include <${header}>`), [client, 'Selectable'].sort());
  });
}

test('two requested public entries of one library both contribute dependencies', async t => {
  const f = await fixture(t);
  await selectableLibrary(f);
  assert.deepEqual(await f.read('#include <Local.h>\n#include <Cloud.h>'), ['CloudClient', 'LocalClient', 'Selectable']);
});

test('cold and cached library indexes and archives preserve Ninja input ordering', async t => {
  const f = await fixture(t);
  const sourceRoot = await f.library('Display', {
    'Display.h': '#include <Zeta.h>\n#include <Alpha.h>\n',
    'panel3c/Tri.cpp': 'void tri() {}\n',
    'panel/Mono.cpp': 'void mono() {}\n',
  });
  await f.library('Zeta', { 'Zeta.h': '#pragma once\n', 'Zeta.cpp': 'void zeta() {}\n' });
  await f.library('Alpha', { 'Alpha.h': '#pragma once\n', 'Alpha.cpp': 'void alpha() {}\n' });
  const args = '%INCLUDE_PATHS% "%SOURCE_FILE_PATH%" -o "%OBJECT_FILE_PATH%"';
  const config = {
    compiler: { cpp: 'g++', c: 'gcc', ar: 'ar', ld: 'g++', objcopy: 'objcopy' },
    args: { cpp: args, c: args, s: args, ld: '%OBJECT_FILE_PATHS% -o "%OBJECT_FILE_PATH%"' },
  };
  const readGraph = async (mode: string, restoreAlpha = false) => {
    const dependencies = await f.preprocess('#include <Display.h>');
    assert.deepEqual(dependencies.map(dependency => dependency.name), ['Display', 'Zeta', 'Alpha']);
    assert.deepEqual(dependencies[0].includes, [path.join(sourceRoot, 'panel/Mono.cpp'), path.join(sourceRoot, 'panel3c/Tri.cpp')]);
    const buildPath = path.join(f.root, mode);
    await fs.mkdir(buildPath);
    const buildArchivePath = path.join(buildPath, 'Alpha.a');
    const file = await new NinjaGenerator(f.logger).generateNinjaFile({
      dependencies, compileConfig: config, buildPath, jobs: 1,
      archiveCacheHits: restoreAlpha ? new Map([[getArchiveDependencyKey('library', 'Alpha'), {
        dependencyName: 'Alpha', dependencyType: 'library', archiveName: 'Alpha.a',
        buildArchivePath, cacheKey: 'test', source: 'local'
      }]]) : undefined,
    });
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    return {
      archive: lines.find(line => line.startsWith('build Display.a: archive ')),
      link: lines.find(line => /^build [^ ]+\.elf: link /.test(line)),
      includeOrder: lines.find(line => line.includes('"-I$Display_path" "-I$Zeta_path" "-I$Alpha_path"')),
    };
  };
  const cold = await readGraph('cold');
  assert.ok(f.cacheReads.length > 0 && f.cacheReads.every(read => !read.hit));
  assert.match(cold.archive, /Mono\.cpp\.o .*Tri\.cpp\.o$/);
  assert.match(cold.link, /Display\.a Zeta\.a Alpha\.a/);
  assert.ok(cold.includeOrder);
  const warm = await readGraph('warm');
  assert.ok(f.cacheReads.length > 0 && f.cacheReads.every(read => read.hit));
  assert.deepEqual(warm, cold);
  assert.deepEqual(await readGraph('restored-archive', true), cold);
});

test('sibling public entries reuse source selection and compiled units with their original macro merge order', async t => {
  const f = await fixture(t);
  await f.library('Selectable', {
    'Local.h': '#define ENTRY_MODE 1\n#define FROM_LOCAL 1\n#include <Child.h>\n',
    'Cloud.h': '#include <CloudClient.h>\n',
    'actual.cpp': '#undef REMOVED\n#include <Required.h>\nvoid implementation() {}\n',
  });
  await f.library('Child', {
    'Child.h': '#if ENTRY_MODE == 0 && FROM_LOCAL && !defined(REMOVED)\n#include <Expected.h>\n#else\n#include <Wrong.h>\n#endif\n',
  });
  for (const client of ['CloudClient', 'Required', 'Expected', 'Wrong']) {
    await f.library(client, { [client + '.h']: '#pragma once\n' });
  }

  const analyzer = f.analyzer as any;
  let sourceScans = 0;
  let sourceUnitReads = 0;
  const selectSources = analyzer.computeLibrarySourceFiles.bind(analyzer);
  analyzer.computeLibrarySourceFiles = (dependency: Dependency, ...args: any[]) => {
    if (dependency.name === 'Selectable') sourceScans++;
    return selectSources(dependency, ...args);
  };
  const analyzeIncludes = analyzer.analyzeLibraryIncludes.bind(analyzer);
  analyzer.analyzeLibraryIncludes = (libraryPath: string, macros: unknown, sources: string[], getTape: (file: string) => unknown, ...args: any[]) =>
    analyzeIncludes(libraryPath, macros, sources, (file: string) => {
      if (path.basename(file) === 'actual.cpp') sourceUnitReads++;
      return getTape(file);
    }, ...args);

  assert.deepEqual(await f.read('#include <Local.h>\n#include <Cloud.h>', '-DENTRY_MODE=0 -DREMOVED=1'),
    ['Child', 'CloudClient', 'Expected', 'Required', 'Selectable']);
  assert.equal(sourceScans, 1);
  assert.equal(sourceUnitReads, 1);
});

test('sibling reuse is discarded if the library fingerprint changes during the walk', async t => {
  const f = await fixture(t);
  await selectableLibrary(f);
  await f.library('Added', { 'Added.h': '#pragma once\n' });
  const cache: LibraryIndexCache = (f.analyzer as any).libraryIndexCache;
  const getOrCreate = cache.getOrCreate.bind(cache);
  let edited = false;
  cache.getOrCreate = async (...args: Parameters<LibraryIndexCache['getOrCreate']>) => {
    const result = await getOrCreate(...args);
    if (args[0] === 'Selectable' && !edited) {
      edited = true;
      await f.library('Selectable', { 'added.cpp': '#include <Added.h>\nvoid added() {}\n' });
    }
    return result;
  };
  assert.deepEqual(await f.read('#include <Local.h>\n#include <Cloud.h>'), ['Added', 'CloudClient', 'LocalClient', 'Selectable']);
});

for (const change of ['changed', 'appeared', 'higher-priority']) {
  test(`sibling reuse rechecks ${change} platform headers outside the indexed library`, async t => {
    const f = await fixture(t);
    const sdk = path.join(f.root, 'sdk');
    const core = path.join(f.root, 'core');
    await fs.mkdir(sdk);
    await fs.mkdir(core);
    const header = path.join(sdk, 'PlatformFlag.h');
    if (change !== 'appeared') await fs.writeFile(header, '#define PLATFORM_FEATURE 0\n');
    await f.library('Selectable', {
      'Local.h': '#pragma once\n',
      'Cloud.h': '#pragma once\n',
      'actual.cpp': '#if __has_include(<PlatformFlag.h>)\n#include <PlatformFlag.h>\n#endif\n#if PLATFORM_FEATURE\n#include <Enabled.h>\n#else\n#include <Disabled.h>\n#endif\n',
    });
    await f.library('Enabled', { 'Enabled.h': '#pragma once\n' });
    await f.library('Disabled', { 'Disabled.h': '#pragma once\n' });

    const cache: LibraryIndexCache = (f.analyzer as any).libraryIndexCache;
    const getOrCreate = cache.getOrCreate.bind(cache);
    let edited = false;
    cache.getOrCreate = async (...args: Parameters<LibraryIndexCache['getOrCreate']>) => {
      const result = await getOrCreate(...args);
      if (args[0] === 'Selectable' && !edited) {
        edited = true;
        const changedHeader = change === 'higher-priority' ? path.join(core, 'PlatformFlag.h') : header;
        await fs.writeFile(changedHeader, '#define PLATFORM_FEATURE (1)\n');
      }
      return result;
    };

    assert.deepEqual(await f.read('#include <Local.h>\n#include <Cloud.h>', '', {
      'build.core.path': core,
      'compiler.sdk.path': sdk,
      'recipe.cpp.o.pattern': `g++ -I"${core}" -I"${sdk}" %INCLUDE_PATHS%`,
    }), ['Disabled', 'Enabled', 'Selectable']);
  });
}

test('nested sibling entries use the macros of their own parent library', async t => {
  const f = await fixture(t);
  await f.library('Left', { 'Left.h': '#define ENTRY_MODE 1\n#include <SharedOne.h>\n#include <SharedTwo.h>\n' });
  await f.library('Right', { 'Right.h': '#define ENTRY_MODE 0\n#include <SharedOne.h>\n#include <SharedTwo.h>\n' });
  await f.library('Shared', {
    'SharedOne.h': '#if ENTRY_MODE\n#include <Enabled.h>\n#else\n#include <Disabled.h>\n#endif\n',
    'SharedTwo.h': '#pragma once\n',
  });
  await f.library('Enabled', { 'Enabled.h': '#pragma once\n' });
  await f.library('Disabled', { 'Disabled.h': '#pragma once\n' });
  assert.deepEqual(await f.read('#include <Left.h>\n#include <Right.h>'), ['Disabled', 'Enabled', 'Left', 'Right', 'Shared']);
});

test('real compiled translation units retain private dependencies without selecting unrelated headers', async t => {
  const f = await fixture(t);
  await f.library('Selectable', {
    'Local.h': '#pragma once\n',
    'Cloud.h': '#include <CloudClient.h>\n',
    'actual.cpp': '#include <External.h>\nvoid private_implementation() {}\n',
  });
  await f.library('External', { 'External.h': '#pragma once\n' });
  await f.library('CloudClient', { 'CloudClient.h': '#pragma once\n' });
  assert.deepEqual(await f.read('#include <Local.h>'), ['External', 'Selectable']);
});

test('external dependency cycles terminate while a later entry of an already selected library is resolved', async t => {
  const f = await fixture(t);
  await f.library('Alpha', {
    'A.h': '#pragma once\n#include <B.h>\n',
    'Back.h': '#pragma once\n#include <Late.h>\n',
    'Unused.h': '#include <Unwanted.h>\n',
  });
  await f.library('Beta', { 'B.h': '#pragma once\n#include <A.h>\n#include <Back.h>\n' });
  await f.library('Late', { 'Late.h': '#pragma once\n' });
  await f.library('Unwanted', { 'Unwanted.h': '#pragma once\n' });
  assert.deepEqual(await f.read('#include <A.h>'), ['Alpha', 'Beta', 'Late']);
  assert.equal(f.logger.messages.some(message => message.includes('Reached maximum recursion depth')), false);
});

test('one analyzer resets session entries and caches entry-specific closures independently', async t => {
  const f = await fixture(t);
  await selectableLibrary(f);
  const selectedHit = () => f.cacheReads.find(read => read.name === 'Selectable')?.hit;
  assert.deepEqual(await f.read('#include <Local.h>'), ['LocalClient', 'Selectable']);
  assert.equal(selectedHit(), false);
  assert.deepEqual(await f.read('#include <Cloud.h>'), ['CloudClient', 'Selectable']);
  assert.equal(selectedHit(), false);
  assert.deepEqual(await f.read('#include <Cloud.h>'), ['CloudClient', 'Selectable']);
  assert.equal(selectedHit(), true);
  assert.deepEqual(await f.read('#include <Local.h>'), ['LocalClient', 'Selectable']);
  assert.equal(selectedHit(), true);
});

test('same public entry under different macro contexts does not lose dependencies or reuse the wrong cache', async t => {
  const f = await fixture(t);
  await f.library('Conditional', {
    'Conditional.h': '#if ENTRY_MODE\n#include <Extra.h>\n#else\n#include <Base.h>\n#endif\n',
    'Unused.h': '#include <Unwanted.h>\n',
  });
  await f.library('Base', { 'Base.h': '#pragma once\n' });
  await f.library('Extra', { 'Extra.h': '#pragma once\n' });
  await f.library('Unwanted', { 'Unwanted.h': '#pragma once\n' });
  assert.deepEqual(await f.read('#include <Conditional.h>', '-DENTRY_MODE=0'), ['Base', 'Conditional']);
  assert.deepEqual(await f.read('#include <Conditional.h>', '-DENTRY_MODE=1'), ['Conditional', 'Extra']);
  assert.deepEqual(await f.read('#include <Conditional.h>', '-DENTRY_MODE=1'), ['Conditional', 'Extra']);
  assert.equal(f.cacheReads.find(read => read.name === 'Conditional')?.hit, true);
  assert.deepEqual(await f.read('#include <Conditional.h>', '-DENTRY_MODE=0'), ['Base', 'Conditional']);
  assert.equal(f.cacheReads.find(read => read.name === 'Conditional')?.hit, true);
});

test('no requested entry does not fall back to every private or public header', async t => {
  const f = await fixture(t);
  const sourceRoot = await f.library('HeaderOnly', {
    'Unused.h': '#include <Unwanted.h>\n',
    'private/unused.inc': '#include <AlsoUnwanted.h>\n',
  });
  const result = await (f.analyzer as any).buildLibraryIndex({ name: 'HeaderOnly', path: sourceRoot }, new Map());
  assert.deepEqual(result.includeFiles, []);
  assert.deepEqual(result.sourceFiles, []);
});

test('forced libraries without a public entry still analyze their compiled TUs', async t => {
  const f = await fixture(t);
  const sourceRoot = await f.library('Forced', {
    'Unused.h': '#include <Unwanted.h>\n',
    'source.cpp': '#include <Needed.h>\nvoid implementation() {}\n',
  });
  const result = await (f.analyzer as any).buildLibraryIndex({ name: 'Forced', path: sourceRoot }, new Map());
  assert.deepEqual(result.includeFiles, ['Needed.h']);
  assert.deepEqual(result.sourceFiles, [path.join(sourceRoot, 'source.cpp')]);
});
