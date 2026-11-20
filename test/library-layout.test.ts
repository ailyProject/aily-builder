import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import extra from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibrarySelection } from '../src/LibrarySelection';
import { headerInputsCurrent } from '../src/LibraryIndexCache';
import { PreprocessInputChangedError } from '../src/DirectiveTapeSnapshot';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-library-layout-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return {
    root,
    async write(relative: string, text = '') {
      const file = path.join(root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
      return file;
    },
  };
}

test('standard package ownership covers internal fragments while old add keeps the src compile root', async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\narchitectures=fixture\n');
  await f.write('Package/src/Public.h', '#include "../implementation/internal.h"\n');
  const fragment = await f.write('Package/implementation/body.c', 'int body() { return 1; }\n');
  const selection = new LibrarySelection('fixture');
  const sourceRoot = path.join(f.root, 'Package/src');
  await selection.add(sourceRoot, 'platform', ['Public.h']);
  selection.resolve();
  const dependency = selection.forHeader('Public.h', []);
  assert.equal(dependency?.path, sourceRoot);
  assert.equal(selection.owner(fragment), dependency);
});

test('discovery keeps a standard package whole and preserves a nested real library', async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\narchitectures=fixture\n');
  await f.write('Package/src/Public.h');
  await f.write('Package/implementation/body.c');
  await f.write('Package/examples/NotALibrary/Example.cpp');
  await f.write('Package/vendor/Nested/library.properties', 'name=Nested\narchitectures=*\n');
  const nestedHeader = await f.write('Package/vendor/Nested/src/Nested.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const layouts = await discoverLibraryLayouts(f.root);
  assert.deepEqual(layouts.map(layout => path.relative(f.root, layout.sourceRoot)).sort(), [
    path.join('Package', 'src'), path.join('Package', 'vendor', 'Nested', 'src'),
  ].sort());
  const outer = layouts.find(layout => layout.sourceRoot === path.join(f.root, 'Package/src'))!;
  assert.equal(outer.ownerRoot, path.join(f.root, 'Package'));
  assert.deepEqual(outer.includeRoots, [outer.sourceRoot]);
  const selection = new LibrarySelection('fixture');
  for (const layout of layouts) await selection.addLayout(layout, 'platform', [layout === outer ? 'Public.h' : 'Nested.h']);
  selection.resolve();
  assert.equal(selection.owner(nestedHeader), selection.forHeader('Nested.h', []));
  assert.notEqual(selection.owner(nestedHeader), selection.forHeader('Public.h', []));
});

