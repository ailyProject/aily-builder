import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveArtifactTargetMarkers } from '../src/ArduinoCompiler';
import { projectResolvedBuildTargetSelection } from '../src/ResolvedBuildTargetSelection';

const fqbn = 'STMicroelectronics:stm32:GenF1';
const properties = { 'build.board': 'GENERIC_F103C8TX', 'build.product_line': 'STM32F103xB',
  'build.mcu': 'cortex-m3', 'build.variant': 'STM32F1xx/F103C8T_F103CB(T-U)',
  'upload.maximum_size': '65536', 'upload.maximum_data_size': '20480' };

test('exact SDK chip selection distinguishes C8 from the shared xB compile family', () => {
  for (const boardId of ['GENERIC_F103C8TX', 'BLUEPILL_F103C8', 'CUSTOM_F103C8T6']) {
    assert.deepEqual(resolveArtifactTargetMarkers(fqbn, { ...properties, 'build.board': boardId }),
      { boardId, mcu: 'STM32F103C8' });
  }
  assert.equal(properties['build.product_line'], 'STM32F103xB', 'Never rewrite the SDK family fact.');
});

test('ambiguous family or an unrelated chip cannot be guessed from capacity or display names', () => {
  for (const boardId of ['MY_BOARD', 'GENERIC_F103C8TX_EXTRA_CB']) {
    assert.equal(resolveArtifactTargetMarkers(fqbn, { ...properties, 'build.board': boardId }).mcu, 'STM32F103xB');
  }
});

test('the CB LQFP48 wave preserves original xB facts and requires an exact T package token', () => {
  const cb = { ...properties, 'upload.maximum_size': '131072' };
  const original = structuredClone(cb);
  for (const boardId of ['GENERIC_F103CBTX', 'CUSTOM_F103CBT6', 'CUSTOM_F103CBT7']) {
    assert.deepEqual(resolveArtifactTargetMarkers(fqbn, { ...cb, 'build.board': boardId }),
      { boardId, mcu: 'STM32F103CB' });
  }
  assert.deepEqual(cb, original, 'Never rewrite producer facts or its compiler product line.');
  for (const boardId of ['BLUEPILL_F103CB', 'GENERIC_F103CBUX', 'CUSTOM_F103CBU6',
    'CUSTOM_F103CBT8', 'GENERIC_F103CBTX_EXTRA', 'MY_BOARD']) {
    assert.equal(resolveArtifactTargetMarkers(fqbn, { ...cb, 'build.board': boardId }).mcu,
      'STM32F103xB', `No CB package guess for ${boardId}.`);
  }
});

test('the RB LQFP64 wave requires its exact T package and selected SDK variant', () => {
  const rb = { ...properties, 'build.variant': 'STM32F1xx/F103R(8-B)T', 'upload.maximum_size': '131072' };
  const original = structuredClone(rb);
  for (const boardId of ['GENERIC_F103RBTX', 'CUSTOM_F103RBT6', 'CUSTOM_F103RBT7']) {
    assert.deepEqual(resolveArtifactTargetMarkers(fqbn, { ...rb, 'build.board': boardId }),
      { boardId, mcu: 'STM32F103RB' });
  }
  assert.deepEqual(rb, original, 'Publish exact RB without rewriting the SDK xB fact.');
  for (const boardId of ['NUCLEO_F103RB', 'BLUEBUTTON_F103RB', 'GENERIC_F103RBHX',
    'CUSTOM_F103RBU6', 'GENERIC_F103R8TX', 'CUSTOM_F103RBT8', 'GENERIC_F103RBTX_EXTRA', 'MY_BOARD']) {
    assert.equal(resolveArtifactTargetMarkers(fqbn, { ...rb, 'build.board': boardId }).mcu,
      'STM32F103xB', `No RB package guess for ${boardId}.`);
  }
});

