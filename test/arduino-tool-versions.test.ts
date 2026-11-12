import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { findArduinoToolPath, resolveArduinoToolPaths } from '../src/ArduinoToolResolver';
import { CompileConfigManager } from '../src/CompileConfigManager';

function fixture(t: TestContext) {
  const toolsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aily tools-'));
  t.after(() => fs.rmSync(toolsPath, { recursive: true, force: true }));
  const directory = (...parts: string[]) => {
    const value = path.join(toolsPath, ...parts);
    fs.mkdirSync(value, { recursive: true });
    return value.replace(/\\/g, '/');
  };
  return { location: { toolsPath, arduino15BasePath: toolsPath, packageName: 'test' }, directory };
}

test('an explicit tool version matches either versioned layout without accepting a newer or prerelease copy', async t => {
  const { location, directory } = fixture(t);
  const toolName = 'esptool_py';
  directory('esptool_py@5.3.1');
  directory('esptool_py@5.3.0-rc');
  const options = { ...location, toolName, version: '5.3.0' };
  assert.equal(await findArduinoToolPath(options), null);
  const nested = directory(toolName, '5.3.0');
  assert.equal(await findArduinoToolPath(options), nested);
  const canonical = directory('esptool_py@5.3.0');
  assert.equal(await findArduinoToolPath(options), canonical);
  assert.ok(await findArduinoToolPath({ ...location, toolName }));
});

test('known distribution directory names satisfy their corresponding package pins', async t => {
  const { location, directory } = fixture(t);
  for (const [toolName, version, layout] of [
    ['bossac', '1.6.1', 'bossac_1.6.1'],
    ['ctags', '5.8.0', 'ctags@5.8-arduino11'],
    ['pqt-picotool', '4.1.0', 'pqt-picotool@4.1.0-1aec55e'],
    ['openocd', '0.12.0', 'xpack-openocd@0.12.0'],
    ['arm-none-eabi-gcc', '14.2.1', 'xpack-arm-none-eabi-gcc@14.2.1-1.1'],
  ]) {
    const expected = directory(layout);
    assert.equal(await findArduinoToolPath({ ...location, toolName, version }), expected);
  }
});

test('preprocessing reports the required tool version when the only payload belongs to another version', async t => {
  const { location, directory } = fixture(t);
  directory('esptool_py@5.3.1');
  const options = {
    ...location,
    platformProperties: { 'tools.esptool_py.path': '{runtime.tools.esptool_py.path}' },
  };
  await assert.rejects(resolveArduinoToolPaths({
    ...options, toolVersions: { esptool_py: '5.3.0' },
  }), /Required Arduino tool esptool_py@5\.3\.0/);
  const legacy = await resolveArduinoToolPaths({
    ...options, toolVersions: { esptool_py: '^5.3.0' },
  });
  assert.match(legacy['runtime.tools.esptool_py.path'], /esptool_py@5\.3\.1$/);
});

test('a pinned output recipe keeps its resolved executable path and reports a missing executable', t => {
  const { directory } = fixture(t);
  const pinned = directory('esptool_py@5.3.0');
  const executable = `${pinned}/esptool.exe`;
  fs.writeFileSync(`${directory('esptool_py@5.3.1')}/esptool.exe`, '');
  const manager = new CompileConfigManager(null);
  const arduinoConfig = { platform: {
    'runtime.tools.esptool_py.path': pinned,
    'recipe.objcopy.bin.pattern': `"${executable}" elf2image`,
  } };
  const versions = { esptool_py: '5.3.0' };
  assert.throws(() => manager.parseCompileConfig(arduinoConfig, versions), /Required Arduino tool executable/);
  fs.writeFileSync(executable, '');
  assert.equal(manager.parseCompileConfig(arduinoConfig, versions).compiler.bin, `"${executable}"`);
  assert.equal(manager.parseCompileConfig(arduinoConfig).compiler.bin, 'esptool.exe');
  assert.equal(manager.parseCompileConfig(arduinoConfig, { esptool_py: '^5.3.0' }).compiler.bin, 'esptool.exe');
});
