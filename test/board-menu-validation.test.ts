import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArduinoConfigParser } from '../src/ArduinoConfigParser';

// ESP32 3.3.10 menu IDs from boards.txt: the TinyUSB value is "default".
const boards = [
  'esp32s3.name=ESP32S3 Dev Module',
  'esp32s3.build.usb_mode=1',
  'esp32s3.menu.USBMode.hwcdc=Hardware CDC and JTAG',
  'esp32s3.menu.USBMode.hwcdc.build.usb_mode=1',
  'esp32s3.menu.USBMode.default=USB-OTG (TinyUSB)',
  'esp32s3.menu.USBMode.default.build.usb_mode=0',
  'esp32s3.menu.CDCOnBoot.default=Disabled',
  'esp32s3.menu.CDCOnBoot.default.build.cdc_on_boot=0',
  'esp32s3.menu.CDCOnBoot.cdc=Enabled',
  'esp32s3.menu.CDCOnBoot.cdc.build.cdc_on_boot=1',
  'other.menu.USBMode.otg=Other board option',
].join('\n');

test('board menus validate explicit selections before filtering options', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-board-menu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'boards.txt');
  fs.writeFileSync(file, boards);
  const parser = new ArduinoConfigParser();
  const fqbn = parser.parseFQBN('esp32:esp32:esp32s3');
  const parse = (options: Record<string, string> = {}) => parser.parseBoardsTxt(file, fqbn, options);

  for (const value of ['otg-tinyusb', 'otg', 'tinyusb', 'DEFAULT', '']) {
    await t.test(`rejects USBMode=${JSON.stringify(value)} with valid choices`, () => {
      assert.throws(() => parse({ USBMode: value }), error => {
        assert.match(String(error), /USBMode/);
        assert.ok(String(error).includes(JSON.stringify(value)));
        assert.match(String(error), /hwcdc.*default/);
        return true;
      });
    });
  }

  await t.test('preserves default ordering, exact valid selections and independent CDC values', () => {
    const omitted = parse();
    assert.equal(omitted['menu.USBMode.hwcdc.build.usb_mode'], '1');
    assert.equal(omitted['menu.USBMode.default.build.usb_mode'], '0');
    const options = { USBMode: 'default', CDCOnBoot: 'cdc', 'build.extra_flags': '-DCUSTOM=1' };
    const selected = parse(options);
    assert.equal(selected['menu.USBMode.default.build.usb_mode'], '0');
    assert.equal(selected['menu.USBMode.hwcdc'], undefined);
    assert.equal(selected['menu.CDCOnBoot.cdc.build.cdc_on_boot'], '1');
    assert.equal(selected['menu.CDCOnBoot.default'], undefined);
    assert.deepEqual(options, { USBMode: 'default', CDCOnBoot: 'cdc', 'build.extra_flags': '-DCUSTOM=1' });
    assert.equal(parse({ USBMode: 'hwcdc' })['menu.USBMode.hwcdc.build.usb_mode'], '1');
  });

  await t.test('validates other known menus without confusing arbitrary build properties with menus', () => {
    assert.throws(() => parse({ CDCOnBoot: 'enabled' }), /CDCOnBoot.*enabled.*default.*cdc/);
    assert.doesNotThrow(() => parse({ 'build.extra_flags': '-DCUSTOM=1', custom_property: 'value' }));
    assert.equal(parser.parseBoardsTxt(file, parser.parseFQBN('esp32:esp32:other'), { USBMode: 'otg' })['menu.USBMode.otg'], 'Other board option');
  });
});
