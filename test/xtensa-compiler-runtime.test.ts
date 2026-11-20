import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { reportWindowsXtensaConfigFailure, requireWindowsXtensaConfig } from '../src/XtensaCompilerRuntime';

test('Windows dynamic Xtensa wrappers use their own selected installation resources', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily xtensa tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const lib = path.join(root, 'lib');
  fs.mkdirSync(bin);
  fs.mkdirSync(lib);
  const executable = path.join(bin, 'xtensa-esp32s2-elf-g++.exe');
  const resource = path.join(lib, 'xtensa_esp32s2.so');
  const compiler = { cpp: executable, ld: executable };
  fs.writeFileSync(executable, '');

  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (line: string) => {
    lines.push(line);
    return true;
  });
  assert.doesNotThrow(() => requireWindowsXtensaConfig(compiler));
  assert.equal(lines.length, 0);
  fs.writeFileSync(path.join(bin, 'xtensa-esp-elf-g++.exe'), '');

  assert.throws(() => requireWindowsXtensaConfig(compiler), /Cannot use Xtensa compiler configuration.*ENOENT/);
  fs.writeFileSync(resource, 'not a PE library');
  assert.throws(() => requireWindowsXtensaConfig(compiler), /invalid Windows executable format/);
  assert.equal(lines.length, 2);

  const pe = Buffer.alloc(68);
  pe.writeUInt16LE(0x5a4d, 0);
  pe.writeUInt32LE(64, 60);
  pe.writeUInt32LE(0x00004550, 64);
  fs.writeFileSync(resource, pe);
  assert.doesNotThrow(() => requireWindowsXtensaConfig(compiler));
  reportWindowsXtensaConfigFailure('input.cpp:1: fatal error: missing.h: No such file or directory', compiler);
  assert.equal(lines.length, 2);

  reportWindowsXtensaConfigFailure("cc1plus.exe: fatal error: 'XTENSA_GNU_CONFIG' is defined but could not be loaded: Unable to load DLL.", compiler);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(line.trim().startsWith('[AILY_TOOL_LOAD_FAILURE] '));
    assert.deepEqual(JSON.parse(line.trim().slice('[AILY_TOOL_LOAD_FAILURE] '.length)), {
      version: 1,
      code: 'TOOL_LOAD_XTENSA_CONFIG',
      stage: 'compile',
      executable,
      resource
    });
  }
});
