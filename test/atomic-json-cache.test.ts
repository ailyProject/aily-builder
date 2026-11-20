import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import native from 'node:fs/promises';
import { LibraryIndexCache, dependencyInputIdentity } from '../src/LibraryIndexCache';
import { publishAtomicJsonCache } from '../src/AtomicJsonCache';

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-atomic-json-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-atomic-json-'));
    await fs.remove(root);
  });
  const file = path.join(root, 'cache', 'record.json');
  const messages: string[] = [];
  const makeCache = (): any => Object.assign(Object.create(LibraryIndexCache.prototype), {
    cacheDir: path.dirname(file), logger: { debug(message: string) { messages.push(message); } },
  });
  const value = (generation: string) => ({ generation, payload: generation.repeat(8192) });
  await fs.outputJSON(file, value('old'));
  return { root, file, messages, makeCache, value };
}

function error(code: string): NodeJS.ErrnoException { return Object.assign(new Error(`controlled ${code} rename`), { code }); }

// The same producer fault reaches the original fs-extra cache writer and the
// native atomic publisher, so the regression contracts remain meaningful.
function mockRename(t: TestContext, implementation: (source: string, destination: string) => Promise<void>): void {
  t.mock.method(fs, 'rename', implementation);
  t.mock.method(native, 'rename', implementation);
}

function mockUnlink(t: TestContext, implementation: (file: string) => Promise<void>): void {
  t.mock.method(fs, 'unlink', implementation);
  t.mock.method(native, 'unlink', implementation);
}

async function withReaders(file: string, values: Map<string, unknown>, publish: () => Promise<void>): Promise<number> {
  let stop = false, reads = 0;
  const failures: unknown[] = [];
  const reader = (async () => {
    do {
      try {
        const value = await fs.readJSON(file);
        assert.deepEqual(value, values.get(value.generation));
        reads++;
      } catch (failure) { failures.push(failure); break; }
      await setImmediate();
    } while (!stop);
  })();
  try { await publish(); }
  finally { stop = true; await reader; }
  assert.deepEqual(failures, [], 'Readers must always see one complete committed record');
  assert.ok(reads > 0);
  return reads;
}

test('Windows sharing contention retries atomic replacement while readers retain complete JSON', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), actualRename = native.rename.bind(native), actualUnlink = native.unlink.bind(native);
  const sources = new Set<string>();
  const codes = ['EPERM', 'EACCES', 'EBUSY'];
  let attempts = 0;
  mockUnlink(t, async (file: string) => { assert.notEqual(file, f.file); return actualUnlink(file); });
  mockRename(t, async (source: string, destination: string) => {
    if (destination !== f.file) return actualRename(source, destination);
    sources.add(source);
    const record = await fs.readJSON(source);
    assert.equal(record.generation, 'new');
    if (attempts++ < codes.length) {
      assert.equal((await fs.readJSON(f.file)).generation, 'old');
      throw error(codes[attempts - 1]);
    }
    return actualRename(source, destination);
  });
  await withReaders(f.file, new Map(['old', 'new'].map(id => [id, f.value(id)])), () => f.makeCache().writeCache(f.file, f.value('new')));
  assert.equal((await fs.readJSON(f.file)).generation, 'new');
  assert.ok(attempts >= 4 && attempts <= 6, 'Three injected conflicts plus any real sharing contention stay bounded');
  assert.equal(sources.size, 1, 'Retries must publish the same complete temporary file');
  assert.deepEqual(f.messages, []);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['record.json']);
});

test('Windows retry exhaustion preserves the prior record and cleans only the failed writer temporary file', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), before = await fs.readFile(f.file);
  const foreign = path.join(path.dirname(f.file), 'another-writer.tmp');
  await fs.writeFile(foreign, 'another writer owns these bytes');
  let attempts = 0;
  mockRename(t, async () => { attempts++; throw error('EACCES'); });
  await withReaders(f.file, new Map([['old', f.value('old')]]), () => f.makeCache().writeCache(f.file, f.value('new')));
  assert.equal(attempts, 6, 'Transient replacement contention must have a fixed attempt bound');
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'another writer owns these bytes');
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['another-writer.tmp', 'record.json']);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /failed to write cache/);
  assert.match(f.messages[0], /EACCES/);
});

test('a permanent rename error is reported once without deleting a valid destination or leaving a temporary file', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file);
  let attempts = 0;
  mockRename(t, async () => { attempts++; throw error('EINVAL'); });
  await f.makeCache().writeCache(f.file, f.value('new'));
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /EINVAL/);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['record.json']);
});

test('overlapping independent cache instances retry their own complete files without a shared process lock', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), actualRename = native.rename.bind(native);
  let release!: () => void;
  let releaseLeft!: () => void;
  const firstAttempts = new Promise<void>(resolve => { release = resolve; });
  const leftCommitted = new Promise<void>(resolve => { releaseLeft = resolve; });
  const attempts = new Map<string, number>();
  mockRename(t, async (source: string, destination: string) => {
    const seen = attempts.get(source) || 0;
    attempts.set(source, seen + 1);
    if (seen === 0) {
      if (attempts.size === 2) release();
      await firstAttempts;
      throw error('EPERM');
    }
    const value = await fs.readJSON(source);
    if (value.generation === 'right') await leftCommitted;
    await actualRename(source, destination);
    if (value.generation === 'left') releaseLeft();
  });
  await withReaders(f.file, new Map(['old', 'left', 'right'].map(id => [id, f.value(id)])), async () => {
    await Promise.all([
      f.makeCache().writeCache(f.file, f.value('left')),
      f.makeCache().writeCache(f.file, f.value('right')),
    ]);
  });
  assert.equal(attempts.size, 2);
  assert.ok([...attempts.values()].every(count => count >= 2 && count <= 6));
  assert.equal((await fs.readJSON(f.file)).generation, 'right', 'The last successful replacement wins');
  assert.deepEqual(f.messages, []);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['record.json']);
});

