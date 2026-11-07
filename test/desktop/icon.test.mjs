// The window, tray and installer have KeaS's icon (audit 2, 3.1: the tray slot was blank because no icon shipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('desktop/icon.png is a real 256 x 256 PNG, shipped, and the installer and windows use it', () => {
  const png = readFileSync(new URL('../../desktop/icon.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 256, 'width');
  assert.equal(png.readUInt32BE(20), 256, 'height');
  assert.ok(png.length > 1000, 'not an empty image');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.build.win.icon, 'desktop/icon.png');
  assert.ok(pkg.build.files.includes('desktop/**/*'));
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /ICON_FILE = path\.join\(__dirname, 'icon\.png'\)/);
  assert.match(main, /icon: appIcon\(\)/);
});
