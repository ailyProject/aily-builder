import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emitSimulationArtifactManifest } from '../src/ArtifactManifest';

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-artifact-manifest-'));
  try {
    const sketchPath = path.join(root, 'sketch.ino');
    const elfPath = path.join(root, 'sketch.elf');
    const linkerMapPath = path.join(root, 'sketch.map');
    const mergedPath = path.join(root, 'sketch.merged.bin');
    const sdkconfigPath = path.join(root, 'sdkconfig');
    const manifestPath = path.join(root, 'aily-artifact-manifest.json');
    const sourceMapPath = path.join(root, 'aily-block-source-map.json');
    const sketch = 'void setup() {}\\nvoid loop() {}\\n';
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
      ].join('\n')),
      writeFile(mergedPath, Buffer.from([0xe9, 0x00, 0x00, 0x00])),
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

    const manifest = await emitSimulationArtifactManifest({
      buildPath: root,
      sketchPath,
      board: 'esp32:esp32:XIAO_ESP32S3',
      mcu: 'esp32s3',
      toolVersions: {
        esptool_py: '5.1.0',
        'esp-x32': '14.2.0',
      },
      primaryOutputPath: mergedPath,
      manifestPath,
    });

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.kind, 'aily-build-artifact');
    assert.equal(manifest.target.architecture, 'esp32');
    assert.equal(manifest.target.boardId, 'XIAO_ESP32S3');
    assert.equal(manifest.target.mcu, 'esp32s3');
    assert.equal(manifest.primaryFile, 'sketch.merged.bin');
    assert.equal(manifest.flash?.imagePath, 'sketch.merged.bin');
    assert.equal(manifest.flash?.imageSizeBytes, 4);
    assert.equal(manifest.flash?.sdkConfiguredSizeBytes, 16 * 1024 * 1024);
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
    assert.equal(manifest.files.length, 6);
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

    const persisted = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(persisted, manifest);
    console.log('artifact manifest contract: ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
