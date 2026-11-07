// Draws desktop/icon.png (256 x 256, the window, tray and installer icon) from web/public/icon.svg.
// Run it after changing the SVG: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIZE = 256;
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'web', 'public', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = img.getSize().width === SIZE ? img : img.resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.writeFileSync(path.join(ROOT, 'desktop', 'icon.png'), out.toPNG());
  console.log('wrote desktop/icon.png', out.getSize());
  app.quit();
});