test('the publisher propagates a permanent error while the cache wrapper remains best effort', async t => {
  const f = await fixture(t), primary = error('EIO'), before = await fs.readFile(f.file);
  let attempts = 0;
  mockRename(t, async () => { attempts++; throw primary; });
  await assert.rejects(publishAtomicJsonCache(f.file, f.value('new')), failure => failure === primary);
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['record.json']);
});

test('a partial temporary write failure closes its own handle and preserves the committed record', async t => {
  const f = await fixture(t), actualOpen = native.open.bind(native), primary = error('ENOSPC');
  let closed = false;
  t.mock.method(native, 'open', async (...args: Parameters<typeof native.open>) => {
    const handle = await actualOpen(...args);
    return { async writeFile(bytes: string) { await handle.writeFile(bytes.slice(0, 7)); throw primary; },
      async close() { await handle.close(); closed = true; } };
  });
  await assert.rejects(publishAtomicJsonCache(f.file, f.value('new')), failure => failure === primary);
  assert.equal(closed, true);
  assert.equal((await fs.readJSON(f.file)).generation, 'old');
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['record.json']);
});

test('a failed initial close is retried for cleanup without replacing the close error', async t => {
  const f = await fixture(t), actualOpen = native.open.bind(native), primary = error('EIO');
  let closes = 0;
  t.mock.method(native, 'open', async (...args: Parameters<typeof native.open>) => {
    const handle = await actualOpen(...args);
    return { writeFile: handle.writeFile.bind(handle), async close() {
      if (++closes === 1) throw primary;
      await handle.close();
    } };
  });
  await assert.rejects(publishAtomicJsonCache(f.file, f.value('new')), failure => failure === primary);
  assert.equal(closes, 2);
  assert.equal((await fs.readJSON(f.file)).generation, 'old');
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['record.json']);
});

test('an exclusive-open collision never grants cleanup ownership of the preexisting temporary file', async t => {
  const f = await fixture(t), primary = error('EEXIST');
  let occupied = '';
  t.mock.method(native, 'open', async (file: string, flags: string) => {
    assert.equal(flags, 'wx');
    occupied = file;
    await fs.writeFile(file, 'another writer owns this file');
    throw primary;
  });
  await assert.rejects(publishAtomicJsonCache(f.file, f.value('new')), failure => failure === primary);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'another writer owns this file');
  assert.equal((await fs.readJSON(f.file)).generation, 'old');
});

test('cleanup failure cannot replace the original publication error', async t => {
  const f = await fixture(t), primary = error('EINVAL');
  mockRename(t, async () => { throw primary; });
  mockUnlink(t, async () => { throw error('EACCES'); });
  await assert.rejects(publishAtomicJsonCache(f.file, f.value('new')), failure => failure === primary);
  assert.equal((await fs.readJSON(f.file)).generation, 'old');
});

test('permission failures on other platforms are not treated as Windows sharing contention', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), primary = error('EACCES');
  let attempts = 0;
  mockRename(t, async () => { attempts++; throw primary; });
  await assert.rejects(publishAtomicJsonCache(f.file, f.value('new')), failure => failure === primary);
  assert.equal(attempts, 1);
});

for (const changedInput of ['source', 'present metadata', 'missing metadata']) {
  test(`input validation still rejects changed ${changedInput} during a publication retry`, { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t), actualRename = native.rename.bind(native), cache = f.makeCache();
    const library = path.join(f.root, 'Package', 'src'), source = path.join(library, 'main.cpp');
    const metadata = path.join(f.root, 'Package', 'library.properties');
    await fs.outputFile(source, 'int originalUnit() { return 1; }\n');
    if (changedInput !== 'missing metadata') await fs.writeFile(metadata, 'name=Package\n');
    const requiredInputs: Array<[string, string | null]> = [[metadata, dependencyInputIdentity(metadata) ?? null]];
    let mutated = false;
    mockRename(t, async (temporary: string, destination: string) => {
      if (!mutated) {
        mutated = true;
        await fs.writeFile(changedInput === 'source' ? source : metadata,
          changedInput === 'source' ? 'int changedUnit() { return 2; }\n' : 'name=Changed metadata\n');
        throw error('EPERM');
      }
      return actualRename(temporary, destination);
    });
    await assert.rejects(cache.getOrCreate('Package', library, new Map(), async () => ({
      sourceFiles: [source], includeFiles: [], macroDefinitions: new Map(),
      headerInputs: [[source, dependencyInputIdentity(source)!]],
    }), 'publication-guard-contract', { requiredInputs }), (failure: any) => failure.code === 'PREPROCESS_INPUTS_CHANGED');
    assert.equal(mutated, true);
    assert.deepEqual(f.messages.filter(message => message.includes('failed to write cache')), []);
  });
}
