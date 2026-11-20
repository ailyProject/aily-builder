import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSourceWithDefines } from '../src/utils/AnalyzeFile';

test('diagnostic prose in Wio headers does not interrupt dependency analysis', () => {
  const result = analyzeSourceWithDefines(Buffer.from(`
#if 0
#error Didn't support this Touch yet.
#endif
#warning User's display may need a different configuration.
#include "Display.h"
`), new Map());

  assert.deepEqual(result.includes, ['Display.h']);
  assert.equal(result.fallbackRequired, false);
});

test('an unterminated quoted include still requires a fallback', () => {
  assert.throws(() => analyzeSourceWithDefines('#include "Display.h\n', new Map()), /fallback/);
});

test('trailing tokens accepted by GCC preserve the conditional dependency edges', () => {
  const result = analyzeSourceWithDefines(`
#if 0
#include "Inactive.h"
#else legacy label
#include "Display.h"
#endif;
#include "After.h"
`, new Map());

  assert.deepEqual(result.includes, ['Display.h', 'After.h']);
  assert.equal(result.fallbackRequired, false);
  assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.severity), ['warning', 'warning']);
});
