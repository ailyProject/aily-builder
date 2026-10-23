import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { resolveArduinoPlatformFiles, resolveArduinoSdkLayout } from '../src/ArduinoBuildContext';
import { ArduinoSelectedToolPathError, findArduinoToolPath, resolveArduinoToolPaths, resolveArduinoToolsBasePath } from '../src/ArduinoToolResolver';

const names = ['src/ArduinoBuildContext.ts', 'src/ArduinoToolResolver.ts',
  'src/ArduinoPropertyResolver.ts', 'src/ArduinoPropertyFile.ts', 'test/physical-build-paths.test.ts'];
const pins = () => names.map(name => {
  const filename = path.resolve(__dirname, '..', name), bytes = fs.readFileSync(filename);
  return { path: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const before = pins();
const same = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-builder-physical-paths-'));
  const aliases: string[] = [];
  t.after(() => {
    // Remove each owned junction itself before recursively removing only the
    // freshly created fixture. No shared SDK, tools, or compiler is touched.
    for (const alias of aliases) {
      assert(same(path.dirname(alias), root));
      assert(fs.lstatSync(alias).isSymbolicLink()); fs.unlinkSync(alias);
    }
    assert(same(fs.realpathSync(root), root));
    assert(same(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir())));
    assert(path.basename(root).startsWith('aily-builder-physical-paths-'));
    fs.rmSync(root, { recursive: true });
  });
  return { root, junction(name: string, target: string) {
    const alias = path.join(root, name); assert(same(path.dirname(alias), root));
    fs.symlinkSync(target, alias, 'junction'); aliases.push(alias); return alias;
  } };
}
const options = { packageName: 'vendor', platformName: 'arch' };

test('selected SDK and tool reads use physical Windows junction targets; path-only helpers retain caller paths',
  { skip: process.platform !== 'win32', concurrency: false }, async t => {
    const f = fixture(t), physical = path.join(f.root, 'physical');
    const sdk = path.join(physical, 'Arduino15/packages/vendor/hardware/arch/1.0.0');
    const tool = path.join(physical, 'tools/compiler@1.0.0');
    fs.mkdirSync(sdk, { recursive: true }); fs.mkdirSync(tool, { recursive: true });
    fs.writeFileSync(path.join(sdk, 'platform.txt'), 'version=1.0.0\n');
    fs.writeFileSync(path.join(sdk, 'boards.txt'), 'Board.build.core=core\n');
    const alias = f.junction('borrowed', physical);
    const aliasSDK = path.join(alias, 'Arduino15/packages/vendor/hardware/arch/1.0.0');
    const aliasTools = path.join(alias, 'tools');
    const explicit = await resolveArduinoPlatformFiles({ ...options, sdkPath: aliasSDK, arduino15BasePath: 'unused' });
    const discovered = await resolveArduinoPlatformFiles({ ...options, arduino15BasePath: path.join(alias, 'Arduino15') });
    const expected = { sdkPath: fs.realpathSync(sdk), platformTxtPath: path.join(fs.realpathSync(sdk), 'platform.txt'),
      boardsTxtPath: path.join(fs.realpathSync(sdk), 'boards.txt') };
    assert.deepEqual(explicit, expected); assert.deepEqual(discovered, expected);
    const toolOptions = { ...options, toolName: 'compiler', version: '1.0.0', toolsPath: aliasTools, arduino15BasePath: 'unused' };
    assert.equal(await findArduinoToolPath(toolOptions), fs.realpathSync(tool));
    const resolved = await resolveArduinoToolPaths({ ...toolOptions, platformProperties: {
      'compiler.path': '{runtime.tools.compiler.path}/bin/' } });
    assert.equal(resolved['runtime.tools.compiler.path'], fs.realpathSync(tool));
    assert.equal(resolveArduinoSdkLayout(aliasSDK, 'core', 'variant').sdkPath, aliasSDK);
    assert.equal(resolveArduinoToolsBasePath(toolOptions), aliasTools);
    assert.equal(fs.readFileSync(path.join(sdk, 'platform.txt'), 'utf8'), 'version=1.0.0\n');
    assert(fs.lstatSync(alias).isSymbolicLink());
  });

test('selected unreadable paths reject while optional discovery retains its partial-result contract',
  { skip: process.platform !== 'win32', concurrency: false }, async t => {
    const f = fixture(t), sdk = path.join(f.root, 'sdk'); fs.mkdirSync(sdk);
    fs.writeFileSync(path.join(sdk, 'platform.txt'), 'version=1.0.0\n');
    await assert.rejects(resolveArduinoPlatformFiles({ ...options, sdkPath: sdk, arduino15BasePath: 'unused' }),
      { code: 'ENOENT' });
    const missingTarget = path.join(f.root, 'removed-tool'); fs.mkdirSync(missingTarget);
    f.junction('compiler@1.0.0', missingTarget); fs.rmdirSync(missingTarget);
    const toolOptions = { ...options, toolName: 'compiler', version: '1.0.0', toolsPath: f.root, arduino15BasePath: 'unused' };
    const selectedFailure = (error: unknown) => {
      assert(error instanceof ArduinoSelectedToolPathError);
      assert.equal(error.code, 'ARDUINO_SELECTED_TOOL_PATH_UNREADABLE');
      assert(same(error.selectedPath, path.join(f.root, 'compiler@1.0.0')));
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    };
    await assert.rejects(findArduinoToolPath(toolOptions), selectedFailure);
    const warnings: string[] = [];
    await assert.rejects(resolveArduinoToolPaths({ ...toolOptions, platformProperties: {
      'compiler.path': '{runtime.tools.compiler.path}/bin/' }, onWarning: warning => warnings.push(warning) }), selectedFailure);
    assert.equal(warnings.length, 1);
    // No selected tool remains the existing optional-discovery result.
    assert.equal(await findArduinoToolPath({ ...toolOptions, toolName: 'absent' }), null);

    const available = path.join(f.root, 'available@1.0.0'); fs.mkdirSync(available);
    const discoveryFailure = new Error('ordinary discovery failure');
    const discoveryWarnings: string[] = [];
    const partial = await resolveArduinoToolPaths({ ...toolOptions, platformProperties: {
      'first.path': '{runtime.tools.available.path}/bin/', 'later.path': '{runtime.tools.later.path}/bin/' },
      toolVersions: { available: '1.0.0', get later(): string { throw discoveryFailure; } },
      onWarning: warning => discoveryWarnings.push(warning) });
    assert.deepEqual(partial, { 'runtime.tools.available.path': fs.realpathSync(available) });
    assert.equal(discoveryWarnings.length, 1);
    assert(discoveryWarnings[0].includes(discoveryFailure.message));
  });

after(() => {
  assert.deepEqual(pins(), before);
  console.log('source-evidence ' + JSON.stringify({ node: process.version, execArgv: process.execArgv,
    sourceBookendsEqual: true, sourcePins: before, emittedFiles: 0, productBuilds: 0,
    realWindowsJunctions: process.platform === 'win32', sourceTestCases: 2 }));
});
