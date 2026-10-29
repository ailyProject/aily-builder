import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { TestContext } from 'node:test';
import { Dependency, DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { LibraryIndexCache } from '../src/LibraryIndexCache';
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
  });

  return {
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
    async read(includes: string, extraDefines = '') {
      // Exactly one ino and no companion C/C++ files: exercise the production
      // directive/index route, not the separate native-compiler sketch route.
      await fs.writeFile(sketch, `${includes}\nvoid setup() {}\nvoid loop() {}\n`);
      cacheReads.length = 0;
      logger.messages.length = 0;
      const result: Dependency[] = await analyzer.preprocess({
        fqbn: 'fixture:fixture:board',
        fqbnParsed: { package: 'fixture', platform: 'fixture', boardId: 'board' },
        platform: { 'recipe.cpp.o.pattern': `g++ -DARDUINO_ARCH_FIXTURE=1 ${extraDefines}` },
        board: {},
      });
      assert.equal(result.some(dependency => dependency.type === 'sketch'), false);
      return result.filter(dependency => dependency.type === 'library').map(dependency => dependency.name).sort();
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
