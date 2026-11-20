import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { dependencyInputIdentity, headerInputsCurrent } from '../src/LibraryIndexCache';
import { FileObservationSnapshot, readFileObservation } from '../src/FileObservation';
import { readCompilerHeaderSearch } from '../src/CompilerHeaderSearch';
import { toHostPathKey } from '../src/utils/HostPlatform';

const logger = { debug() {}, verbose() {}, info() {}, warn() {}, error() {} } as any;
const key = (file: unknown) => toHostPathKey(path.resolve(String(file)));
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-file-observation-')));
  t.after(async () => { assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert.match(path.basename(root), /^aily-file-observation-/); await fs.remove(root); });
  return root;
}
async function countProbes<T>(files: string[], run: () => Promise<T> | T) {
  const targets = new Set(files.map(key)), counts = { stat: 0, exists: 0 };
  const originalStat = fs.statSync, originalExists = fs.existsSync;
  (fs as any).statSync = (file: unknown, ...args: any[]) => { if (targets.has(key(file))) counts.stat++; return (originalStat as any)(file, ...args); };
  (fs as any).existsSync = (file: unknown) => { if (targets.has(key(file))) counts.exists++; return (originalExists as any)(file); };
  try { return { value: await run(), counts, total: counts.stat + counts.exists }; }
  finally { (fs as any).statSync = originalStat; (fs as any).existsSync = originalExists; }
}

test('one work-validation boundary merges identity, exists and isFile probes but the next boundary reads afresh', async t => {
  const root = await fixture(t), header = path.join(root, 'external.h'), missing = path.join(root, 'optional.h'), directory = path.join(root, 'dir');
  await fs.writeFile(header, '#define MODE 1\n'); await fs.mkdir(directory);
  const work: any = { sourceHash: 'stable-library-bytes', externalHeaders: new Map([[header, dependencyInputIdentity(header)]]),
    observedPaths: new Map([[header, true], [missing, false], [directory, true]]),
    observedFiles: new Map([[header, true], [missing, false], [directory, false]]),
    headerInputs: new Map(), tapes: new Map(), units: new Map(), lookupChanged: false };
  const legacy = await countProbes([header, missing, directory], () => {
    assert.equal(dependencyInputIdentity(header), work.externalHeaders.get(header));
    for (const [file, expected] of work.observedPaths) assert.equal(fs.existsSync(file), expected);
    for (const [file, expected] of work.observedFiles) { let actual = false; try { actual = fs.statSync(file).isFile(); } catch {} assert.equal(actual, expected); }
  });
  assert.equal(legacy.total, 7, 'The prior three-map contract reads an overlapping path repeatedly');
  const dependency: any = { name: 'Library', type: 'library', path: path.join(root, 'library') }, shared = new Map([[dependency, work]]);
  let usedWork: unknown;
  const analyzer: any = Object.assign(Object.create(DependencyAnalyzer.prototype), { logger, platformContextKey: '', compilerDependencyDirectories: [], selectedLibraryPaths: [],
    libraryIndexCache: { async getOrCreate(_name: string, _path: string, _macros: unknown, build: any) { return { ...await build('stable-library-bytes'), sourceHash: 'stable-library-bytes' }; } },
    async buildLibraryIndex(_library: unknown, macros: unknown, _entries: unknown, current: unknown) { usedWork = current; return { sourceFiles: [], includeFiles: [], macroDefinitions: macros, headerInputs: [] }; } });
  const check = () => analyzer.applyLibraryIndex(dependency, new Map(), [], shared);
  const first = await countProbes([header, missing, directory], check);
  assert.equal(usedWork, work); assert.equal(first.total, 3); assert.equal(first.counts.exists, 0);
  const second = await countProbes([header, missing, directory], check);
  assert.equal(usedWork, work); assert.equal(second.total, 3, 'No valid observation is lent to the next apply boundary');
  const uniqueWork = { ...work, externalHeaders: new Map(), observedPaths: new Map() };
  shared.set(dependency, uniqueWork);
  const unique = await countProbes([header, missing, directory], check);
  assert.equal(usedWork, uniqueWork); assert.equal(unique.total, 3, 'Unique predicates still read every independent path');
  shared.set(dependency, work);
  shared.set(dependency, { ...work, externalHeaders: new Map([[header, undefined]]) });
  const invalidIdentity = await countProbes([header, missing, directory], check);
  assert.equal(invalidIdentity.total, 0, 'An already invalid identity keeps the old no-I/O short circuit');
  shared.set(dependency, work);
  await fs.writeFile(missing, '#define OPTIONAL 1\n'); await check();
  assert.notEqual(usedWork, work, 'A previously missing path appears: the work is discarded');
  await fs.unlink(missing); shared.set(dependency, work);
  await fs.writeFile(header, '#define MODE 22\n'); await check();
  assert.notEqual(usedWork, work, 'Changed external identity is independently rechecked');
  const original = fs.statSync, denied = Object.assign(new Error('provider denied metadata'), { code: 'EACCES' });
  shared.set(dependency, { ...work, externalHeaders: new Map() });
  (fs as any).statSync = (file: unknown, ...args: any[]) => { if (key(file) === key(missing)) throw denied; return (original as any)(file, ...args); };
  try { const prior = shared.get(dependency); await check(); assert.notEqual(usedWork, prior, 'A permission error is not a valid cached absence'); }
  finally { (fs as any).statSync = original; }
});

