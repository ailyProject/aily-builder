import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { DirectiveTapeSnapshot, PreprocessInputChangedError } from '../src/DirectiveTapeSnapshot';
import { readFileObservation } from '../src/FileObservation';
import { LibraryIndexCache, dependencyInputIdentity, headerInputsCurrent } from '../src/LibraryIndexCache';
import { Logger } from '../src/utils/Logger';

class QuietLogger extends Logger {
  readonly messages: string[] = [];
  debug(message: string): void { this.messages.push(message); }
  info(): void {} verbose(): void {} warn(): void {} error(): void {}
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-tape-generation-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-tape-generation-'));
    await fs.remove(root);
  });
  const library = path.join(root, 'library', 'src'), sdk = path.join(root, 'sdk');
  await fs.ensureDir(library); await fs.ensureDir(sdk);
  const source = path.join(library, 'common.cpp'), publicHeader = path.join(library, 'Feature.h');
  const external = path.join(sdk, 'Shared.h');
  await fs.writeFile(source, '#include "Feature.h"\nint value() { return FEATURE_FLAG; }\n');
  await fs.writeFile(publicHeader, '#pragma once\n#include <Shared.h>\n#include <Shared.h>\n');
  await fs.writeFile(external, '#pragma once\n#define FEATURE_FLAG 1\n');
  const logger = new QuietLogger();
  const cache = Object.assign(Object.create(LibraryIndexCache.prototype), { logger, cacheDir: path.join(root, 'cache') });
  const search = { sourceDirectory: true, quote: [], bracket: [sdk], system: [] };
  const analyzer = () => Object.assign(Object.create(DependencyAnalyzer.prototype), {
    logger, libraryIndexCache: cache, libraryMap: new Map(), platformHeaderRoots: [sdk],
    platformContextKey: 'tape-generation-fixture', compilerSearch: { c: search, cpp: search },
    compilerDependencyDirectories: [], selectedLibraryPaths: [], projectAndLibraryRoots: [library],
    headerExistence: new Map(), headerLookups: new WeakMap(),
  });
  const dependency = () => ({ name: 'Feature', path: library, type: 'library', includes: [] });
  let generation = 1;
  const change = () => {
    generation++;
    fs.writeFileSync(external, `#pragma once\n#define FEATURE_FLAG ${generation}\n`);
    const time = new Date(Date.now() + generation * 3000);
    fs.utimesSync(external, time, time);
  };
  const read = (a = analyzer(), shared?: Map<any, any>) => a.applyLibraryIndex(dependency(), new Map(), ['Feature.h'], shared);
  const flag = (result: any) => result.macroDefinitions.get('FEATURE_FLAG')?.value;
  return { root, library, sdk, source, publicHeader, external, analyzer, dependency, logger, cache, change, read, flag };
}

function replace<T extends object, K extends keyof T>(t: TestContext, object: T, key: K, replacement: T[K]) {
  const original = object[key]; object[key] = replacement;
  t.after(() => { object[key] = original; });
  return original;
}

test('changed bytes during the first tape read rebuild the whole library generation before return', async t => {
  const f = await fixture(t), original = fs.readFileSync;
  let changed = false;
  replace(t, fs, 'readFileSync', ((file: any, ...args: any[]) => {
    const value = (original as any)(file, ...args);
    if (!changed && typeof file === 'string' && path.resolve(file) === f.external && Buffer.isBuffer(value)) {
      changed = true; f.change();
    }
    return value;
  }) as any);
  const first = await f.read();
  assert.equal(changed, true); assert.equal(f.flag(first), '2');
  assert.equal(first.headerInputs.find(([file]: [string, string]) => file === f.external)?.[1], dependencyInputIdentity(f.external));
  const cached = await f.read(); assert.equal(cached.cacheHit, true); assert.equal(f.flag(cached), '2');
  const direct = await f.analyzer().buildLibraryIndex(f.dependency(), new Map(), ['Feature.h']);
  assert.equal(f.flag(direct), f.flag(cached));
  assert.equal(f.logger.messages.filter(message => message.includes('retry Feature')).length, 1);
});

test('a repeated pragma-once include cannot overwrite old tape proof with the new identity', async t => {
  const f = await fixture(t), a = f.analyzer(), original = a.libraryHeaderResolver;
  let includes = 0;
  a.libraryHeaderResolver = function (...args: any[]) {
    const resolve = original.apply(this, args);
    return (...parameters: any[]) => {
      if (parameters[0] === 'Shared.h' && ++includes === 2) f.change();
      return resolve(...parameters);
    };
  };
  const result = await f.read(a);
  assert.equal(f.flag(result), '2'); assert.equal(headerInputsCurrent(result.headerInputs), true);
  assert.equal(f.flag(await f.read()), '2');
  assert.equal(f.logger.messages.filter(message => message.includes('retry Feature')).length, 1);
});

test('a change between asynchronous source selection and include analysis restarts with fresh tapes', async t => {
  const f = await fixture(t), a = f.analyzer(), original = a.analyzeLibraryIncludes;
  let changed = false;
  a.analyzeLibraryIncludes = function (...args: any[]) {
    if (!changed) { changed = true; f.change(); }
    return original.apply(this, args);
  };
  const result = await f.read(a, new Map());
  assert.equal(f.flag(result), '2'); assert.equal(f.flag(await f.read()), '2');
  assert.equal(f.logger.messages.filter(message => message.includes('retry Feature')).length, 1);
});

