import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { TestContext } from 'node:test';
import { ArduinoCompiler, CompileOptions } from '../src/ArduinoCompiler';
import { Logger } from '../src/utils/Logger';

const repository = path.resolve(__dirname, '..');

class QuietLogger extends Logger {
  readonly progressEvents: Array<{ stage: string; status: string; percent: number }> = [];
  info(): void {}
  verbose(): void {}
  debug(): void {}
  warn(): void {}
  error(): void {}
  progress(event: { stage: any; status: any; percent: number; message: string }): void {
    this.progressEvents.push(event);
  }
}

interface SizeFixture {
  root: string;
  outputPath: string;
  options: CompileOptions;
}

async function sizeFixture(
  t: TestContext,
  architecture: 'avr' | 'stm32',
  textSize: number,
  dataSize = 0,
  maximumText = 1024,
  maximumData?: number,
): Promise<SizeFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-capacity-integration-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sketchPath = path.join(root, 'sketch.ino');
  const recipeScript = path.join(root, 'size.cjs');
  const outputPath = path.join(root, architecture === 'avr' ? 'sketch.hex' : 'sketch.bin');
  await fs.writeFile(sketchPath, 'void setup() {}\nvoid loop() {}\n');
  await fs.writeFile(outputPath, Buffer.alloc(16));
  await fs.writeFile(recipeScript, `console.log('TEXT ${textSize}\\nDATA ${dataSize}');\n`);
  const board = architecture === 'avr' ? 'arduino:avr:uno' : 'STMicroelectronics:stm32:Generic';
  const platform: Record<string, string> = {
    'build.arch': architecture,
    'upload.maximum_size': String(maximumText),
    'recipe.size.pattern': `"${process.execPath}" "${recipeScript}"`,
    'recipe.size.regex': '^TEXT (\\d+)$',
    'recipe.size.regex.data': '^DATA (\\d+)$',
  };
  if (maximumData !== undefined) platform['upload.maximum_data_size'] = String(maximumData);
  const [packageName, platformName, boardId] = board.split(':');
  return {
    root,
    outputPath,
    options: {
      sketchPath,
      board,
      buildPath: root,
      preprocessResult: {
        success: true,
        preprocessTime: 7,
        arduinoConfig: {
          fqbn: board,
          fqbnParsed: { package: packageName, platform: platformName, boardId },
          platform,
          board: {},
        },
        compileConfig: {},
        dependencies: [],
      },
    },
  };
}

function compilerFor(fixture: SizeFixture, logger = new QuietLogger()): ArduinoCompiler {
  const compiler = new ArduinoCompiler(logger);
  // Only replace compilation work: capacity calculation still executes the
  // platform's real size recipe and the public compile-result orchestration.
  const internal = compiler as any;
  internal.runGlobalPrebuild = async () => {};
  internal.prepareBuildDirectory = async () => {};
  internal.ninjaPipeline = {
    compile: async () => ({ success: true, outFilePath: fixture.outputPath }),
  };
  return compiler;
}

for (const architecture of ['avr', 'stm32'] as const) {
  for (const textSize of [1023, 1024, 1025]) {
    test(`${architecture}: text size ${textSize} propagates the capacity boundary`, async t => {
      const fixture = await sizeFixture(t, architecture, textSize);
      const result = await compilerFor(fixture).compile(fixture.options);
      assert.deepEqual(result.firmwareSize?.sections, [
        { name: 'text', size: textSize, maxSize: 1024 },
      ]);
      assert.equal(result.success, textSize <= 1024);
      if (textSize > 1024) {
        assert.ok(result.firmwareSize?.errors?.length);
        assert.match(result.error!, /text section exceeds/i);
        assert.equal(result.outFilePath, undefined, 'failed output must not be published');
      } else {
        assert.equal(result.firmwareSize?.errors?.length ?? 0, 0);
        assert.equal(result.outFilePath, fixture.outputPath);
      }
    });
  }

  for (const dataSize of [256, 257]) {
    test(`${architecture}: RAM size ${dataSize} preserves its existing limit`, async t => {
      const fixture = await sizeFixture(t, architecture, 512, dataSize, 1024, 256);
      const result = await compilerFor(fixture).compile(fixture.options);
      assert.deepEqual(result.firmwareSize?.sections, [
        { name: 'text', size: 512, maxSize: 1024 },
        { name: 'data', size: dataSize, maxSize: 256 },
      ]);
      assert.equal(result.success, dataSize <= 256);
      assert.ok(result.firmwareSize?.warnings?.some(warning => /Low memory/.test(warning)));
      if (dataSize > 256) {
        assert.match(result.error!, /data section exceeds/i);
        assert.equal(result.outFilePath, undefined);
      }
    });
  }
}

