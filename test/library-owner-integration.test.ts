import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { TestContext } from 'node:test';
import { DependencyAnalyzer, Dependency } from '../src/DependencyAnalyzer';
import { LibraryIndexCache } from '../src/LibraryIndexCache';
import { Logger } from '../src/utils/Logger';
import { isPreprocessInputChanged } from '../src/DirectiveTapeSnapshot';

class QuietLogger extends Logger { debug(): void {} info(): void {} verbose(): void {} warn(): void {} error(): void {} }

async function fixture(t: TestContext) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'aily-owner-contract-'));
  const sketch = path.join(root, 'sketch', 'sketch.ino'), libraries = path.join(root, 'libraries');
  await fs.mkdir(path.dirname(sketch), { recursive: true }); await fs.mkdir(libraries);
  const environment: Record<string, string | undefined> = {
    SKETCH_PATH: sketch, SKETCH_DIR_PATH: path.dirname(sketch), BUILD_PATH: path.join(root, 'build'),
    LIBRARIES_PATH: libraries, PROJECT_LIBRARY_PATHS: undefined, SDK_CORE_PATH: undefined,
    SDK_VARIANT_PATH: undefined, SDK_CORE_LIBRARIES_PATH: undefined, SDK_PATH: undefined, BUILD_MCU: undefined,
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(async () => {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('aily-owner-contract-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true });
  });
  const logger = new QuietLogger();
  const cache: LibraryIndexCache = Object.assign(Object.create(LibraryIndexCache.prototype), { logger, cacheDir: path.join(root, 'cache') });
  const analyzer: DependencyAnalyzer = Object.assign(Object.create(DependencyAnalyzer.prototype), {
    logger, dependencyList: new Map(), macroDefinitions: new Map(), configuredMacros: new Map(),
    libraryMap: new Map(), libraryEntryPoints: new Map(), libraryIndexCache: cache,
    platformHeaderRoots: [], platformContextKey: '', compilerSearch: {}, projectAndLibraryRoots: [],
  });
  analyzer.setMacro('CONTRACT_MODE', '1');
  const write = async (relative: string, contents: string) => {
    const file = path.join(libraries, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents); return file;
  };
  const peer = async (name: string) => {
    await write(`${name}/library.properties`, `name=${name}\nversion=1.0.0\narchitectures=*\n`);
    await write(`${name}/src/${name}.h`, '#pragma once\n');
    await write(`${name}/src/${name}.cpp`, `#include "${name}.h"\nvoid ${name}_unit() {}\n`);
  };
  return { root, libraries, analyzer, cache, write, peer,
    async read(include: string, withRecipe = true): Promise<Dependency[]> {
      await fs.writeFile(sketch, `#include <${include}>\nvoid setup() {}\nvoid loop() {}\n`);
      const recipe = withRecipe ? 'g++ -DCONTRACT_MODE=1 %INCLUDE_PATHS%' : '';
      return (await analyzer.preprocess({ fqbn: 'contract:generic:board', fqbnParsed: { package: 'contract', platform: 'generic', boardId: 'board' },
        platform: { 'recipe.cpp.o.pattern': recipe }, board: {} })).filter(d => d.type === 'library');
    },
  };
}

for (const withRecipe of [true, false]) test(`same-package outside-src implementation is parsed without creating another library (${withRecipe})`, async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\nversion=1.0.0\narchitectures=*\n');
  await f.write('Package/src/Package.h', '#include "../implementation/detail.h"\n');
  const unit = await f.write('Package/src/main.cpp', '#include "Package.h"\nvoid package_unit() {}\n');
  const header = await f.write('Package/implementation/detail.h', '#if CONTRACT_MODE == 1\n#include "chosen.c"\n#else\n#include "other.c"\n#endif\n');
  const fragment = await f.write('Package/implementation/chosen.c', '#include <ChosenPeer.h>\nint chosen_fragment() { return 1; }\n');
  await f.write('Package/implementation/other.c', '#include <OtherPeer.h>\nint other_fragment() { return 2; }\n');
  await f.peer('ChosenPeer'); await f.peer('OtherPeer');
  const dependencies = await f.read('Package.h', withRecipe);
  assert.deepEqual(dependencies.map(d => d.name).sort(), ['ChosenPeer', 'Package']);
  const selected = dependencies.find(d => d.name === 'Package')!;
  assert.deepEqual(selected.includes, [unit]);
  for (const file of [header, fragment]) assert.ok(selected.headerInputs?.some(([p, id]) => p === file && id), 'Consumed internal implementation must keep its file proof');
});