test('an exact RB token cannot conceal incompatible CPU, variant, family or capacities', () => {
  const rb = { ...properties, 'build.board': 'GENERIC_F103RBTX',
    'build.variant': 'STM32F1xx/F103R(8-B)T', 'upload.maximum_size': '131072' };
  for (const [key, value] of [['build.variant', 'STM32F1xx/F103C8T_F103CB(T-U)'],
    ['build.variant', 'STM32F1xx/F103R(8-B)H'], ['build.mcu', 'cortex-m4'],
    ['upload.maximum_size', '65536'], ['upload.maximum_data_size', '49152']]) {
    assert.throws(() => resolveArtifactTargetMarkers(fqbn, { ...rb, [key]: value }), /STM32F103RB.*conflicts/);
  }
  for (const key of ['build.mcu', 'build.variant', 'upload.maximum_size', 'upload.maximum_data_size']) {
    const missing = { ...rb }; delete missing[key];
    assert.throws(() => resolveArtifactTargetMarkers(fqbn, missing), /STM32F103RB.*conflicts/);
  }
  assert.equal(resolveArtifactTargetMarkers(fqbn, { ...rb, 'build.product_line': 'STM32F103xE' }).mcu,
    'STM32F103xE', 'Never normalize another compiler family to RB.');
});

test('an exact CB token cannot conceal incompatible CPU, variant or capacities', () => {
  const cb = { ...properties, 'build.board': 'GENERIC_F103CBTX', 'upload.maximum_size': '131072' };
  for (const [key, value] of [['build.variant', 'STM32F1xx/F103R(8-B)T'], ['build.mcu', 'cortex-m4'],
    ['upload.maximum_size', '65536'], ['upload.maximum_data_size', '65536']]) {
    assert.throws(() => resolveArtifactTargetMarkers(fqbn, { ...cb, [key]: value }), /STM32F103CB.*conflicts/);
  }
  assert.equal(resolveArtifactTargetMarkers(fqbn, { ...cb, 'build.product_line': 'STM32F103xE' }).mcu,
    'STM32F103xE', 'Never normalize a different compiler family to CB.');
});

test('a C8 SDK token cannot conceal incompatible variant, CPU or capacities', () => {
  for (const [key, value] of [['build.variant', 'STM32F1xx/other'], ['build.mcu', 'cortex-m4'],
    ['upload.maximum_size', '131072'], ['upload.maximum_data_size', '65536']]) {
    assert.throws(() => resolveArtifactTargetMarkers(fqbn, { ...properties, [key]: value }), /conflicts/);
  }
});

