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

    const c3Manifest = await emitSimulationArtifactManifest({
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
    });
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