test('the current resolver probe feeds the real observer and tape identity, while cached lookups obtain a fresh identity', async t => {
  const root = await fixture(t), library = path.join(root, 'library'), first = path.join(root, 'first'), second = path.join(root, 'second'), third = path.join(root, 'third');
  for (const directory of [library, first, second, third]) await fs.mkdir(directory);
  const sharedHeader = path.join(second, 'Shared.h'), optional = path.join(first, 'optional.h');
  await fs.writeFile(sharedHeader, '#define SELECTED 1\n'); await fs.writeFile(path.join(third, 'Shared.h'), '#define NEXT_SELECTED 1\n');
  await fs.writeFile(path.join(library, 'Feature.h'), '#if __has_include(<optional.h>)\n#include <optional.h>\n#endif\n#include <Shared.h>\n');
  const response = path.join(root, 'flags.rsp');
  await fs.writeFile(response, [first, second, third].map(directory => `-I"${directory.replace(/\\/g, '/')}"`).join(' '));
  const search = readCompilerHeaderSearch(`@"${response}"`, root);
  const analyzer: any = Object.assign(Object.create(DependencyAnalyzer.prototype), { logger, libraryMap: new Map(), platformHeaderRoots: [],
    compilerSearch: { cpp: search, c: search }, compilerDependencyDirectories: [], selectedLibraryPaths: [], projectAndLibraryRoots: [], headerExistence: new Map(), headerLookups: new WeakMap() });
  const dependency: any = { name: 'Library', type: 'library', path: library, includes: [] };
  const built = await countProbes([sharedHeader], () => analyzer.buildLibraryIndex(dependency, new Map(), ['Feature.h']));
  assert.equal(built.total, 3,
    'Resolver/observer share the initial probe; after-read and end-of-analysis each verify the parsed generation afresh');
  assert.ok(built.value.headerInputs.some(([file, identity]: any) => file === sharedHeader && identity === dependencyInputIdentity(sharedHeader)));
  const finalValidation = await countProbes([sharedHeader], () => headerInputsCurrent(built.value.headerInputs));
  assert.equal(finalValidation.value, true); assert.equal(finalValidation.total, 1, 'The independent final cache boundary still probes');
  const observer = (file: string, _check: string, found: boolean, current: any) => current ?? (found ? readFileObservation(file) : undefined);
  const resolve = () => analyzer.resolveCompilerHeader({ file: path.join(library, 'Feature.h') }, 'Shared.h', 'angle', false, search, library, observer);
  await fs.writeFile(sharedHeader, '#define SELECTED 222\n');
  const cached = await countProbes([sharedHeader], resolve);
  assert.equal(cached.total, 1); assert.equal(cached.value.observation.identity, dependencyInputIdentity(sharedHeader), 'A cached search does not pass an old identity to a new observer');
  assert.equal(headerInputsCurrent(built.value.headerInputs), false);
  await fs.writeFile(optional, '#define OPTIONAL 1\n');
  assert.equal(headerInputsCurrent(built.value.headerInputs), false, '__has_include candidates remain exact');
  const shadow = path.join(first, 'Shared.h'); await fs.writeFile(shadow, '#define SHADOW 1\n');
  analyzer.resetHeaderLookups(); assert.equal(resolve().file, shadow, 'Response-file include order still selects the earlier shadow');
  const next = analyzer.resolveCompilerHeader({ file: shadow, directory: first }, 'Shared.h', 'angle', true, search, library, observer);
  assert.equal(next.file, sharedHeader, 'include_next retains its origin and order');
});

test('snapshot reuse is local, and unknown I/O failures cannot satisfy a negative cache input', async t => {
  const root = await fixture(t), missing = path.join(root, 'new.h');
  const sameBoundary = await countProbes([missing], () => { const view = new FileObservationSnapshot(); assert.equal(view.read(missing).state, 'missing'); assert.equal(view.read(missing).isFile, false); assert.equal(view.read(missing).identity, undefined); });
  assert.equal(sameBoundary.total, 1);
  const input: any = [[missing, null], [missing, null]];
  const validate = await countProbes([missing], () => headerInputsCurrent(input));
  assert.equal(validate.value, true); assert.equal(validate.total, 2, 'Single-field records each receive their fresh observation');
  assert.equal(headerInputsCurrent([[missing, null], [missing, 'conflicting-identity']]), false, 'Contradictory identities for one path are never accepted');
  await fs.writeFile(missing, 'changed'); assert.equal(headerInputsCurrent(input), false);
  await fs.unlink(missing);
  const original = fs.statSync, denied = Object.assign(new Error('provider denied metadata'), { code: 'EACCES' });
  (fs as any).statSync = () => { throw denied; };
  try { assert.equal(readFileObservation(missing).state, 'unavailable'); assert.equal(headerInputsCurrent(input), false); }
  finally { (fs as any).statSync = original; }
});