test('continuous input mutation fails closed after two generations and publishes no macro index', async t => {
  const f = await fixture(t), original = fs.readFileSync;
  let reads = 0;
  replace(t, fs, 'readFileSync', ((file: any, ...args: any[]) => {
    const value = (original as any)(file, ...args);
    if (typeof file === 'string' && path.resolve(file) === f.external && Buffer.isBuffer(value)) { reads++; f.change(); }
    return value;
  }) as any);
  await assert.rejects(f.read(), (error: any) => error instanceof PreprocessInputChangedError
    && error.code === 'PREPROCESS_INPUTS_CHANGED' && error.retryable && error.attempts === 2);
  assert.equal(reads, 2);
  const files = await fs.readdir(path.join(f.root, 'cache')).catch(() => []);
  assert.equal(files.some(file => file.startsWith('source-')), false);
});

test('a snapshot reuses only the same captured generation and refuses fresh changed or unreadable observations', async t => {
  const f = await fixture(t), snapshot = new DirectiveTapeSnapshot();
  const before = readFileObservation(f.external), first = snapshot.read(f.external, before);
  assert.strictEqual(snapshot.read(f.external, before), first);
  f.change();
  assert.throws(() => snapshot.observe(f.external, readFileObservation(f.external)), PreprocessInputChangedError);
  assert.throws(() => snapshot.verifyLoaded(), PreprocessInputChangedError);
  assert.throws(() => snapshot.observe(f.external, { state: 'unavailable', exists: false, isFile: false,
    identity: undefined, stat: undefined, errorCode: 'EACCES' }), PreprocessInputChangedError);
});

test('macro origins follow the final definition object across independent and reused translation units', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.source, '#include "Feature.h"\n#undef FEATURE_FLAG\n#define FEATURE_FLAG 3\n#undef REMOVED_FLAG\nint value() { return FEATURE_FLAG; }\n');
  await fs.writeFile(path.join(f.library, 'second.cpp'), '#define ANOTHER_FLAG 4\nint second() { return ANOTHER_FLAG; }\n');
  const a = f.analyzer(), shared = new Map(), dependency = f.dependency();
  const build = a.buildLibraryIndex;
  let result: any;
  a.buildLibraryIndex = async function (...args: any[]) { result = await build.apply(this, args); return result; };
  await a.applyLibraryIndex(dependency, new Map(), ['Feature.h'], shared);
  assert.equal(f.flag(result), '3');
  assert.equal(result.macroOrigins.get('FEATURE_FLAG').file, f.source);
  assert.equal(result.macroOrigins.get('FEATURE_FLAG').kind, 'define');
  assert.equal(result.macroOrigins.get('REMOVED_FLAG').kind, 'undef');
  assert.equal(result.macroOrigins.get('ANOTHER_FLAG').file, path.join(f.library, 'second.cpp'));
  assert.equal(result.macroOrigins.get('FEATURE_FLAG').identity, dependencyInputIdentity(f.source));
  const work = shared.get(dependency), again = await a.buildLibraryIndex(dependency, new Map(), ['Feature.h'], work);
  assert.equal(f.flag(again), '3');
  assert.deepEqual([...again.macroOrigins], [...result.macroOrigins]);
});

test('synchronous TU spans share repeated positive resolver and tape observations, while later TUs remain fresh', async t => {
  const single = await fixture(t), repeated = await fixture(t);
  await fs.writeFile(single.publicHeader, '#pragma once\n#include <Shared.h>\n');
  await fs.writeFile(repeated.publicHeader, '#pragma once\n' + '#include <Shared.h>\n'.repeat(12));
  const counts = new Map([[single.external, 0], [repeated.external, 0]]), original = fs.statSync;
  replace(t, fs, 'statSync', ((file: any, ...args: any[]) => {
    if (typeof file === 'string' && counts.has(path.resolve(file))) {
      const exact = path.resolve(file); counts.set(exact, counts.get(exact)! + 1);
    }
    return (original as any)(file, ...args);
  }) as any);
  for (const f of [single, repeated]) {
    const result = await f.analyzer().buildLibraryIndex(f.dependency(), new Map(), ['Feature.h']);
    assert.equal(f.flag(result), '1');
  }
  assert.equal(counts.get(single.external), counts.get(repeated.external));
  assert.ok(counts.get(single.external)! >= 5, 'later source/TU spans and the final guard still observe freshly');
  assert.ok(counts.get(repeated.external)! < 12, 'repeated includes do not each probe the positive header again');
});

test('an input changed after one synchronous TU span is observed afresh by the next TU', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.library, 'second.cpp'), '#include "Feature.h"\nint second() { return FEATURE_FLAG; }\n');
  const original = DirectiveTapeSnapshot.prototype.withinSpan;
  let changed = false;
  replace(t, DirectiveTapeSnapshot.prototype, 'withinSpan', function (this: DirectiveTapeSnapshot, parse: () => any) {
    const result = original.call(this, parse);
    if (!changed && this.reference(f.external)) { changed = true; f.change(); }
    return result;
  });
  const result = await f.read();
  assert.equal(changed, true); assert.equal(f.flag(result), '2');
  assert.equal(f.logger.messages.filter(message => message.includes('retry Feature')).length, 1);
  assert.equal(f.flag(await f.read()), '2');
});
