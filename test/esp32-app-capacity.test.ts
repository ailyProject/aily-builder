import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test, { TestContext } from 'node:test';
import { parseEsp32Partitions, readEsp32AppCapacity, selectEsp32AppPartition, Esp32Partition } from '../src/Esp32AppCapacity';

function app(name = 'factory', offset = 0x10000, size = 4096, subtype = 0): Esp32Partition {
  return { name, type: 0, subtype, offset, size };
}

function table(partitions: Esp32Partition[], md5 = false): Buffer {
  const records = partitions.map(partition => {
    const record = Buffer.alloc(32);
    record.writeUInt16LE(0x50aa);
    record[2] = partition.type; record[3] = partition.subtype;
    record.writeUInt32LE(partition.offset, 4); record.writeUInt32LE(partition.size, 8);
    record.write(partition.name, 12, 16, 'utf8');
    return record;
  });
  if (md5) {
    const footer = Buffer.alloc(32, 0xff);
    footer.writeUInt16LE(0xebeb);
    createHash('md5').update(Buffer.concat(records)).digest().copy(footer, 16);
    records.push(footer);
  }
  return Buffer.concat([...records, Buffer.alloc(32, 0xff)]);
}

test('SDK binary table accepts names, numeric subtypes, MD5 and old no-MD5 format', () => {
  const entries = [
    { name: 'nvs', type: 1, subtype: 2, offset: 0x9000, size: 0x5000 },
    app('arbitrary label', 0x10000, 0x100000, 0x10), app('update 1', 0x110000, 0x100000, 0x11),
  ];
  assert.deepEqual(parseEsp32Partitions(table(entries)), entries);
  assert.deepEqual(parseEsp32Partitions(table(entries, true)), entries);
});

for (const [name, bytes] of [
  ['empty', Buffer.alloc(0)], ['truncated', Buffer.alloc(31)], ['oversized', Buffer.alloc(0x1020)],
  ['wrong magic', Buffer.alloc(64)], ['empty terminator', Buffer.alloc(32, 0xff)],
  ['missing terminator', table([app()]).subarray(0, 32)],
  ['zero APP size', table([app('empty', 0x10000, 0)])],
  ['APP address overflow', table([app('overflow', 0xffff0000, 0x20000)])],
] as const) {
  test(`malformed partition table rejects ${name}`, () => assert.throws(() => parseEsp32Partitions(bytes)));
}

test('MD5 and trailing padding corruption are not silently accepted', () => {
  const checksum = table([app()], true); checksum[48] ^= 1;
  assert.throws(() => parseEsp32Partitions(checksum), /MD5/);
  const footer = table([app()], true); footer[34] = 0;
  assert.throws(() => parseEsp32Partitions(footer), /MD5/);
  const padding = table([app()]); padding[63] = 0;
  assert.throws(() => parseEsp32Partitions(padding), /terminator/);
});

test('target must be exactly one APP start, not any address inside the largest partition', () => {
  const partitions = [app(), app('other', 0x20000, 8192, 0x11)];
  assert.equal(selectEsp32AppPartition(partitions, 0x10000), partitions[0]);
  assert.throws(() => selectEsp32AppPartition(partitions, 0x10001), /No unique/);
  assert.throws(() => selectEsp32AppPartition([{ ...app(), type: 1 }], 0x10000), /No unique/);
  assert.throws(() => selectEsp32AppPartition([app(), app('duplicate')], 0x10000), /No unique/);
});

async function fixture(t: TestContext, partitions = [app()], imageBytes = 4096) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-esp32-capacity space-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imageFile = path.join(root, 'sketch.bin');
  await fs.writeFile(imageFile, Buffer.alloc(imageBytes));
  await fs.writeFile(path.join(root, 'sketch.partitions.bin'), table(partitions, true));
  const platform: Record<string, string> = {
    'build.arch': 'ESP32', 'build.project_name': 'sketch', 'upload.maximum_size': '16777216'
  };
  const upload = (offset: number, file = imageFile) => `esptool --port "COM999" write-flash 0x8000 "${root}/sketch.partitions.bin" 0xe000 "boot_app0.bin" 0x${offset.toString(16)} "${file}"`;
  return { root, imageFile, platform, upload };
}