test('platforms without a size recipe keep their normal successful result', async t => {
  const fixture = await sizeFixture(t, 'avr', 512);
  delete fixture.options.preprocessResult!.arduinoConfig.platform['recipe.size.pattern'];
  const result = await compilerFor(fixture).compile(fixture.options);
  assert.equal(result.success, true);
  assert.equal(result.outFilePath, fixture.outputPath);
  assert.deepEqual(result.firmwareSize?.sections, []);
});

interface AppPartition {
  name: string;
  subtype: number;
  offset: number;
  size: number;
}

async function esp32Fixture(
  t: TestContext,
  imageBytes: number,
  partitions: AppPartition[] = [{ name: 'factory', subtype: 0, offset: 0x10000, size: 0x10000 }],
  targetOffset = 0x10000,
): Promise<SizeFixture> {
  // The fake ELF size is deliberately far smaller than the actual BIN. The
  // production capacity check must use the complete uploaded image instead.
  const fixture = await sizeFixture(t, 'stm32', 700, 100, 16 * 1024 * 1024, 256);
  await fs.writeFile(fixture.outputPath, Buffer.alloc(imageBytes));
  const records = partitions.map(partition => {
    const record = Buffer.alloc(32);
    record.writeUInt16LE(0x50aa, 0);
    record[2] = 0;
    record[3] = partition.subtype;
    record.writeUInt32LE(partition.offset, 4);
    record.writeUInt32LE(partition.size, 8);
    record.write(partition.name, 12, 16, 'ascii');
    return record;
  });
  await fs.writeFile(path.join(fixture.root, 'sketch.partitions.bin'), Buffer.concat([
    ...records, Buffer.alloc(32, 0xff),
  ]));
  fixture.options.board = 'esp32:esp32:esp32s3';
  const preprocess = fixture.options.preprocessResult!;
  preprocess.arduinoConfig.fqbn = fixture.options.board;
  preprocess.arduinoConfig.fqbnParsed = { package: 'esp32', platform: 'esp32', boardId: 'esp32s3' };
  Object.assign(preprocess.arduinoConfig.platform, {
    'build.arch': 'ESP32',
    'build.mcu': 'esp32s3',
    'build.path': fixture.root,
    'build.project_name': 'sketch',
  });
  preprocess.upload = {
    command: `esptool write-flash 0x${targetOffset.toString(16)} "${fixture.outputPath}"`,
    toolName: 'esptool_py',
    use1200bpsTouch: false,
    waitForUploadPort: false,
  };
  return fixture;
}

for (const imageBytes of [0xffff, 0x10000, 0x10001]) {
  test(`ESP32: final BIN ${imageBytes} uses the actual APP boundary, not SDK/ELF size`, async t => {
    const fixture = await esp32Fixture(t, imageBytes);
    const logger = new QuietLogger();
    const result = await compilerFor(fixture, logger).compile(fixture.options);
    const text = result.firmwareSize?.sections.find(section => section.name === 'text');
    assert.equal(text?.size, imageBytes);
    assert.equal(text?.maxSize, 0x10000);
    assert.equal(result.success, imageBytes <= 0x10000);
    assert.equal(result.firmwareSize?.sections.find(section => section.name === 'data')?.size, 100);
    if (imageBytes > 0x10000) {
      assert.ok(result.firmwareSize?.errors?.length);
      assert.match(result.error!, /factory/i);
      assert.match(result.error!, /65537/);
      assert.equal(result.outFilePath, undefined);
      assert.equal(logger.progressEvents.some(event => event.status === 'complete'), false);
    } else {
      assert.equal(result.outFilePath, fixture.outputPath);
      assert.equal(logger.progressEvents.filter(event => event.status === 'complete').length, 1);
    }
  });
}