test('snapshot coalescing preserves case-distinct paths using independent real metadata', async t => {
  const root = await fixture(t), first = path.join(root, 'stat-a.h'), second = path.join(root, 'stat-b.h');
  await fs.writeFile(first, 'first'); await fs.writeFile(second, 'second-file-with-different-size');
  const upper = path.resolve(root, 'Case.h'), lower = path.resolve(root, 'case.h');
  const original = fs.statSync, calls: string[] = [];
  (fs as any).statSync = (file: unknown, ...args: any[]) => {
    const requested = path.resolve(String(file));
    if (requested === upper || requested === lower) {
      calls.push(requested);
      return (original as any)(requested === upper ? first : second, ...args);
    }
    return (original as any)(file, ...args);
  };
  try {
    const view = new FileObservationSnapshot(), a = view.read(upper), b = view.read(lower);
    assert.deepEqual(calls, [upper, lower], 'Both spellings reach their filesystem provider independently');
    assert.equal(a.state, 'present'); assert.equal(b.state, 'present');
    assert.notEqual(a.identity, b.identity, 'Distinct real Stats must not be replaced by a folded-case observation');
    assert.equal(view.read(upper), a); assert.equal(view.read(lower), b);
    assert.equal(calls.length, 2, 'Only exact repeated paths coalesce');
  } finally { (fs as any).statSync = original; }
});

test('fresh no-entry probes avoid expected filesystem exceptions and preserve files, directories and boundary changes', async t => {
  const root = await fixture(t), missing = path.join(root, 'optional.h'), regular = path.join(root, 'regular.h');
  const directory = path.join(root, 'directory'), nonDirectoryChild = path.join(regular, 'nested.h');
  await fs.writeFile(regular, '#define VALUE 1\n'); await fs.mkdir(directory);
  const original = fs.statSync, requests: Array<{ path: string; options: any; threw: boolean }> = [];
  (fs as any).statSync = (file: unknown, options: any) => {
    const request = { path: path.resolve(String(file)), options, threw: false }; requests.push(request);
    try { return (original as any)(file, options); }
    catch (error) { request.threw = true; throw error; }
  };
  try {
    const first = new FileObservationSnapshot();
    const absent = first.read(missing), blockedByFile = readFileObservation(nonDirectoryChild);
    assert.equal(absent.state, 'missing'); assert.equal(absent.identity, undefined);
    assert.equal(blockedByFile.state, 'missing'); assert.equal(blockedByFile.exists, false);
    assert.equal(requests.length, 2); assert.ok(requests.every(request => request.options?.throwIfNoEntry === false));
    assert.equal(requests.filter(request => request.threw).length, 0, 'Real fs-extra/Node no-entry probes do not construct thrown errors');
    await fs.writeFile(missing, '#define OPTIONAL 1\n');
    assert.equal(first.read(missing), absent, 'Only the same synchronous snapshot retains its observation');
    const fresh = new FileObservationSnapshot().read(missing);
    assert.equal(fresh.state, 'present'); assert.equal(fresh.isFile, true); assert.ok(fresh.identity);
    const dir = readFileObservation(directory), file = readFileObservation(regular);
    assert.equal(dir.state, 'present'); assert.equal(dir.exists, true); assert.equal(dir.isFile, false); assert.ok(dir.identity);
    assert.equal(file.state, 'present'); assert.equal(file.exists, true); assert.equal(file.isFile, true);
    assert.equal(file.identity, `${file.stat!.dev}:${file.stat!.ino}:${file.stat!.size}:${file.stat!.mtimeMs}:${file.stat!.ctimeMs}`);
    await fs.unlink(missing);
    assert.equal(readFileObservation(missing).state, 'missing', 'A later fresh probe sees deletion too');
  } finally { (fs as any).statSync = original; }
});

test('no-entry suppression never accepts unavailable I/O as absence and retains thrown-provider compatibility', async t => {
  const root = await fixture(t), missing = path.join(root, 'optional.h'), original = fs.statSync;
  for (const code of ['EACCES', 'EPERM', 'ELOOP', 'EIO', undefined]) {
    const failure = Object.assign(new Error('metadata unavailable'), code ? { code } : {});
    (fs as any).statSync = (_file: unknown, options: any) => { assert.equal(options?.throwIfNoEntry, false); throw failure; };
    try {
      const observed = readFileObservation(missing);
      assert.equal(observed.state, 'unavailable'); assert.equal(observed.exists, false); assert.equal(observed.isFile, false);
      assert.equal(observed.identity, undefined); assert.equal(observed.stat, undefined); assert.equal(observed.errorCode, code);
      assert.equal(headerInputsCurrent([[missing, null]]), false, 'An I/O failure must invalidate the negative input');
    } finally { (fs as any).statSync = original; }
  }
  for (const code of ['ENOENT', 'ENOTDIR']) {
    (fs as any).statSync = () => { throw Object.assign(new Error('legacy provider no-entry'), { code }); };
    try { const observed = readFileObservation(missing); assert.equal(observed.state, 'missing'); assert.equal(observed.errorCode, code); }
    finally { (fs as any).statSync = original; }
  }
});
