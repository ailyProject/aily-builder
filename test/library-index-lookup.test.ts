import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibraryIndexCache, dependencyInputIdentity, type LibraryIndexBuildResult } from '../src/LibraryIndexCache';
import { DirectiveTapeSnapshot } from '../src/DirectiveTapeSnapshot';
import { type MacroSourceReference } from '../src/MacroSourceOrigins';
import { analyzeDirectiveTapeWithDefines, type MacroDefinition } from '../src/utils/AnalyzeFile';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, verbose() {} };
const macro = (name: string, value?: string, shape: Partial<MacroDefinition> = {}): MacroDefinition =>
  ({ name, isDefined: true, ...(value === undefined ? {} : { value }), ...shape });

async function fixture(t: TestContext, source = '#define LIMIT 32\n', external = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-library-lookup-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-library-lookup-'));
    await fs.remove(root);
  });
  const library = path.join(root, '库 空格'), main = path.join(library, 'main.cpp');
  const header = path.join(external ? root : library, 'Config.h'), missing = path.join(root, 'missing.h');
  await fs.ensureDir(library); await fs.writeFile(main, 'int generic() { return 1; }\n');
  await fs.writeFile(header, source);
  const cache = Object.assign(Object.create(LibraryIndexCache.prototype), { logger: quiet, cacheDir: path.join(root, 'cache') });
  let builds = 0;
  const build = async (incoming: Map<string, MacroDefinition>): Promise<LibraryIndexBuildResult> => {
    builds++;
    const snapshot = new DirectiveTapeSnapshot(), definitions = new Map(incoming), origins = new Map<string, MacroSourceReference>();
    const includeFiles: string[] = [];
    for (const file of [header, main]) {
      const captured = snapshot.read(file);
      const result = analyzeDirectiveTapeWithDefines(captured.tape, definitions, { onMacroChange: (definition, event) => {
        origins.set(definition.name, { file, identity: captured.identity, directiveIndex: event.directiveIndex,
          sourceOffset: event.location.offset, kind: event.kind });
      } });
      includeFiles.push(...result.includes);
    }
    snapshot.verifyLoaded();
    return { sourceFiles: [main], includeFiles, macroDefinitions: definitions, macroOrigins: origins,
      headerInputs: [[header, dependencyInputIdentity(header)!], [main, dependencyInputIdentity(main)!], [missing, null]] };
  };
  const base = new Map<string, MacroDefinition>();
  const warm = (incoming = base) => cache.getOrCreate('Generic', library, incoming, () => build(incoming));
  return { root, library, header, main, missing, cache, base, warm, build, builds: () => builds };
}

test('versioned macro keys distinguish defined sentinel and separator contexts while sorting Maps canonically', async t => {
  const f = await fixture(t, '#if defined(FEATURE)\n#include <Chosen.h>\n#endif\n');
  const absent = new Map([['FEATURE', macro('FEATURE', undefined, { isDefined: false })]]);
  const defined = new Map([['FEATURE', macro('FEATURE', '<undefined>')]]);
  assert.notEqual(f.cache.createMacroKey(absent, ''), f.cache.createMacroKey(defined, ''));
  assert.deepEqual((await f.warm(absent)).includeFiles, []);
  const changed = await f.warm(defined);
  assert.equal(changed.cacheHit, false); assert.deepEqual(changed.includeFiles, ['Chosen.h']);
  assert.equal((await f.warm(defined)).cacheHit, true);
  const joined = new Map([['A', macro('A', 'x|object\nB=y')]]);
  const separate = new Map([['A', macro('A', 'x')], ['B', macro('B', 'y')]]);
  assert.notEqual(f.cache.createMacroKey(joined, ''), f.cache.createMacroKey(separate, ''));
  assert.equal(f.cache.createMacroKey(separate, ''), f.cache.createMacroKey(new Map([...separate].reverse()), ''));
  assert.notEqual(f.cache.createMacroKey(separate, ''), f.cache.createMacroKey(separate, '\nA=x|object'));
  const shapes = [macro('A'), macro('A', ''), macro('A', '1'), macro('A', '1', { functionLike: true }),
    macro('A', '1', { functionLike: true, parameters: ['x'] }),
    macro('A', '1', { functionLike: true, parameters: ['x'], variadic: true })];
  assert.equal(new Set(shapes.map(value => f.cache.createMacroKey(new Map([['A', value]]), ''))).size, shapes.length);
});

test('a previous ambiguous key cannot be consumed by a regular lookup', async t => {
  const f = await fixture(t), result = await f.warm();
  const currentKey = f.cache.createMacroKey(f.base, '');
  const filename = f.cache.getSourceIndexPath(result.sourceHash, currentKey), data = await fs.readJSON(filename);
  const oldKey = createHash('sha256').update('analysis-context=\n').digest('hex');
  assert.notEqual(currentKey, oldKey);
  data.macroKey = oldKey;
  await fs.writeJSON(filename, data);
  assert.equal((await f.warm()).cacheHit, false); assert.equal(f.builds(), 2);
});