for (const missingFile of ['sketch.bin', 'sketch.partitions.bin']) {
  test(`ESP32: missing ${missingFile} fails instead of using the SDK limit`, async t => {
    const fixture = await esp32Fixture(t, 512);
    await fs.unlink(path.join(fixture.root, missingFile));
    const logger = new QuietLogger();
    const result = await compilerFor(fixture, logger).compile(fixture.options);
    assert.equal(result.success, false);
    assert.equal(result.outFilePath, undefined);
    assert.match(result.error!, /missing|not found|ENOENT|unavailable/i);
    assert.equal(logger.progressEvents.some(event => event.status === 'complete'), false);
  });
}

test('ESP32: absent ELF-size recipe cannot bypass final BIN capacity enforcement', async t => {
  const fixture = await esp32Fixture(t, 0x10001);
  delete fixture.options.preprocessResult!.arduinoConfig.platform['recipe.size.pattern'];
  const result = await compilerFor(fixture).compile(fixture.options);
  assert.equal(result.success, false);
  assert.equal(result.outFilePath, undefined);
  assert.equal(result.firmwareSize?.sections.find(section => section.name === 'text')?.size, 0x10001);
});

const unequalOta = [
  { name: 'ota_0', subtype: 0x10, offset: 0x10000, size: 0x10000 },
  { name: 'ota_1', subtype: 0x11, offset: 0x40000, size: 0x20000 },
];

const equalOta = [
  { name: 'ota_0', subtype: 0x10, offset: 0x10000, size: 0x10000 },
  { name: 'ota_1', subtype: 0x11, offset: 0x20000, size: 0x10000 },
];

for (const imageBytes of [0xffff, 0x10000, 0x10001]) {
  test(`ESP32: equal OTA slots preserve the ${imageBytes}-byte API boundary`, async t => {
    const fixture = await esp32Fixture(t, imageBytes, equalOta);
    const logger = new QuietLogger();
    const result = await compilerFor(fixture, logger).compile(fixture.options);
    const text = result.firmwareSize?.sections.find(section => section.name === 'text');
    assert.equal(text?.size, imageBytes);
    assert.equal(text?.maxSize, 0x10000);
    assert.equal(result.success, imageBytes <= 0x10000);
    assert.equal(logger.progressEvents.filter(event => event.status === 'complete').length,
      imageBytes <= 0x10000 ? 1 : 0);
    if (imageBytes > 0x10000) {
      assert.equal(result.outFilePath, undefined);
      assert.match(result.error!, /ota_0/i);
      assert.match(result.error!, /by 1 bytes/i);
    } else {
      assert.equal(result.outFilePath, fixture.outputPath);
      assert.equal(result.firmwareSize?.errors?.length ?? 0, 0);
    }
  });
}

function configureRuntimeUpload(fixture: SizeFixture, tool: 'dfu-util' | 'esp_ota'): void {
  const preprocess = fixture.options.preprocessResult!;
  preprocess.arduinoConfig.board['upload.tool'] = tool;
  // Match SDK 3.3.x command shapes. These commands are parsed, never executed:
  // runtime DFU/OTA determines the destination slot on the device, so there is
  // no host flash-address argument immediately before the firmware filename.
  preprocess.upload = {
    command: tool === 'dfu-util'
      ? `"${path.join(fixture.root, 'tools', 'dfu-util.exe')}" --device 0x303a:0x0002 -D "${fixture.outputPath}" -Q`
      : `python "${path.join(fixture.root, 'tools', 'espota.py')}" -i 127.0.0.1 -p 3232 "--auth=test" -f "${fixture.outputPath}"`,
    toolName: tool,
    use1200bpsTouch: false,
    waitForUploadPort: false,
  };
}