for (const { suffix, flash, ram, otherSuffix, otherFlash, otherRam, variant, packagePins } of [
  { suffix: 'RC', flash: '262144', ram: '49152', otherSuffix: 'RE', otherFlash: '524288', otherRam: '65536',
    variant: 'STM32F1xx/F103R(C-D-E)T', packagePins: 64 },
  { suffix: 'RE', flash: '524288', ram: '65536', otherSuffix: 'RC', otherFlash: '262144', otherRam: '49152',
    variant: 'STM32F1xx/F103R(C-D-E)T', packagePins: 64 },
  { suffix: 'VC', flash: '262144', ram: '49152', otherSuffix: 'ZE', otherFlash: '524288', otherRam: '65536',
    variant: 'STM32F1xx/F103V(C-D-E)(H-T)', packagePins: 100 },
  { suffix: 'ZE', flash: '524288', ram: '65536', otherSuffix: 'VC', otherFlash: '262144', otherRam: '49152',
    variant: 'STM32F1xx/F103Z(C-D-E)(H-T)', packagePins: 144 },
]) {
  const highDensity = { ...properties, 'build.board': `GENERIC_F103${suffix}TX`,
    'build.product_line': 'STM32F103xE', 'build.variant': variant,
    'upload.maximum_size': flash, 'upload.maximum_data_size': ram };

  test(`the ${suffix} LQFP${packagePins} selection publishes exact identity without rewriting xE facts`, () => {
    const original = structuredClone(highDensity);
    for (const boardId of [`GENERIC_F103${suffix}TX`, `CUSTOM_F103${suffix}T6`, `CUSTOM_F103${suffix}T7`]) {
      assert.deepEqual(resolveArtifactTargetMarkers(fqbn, { ...highDensity, 'build.board': boardId }),
        { boardId, mcu: `STM32F103${suffix}` });
    }
    assert.deepEqual(highDensity, original, 'Never rewrite producer facts or the original xE compile family.');
  });

  test(`the ${suffix} selection rejects conflicting CPU, variant or capacities`, () => {
    for (const [key, value] of [['build.mcu', 'cortex-m4'],
      ['build.variant', 'STM32F1xx/F103R(8-B)T'], ['build.variant', 'STM32F1xx/F103R(C-D-E)H'],
      ['build.variant', 'STM32F1xx/F103C8T_F103CB(T-U)'],
      ...['STM32F1xx/F103R(C-D-E)T', 'STM32F1xx/F103V(C-D-E)(H-T)', 'STM32F1xx/F103Z(C-D-E)(H-T)']
        .filter(value => value !== variant).map(value => ['build.variant', value]),
      ['upload.maximum_size', otherFlash], ['upload.maximum_data_size', otherRam],
      ['upload.maximum_data_size', '20480']]) {
      assert.throws(() => resolveArtifactTargetMarkers(fqbn, { ...highDensity, [key]: value }),
        new RegExp(`STM32F103${suffix}.*conflicts`));
    }
    for (const key of ['build.mcu', 'build.variant', 'upload.maximum_size', 'upload.maximum_data_size']) {
      const missing = { ...highDensity }; delete missing[key];
      assert.throws(() => resolveArtifactTargetMarkers(fqbn, missing), new RegExp(`STM32F103${suffix}.*conflicts`));
    }
    assert.throws(() => resolveArtifactTargetMarkers(fqbn,
      { ...highDensity, 'build.board': `GENERIC_F103${otherSuffix}TX` }), /conflicts/,
      'The shared variant cannot conceal a different exact chip capacity.');
  });

  test(`unsupported ${suffix} packages, tokens and families remain unnormalized`, () => {
    for (const boardId of [`GENERIC_F103${suffix}`, `NUCLEO_F103${suffix}`, `GENERIC_F103${suffix}UX`,
      `CUSTOM_F103${suffix}U6`, `GENERIC_F103${suffix}HX`, `CUSTOM_F103${suffix}H7`,
      `CUSTOM_F103${suffix}T8`, `GENERIC_F103${suffix}TX_EXTRA`, 'GENERIC_F103RDTX',
      'GENERIC_F103VETX', 'MY_BOARD']) {
      assert.equal(resolveArtifactTargetMarkers(fqbn, { ...highDensity, 'build.board': boardId }).mcu,
        'STM32F103xE', `No high-density package or capacity guess for ${boardId}.`);
    }
    for (const compilerFamily of ['STM32F103xB', 'STM32F103xG', 'STM32F407xx']) {
      assert.equal(resolveArtifactTargetMarkers(fqbn,
        { ...highDensity, 'build.product_line': compilerFamily }).mcu, compilerFamily,
        'Wrong or unknown compiler families retain the existing original marker behavior.');
    }
  });
}

test('all seven exact identities leave the original compiler family in the resolved selection snapshot', () => {
  for (const [suffix, compilerFamily, variant, flash, ram] of [
    ['C8', 'STM32F103xB', 'STM32F1xx/F103C8T_F103CB(T-U)', '65536', '20480'],
    ['CB', 'STM32F103xB', 'STM32F1xx/F103C8T_F103CB(T-U)', '131072', '20480'],
    ['RB', 'STM32F103xB', 'STM32F1xx/F103R(8-B)T', '131072', '20480'],
    ['RC', 'STM32F103xE', 'STM32F1xx/F103R(C-D-E)T', '262144', '49152'],
    ['RE', 'STM32F103xE', 'STM32F1xx/F103R(C-D-E)T', '524288', '65536'],
    ['VC', 'STM32F103xE', 'STM32F1xx/F103V(C-D-E)(H-T)', '262144', '49152'],
    ['ZE', 'STM32F103xE', 'STM32F1xx/F103Z(C-D-E)(H-T)', '524288', '65536'],
  ]) {
    const resolvedProperties = { 'build.board': `GENERIC_F103${suffix}TX`, 'build.mcu': 'cortex-m3',
      'build.product_line': compilerFamily, 'build.variant': variant,
      'upload.maximum_size': flash, 'upload.maximum_data_size': ram };
    const selection = projectResolvedBuildTargetSelection({ requestedFqbn: fqbn, effectiveFqbn: fqbn,
      packageName: 'STMicroelectronics', architecture: 'stm32', selectedMenus: new Map(), resolvedProperties });
    const original = structuredClone(selection);
    assert.equal(resolveArtifactTargetMarkers(fqbn, resolvedProperties).mcu, `STM32F103${suffix}`);
    assert.deepEqual(selection, original);
    assert.equal(selection.resolvedBuildProperties['build.product_line'], compilerFamily);
  }
});
