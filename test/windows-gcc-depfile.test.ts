import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveWindowsGccProbe } from '../src/WindowsGccDepfile';
import { encodeDepfileAsUtf8 } from '../src/windows-gcc-depfile-runner';

const legacyDepfile = Buffer.concat([
  Buffer.from('probe.o: probe.cpp '),
  Buffer.from('815c', 'hex'), // 乗 ends in a byte that GCC also sees as a backslash.
  Buffer.from(String.raw`\\ \#\ `),
  Buffer.from('c2a9', 'hex'), // 漏 in GBK, also valid UTF-8 for ©.
  Buffer.from('.h \\\r\n extra.h\r\n'),
]);
const unicodeDependency = '乗 # 漏.h';

test('transcodes GCC dependency bytes before Ninja parses their escapes', () => {
  assert.equal(
    encodeDepfileAsUtf8(legacyDepfile, 'gbk').toString(),
    'probe.o: probe.cpp ' + String.raw`乗\ \#\ 漏.h` + ' \\\r\n extra.h\r\n',
  );
  const ascii = Buffer.from('probe.o: probe.cpp extra.h\r\n');
  assert.equal(encodeDepfileAsUtf8(ascii, 'gbk'), ascii);
  const unambiguousUtf8 = Buffer.from('probe.o: probe.cpp 中文字.h\r\n');
  assert.equal(encodeDepfileAsUtf8(unambiguousUtf8, 'gbk'), unambiguousUtf8);
});

test('GCC probes use the configured tool directory and skip project executables', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily gcc probe '));
  const project = path.join(root, 'project');
  const tools = path.join(root, 'compiler');
  const fallback = path.join(root, 'fallback');
  const name = 'arm-none-eabi-gcc.exe';
  const previous = process.cwd();
  try {
    for (const directory of [project, tools, fallback]) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, name), '');
    }
    process.chdir(project);
    const env = { PATH: ['.', project, fallback].join(path.delimiter) };
    assert.equal(resolveWindowsGccProbe('arm-none-eabi-gcc', {
      ...env, COMPILER_PATH: tools + path.sep,
    }), path.join(tools, name));
    assert.equal(resolveWindowsGccProbe(name, env), path.join(fallback, name));
    assert.equal(resolveWindowsGccProbe(name, { PATH: '.;' + project }), undefined);
    assert.equal(resolveWindowsGccProbe('.\\' + name, env), undefined);
  } finally {
    process.chdir(previous);
    for (const directory of [project, tools, fallback]) {
      fs.rmSync(path.join(directory, name), { force: true });
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
    }
    fs.rmdirSync(root);
  }
});

test('Ninja retains converted dependencies across rebuilds and compiler failure', {
  skip: process.platform !== 'win32',
}, t => {
  // Import the compiled helper so it resolves the same sidecar as the CLI.
  const { wrapWindowsGccDepfileCommand } = require('../dist/src/WindowsGccDepfile.js');
  const ninja = path.resolve(__dirname, '../ninja/ninja.exe');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily gcc depfile '));
  t.after(() => {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const file = (name: string) => path.join(directory, name);
  fs.writeFileSync(file('probe.cpp'), '');
  fs.writeFileSync(file('extra.h'), '');
  fs.writeFileSync(file(unicodeDependency), '');
  fs.writeFileSync(file('legacy.d'), legacyDepfile);
  fs.writeFileSync(file('compiler mock.cjs'), [
    'const assert = require("node:assert/strict");',
    'const fs = require("node:fs");',
    'const [output, define] = process.argv.slice(2);',
    'assert.equal(define, \'-DMACRO="value with spaces"\');',
    'if (fs.existsSync("fail")) process.exit(7);',
    'fs.writeFileSync(output, "compiled");',
    'fs.copyFileSync("legacy.d", output + ".d");',
  ].join('\n'));
  const original = `"${process.execPath}" "compiler mock.cjs" $out "-DMACRO=\\"value with spaces\\""`;
  fs.writeFileSync(file('build.ninja'), [
    'rule compile',
    '  command = ' + wrapWindowsGccDepfileCommand(original, 'gbk'),
    '  deps = gcc',
    '  depfile = $out.d',
    'build probe.o: compile probe.cpp',
    '',
  ].join('\n'));
  const runNinja = () => spawnSync(ninja, ['-v', 'probe.o'], {
    cwd: directory, encoding: 'utf8', windowsHide: true,
  });
  const expectCold = () => {
    const result = runNinja();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[1\/1\]/);
  };

  expectCold();
  assert.match(runNinja().stdout, /no work to do/);
  fs.unlinkSync(file(unicodeDependency));
  fs.writeFileSync(file('fail'), '');
  const failed = runNinja();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /\[code=7\]/);
  assert.equal(fs.existsSync(file('probe.o.d')), false);
  fs.unlinkSync(file('fail'));
  fs.writeFileSync(file(unicodeDependency), '');
  expectCold();
  assert.match(runNinja().stdout, /no work to do/);
});