for (const architecture of ['AVR', 'STM32', 'RP2040', 'ESP8266']) {
  test(`${architecture} does not read ESP32 artifacts or alter its capacity logic`, async () => {
    assert.equal(await readEsp32AppCapacity({ platform: { 'build.arch': architecture } }, 'missing'), undefined);
  });
}

for (const mcu of ['esp32', 'esp32s3', 'esp32c3', 'esp32c6', 'esp32p4']) {
  test(`${mcu} uses actual APP BIN and partition, not the Custom 16 MiB estimate`, async t => {
    const f = await fixture(t);
    delete f.platform['build.arch']; f.platform['build.mcu'] = mcu;
    const result = await readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, f.upload(0x10000));
    assert.equal(result?.imageBytes, 4096); assert.equal(result?.maxBytes, 4096);
    assert.deepEqual(result?.warnings, []);
  });
}

test('fqbn identifies ESP32 when an older cached platform lacks MCU/architecture fields', async t => {
  const f = await fixture(t); delete f.platform['build.arch'];
  const result = await readEsp32AppCapacity({ platform: f.platform, fqbnParsed: { platform: 'esp32' } }, f.root, f.imageFile, f.upload(0x10000));
  assert.equal(result?.maxBytes, 4096);
});

test('target factory is not constrained by a smaller non-target test or rescue image', async t => {
  const f = await fixture(t, [app('factory', 0x10000, 8192), app('test', 0x20000, 4096, 0x20)], 6000);
  const result = await readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, f.upload(0x10000));
  assert.equal(result?.maxBytes, 8192); assert.deepEqual(result?.warnings, []);
});

test('unequal OTA slots use the actual target and warn if another update slot cannot hold this BIN', async t => {
  const f = await fixture(t, [app('ota_0', 0x10000, 4096, 0x10), app('ota_1', 0x20000, 8192, 0x11)], 6000);
  const small = await readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, f.upload(0x10000));
  assert.equal(small?.maxBytes, 4096); assert.deepEqual(small?.warnings, []);
  const large = await readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, f.upload(0x20000));
  assert.equal(large?.maxBytes, 8192); assert.match(large!.warnings[0], /ota_0.*4096.*OTA slot rotation/);
});

test('non-target factory size never substitutes for an APP-only OTA destination', async t => {
  const f = await fixture(t, [app('factory', 0x10000, 4096), app('ota_1', 0x400000, 8192, 0x11)], 6000);
  const result = await readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, f.upload(0x400000));
  assert.equal(result?.target.name, 'ota_1'); assert.equal(result?.maxBytes, 8192);
});

test('selected upload recipe resolves APP-only flash_offset, not the presence of the property alone', async t => {
  const f = await fixture(t, [app('ota_0', 0x10000, 4096, 0x10), app('ota_1', 0x400000, 8192, 0x11)], 6000);
  f.platform['build.flash_offset'] = '0x400000';
  f.platform['tools.esptool_py.upload.pattern'] = f.upload(0x10000);
  f.platform['tools.esptool_py_app_only.upload.pattern'] = 'esptool write-flash {build.flash_offset} "' + f.imageFile + '"';
  const standard = await readEsp32AppCapacity({ platform: f.platform, board: { 'upload.tool': 'esptool_py' } }, f.root, f.imageFile);
  assert.equal(standard?.maxBytes, 4096);
  const only = await readEsp32AppCapacity({ platform: f.platform, board: { 'upload.tool': 'esptool_py_app_only' } }, f.root, f.imageFile);
  assert.equal(only?.maxBytes, 8192);
});

test('partition recipe output path handles spaces and does not search arbitrary old tables', async t => {
  const f = await fixture(t); const selectedTable = path.join(f.root, 'selected table.bin');
  await fs.rename(path.join(f.root, 'sketch.partitions.bin'), selectedTable);
  f.platform['build.path'] = f.root;
  f.platform['recipe.objcopy.partitions.bin.pattern'] = 'python gen.py "{build.path}/partitions.csv" "{build.path}/selected table.bin"';
  const result = await readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, f.upload(0x10000));
  assert.equal(result?.partitionFile, selectedTable);
});

