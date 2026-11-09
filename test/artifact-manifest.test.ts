import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveArtifactTargetMarkers,
  resolveCompileToolVersions,
} from '../src/ArduinoCompiler';
import { emitSimulationArtifactManifest, type EmitArtifactManifestOptions } from '../src/ArtifactManifest';
import type { BuildInputRecord } from '../src/BuildInputRecord';
import { ESP32_SPP_PROVIDER, ESP32_SPP_TRANSPORT_PROFILE, ESP32_BLE_PROVIDER, ESP32C3_WIFI_PROVIDER, ESP32C6_WIFI_PROVIDER, ESP32S3_WIFI_PROVIDER, ESP32C6_BLE_PROVIDER, ESP32_WIFI_OPENETH_PROVIDER } from '../src/SimulationTransportSources';
import { applySimulationDebugProfile } from '../src/SimulationDebugProfile';
import { projectPlatformBuildProperties } from '../src/PlatformPropertyProjector';

async function main(): Promise<void> {
  assert.deepEqual(projectPlatformBuildProperties({ version: '3.3.1', 'runtime.platform.path': '/sdk', unused: 'discard' }),
    { version: '3.3.1', 'runtime.platform.path': '/sdk' });
  assert.deepEqual(projectPlatformBuildProperties({ 'compiler.sdk.path': '/resolved/chip-sdk', unused: 'discard' }),
    { 'compiler.sdk.path': '/resolved/chip-sdk' });
  const debugCompileConfig = applySimulationDebugProfile({
    args: {
      c: '-c -Os -flto',
      cpp: '-c -O2',
      s: '-c -x assembler-with-cpp',
    },
  });
  assert.match(debugCompileConfig.args.c, /-Og -g3 -fno-lto$/u);
  assert.match(debugCompileConfig.args.cpp, /-Og -g3$/u);
  assert.match(debugCompileConfig.args.s, /-g3$/u);
  assert.deepEqual(
    applySimulationDebugProfile(debugCompileConfig),
    debugCompileConfig,
  );

  const sourceRoot = path.join(os.tmpdir(), 'aily source root');
  const originalCompileConfig = { args: { c: '-c -Os', cpp: '-c -Os', s: '-c' } };
  const portableDebug = applySimulationDebugProfile(originalCompileConfig, sourceRoot);
  const sourceMapping = `"-fdebug-prefix-map=${path.resolve(sourceRoot)}=/source"`;
  assert.ok(portableDebug.args.c.endsWith(sourceMapping));
  assert.ok(portableDebug.args.cpp.endsWith(sourceMapping));
  assert.ok(!portableDebug.args.s.includes('-fdebug-prefix-map='));
  assert.deepEqual(applySimulationDebugProfile(portableDebug, sourceRoot), portableDebug);
  assert.deepEqual(originalCompileConfig, { args: { c: '-c -Os', cpp: '-c -Os', s: '-c' } });
  const dollarRoot = sourceRoot + '$literal';
  const dollarMapping = applySimulationDebugProfile(originalCompileConfig, dollarRoot).args.cpp;
  assert.ok(dollarMapping.includes(process.platform === 'win32' ? '$$literal' : '\\$$literal'));
  for (const invalid of ['', 'relative/source', sourceRoot + '\n', sourceRoot + '=foreign',
    sourceRoot + '  two-spaces', sourceRoot + '\u00a0non-breaking-space', '/' + 'x'.repeat(4096)]) {
    assert.throws(() => applySimulationDebugProfile(originalCompileConfig, invalid), /source root/u);
  }

  assert.deepEqual(
    resolveArtifactTargetMarkers('STMicroelectronics:stm32:Disco', {
      'build.board': 'DISCO_F407VG',
      'build.mcu': 'cortex-m4',
      'build.product_line': 'STM32F407xx',
    }),
    {
      boardId: 'DISCO_F407VG',
      mcu: 'STM32F407xx',
    },
  );
  assert.throws(
    () => resolveArtifactTargetMarkers('STMicroelectronics:stm32:Disco', {
      'build.mcu': 'cortex-m4',
    }),
    /build\.board and build\.product_line/,
  );
  assert.deepEqual(
    resolveArtifactTargetMarkers('esp32:esp32:XIAO_ESP32S3', {
      'build.mcu': 'esp32s3',
    }),
    { mcu: 'esp32s3' },
  );

  assert.deepEqual(
    resolveCompileToolVersions({}, {
      success: true,
      preprocessTime: 1,
      cacheIdentity: {
        requestedToolVersions: {
          'esp-x32': '14.2.0',
          esptool_py: '5.1.0',
        },
      },
    }),
    {
      'esp-x32': '14.2.0',
      esptool_py: '5.1.0',
    },
  );
  assert.deepEqual(
    resolveCompileToolVersions(
      {
        'esp-x32': '15.0.0',
      },
      {
        success: true,
        preprocessTime: 1,
        toolVersions: {
          'esp-x32': '14.2.0',
          esptool_py: '5.1.0',
        },
      },
    ),
    {
      'esp-x32': '15.0.0',
      esptool_py: '5.1.0',
    },
  );

  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-artifact-manifest-'));
  try {
    const sketchPath = path.join(root, 'sketch.ino');
    const elfPath = path.join(root, 'sketch.elf');
    const linkerMapPath = path.join(root, 'sketch.map');
    const mergedPath = path.join(root, 'sketch.merged.bin');
    const bootloaderPath = path.join(root, 'sketch.bootloader.bin');
    const partitionsPath = path.join(root, 'sketch.partitions.bin');
    const applicationPath = path.join(root, 'sketch.bin');
    const sdkconfigPath = path.join(root, 'sdkconfig');
    const sdkPath = path.join(root, 'sdk');
    const bootApp0SourcePath = path.join(
      sdkPath,
      'tools',
      'partitions',
      'boot_app0.bin',
    );
    const esp32ArduinoLibsPath = path.join(root, 'esp32-arduino-libs');
    const idfVersionHeaderPath = path.join(
      esp32ArduinoLibsPath,
      'esp32s3',
      'include',
      'esp_common',
      'include',
      'esp_idf_version.h',
    );
    const c3IdfVersionHeaderPath = path.join(
      esp32ArduinoLibsPath,
      'esp32c3',
      'include',
      'esp_common',
      'include',
      'esp_idf_version.h',
    );
    const chipSdkPath = path.join(root, 'esp32-chip-sdk');
    const chipIdfVersionHeaderPath = path.join(chipSdkPath, 'include', 'esp_common', 'include', 'esp_idf_version.h');
    const manifestPath = path.join(root, 'aily-artifact-manifest.json');
    const sourceMapPath = path.join(root, 'aily-block-source-map.json');
    const sketch = 'void setup() {}\\nvoid loop() {}\\n';
    const bootloader = Buffer.from([0xe9, 0x01, 0x02, 0x03]);
    const partitions = Buffer.from([0xaa, 0x50, 0x01, 0x02]);
    const bootApp0 = Buffer.from([0xef, 0xbe, 0xad, 0xde]);
    const application = Buffer.from([0xe9, 0x04, 0x05, 0x06]);
    const merged = Buffer.alloc(1024 * 1024, 0xff);
    bootloader.copy(merged, 0);
    partitions.copy(merged, 0x8000);
    bootApp0.copy(merged, 0xe000);
    application.copy(merged, 0x10000);
    await Promise.all([
      mkdir(path.dirname(bootApp0SourcePath), { recursive: true }),
      mkdir(path.dirname(idfVersionHeaderPath), { recursive: true }),
      mkdir(path.dirname(c3IdfVersionHeaderPath), { recursive: true }),
      mkdir(path.dirname(chipIdfVersionHeaderPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(sketchPath, sketch),
      writeFile(elfPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
      writeFile(linkerMapPath, [
        'Memory Configuration',
        '',
        'Name             Origin             Length             Attributes',
        'dram0_0_seg      0x3fc88000         0x00053700         rw',
        'iram0_2_seg      0x42000020         0x007fffe0         xr',
        'drom0_0_seg      0x3c000020         0x01ffffe0         r',
        'extern_ram_seg   0x3c000020         0x01ffffe0         xrw',
        '*default*        0x00000000         0xffffffff',
        '',
        'Linker script and memory map',
        ' .data.ailyFreeRtosDebugObjectRegistryV1',
        '                0x3fc90000 ailyFreeRtosDebugObjectRegistryV1',
      ].join('\n')),
      writeFile(mergedPath, merged),
      writeFile(bootloaderPath, bootloader),
      writeFile(partitionsPath, partitions),
      writeFile(applicationPath, application),
      // Newer Arduino-ESP32 recipes also copy this official upload input into
      // the build directory. It is OTA data, never the application binary.
      writeFile(path.join(root, 'boot_app0.bin'), bootApp0),
      writeFile(bootApp0SourcePath, bootApp0),
      writeFile(idfVersionHeaderPath, [
        '#define ESP_IDF_VERSION_MAJOR 5',
        '#define ESP_IDF_VERSION_MINOR 5',
        '#define ESP_IDF_VERSION_PATCH 1',
        '',
      ].join('\n')),
      writeFile(c3IdfVersionHeaderPath, [
        '#define ESP_IDF_VERSION_MAJOR 5',
        '#define ESP_IDF_VERSION_MINOR 5',
        '#define ESP_IDF_VERSION_PATCH 1',
        '',
      ].join('\n')),
      writeFile(chipIdfVersionHeaderPath, [
        '#define ESP_IDF_VERSION_MAJOR 5',
        '#define ESP_IDF_VERSION_MINOR 5',
        '#define ESP_IDF_VERSION_PATCH 4',
        '',
      ].join('\n')),
      writeFile(sdkconfigPath, 'CONFIG_ESPTOOLPY_FLASHSIZE="16MB"\n'),
      writeFile(sourceMapPath, JSON.stringify({
        schemaVersion: 1,
        kind: 'aily-block-source-map',
        source: {
          path: 'sketch.ino',
          sizeBytes: Buffer.byteLength(sketch),
          sha256: createHash('sha256').update(sketch).digest('hex'),
        },
        mappings: [{
          blockId: 'block-loop',
          executionRole: 'statement',
          ranges: [{ startLine: 2, endLine: 2 }],
          executableRanges: [{ startLine: 2, endLine: 2 }],
          supportRanges: [],
        }],
      })),
    ]);

    const emitOptions: EmitArtifactManifestOptions = {
      buildPath: root,
      sketchPath,
      board: 'esp32:esp32:XIAO_ESP32S3',
      mcu: 'esp32s3',
      toolVersions: {
        esptool_py: '5.1.0',
        'esp-x32': '14.2.0',
      },
      platformProperties: {
        version: '3.3.1',
        'build.flash_size': '1MB',
        'build.flash_mode': 'dio',
        'build.boot': 'qio',
        'build.img_freq': '80m',
        'compiler.sdk.path': path.join(esp32ArduinoLibsPath, 'esp32s3'),
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args': [
          '--chip esp32s3 merge_bin --fill-flash-size 1MB -o "sketch.merged.bin"',
          '0x0 "sketch.bootloader.bin"',
          '0x8000 "sketch.partitions.bin"',
          '0xe000 "boot_app0.bin"',
          '0x10000 "sketch.bin"',
        ].join(' '),
      },
      sdkPath,
      graphSemanticRevision: '7'.repeat(64),
      sourceDocumentSchemaVersion: 2,
      gpioDirections: {
        'xiao_esp32s3.pin_2': 'input',
        'xiao_esp32s3.pin_1': 'output',
        'xiao_esp32s3.pin_3': 'output',
      },
      gpioPulls: {
        'xiao_esp32s3.pin_2': 'down',
        'xiao_esp32s3.pin_4': 'up',
      },
      primaryOutputPath: mergedPath,
      manifestPath,
    };
    const manifest = await emitSimulationArtifactManifest(emitOptions);

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.kind, 'aily-build-artifact');
    assert.equal(manifest.target.architecture, 'esp32');
    assert.equal(manifest.target.boardId, 'XIAO_ESP32S3');
    assert.equal(manifest.target.mcu, 'esp32s3');
    assert.equal(manifest.primaryFile, 'sketch.merged.bin');
    assert.equal(manifest.flash?.imagePath, 'sketch.merged.bin');
    assert.equal(manifest.flash?.imageSizeBytes, 1024 * 1024);
    assert.equal(manifest.flash?.sdkConfiguredSizeBytes, 1024 * 1024);
    assert.deepEqual(manifest.flash?.layout?.device, {
      sizeBytes: 1024 * 1024,
      mode: 'dio',
      bootMode: 'qio',
      frequencyHz: 80_000_000,
      source: 'resolved-board-properties',
    });
    assert.deepEqual(
      manifest.flash?.layout?.segments.map((segment) => [
        segment.role,
        segment.offsetBytes,
        segment.path,
      ]),
      [
        ['bootloader', 0, 'sketch.bootloader.bin'],
        ['partition-table', 0x8000, 'sketch.partitions.bin'],
        ['ota-data-initializer', 0xe000, 'aily-boot-app0.bin'],
        ['application', 0x10000, 'sketch.bin'],
      ],
    );
    assert.deepEqual(manifest.build.environment, {
      schemaVersion: 1,
      arduinoCore: {
        name: 'arduino-esp32',
        version: '3.3.1',
        source: 'platform.version',
      },
      espIdf: {
        name: 'esp-idf',
        version: '5.5.1',
        source: 'esp32-arduino-libs/esp_idf_version.h',
      },
      toolchain: {
        name: 'esp-x32',
        version: '14.2.0',
        source: 'toolVersions.esp-x32',
      },
    });
    assert.deepEqual(manifest.build.graph, {
      schemaVersion: 1,
      kind: 'aily-scene-graph-provenance',
      graphSemanticRevision: '7'.repeat(64),
      sourceDocumentSchemaVersion: 2,
      gpioDirections: {
        'xiao_esp32s3.pin_1': 'output',
        'xiao_esp32s3.pin_2': 'input',
        'xiao_esp32s3.pin_3': 'output',
      },
      gpioPulls: {
        'xiao_esp32s3.pin_2': 'down',
        'xiao_esp32s3.pin_4': 'up',
      },
    });
    assert.equal(manifest.debug?.elfPath, 'sketch.elf');
    assert.equal(manifest.debug?.mapPath, 'sketch.map');
    assert.equal(
      manifest.debug?.memoryMapPath,
      'aily-debug-memory-map.json',
    );
    assert.equal(
      manifest.debug?.sourceMapPath,
      'aily-block-source-map.json',
    );
    assert.equal(
      manifest.debug?.sourceSnapshotPath,
      'aily-debug-source.txt',
    );
    assert.equal(
      manifest.debug?.instrumentationPath,
      'aily-debug-instrumentation.json',
    );
    assert.equal(manifest.files.length, 12);
    assert.deepEqual(manifest.files.filter(file => file.role === 'application').map(file => file.path), ['sketch.bin']);
    assert.deepEqual(manifest.files.filter(file => file.role === 'ota-data-initializer').map(file => file.path),
      ['aily-boot-app0.bin', 'boot_app0.bin']);
    assert.match(manifest.artifactId, /^[a-f0-9]{64}$/);
    const sourceSnapshot = manifest.files.find(
      (file) => file.role === 'debug-source',
    );
    assert.equal(sourceSnapshot?.path, 'aily-debug-source.txt');
    assert.equal(sourceSnapshot?.sizeBytes, Buffer.byteLength(sketch));
    assert.equal(
      sourceSnapshot?.sha256,
      createHash('sha256').update(sketch).digest('hex'),
    );
    assert.equal(
      await readFile(path.join(root, 'aily-debug-source.txt'), 'utf8'),
      sketch,
    );

    const memoryMap = JSON.parse(await readFile(
      path.join(root, 'aily-debug-memory-map.json'),
      'utf8',
    ));
    assert.equal(memoryMap.schemaVersion, 1);
    assert.equal(memoryMap.kind, 'aily-debug-memory-map');
    assert.equal(memoryMap.sources.elf.path, 'sketch.elf');
    assert.equal(memoryMap.sources.linkerMap.path, 'sketch.map');
    assert.deepEqual(
      memoryMap.regions.map((region: { id: string }) => region.id),
      ['drom', 'dram', 'irom'],
    );
    assert.deepEqual(memoryMap.regions[2], {
      id: 'irom',
      label: 'iram0_2_seg',
      startAddress: '0x42000020',
      endAddress: '0x42800000',
      attributes: 'rx',
    });
    const instrumentation = JSON.parse(await readFile(
      path.join(root, 'aily-debug-instrumentation.json'),
      'utf8',
    ));
    assert.deepEqual(instrumentation, {
      schemaVersion: 1,
      kind: 'aily-debug-instrumentation',
      abi: {
        name: 'aily.freertos-object-registry',
        version: 1,
        symbol: 'ailyFreeRtosDebugObjectRegistryV1',
        capabilities: ['freertos.objects'],
      },
      compatibility: {
        architecture: 'esp32',
        mcu: 'esp32s3',
        framework: 'arduino',
        rtos: 'freertos',
      },
    });

    const persisted = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(persisted, manifest);

    const c3Options: EmitArtifactManifestOptions = {
      buildPath: root,
      sketchPath,
      board: 'esp32:esp32:esp32c3',
      mcu: 'esp32c3',
      toolVersions: {
        esptool_py: '5.1.0',
        'esp-rv32': '14.2.0',
      },
      platformProperties: {
        version: '3.3.1',
        'build.flash_size': '1MB',
        'build.flash_mode': 'dio',
        'build.boot': 'qio',
        'build.img_freq': '80m',
        'compiler.sdk.path': path.join(esp32ArduinoLibsPath, 'esp32c3'),
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args': [
          '--chip esp32c3 merge-bin --pad-to-size 1MB -o "sketch.merged.bin"',
          '0x0 "sketch.bootloader.bin"',
          '0x8000 "sketch.partitions.bin"',
          '0xe000 "boot_app0.bin"',
          '0x10000 "sketch.bin"',
        ].join(' '),
      },
      sdkPath,
      primaryOutputPath: mergedPath,
      manifestPath: path.join(root, 'aily-artifact-manifest-c3.json'),
    };
    const c3Manifest = await emitSimulationArtifactManifest(c3Options);
    assert.deepEqual(c3Manifest.build.environment, {
      schemaVersion: 1,
      arduinoCore: {
        name: 'arduino-esp32',
        version: '3.3.1',
        source: 'platform.version',
      },
      espIdf: {
        name: 'esp-idf',
        version: '5.5.1',
        source: 'esp32-arduino-libs/esp_idf_version.h',
      },
      toolchain: {
        name: 'esp-rv32',
        version: '14.2.0',
        source: 'toolVersions.esp-rv32',
      },
    });

    const buildInputsFor = (mcu: string, memoryType = 'qio_qspi', properties: Record<string, string> = {}): BuildInputRecord => {
      const fqbn = `esp32:esp32:${mcu}`;
      const facts: Omit<BuildInputRecord, 'digest'> = {
        schemaVersion: 1, kind: 'aily-build-input-record', scope: 'build-graph-facts',
        configurationSha256: 'a'.repeat(64), steps: [],
        targetSelection: { schemaVersion: 1, requestedFqbn: fqbn, effectiveFqbn: fqbn,
          menuOptions: {}, platform: { package: 'esp32', architecture: 'esp32', version: '3.3.10' },
          resolvedBuildProperties: { 'build.mcu': mcu, 'build.memory_type': memoryType, ...properties } },
      };
      return { ...facts, digest: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
    };
    const buildInputs = buildInputsFor('esp32c6');
    const c6Options: EmitArtifactManifestOptions = {
      ...c3Options,
      board: 'esp32:esp32:esp32c6',
      mcu: 'esp32c6',
      manifestPath: path.join(root, 'aily-artifact-manifest-c6.json'),
      toolVersions: { 'esp-rv32': '14.2.0', 'esp32c6-libs': '3.3.10' },
      platformProperties: { ...c3Options.platformProperties, version: '3.3.10', 'compiler.sdk.path': chipSdkPath,
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args':
          c3Options.platformProperties['recipe.hooks.objcopy.postobjcopy.3.pattern_args']!.replace('esp32c3', 'esp32c6') },
      simulationProviders: [ESP32C6_WIFI_PROVIDER],
      buildInputs,
    };
    const c6Manifest = await emitSimulationArtifactManifest(c6Options);
    assert.deepEqual(c6Manifest.build.simulationProviders, [ESP32C6_WIFI_PROVIDER]);
    assert.equal(c6Manifest.build.simulationNetwork, undefined);
    assert.equal(c6Manifest.build.inputs?.digest, buildInputs.digest);
    for (const changes of [
      { board: c3Options.board, mcu: c3Options.mcu, buildInputs: buildInputsFor('esp32c3') },
      { buildInputs: undefined },
      { buildInputs: buildInputsFor('esp32c6', 'qio_opi') },
      { toolVersions: { 'esp-rv32': '14.2.0', 'esp32c3-libs': '3.3.10' } },
      { simulationProviders: [ESP32C6_WIFI_PROVIDER, ESP32C3_WIFI_PROVIDER] },
      { simulationNetwork: { wifi: true as const } },
    ]) {
      await assert.rejects(emitSimulationArtifactManifest({ ...c6Options, ...changes }), /requires its exact SDK\/IDF\/tool ABI/);
    }
    const s3SdkPath = path.join(root, 's3-wifi-sdk');
    const s3IdfPath = path.join(s3SdkPath, 'include/esp_common/include/esp_idf_version.h');
    await mkdir(path.dirname(s3IdfPath), { recursive: true });
    await writeFile(s3IdfPath, '#define ESP_IDF_VERSION_MAJOR 5\n#define ESP_IDF_VERSION_MINOR 4\n#define ESP_IDF_VERSION_PATCH 2\n');
    const s3ExtraFlags = '-DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=0 -DARDUINO_USB_MSC_ON_BOOT=0 -DARDUINO_USB_DFU_ON_BOOT=0';
    const s3BoardProperties = { 'build.defines': '', 'build.extra_flags': s3ExtraFlags };
    const s3Options: EmitArtifactManifestOptions = { ...emitOptions,
      board: 'esp32:esp32:esp32s3', mcu: 'esp32s3',
      manifestPath: path.join(root, 'aily-artifact-manifest-s3-wifi.json'),
      toolVersions: { 'esp-x32': '14.2.0', 'esp32s3-libs': '5.4.1' },
      platformProperties: { ...emitOptions.platformProperties, version: '3.3.10', 'compiler.sdk.path': s3SdkPath },
      simulationProviders: [ESP32S3_WIFI_PROVIDER],
      buildInputs: buildInputsFor('esp32s3', 'qio_qspi', s3BoardProperties) };
    const s3Manifest = await emitSimulationArtifactManifest(s3Options);
    assert.deepEqual(s3Manifest.build.simulationProviders, [ESP32S3_WIFI_PROVIDER]);
    assert.equal(s3Manifest.build.environment?.espIdf.version, '5.4.2');
    assert.equal(s3Manifest.build.environment?.toolchain.name, 'esp-x32');
    assert.equal(s3Manifest.build.simulationNetwork, undefined);
    const s3OpiManifest = await emitSimulationArtifactManifest({ ...s3Options,
      manifestPath: path.join(root, 'aily-artifact-manifest-s3-wifi-opi.json'),
      buildInputs: buildInputsFor('esp32s3', 'qio_opi', { ...s3BoardProperties, 'build.defines': '-DBOARD_HAS_PSRAM' }) });
    assert.deepEqual(s3OpiManifest.build.simulationProviders, [ESP32S3_WIFI_PROVIDER]);
    assert.equal(s3OpiManifest.build.environment?.espIdf.version, '5.4.2');
    assert.equal(s3OpiManifest.build.environment?.toolchain.name, 'esp-x32');
    for (const invalidDefines of ['', '-DBOARD_HAS_PSRAM -DBOARD_HAS_PSRAM', '-DBOARD_HAS_PSRAM=0']) {
      await assert.rejects(emitSimulationArtifactManifest({ ...s3Options,
        buildInputs: buildInputsFor('esp32s3', 'qio_opi', { ...s3BoardProperties, 'build.defines': invalidDefines }) }),
        /S3 Wi-Fi simulation Artifact requires its exact SDK\/IDF\/tool ABI/);
    }
    await assert.rejects(emitSimulationArtifactManifest({ ...s3Options,
      buildInputs: buildInputsFor('esp32s3', 'qio_opi', { ...s3BoardProperties, 'build.defines': '-DBOARD_HAS_PSRAM',
        'build.extra_flags': s3ExtraFlags.replace('CDC_ON_BOOT=0', 'CDC_ON_BOOT=1') }) }),
      /S3 Wi-Fi simulation Artifact requires its exact SDK\/IDF\/tool ABI/);
    for (const changes of [
      { buildInputs: undefined },
      { buildInputs: buildInputsFor('esp32s3', 'dio_qspi', s3BoardProperties) },
      { buildInputs: buildInputsFor('esp32s3', 'qio_opi', s3BoardProperties) },
      { buildInputs: buildInputsFor('esp32s3', 'qio_qspi', { ...s3BoardProperties, 'build.defines': '-DBOARD_HAS_PSRAM' }) },
      ...['-DARDUINO_USB_MODE=1', '-DARDUINO_USB_CDC_ON_BOOT=0', '-DARDUINO_USB_MSC_ON_BOOT=0', '-DARDUINO_USB_DFU_ON_BOOT=0'].map(flag =>
        ({ buildInputs: buildInputsFor('esp32s3', 'qio_qspi', { ...s3BoardProperties,
          'build.extra_flags': s3ExtraFlags.replace(flag, flag.endsWith('0') ? flag.slice(0, -1) + '1' : flag.slice(0, -1) + '0') }) })),
      { buildInputs: buildInputsFor('esp32s3', 'qio_qspi', { ...s3BoardProperties, 'build.extra_flags': s3ExtraFlags + ' -DARDUINO_USB_CDC_ON_BOOT=1' }) },
      { toolVersions: { 'esp-x32': '14.2.0', 'esp32s3-libs': '3.3.10' } },
      { toolVersions: { 'esp-rv32': '14.2.0', 'esp32s3-libs': '5.4.1' } },
      { platformProperties: { ...s3Options.platformProperties, 'compiler.sdk.path': chipSdkPath } },
      { simulationProviders: [ESP32S3_WIFI_PROVIDER, ESP32C3_WIFI_PROVIDER] },
      { simulationNetwork: { wifi: true as const } },
    ]) await assert.rejects(emitSimulationArtifactManifest({ ...s3Options, ...changes }),
      /(?:C3|S3) Wi-Fi simulation Artifact requires its exact SDK\/IDF\/tool ABI/);
    // Legacy S3 still requires its own pair; C6 retains its exact existing5.5.4 rules.
    await assert.rejects(emitSimulationArtifactManifest({ ...c6Options,
      platformProperties: { ...c6Options.platformProperties, 'compiler.sdk.path': s3SdkPath } }),
      /C6 Wi-Fi simulation Artifact requires its exact SDK\/IDF\/tool ABI/);
    const ordinaryS3 = await emitSimulationArtifactManifest({ ...s3Options, simulationProviders: undefined,
      buildInputs: buildInputsFor('esp32s3', 'qio_opi', { ...s3BoardProperties, 'build.defines': '-DBOARD_HAS_PSRAM', 'build.extra_flags': s3ExtraFlags.replace('CDC_ON_BOOT=0', 'CDC_ON_BOOT=1') }) });
    assert.equal(ordinaryS3.build.simulationProviders, undefined);

    const normalS3SdkPath = path.join(root, 's3-normal-wifi-sdk');
    const normalS3IdfPath = path.join(normalS3SdkPath, 'include/esp_common/include/esp_idf_version.h');
    await mkdir(path.dirname(normalS3IdfPath), { recursive: true });
    await writeFile(normalS3IdfPath, '#define ESP_IDF_VERSION_MAJOR 5\n#define ESP_IDF_VERSION_MINOR 5\n#define ESP_IDF_VERSION_PATCH 4\n');
    const normalS3Options: EmitArtifactManifestOptions = { ...s3Options,
      manifestPath: path.join(root, 'aily-artifact-manifest-s3-normal-wifi.json'),
      toolVersions: { 'esp-x32': '14.2.0', 'esp32s3-libs': '3.3.10' },
      platformProperties: { ...s3Options.platformProperties, 'compiler.sdk.path': normalS3SdkPath },
      buildInputs: buildInputsFor('esp32s3', 'qio_opi', { ...s3BoardProperties, 'build.defines': '-DBOARD_HAS_PSRAM' }) };
    const normalS3Manifest = await emitSimulationArtifactManifest(normalS3Options);
    assert.deepEqual(normalS3Manifest.build.simulationProviders, [ESP32S3_WIFI_PROVIDER]);
    assert.equal(normalS3Manifest.build.environment?.espIdf.version, '5.5.4');
    assert.equal(normalS3Manifest.build.toolVersions['esp32s3-libs'], '3.3.10');
    for (const changes of [
      { toolVersions: { 'esp-x32': '14.2.0', 'esp32s3-libs': '5.4.1' } },
      { buildInputs: buildInputsFor('esp32s3', 'qio_qspi', s3BoardProperties) },
      { buildInputs: buildInputsFor('esp32s3', 'qio_opi', { ...s3BoardProperties, 'build.defines': '-DBOARD_HAS_PSRAM',
        'build.extra_flags': s3ExtraFlags.replace('CDC_ON_BOOT=0', 'CDC_ON_BOOT=1') }) },
      { mcu: 'esp32c3', board: 'esp32:esp32:esp32c3' },
    ]) await assert.rejects(emitSimulationArtifactManifest({ ...normalS3Options, ...changes }));

    const c6BleOptions: EmitArtifactManifestOptions = { ...c6Options,
      manifestPath: path.join(root, 'aily-artifact-manifest-c6-ble-probe.json'),
      simulationProviders: [ESP32C6_BLE_PROVIDER] };
    const c6BleManifest = await emitSimulationArtifactManifest(c6BleOptions);
    assert.deepEqual(c6BleManifest.build.simulationProviders, [ESP32C6_BLE_PROVIDER]);
    assert.equal(c6BleManifest.build.inputs?.digest, buildInputs.digest);
    for (const changes of [
      { buildInputs: buildInputsFor('esp32c6', 'dio_qspi') },
      { simulationProviders: [ESP32C6_BLE_PROVIDER, ESP32C6_WIFI_PROVIDER] },
      { simulationNetwork: { wifi: true as const } },
    ]) {
      await assert.rejects(emitSimulationArtifactManifest({ ...c6BleOptions, ...changes }),
        /C6 BLE IPC Artifact requires its exact SDK\/IDF\/tool ABI/);
    }

    const classicOptions: EmitArtifactManifestOptions = { ...emitOptions,
      board: 'esp32:esp32:esp32', mcu: 'esp32',
      manifestPath: path.join(root, 'aily-artifact-manifest-classic-openeth.json'),
      platformProperties: { ...emitOptions.platformProperties, version: '3.3.10', 'compiler.sdk.path': chipSdkPath },
      simulationProviders: [ESP32_WIFI_OPENETH_PROVIDER],
      toolVersions: { 'esp-x32': '14.2.0', 'esp32-libs': '3.3.10' },
      buildInputs: buildInputsFor('esp32', 'dio_qspi') };
    const classicManifest = await emitSimulationArtifactManifest(classicOptions);
    assert.deepEqual(classicManifest.build.simulationProviders, [ESP32_WIFI_OPENETH_PROVIDER]);
    assert.equal(classicManifest.build.simulationNetwork, undefined);
    for (const changes of [
      { buildInputs: undefined },
      { buildInputs: buildInputsFor('esp32c3') },
      { buildInputs: buildInputsFor('esp32', 'qio_opi') },
      { toolVersions: { 'esp-rv32': '14.2.0', 'esp32-libs': '3.3.10' } },
      { simulationProviders: [ESP32_WIFI_OPENETH_PROVIDER, ESP32C3_WIFI_PROVIDER] },
      { simulationNetwork: { wifi: true as const } },
    ]) {
      await assert.rejects(emitSimulationArtifactManifest({ ...classicOptions, ...changes }),
        /requires its exact SDK\/IDF\/tool ABI|Build-graph target selection does not match/);
    }

    const classicBleOptions = { ...classicOptions, simulationProviders: [ESP32_BLE_PROVIDER],
      manifestPath: path.join(root, 'aily-artifact-manifest-classic-ble.json') };
    const classicBleManifest = await emitSimulationArtifactManifest(classicBleOptions);
    assert.deepEqual(classicBleManifest.build.simulationProviders, [ESP32_BLE_PROVIDER]);
    const classicSppOptions: EmitArtifactManifestOptions = { ...classicOptions, simulationProviders: [ESP32_SPP_PROVIDER],
      simulationTransportProfile: ESP32_SPP_TRANSPORT_PROFILE,
      manifestPath: path.join(root, 'aily-artifact-manifest-classic-spp.json') };
    const classicSppManifest = await emitSimulationArtifactManifest(classicSppOptions);
    assert.deepEqual(classicSppManifest.build.simulationProviders, [ESP32_SPP_PROVIDER]);
    assert.equal(Object.hasOwn(classicSppManifest.build, 'simulationTransportProfile'), false);
    for (const changes of [
      { simulationTransportProfile: undefined }, { buildInputs: undefined },
      { buildInputs: buildInputsFor('esp32c3') }, { buildInputs: buildInputsFor('esp32', 'qio_opi') },
      { simulationProviders: [ESP32_SPP_PROVIDER, ESP32_BLE_PROVIDER] },
      { simulationProviders: [ESP32_BLE_PROVIDER] }, { simulationNetwork: { wifi: true as const } },
    ]) await assert.rejects(emitSimulationArtifactManifest({ ...classicSppOptions, ...changes }),
      /explicit matching transport profile|requires its exact SDK\/IDF\/tool ABI|Build-graph target selection does not match/);
    for (const changes of [
      { buildInputs: undefined }, { buildInputs: buildInputsFor('esp32c3') },
      { buildInputs: buildInputsFor('esp32', 'qio_opi') },
      { toolVersions: { 'esp-rv32': '14.2.0', 'esp32-libs': '3.3.10' } },
      { simulationProviders: [ESP32_BLE_PROVIDER, ESP32_WIFI_OPENETH_PROVIDER] },
      { simulationNetwork: { wifi: true as const } },
    ]) await assert.rejects(emitSimulationArtifactManifest({ ...classicBleOptions, ...changes }),
      /requires its exact SDK\/IDF\/tool ABI|Build-graph target selection does not match/);

    const chipSdkManifest = await emitSimulationArtifactManifest({ ...emitOptions,
      platformProperties: { ...emitOptions.platformProperties,
        version: '3.3.10', 'compiler.sdk.path': chipSdkPath,
        // The compiler-resolved root wins. A legacy tool root must not be
        // consulted, nor may the MCU be appended to a chip-specific package.
        'runtime.tools.esp32-arduino-libs.path': esp32ArduinoLibsPath,
      },
    });
    assert.equal(chipSdkManifest.build.environment?.arduinoCore.version, '3.3.10');
    assert.equal(chipSdkManifest.build.environment?.espIdf.version, '5.5.4');
    for (const sdkRoot of [undefined, 'relative-sdk', '{tools.esp32-arduino-libs.path}', path.join(root, 'missing-sdk')]) {
      await assert.rejects(emitSimulationArtifactManifest({ ...emitOptions,
        platformProperties: { ...emitOptions.platformProperties,
          'compiler.sdk.path': sdkRoot as string,
          'runtime.tools.esp32-arduino-libs.path': esp32ArduinoLibsPath,
        },
      }), /resolved compiler.sdk.path|cannot read esp_idf_version.h/u);
    }

    await writeFile(applicationPath, Buffer.from([0xe9, 0x04, 0x05, 0xff]));
    await assert.rejects(emitSimulationArtifactManifest(emitOptions),
      /merged image does not contain the declared application segment/u);
    await writeFile(applicationPath, application);
    await assert.rejects(emitSimulationArtifactManifest({ ...emitOptions,
      platformProperties: { ...emitOptions.platformProperties,
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args':
          `${emitOptions.platformProperties['recipe.hooks.objcopy.postobjcopy.3.pattern_args']} 0x20000 "other.bin"`,
      },
    }), /merge recipe contains duplicate application segments/u);
    console.log('artifact manifest contract: ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