test('a cross-owner private header is an explicit entry without scanning the entire child package', async t => {
  const f = await fixture(t);
  await f.write('Parent/library.properties', 'name=Parent\nversion=1.0.0\narchitectures=*\n');
  await f.write('Parent/src/Parent.h', '#include "../Child/private/extra.h"\n');
  await f.write('Parent/src/main.cpp', '#include "Parent.h"\n');
  await f.write('Parent/Child/library.properties', 'name=Child\nversion=1.0.0\narchitectures=*\n');
  await f.write('Parent/Child/src/Child.h', '#pragma once\n');
  const unit = await f.write('Parent/Child/src/main.cpp', '#include "Child.h"\n');
  const extra = await f.write('Parent/Child/private/extra.h', '#include <ChosenPeer.h>\n');
  await f.write('Parent/Child/private/unreferenced.cpp', '#include <OtherPeer.h>\n');
  await f.peer('ChosenPeer'); await f.peer('OtherPeer');
  const dependencies = await f.read('Parent.h');
  assert.deepEqual(dependencies.map(d => d.name).sort(), ['Child', 'ChosenPeer', 'Parent']);
  const child = dependencies.find(d => d.name === 'Child')!;
  assert.deepEqual(child.includes, [unit]);
  assert.ok(child.headerInputs?.some(([p, id]) => p === extra && id));
});

for (const exists of [true, false]) test(`layout metadata ${exists ? 'edit' : 'creation'} during cache publication cannot authorize the old layout`, async t => {
  const f = await fixture(t);
  const prefix = exists ? 'Package/src' : 'Package';
  if (exists) await f.write('Package/library.properties', 'name=Package\nversion=1.0.0\narchitectures=*\n');
  await f.write(`${prefix}/Package.h`, '#pragma once\n');
  await f.write(`${prefix}/main.cpp`, '#include "Package.h"\n');
  const cache = f.cache as any, original = cache.writeCache.bind(cache);
  let changed = false;
  cache.writeCache = async (...args: any[]) => {
    await original(...args);
    if (!changed) { changed = true; await f.write('Package/library.properties', 'name=ChangedPackage\nversion=2.0.0\narchitectures=other\n'); }
  };
  await assert.rejects(f.read('Package.h'), isPreprocessInputChanged);
  assert.equal(changed, true);
});

test('an unrelated object file does not invalidate library layout or exact header facts', async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\nversion=1.0.0\narchitectures=*\n');
  await f.write('Package/src/Package.h', '#pragma once\n');
  const unit = await f.write('Package/src/main.cpp', '#include "Package.h"\n');
  const cache = f.cache as any, original = cache.writeCache.bind(cache);
  let changed = false;
  cache.writeCache = async (...args: any[]) => { await original(...args); if (!changed) { changed = true; await f.write('Package/src/transient.o', 'unrelated output'); } };
  const dependencies = await f.read('Package.h');
  assert.deepEqual(dependencies.find(d => d.name === 'Package')?.includes, [unit]);
  assert.equal(changed, true);
});

test('a configured missing search root appearing during publication cannot preserve the old library selection', async t => {
  const f = await fixture(t);
  await f.peer('Package');
  const projectLibraries = path.join(f.root, 'project-libraries');
  process.env.PROJECT_LIBRARY_PATHS = projectLibraries;
  const cache = f.cache as any, original = cache.writeCache.bind(cache);
  let changed = false;
  cache.writeCache = async (...args: any[]) => {
    await original(...args);
    if (!changed) {
      changed = true;
      await fs.mkdir(path.join(projectLibraries, 'Package'), { recursive: true });
      await fs.writeFile(path.join(projectLibraries, 'Package', 'Package.h'), '#pragma once\n');
    }
  };
  await assert.rejects(f.read('Package.h'), isPreprocessInputChanged);
  assert.equal(changed, true);
});
