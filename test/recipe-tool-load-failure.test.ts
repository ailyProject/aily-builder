import assert from 'node:assert/strict';
import test from 'node:test';
import { RecipeRunner, RecipeRunnerError } from '../src/RecipeRunner';

const windowsOnly = { skip: process.platform !== 'win32' };
const objcopy = 'recipe.objcopy.bin.pattern';
const prebuild = 'recipe.hooks.prebuild.4.pattern';

function nodeCommand(script: string): string {
  return '"' + process.execPath + '" -e "' + script + '"';
}

test('independent Windows recipes reset inherited PyInstaller state only in the child', windowsOnly, async () => {
  const script = 'process.stdout.write(JSON.stringify([process.env.PYINSTALLER_RESET_ENVIRONMENT, process.env._PYI_ARCHIVE_FILE]))';
  const command = nodeCommand(script);
  const runner = new RecipeRunner({
    [objcopy]: command,
    [prebuild]: 'cmd /d /c IF 1==1 ( ' + command + ' )'
  });
  const originalReset = process.env.PYINSTALLER_RESET_ENVIRONMENT;
  const clean = { PYINSTALLER_RESET_ENVIRONMENT: undefined, _PYI_ARCHIVE_FILE: undefined };
  const frozenParent = { ...clean, pyinstaller_reset_environment: '0', _PYI_ARCHIVE_FILE: process.execPath };

  assert.deepEqual(JSON.parse((await runner.runRecipe(objcopy, { env: clean })).stdout), [null, null]);
  for (const recipe of [objcopy, prebuild]) {
    const result = await runner.runRecipe(recipe, { env: frozenParent });
    assert.deepEqual(JSON.parse(result.stdout), ['1', process.execPath]);
  }
  assert.equal(process.env.PYINSTALLER_RESET_ENVIRONMENT, originalReset);
  assert.equal(frozenParent.pyinstaller_reset_environment, '0');
});

test('PyInstaller diagnostics preserve stderr and report only evidenced Win32 errors', windowsOnly, async t => {
  const stderrWrite = t.mock.method(process.stderr, 'write', () => true);
  const resource = 'C:\\Users\\示例 用户\\Temp\\_MEI123\\python313.dll';
  const firstLine = "[PYI-548:ERROR] Failed to load Python DLL '" + resource + "'.\r\n";
  const cases = [
    { recipe: prebuild, stderr: firstLine + 'LoadLibrary: ?????????', stage: 'prebuild', win32Error: undefined },
    { recipe: objcopy, stderr: firstLine + 'LoadLibrary: [WinError 126] module unavailable\r\n', stage: 'objcopy', win32Error: 126 },
    { recipe: objcopy, stderr: 'gcc: ld returned 126 exit status\r\n', stage: undefined, win32Error: undefined }
  ];

  const payloads: object[] = [];
  for (const fixture of cases) {
    const encoded = Buffer.from(fixture.stderr).toString('base64');
    const script = "process.stderr.write(Buffer.from('" + encoded + "', 'base64')); process.exitCode = 126";
    const runner = new RecipeRunner({ [fixture.recipe]: nodeCommand(script) });
    await assert.rejects(runner.runRecipe(fixture.recipe), error => {
      assert.ok(error instanceof RecipeRunnerError);
      assert.equal(error.code, 'PROCESS_FAILED');
      assert.equal(error.details.exitCode, 126);
      assert.equal(error.details.stderr, fixture.stderr);
      if (fixture.stage) {
        const payload = {
          version: 1,
          code: 'TOOL_LOAD_PYTHON_DLL',
          stage: fixture.stage,
          executable: process.execPath,
          resource,
          ...(fixture.win32Error ? { win32Error: fixture.win32Error } : {})
        };
        assert.deepEqual(error.details.toolLoadFailure, payload);
        payloads.push(payload);
      } else {
        assert.equal(error.details.toolLoadFailure, undefined);
      }
      return true;
    });
  }

  const lines = stderrWrite.mock.calls.map(call => String(call.arguments[0]));
  assert.deepEqual(lines, payloads.map(payload => '\n[AILY_TOOL_LOAD_FAILURE] ' + JSON.stringify(payload) + '\n'));
});
