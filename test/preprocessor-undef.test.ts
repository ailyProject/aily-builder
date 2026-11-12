import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSourceWithDefines } from '../src/utils/AnalyzeFile';

test('undef with extra tokens removes the complete macro and preserves following dependency branches', () => {
  const source = `
#define noInterrupts() old_enter()
#define interrupts() old_exit()
#undef noInterrupts() {portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;portENTER_CRITICAL(&mux)
#undef interrupts() portEXIT_CRITICAL(&mux);}
#ifdef noInterrupts
#include "stale-enter.h"
#else
#include "after-enter.h"
#endif
#ifdef interrupts
#include "stale-exit.h"
#else
#include "after-exit.h"
#endif
`;
  const result = analyzeSourceWithDefines(source, new Map());
  assert.equal(result.fallbackRequired, false);
  assert.deepEqual(result.includes, ['after-enter.h', 'after-exit.h']);
  assert.equal(result.defines.get('noInterrupts')?.isDefined, false);
  assert.equal(result.defines.get('interrupts')?.isDefined, false);
  assert.equal(result.diagnostics.filter(d => d.severity === 'warning').length, 2);
});

test('undef does not expand its identifier and warns about extra tokens only in active branches', () => {
  const result = analyzeSourceWithDefines(`
#define ALIAS TARGET
#define TARGET 1
#if 0
#undef TARGET garbage
#endif
#undef ALIAS extra tokens
#ifdef TARGET
#include "retained.h"
#endif
#undef TARGET /* ordinary comment */
`, new Map());
  assert.deepEqual(result.includes, ['retained.h']);
  assert.equal(result.defines.get('ALIAS')?.isDefined, false);
  assert.equal(result.defines.get('TARGET')?.isDefined, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].severity, 'warning');
});

for (const argument of ['', '123', '(NAME)', 'NAME$OTHER', 'NAME\\u1234', 'NAME变量']) {
  test(`undef keeps unsupported or missing identifiers fatal: ${JSON.stringify(argument)}`, () => {
    assert.throws(() => analyzeSourceWithDefines(`#undef ${argument}\n`, new Map()), /fallback/);
  });
}
