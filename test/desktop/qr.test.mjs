// The two-step setup shows a QR code drawn on this PC (audit 2, 1.5): the vendored encoder makes an image from the
// otpauth:// address with nothing sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';


test('the QR encoder is the pinned qrcode-generator 1.4.4, loaded by the setup page, and draws a data: image', () => {
  // (Run the way the page runs it: a plain script that leaves `qrcode` on the window.)
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../../desktop/setup/vendor/qrcode-generator-1.4.4.js', import.meta.url), 'utf8'), ctx);
  const q = ctx.qrcode(0, 'M');
  q.addData('otpauth://totp/Kea:sam%40example.org?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Kea');
  q.make();
  assert.ok(q.getModuleCount() >= 21);
  assert.match(q.createDataURL(6, 2), /^data:image\/gif;base64,/);
  const src = readFileSync(new URL('../../desktop/setup/vendor/qrcode-generator-1.4.4.js', import.meta.url), 'utf8');
  assert.match(src, /Copyright \(c\) 2009 Kazuhiko Arase/);
  assert.doesNotMatch(src, /XMLHttpRequest|fetch\(|navigator\.sendBeacon/);
  const html = readFileSync(new URL('../../desktop/setup/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="vendor\/qrcode-generator-1\.4\.4\.js"><\/script>\s*<script src="setup\.js">/);
});