const recoveryAndOta = [
  { name: 'factory_recovery', subtype: 0, offset: 0x10000, size: 0x1000 },
  { name: 'ota_0', subtype: 0x10, offset: 0x20000, size: 0x10000 },
  { name: 'ota_1', subtype: 0x11, offset: 0x30000, size: 0x10000 },
];

for (const imageBytes of [0x10000, 0x10001]) {
  test(`ESP32: DFU -D without an address uses OTA capacity at ${imageBytes} bytes`, async t => {
    const fixture = await esp32Fixture(t, imageBytes, recoveryAndOta);
    configureRuntimeUpload(fixture, 'dfu-util');
    const logger = new QuietLogger();
    const result = await compilerFor(fixture, logger).compile(fixture.options);
    const text = result.firmwareSize?.sections.find(section => section.name === 'text');
    assert.equal(text?.size, imageBytes);
    assert.equal(text?.maxSize, 0x10000, 'factory recovery is not a runtime OTA candidate');
    assert.equal(result.success, imageBytes <= 0x10000);
    assert.equal(logger.progressEvents.filter(event => event.status === 'complete').length,
      imageBytes <= 0x10000 ? 1 : 0);
    if (imageBytes > 0x10000) {
      assert.equal(result.outFilePath, undefined);
      assert.match(result.error!, /runtime OTA capacity.*ota_0/i);
      assert.match(result.error!, /by 1 bytes/i);
    } else {
      assert.equal(result.outFilePath, fixture.outputPath);
      assert.equal(result.firmwareSize?.warnings?.length ?? 0, 0);
    }
  });
}

for (const imageBytes of [0x10000, 0x10001]) {
  test(`ESP32: runtime OTA uses the smallest unequal candidate at ${imageBytes} bytes`, async t => {
    const fixture = await esp32Fixture(t, imageBytes, [
      ...unequalOta,
      { name: 'factory_recovery', subtype: 0, offset: 0x60000, size: 0x1000 },
      { name: 'test', subtype: 0x20, offset: 0x70000, size: 0x1000 },
    ]);
    configureRuntimeUpload(fixture, 'esp_ota');
    const result = await compilerFor(fixture).compile(fixture.options);
    assert.equal(result.firmwareSize?.sections.find(section => section.name === 'text')?.maxSize, 0x10000);
    assert.equal(result.success, imageBytes <= 0x10000);
    if (imageBytes > 0x10000) {
      assert.equal(result.outFilePath, undefined);
      assert.match(result.error!, /runtime OTA capacity.*ota_0/i);
    } else {
      assert.equal(result.outFilePath, fixture.outputPath);
      assert.equal(result.firmwareSize?.errors?.length ?? 0, 0);
    }
  });
}

test('ESP32: larger selected OTA slot succeeds and warns about the smaller OTA slot', async t => {
  const fixture = await esp32Fixture(t, 0x10001, unequalOta, 0x40000);
  const result = await compilerFor(fixture).compile(fixture.options);
  assert.equal(result.success, true);
  assert.equal(result.outFilePath, fixture.outputPath);
  assert.equal(result.firmwareSize?.sections.find(section => section.name === 'text')?.maxSize, 0x20000);
  assert.ok(result.firmwareSize?.warnings?.some(warning => /ota_0/i.test(warning)));
});

test('ESP32: small selected OTA slot fails even when another OTA slot can fit', async t => {
  const fixture = await esp32Fixture(t, 0x10001, unequalOta);
  const result = await compilerFor(fixture).compile(fixture.options);
  assert.equal(result.success, false);
  assert.equal(result.outFilePath, undefined);
  assert.match(result.error!, /ota_0/i);
  assert.equal(result.firmwareSize?.sections.find(section => section.name === 'text')?.maxSize, 0x10000);
});

