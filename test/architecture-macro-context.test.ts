import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompileConfigManager } from '../src/CompileConfigManager';
import { DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { analyzeSourceWithDefines } from '../src/utils/AnalyzeFile';
import { ExpressionEvaluator, MacroExpander } from '../src/utils/PreprocessorExpression';

const logger = { debug() {}, info() {}, verbose() {}, warn() {}, error() {} } as any;

test('a platform family predicate can generate defined with a pasted identifier without expanding its operand', () => {
  for (const value of ['0', '', '(4U)', 'OTHER']) {
    const macros = new Map();
    const result = analyzeSourceWithDefines(`
#define __FALCON__ ${value}
#define part_is_present(part) (defined(__ ## part ## __))
#define FAMILY (part_is_present(SPARROW) || part_is_present(FALCON))
#if FAMILY
#include <chosen.h>
#else
#include <wrong.h>
#endif
`, macros, { allowIndeterminate: true });
    assert.equal(result.fallbackRequired, false, `defined tests presence rather than replacement text ${JSON.stringify(value)}`);
    assert.deepEqual(result.includes, ['chosen.h']);
    assert.deepEqual(new ExpressionEvaluator(macros).evaluateDetailed('part_is_present(SPARROW)'), { kind: 'known', value: false });
    assert.deepEqual(new ExpressionEvaluator(macros).evaluateDetailed('part_is_present(FALCON)'), { kind: 'known', value: true });
  }
});

test('generated defined respects undef and ordinary defined while malformed operands stay indeterminate', () => {
  const macros = new Map();
  analyzeSourceWithDefines(`
#define __FALCON__ 1
#define part_is_present(part) defined(__ ## part ## __)
#define DEFINED_ALIAS defined
#define OBJECT_PREDICATE defined(__FALCON__)
#undef __FALCON__
`, macros);
  const evaluator = new ExpressionEvaluator(macros);
  assert.deepEqual(evaluator.evaluateDetailed('part_is_present(FALCON)'), { kind: 'known', value: false });
  assert.deepEqual(evaluator.evaluateDetailed('OBJECT_PREDICATE'), { kind: 'known', value: false });
  assert.deepEqual(evaluator.evaluateDetailed('DEFINED_ALIAS(part_is_present) && !DEFINED_ALIAS __FALCON__'), { kind: 'known', value: true });
  assert.deepEqual(evaluator.evaluateDetailed('defined(part_is_present) && !defined __FALCON__'), { kind: 'known', value: true });
  for (const expression of ['defined(1)', 'defined()', 'defined(A B)', 'defined', 'defined + 1', '0 && defined', 'DEFINED_ALIAS + 1']) {
    assert.equal(evaluator.evaluateDetailed(expression).kind, 'indeterminate');
  }
  // This is conditional-expression behavior; general macro expansion is shared
  // by include operands and must not acquire a global defined operator.
  macros.set('VALUE', { name: 'VALUE', isDefined: true, value: '7' });
  assert.equal(new MacroExpander(macros).expand('defined(VALUE)'), 'defined(7)');
});

test('resolved C/C++ recipe search reaches a nested platform definition before selecting a wrapper dependency', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-architecture-context-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(root), /^aily-architecture-context-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const library = path.join(root, 'library'), platform = path.join(root, 'platform headers');
  await fs.mkdir(library); await fs.mkdir(path.join(platform, 'family'), { recursive: true });
  const write = (directory: string, file: string, text: string) => fs.writeFile(path.join(directory, file), text);
  await write(platform, 'Device.h', `
#define part_is_present(part) (defined(__ ## part ## __))
#define FAMILY (part_is_present(FALCON) || part_is_present(SPARROW))
#if FAMILY
#include "family/selected.h"
#endif
`);
  await write(platform, 'family/selected.h', `
#if defined(__FALCON__)
#define CORE_LEVEL (4U)
#elif defined(__SPARROW__)
#define CORE_LEVEL (0U)
#endif
`);
  const wrapper = `#include <Device.h>
#if CORE_LEVEL == 4
#include <chosen4.h>
#elif CORE_LEVEL == 0
#include <chosen0.h>
#endif
int wrapper() { return 1; }
`;
  await write(library, 'wrapper.c', wrapper); await write(library, 'wrapper.cpp', wrapper);
  const response = path.join(root, 'search.rsp');
  await fs.writeFile(response, `-I"${platform.replace(/\\/g, '/')}"`);

  for (const [target, expected] of [['FALCON', 'chosen4.h'], ['SPARROW', 'chosen0.h']] as const) {
    const recipe = `"compiler" -c -D__${target}__=0 @"${response.replace(/\\/g, '/')}" %INCLUDE_PATHS% "{source_file}" -o "{object_file}"`;
    const config = { fqbn: 'generic:fixture:board', fqbnParsed: { package: 'generic', platform: 'fixture', boardId: 'board' },
      platform: { 'recipe.c.o.pattern': recipe, 'recipe.cpp.o.pattern': recipe } };
    const args = new CompileConfigManager(logger).parseCompileConfig(config).args;
    const analyzer: any = Object.assign(Object.create(DependencyAnalyzer.prototype), {
      logger, macroDefinitions: new Map(), configuredMacros: new Map(), libraryMap: new Map(),
      selectedLibraryPaths: [], projectAndLibraryRoots: [library],
    });
    analyzer.configurePlatformHeaderContext(config, args);
    analyzer.initializeDefaultMacros(config);
    const routes: string[] = [];
    const original = analyzer.resolveCompilerHeader;
    analyzer.resolveCompilerHeader = function (...parameters: any[]) {
      const resolved = original.apply(this, parameters);
      if (resolved) routes.push(resolved.file);
      return resolved;
    };
    const result = await analyzer.buildLibraryIndex({ name: 'GenericWrapper', path: library }, analyzer.macroDefinitions);
    assert.deepEqual(result.includeFiles, [expected], 'The wrapper observes the platform definition at its include location');
    assert.equal(result.macroDefinitions.get('CORE_LEVEL')?.value, target === 'FALCON' ? '(4U)' : '(0U)');
    for (const file of [path.join(platform, 'Device.h'), path.join(platform, 'family/selected.h')]) {
      assert.ok(routes.includes(file), 'The actual ordered compiler resolver visits the header');
      assert.ok(result.headerInputs.some(([input, identity]: any) => input === file && typeof identity === 'string'), 'Selected definitions retain fresh file proof');
    }
  }
});
