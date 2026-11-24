import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArduinoCompiler } from '../src/ArduinoCompiler';
import { Logger } from '../src/utils/Logger';

for (const extension of ['ino', 'cpp'] as const) {
  test(`staged .${extension} preserves unchanged bytes and detects same-size edits`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-incremental-sketch-'));
    const names = ['SKETCH_PATH', 'SKETCH_NAME', 'BUILD_PATH'] as const;
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
    t.after(async () => {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    });

    const build = path.join(root, 'build');
    const source = path.join(root, `sketch.${extension}`);
    const staged = path.join(build, 'sketch.cpp');
    const compiler = new ArduinoCompiler(new Logger()) as unknown as {
      prepareBuildDirectory(buildPath: string): Promise<void>;
    };
    const prepare = async () => {
      process.env.SKETCH_PATH = source;
      process.env.SKETCH_NAME = 'sketch';
      process.env.BUILD_PATH = build;
      await compiler.prepareBuildDirectory(build);
      assert.equal(process.env.SKETCH_PATH, staged);
    };

    const originalSource = Buffer.from('void setup() { delay(1); }\nvoid loop() {}\n');
    const editedSource = Buffer.from('void setup() { delay(2); }\nvoid loop() {}\n');
    const sourceMode = extension === 'cpp' && process.platform !== 'win32' ? 0o600 : undefined;
    await fs.writeFile(source, originalSource, { mode: sourceMode });
    const sourceTime = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(source, sourceTime, sourceTime);
    await prepare();
    const initialBytes = await fs.readFile(staged);
    if (extension === 'ino') assert.match(initialBytes.toString('utf8'), /#include <Arduino\.h>/);
    else assert.deepEqual(initialBytes, originalSource);
    if (sourceMode !== undefined) assert.equal((await fs.stat(staged)).mode & 0o777, sourceMode);

    const stagedTime = new Date('2021-01-01T00:00:00Z');
    await fs.utimes(staged, stagedTime, stagedTime);
    await prepare();
    assert.deepEqual(await fs.readFile(staged), initialBytes);
    assert.equal((await fs.stat(staged)).mtimeMs, stagedTime.getTime());

    await fs.writeFile(source, editedSource);
    await fs.utimes(source, sourceTime, sourceTime);
    if (sourceMode !== undefined) await fs.chmod(staged, 0o644);
    await prepare();
    const editedBytes = await fs.readFile(staged);
    if (extension === 'ino') assert.ok(editedBytes.includes(editedSource));
    else assert.deepEqual(editedBytes, editedSource);
    assert.notDeepEqual(editedBytes, initialBytes);
    assert.ok((await fs.stat(staged)).mtimeMs > stagedTime.getTime());
    if (sourceMode !== undefined) assert.equal((await fs.stat(staged)).mode & 0o777, sourceMode);
  });
}