test('merged BIN is not measured as the APP image', async t => {
  const f = await fixture(t); const merged = path.join(f.root, 'sketch.merged.bin');
  await fs.writeFile(merged, Buffer.alloc(8192));
  const result = await readEsp32AppCapacity({ platform: f.platform }, f.root, merged, f.upload(0x10000));
  assert.equal(result?.imageFile, f.imageFile); assert.equal(result?.imageBytes, 4096);
});

test('postprocessed/signed APP BIN uses its final bytes and selected upload filename', async t => {
  const f = await fixture(t); const signed = path.join(f.root, 'sketch.signed.bin');
  await fs.writeFile(signed, Buffer.alloc(4097));
  const result = await readEsp32AppCapacity({ platform: f.platform }, f.root, signed, f.upload(0x10000, signed));
  assert.equal(result?.imageFile, signed); assert.equal(result?.imageBytes, 4097);
});

test('no or ambiguous upload target fails instead of falling back to a SDK size estimate', async t => {
  const f = await fixture(t);
  await assert.rejects(() => readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile), /upload recipe/);
  await assert.rejects(() => readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, 'esptool write-flash'), /upload offset/);
  await assert.rejects(() => readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile,
    f.upload(0x10000) + ` 0x20000 "${f.imageFile}"`), /upload offset/);
});

test('zero-length APP image is rejected', async t => {
  const f = await fixture(t, [app()], 0);
  await assert.rejects(() => readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile, f.upload(0x10000)), /empty ESP32 APP image/);
});

test('Nano ESP32 DFU limits actual OTA slots, not its small factory recovery APP', async t => {
  const f = await fixture(t, [app('app0', 0x10000, 8192, 0x10), app('app1', 0x310000, 8192, 0x11), app('factory', 0xf70000, 4096)], 6000);
  const result = await readEsp32AppCapacity({ platform: f.platform, board: { 'upload.tool': 'dfu-util' } }, f.root, f.imageFile,
    `"/tools/dfu-util.exe" --device 0x2341:0x0070 -D "${f.imageFile}" -Q`);
  assert.equal(result?.maxBytes, 8192); assert.equal(result?.targetMode, 'ota');
  assert.deepEqual(result?.warnings, []);
});

test('runtime OTA cannot choose the largest unequal slot and pretend both update directions fit', async t => {
  const f = await fixture(t, [app('ota_0', 0x10000, 4096, 0x10), app('ota_1', 0x20000, 8192, 0x11)], 6000);
  const result = await readEsp32AppCapacity({ platform: f.platform, board: { 'upload.tool': 'esp_ota' } }, f.root, f.imageFile,
    `python espota.py -i 192.0.2.1 -f "${f.imageFile}"`);
  assert.equal(result?.maxBytes, 4096); assert.equal(result?.targetMode, 'ota');
});

test('DFU without any OTA APP slot fails instead of guessing a recovery partition', async t => {
  const f = await fixture(t);
  await assert.rejects(() => readEsp32AppCapacity({ platform: f.platform }, f.root, f.imageFile,
    `dfu-util -D "${f.imageFile}" -Q`), /runtime OTA slots/);
});

test('Unicode source path and ASCII directory alias resolve to the same uploaded APP', async t => {
  const f = await fixture(t); const unicode = path.join(f.root, '中文项目'), alias = path.join(f.root, 'ascii-alias');
  await fs.mkdir(unicode);
  const actualImage = path.join(unicode, 'sketch.bin');
  await fs.rename(f.imageFile, actualImage);
  await fs.symlink(unicode, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedImage = path.join(alias, 'sketch.bin');
  const result = await readEsp32AppCapacity({ platform: f.platform }, f.root, actualImage, f.upload(0x10000, aliasedImage));
  assert.equal(result?.imageBytes, 4096); assert.equal(result?.maxBytes, 4096);
});