async function runCli(fixture: SizeFixture) {
  const driver = path.join(fixture.root, 'cli-driver.cjs');
  const preprocess = path.join(fixture.root, 'preprocess.json');
  await fs.writeFile(preprocess, JSON.stringify(fixture.options.preprocessResult));
  // Patch only work which requires an SDK/toolchain. main.ts and the compiler
  // result -> process-exit path are both the actual production implementations.
  await fs.writeFile(driver, `
const { ArduinoCompiler } = require(${JSON.stringify(path.join(repository, 'src/ArduinoCompiler.ts'))});
const { NinjaCompilationPipeline } = require(${JSON.stringify(path.join(repository, 'src/NinjaCompilationPipeline.ts'))});
const { CacheManager } = require(${JSON.stringify(path.join(repository, 'src/CacheManager.ts'))});
ArduinoCompiler.prototype.runGlobalPrebuild = async () => {};
ArduinoCompiler.prototype.prepareBuildDirectory = async () => {};
NinjaCompilationPipeline.prototype.compile = async () => ({
  success: true, outFilePath: ${JSON.stringify(fixture.outputPath)}
});
CacheManager.prototype.maintainCache = async () => {};
require(${JSON.stringify(path.join(repository, 'main.ts'))});
`);
  const env = { ...process.env };
  // CLI restores its own build context; avoid inheriting another test or user's
  // build path in recipe cwd/source selection.
  for (const key of ['BUILD_PATH', 'SKETCH_PATH', 'SKETCH_NAME', 'SKETCH_DIR_PATH']) delete env[key];
  return spawnSync(process.execPath, [
    '--require', require.resolve('tsx/cjs'), driver, 'compile', fixture.options.sketchPath,
    '--board', fixture.options.board, '--build-path', fixture.root,
    '--preprocess-result', preprocess,
  ], { cwd: repository, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
}

test('CLI rejects program capacity overflow with exit 1 and no successful output', async t => {
  const result = await runCli(await sizeFixture(t, 'avr', 1025));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /Compilation failed:.*text section exceeds/i);
  assert.doesNotMatch(output, /Compilation successful|Output File:/i);
});

test('CLI rejects RAM capacity overflow with exit 1', async t => {
  const result = await runCli(await sizeFixture(t, 'stm32', 512, 257, 1024, 256));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /Compilation failed:.*data section exceeds/i);
  assert.doesNotMatch(output, /Compilation successful|Output File:/i);
});

test('CLI accepts an exact capacity boundary with exit 0', async t => {
  const result = await runCli(await sizeFixture(t, 'avr', 1024));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Compilation successful!/);
  assert.match(result.stdout, /Output File:/);
});

test('CLI rejects actual ESP32 APP overflow with exit 1 and no completion event', async t => {
  const result = await runCli(await esp32Fixture(t, 0x10001));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /Compilation failed:.*factory/i);
  assert.doesNotMatch(output, /Compilation successful|Output File:/i);
  assert.doesNotMatch(output, /"status":"complete"/);
});

test('CLI rejects a missing ESP32 partition artifact with exit 1', async t => {
  const fixture = await esp32Fixture(t, 512);
  await fs.unlink(path.join(fixture.root, 'sketch.partitions.bin'));
  const result = await runCli(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /Compilation successful|Output File:/i);
});

test('CLI accepts the exact ESP32 APP limit and publishes one completion event', async t => {
  const result = await runCli(await esp32Fixture(t, 0x10000));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Compilation successful!/);
  assert.equal((result.stdout.match(/"status":"complete"/g) || []).length, 1);
});

test('CLI rejects DFU runtime OTA overflow with exit 1 and no completion event', async t => {
  const fixture = await esp32Fixture(t, 0x10001, recoveryAndOta);
  configureRuntimeUpload(fixture, 'dfu-util');
  const result = await runCli(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /Compilation failed:.*runtime OTA capacity.*ota_0/i);
  assert.doesNotMatch(output, /Compilation successful|Output File:/i);
  assert.doesNotMatch(output, /"status":"complete"/);
});

test('CLI accepts DFU runtime OTA at the exact limit with one completion event', async t => {
  const fixture = await esp32Fixture(t, 0x10000, recoveryAndOta);
  configureRuntimeUpload(fixture, 'dfu-util');
  const result = await runCli(fixture);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Compilation successful!/);
  assert.match(result.stdout, /Output File:/);
  assert.equal((result.stdout.match(/"status":"complete"/g) || []).length, 1);
});
