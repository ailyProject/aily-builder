import assert from 'node:assert/strict';
import test from 'node:test';
import { CompileConfigManager } from '../src/CompileConfigManager';
import { escapeQuotedDefines } from '../src/utils/escapeQuotes';

test('Ninja compile arguments normalize Arduino string macros once', () => {
  // UNO R4 wraps PROJECT_NAME in double quotes, while Nano ESP32 uses single quotes.
  const recipe = [
    '"C:/Arduino Tools/g++.exe" -c',
    '"-DPROJECT_NAME="C:/Coder weather via HTTP/.build/main""',
    '-DboardName="ESP32 Dev Module"',
    `'-DUSB_PRODUCT="Nano ESP32"' '-DUSB_DEBUG=1'`,
    `-DSIZE=(4) "-IC:/Arduino SDK/include" "@C:/Arduino SDK/includes.rsp"`,
  ].join(' ');
  const config = new CompileConfigManager(null).parseCompileConfig({
    platform: { 'recipe.cpp.o.pattern': recipe },
  });

  assert.equal(config.args.cpp, [
    '-c',
    String.raw`"-DPROJECT_NAME=\"C:/Coder weather via HTTP/.build/main\""`,
    String.raw`"-DboardName=\"ESP32 Dev Module\""`,
    String.raw`"-DUSB_PRODUCT=\"Nano ESP32\"" -DUSB_DEBUG=1`,
    `"-DSIZE=(4)" "-IC:/Arduino SDK/include" "@C:/Arduino SDK/includes.rsp"`,
  ].join(' '));
});

test('string macros keep C escapes and already escaped arguments', () => {
  const args = String.raw`-DQUOTED="two \"words\"" "-DREADY=\"already quoted\""`;
  const expected = String.raw`"-DQUOTED=\"two \\\"words\\\"\"" "-DREADY=\"already quoted\""`;

  assert.equal(escapeQuotedDefines(args), expected);
  assert.equal(escapeQuotedDefines(expected), expected);
});