test('legacy and explicitly configured source roots remain separate without a common-ancestor merge', async t => {
  const f = await fixture(t);
  await f.write('Legacy/Legacy.h');
  await f.write('Legacy/detail/body.c');
  await f.write('Custom/.private.h');
  const left = await f.write('Custom/left/Left.h');
  const right = await f.write('Custom/right/Right.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const discovered = await discoverLibraryLayouts(f.root);
  assert.deepEqual(discovered.map(layout => path.relative(f.root, layout.sourceRoot)).sort(), [
    path.join('Custom', 'left'), path.join('Custom', 'right'), 'Legacy',
  ].sort());
  const selection = new LibrarySelection('fixture');
  for (const file of [left, right]) {
    const sourceRoot = path.dirname(file);
    const layouts = await discoverLibraryLayouts(sourceRoot, { explicitSourceRoot: true });
    assert.equal(layouts.length, 1);
    assert.equal(layouts[0].kind, 'explicit');
    assert.equal(layouts[0].sourceRoot, sourceRoot);
    await selection.addLayout(layouts[0], 'project', [path.basename(file)]);
  }
  selection.resolve();
  assert.notEqual(selection.owner(left), selection.owner(right));
});

test('an explicit internal source root overrides the enclosing package owner without expanding either compile root', async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\n');
  await f.write('Package/src/Public.h');
  const fragment = await f.write('Package/implementation/Fragment.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const [layout] = await discoverLibraryLayouts(path.join(f.root, 'Package'));
  const [explicit] = await discoverLibraryLayouts(path.dirname(fragment), { explicitSourceRoot: true });
  const selection = new LibrarySelection('fixture');
  await selection.addLayout(layout, 'platform', ['Public.h']);
  assert.equal(selection.owner(fragment)?.path, path.join(f.root, 'Package/src'));
  await selection.addLayout(explicit, 'project', ['Fragment.h']);
  selection.resolve();
  assert.equal(selection.owner(fragment)?.path, path.dirname(fragment));
  assert.equal(selection.forHeader('Public.h', [])?.path, path.join(f.root, 'Package/src'));
});

test('metadata observations preserve positive and negative facts and invalidate on properties change or creation', async t => {
  const f = await fixture(t);
  const properties = await f.write('Package/library.properties', 'name=Package\narchitectures=fixture\n');
  await f.write('Package/src/Public.h');
  await f.write('Legacy/Legacy.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const layouts = await discoverLibraryLayouts(f.root);
  const selection = new LibrarySelection('fixture');
  for (const layout of layouts) await selection.addLayout(layout, 'platform', ['Shared.h']);
  selection.resolve();
  const observations = selection.inputObservations();
  assert.ok(observations.some(([file, identity]) => file === properties && typeof identity === 'string'));
  const missing = path.join(f.root, 'Legacy/library.properties');
  assert.ok(observations.some(([file, identity]) => file === missing && identity === null));
  assert.ok(headerInputsCurrent(observations));
  await fs.writeFile(properties, 'name=Changed Package\narchitectures=another-target\n');
  assert.equal(headerInputsCurrent(observations), false);
  const fresh = await discoverLibraryLayouts(f.root);
  const legacyFacts = fresh.find(layout => layout.sourceRoot === path.join(f.root, 'Legacy'))!.metadataInputs!;
  assert.ok(headerInputsCurrent(legacyFacts));
  await fs.writeFile(missing, 'name=New metadata\n');
  assert.equal(headerInputsCurrent(legacyFacts), false);
  const detached = selection.inputObservations();
  detached.length = 0;
  assert.ok(selection.inputObservations().length > 0);
});

test('metadata reads reject a change during the asynchronous byte read using the existing typed input error', async t => {
  const f = await fixture(t);
  const properties = await f.write('Package/library.properties', 'name=Before\n');
  await f.write('Package/src/Public.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const original = extra.readFile;
  let changed = false;
  (extra as any).readFile = async (...args: any[]) => {
    const bytes = await Reflect.apply(original, extra, args);
    if (path.resolve(args[0]) === properties && !changed) {
      changed = true;
      await fs.writeFile(properties, 'name=After with different bytes\n');
    }
    return bytes;
  };
  try {
    await assert.rejects(discoverLibraryLayouts(path.join(f.root, 'Package')), error =>
      error instanceof PreprocessInputChangedError && error.inputPath === properties);
    assert.equal(changed, true);
  } finally { extra.readFile = original; }
});

test('ordinary build outputs do not invalidate metadata facts, but a new nested library changes the discovery shape', async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\n');
  await f.write('Package/src/Public.h');
  await f.write('Package/implementation/body.c');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const selection = new LibrarySelection('fixture');
  for (const layout of await discoverLibraryLayouts(f.root)) await selection.addLayout(layout, 'platform', ['Public.h']);
  const observations = selection.inputObservations();
  await f.write('Package/src/output.o', 'temporary object bytes');
  await f.write('Package/cache.a', 'temporary archive bytes');
  assert.equal(headerInputsCurrent(observations), true);
  assert.doesNotThrow(() => selection.assertLayoutCurrent());
  await f.write('Package/implementation/New/library.properties', 'name=New nested library\n');
  await f.write('Package/implementation/New/src/New.h');
  assert.throws(() => selection.assertLayoutCurrent(), PreprocessInputChangedError);
});

test('ordinary source additions and unrelated subdirectories preserve an existing layout boundary', async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\n');
  await f.write('Package/src/Public.h');
  await f.write('Legacy/Legacy.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const selection = new LibrarySelection('fixture');
  for (const layout of await discoverLibraryLayouts(f.root, { onInputs: inputs => selection.observeLayoutInputs(inputs) })) {
    await selection.addLayout(layout, 'platform', ['Public.h']);
  }
  await f.write('Package/src/added.cpp', '#include <Added.h>\nvoid added() {}\n');
  await f.write('Legacy/added.cpp', 'void legacyAdded() {}\n');
  await f.write('Package/implementation/resources/readme.txt', 'unrelated resource');
  await f.write('Legacy/detail/another.cpp', 'void nestedAdded() {}\n');
  await f.write('UnrelatedDirectory/readme.txt', 'not a library');
  assert.equal(headerInputsCurrent(selection.inputObservations()), true);
  assert.doesNotThrow(() => selection.assertLayoutCurrent());
});

test('a new legacy library and a new public header still change selection semantics', async t => {
  const f = await fixture(t);
  await f.write('Existing/Existing.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const initial = new LibrarySelection('fixture');
  for (const layout of await discoverLibraryLayouts(f.root, { onInputs: inputs => initial.observeLayoutInputs(inputs) })) {
    await initial.addLayout(layout, 'platform', ['Existing.h']);
  }
  await f.write('Introduced/Introduced.h');
  assert.throws(() => initial.assertLayoutCurrent(), PreprocessInputChangedError);
  const fresh = new LibrarySelection('fixture');
  for (const layout of await discoverLibraryLayouts(f.root, { onInputs: inputs => fresh.observeLayoutInputs(inputs) })) {
    await fresh.addLayout(layout, 'platform', ['Existing.h']);
  }
  await f.write('Existing/AnotherPublic.h');
  assert.throws(() => fresh.assertLayoutCurrent(), PreprocessInputChangedError);
});

test('an unreadable properties file is not accepted as absent metadata', async t => {
  const f = await fixture(t);
  const properties = await f.write('Package/library.properties', 'name=Package\n');
  await f.write('Package/src/Public.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const original = extra.readFile;
  (extra as any).readFile = async (...args: any[]) => {
    if (path.resolve(args[0]) === properties) throw Object.assign(new Error('controlled read denial'), { code: 'EACCES' });
    return Reflect.apply(original, extra, args);
  };
  try {
    await assert.rejects(discoverLibraryLayouts(path.join(f.root, 'Package')), error =>
      error instanceof PreprocessInputChangedError && error.inputPath === properties && error.reason === 'EACCES');
  } finally { extra.readFile = original; }
});

test('an initially empty collection still records the boundary needed to reject a new library', async t => {
  const f = await fixture(t);
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const selection = new LibrarySelection('fixture');
  assert.deepEqual(await discoverLibraryLayouts(f.root, {
    onInputs: inputs => selection.observeLayoutInputs(inputs),
  }), []);
  assert.doesNotThrow(() => selection.assertLayoutCurrent());
  await f.write('Introduced/library.properties', 'name=Introduced\n');
  await f.write('Introduced/src/Introduced.h');
  assert.throws(() => selection.assertLayoutCurrent(), PreprocessInputChangedError);
});

test('Windows discovery follows host case rules for src, source extensions and ignored examples', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await f.write('Package/library.properties', 'name=Package\n');
  await f.write('Package/SrC/Public.H');
  await f.write('Package/implementation/body.cpp');
  await f.write('LegacyUpper/Public.H');
  await f.write('Assembly/boot.s');
  await f.write('Examples/NotALibrary/Example.H');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const layouts = await discoverLibraryLayouts(f.root);
  assert.deepEqual(layouts.map(layout => path.relative(f.root, layout.sourceRoot)).sort(), [
    'Assembly', 'LegacyUpper', path.join('Package', 'SrC'),
  ].sort());
  const selection = new LibrarySelection('fixture');
  await selection.add(path.join(f.root, 'Package/SrC'), 'platform', ['Public.H']);
  selection.resolve();
  assert.equal(selection.forHeader('Public.H', [])?.name, 'Package');
  assert.equal(selection.owner(path.join(f.root, 'Package/implementation/body.cpp')), selection.forHeader('Public.H', []));
});

test('layout ownership retains the existing metadata, selected-header and project priority rules', async t => {
  const f = await fixture(t);
  await f.write('Radio/library.properties', 'name=Radio\narchitectures=fixture\n');
  await f.write('Radio/src/Radio.h');
  await f.write('Community/library.properties', 'name=Community Radio\narchitectures=*\n');
  await f.write('Community/src/Radio.h');
  await f.write('Project/library.properties', 'name=Project Radio\narchitectures=other\n');
  await f.write('Project/src/Radio.h');
  const { discoverLibraryLayouts } = await import('../src/LibraryLayout');
  const layouts = await discoverLibraryLayouts(f.root);
  const selection = new LibrarySelection('fixture');
  for (const layout of layouts.filter(layout => path.basename(layout.ownerRoot) !== 'Project')) await selection.addLayout(layout, 'platform', ['Radio.h']);
  selection.resolve();
  assert.equal(selection.forHeader('Radio.h', [])?.path, path.join(f.root, 'Radio/src'));
  assert.equal(selection.forHeader('Radio.h', [path.join(f.root, 'Community/src')])?.path, path.join(f.root, 'Community/src'));
  const prior = selection.fingerprint;
  await selection.addLayout(layouts.find(layout => path.basename(layout.ownerRoot) === 'Project')!, 'project', ['Radio.h']);
  selection.resolve();
  assert.equal(selection.forHeader('Radio.h', [])?.path, path.join(f.root, 'Project/src'));
  assert.notEqual(selection.fingerprint, prior);
});
