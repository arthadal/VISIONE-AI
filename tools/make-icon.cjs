// Icona di VISIONE (P-104): nucleo azzurro con anelli su fondo scuro, come il reactor della scena.
// Si rigenera con: node_modules\electron\dist\electron.exe tools\make-icon.cjs
// Scrive build/icon.png (512×512, con trasparenza): electron-builder ne ricava l'.ico di Windows.
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const SIZE = 512;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="fondo" cx="50%" cy="45%" r="70%">
      <stop offset="0" stop-color="#0d2238"/><stop offset="1" stop-color="#040b14"/>
    </radialGradient>
    <radialGradient id="alone" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#7fe7ff" stop-opacity="0.55"/><stop offset="0.45" stop-color="#1fb6ff" stop-opacity="0.18"/><stop offset="1" stop-color="#1fb6ff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="nucleo" cx="45%" cy="40%" r="60%">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#c8f6ff"/><stop offset="0.75" stop-color="#3cc8ff"/><stop offset="1" stop-color="#0b6fb8"/>
    </radialGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="url(#fondo)"/>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="none" stroke="#2ad0ff" stroke-opacity="0.35" stroke-width="6"/>
  <circle cx="256" cy="256" r="210" fill="url(#alone)"/>
  <g fill="none" stroke="#5fdcff" stroke-linecap="round">
    <circle cx="256" cy="256" r="168" stroke-opacity="0.35" stroke-width="5" stroke-dasharray="6 14"/>
    <ellipse cx="256" cy="256" rx="150" ry="52" stroke-opacity="0.85" stroke-width="9" transform="rotate(-24 256 256)"/>
    <ellipse cx="256" cy="256" rx="150" ry="52" stroke-opacity="0.55" stroke-width="7" transform="rotate(36 256 256)"/>
    <path d="M58 256 H178 M334 256 H454" stroke="#bff3ff" stroke-opacity="0.9" stroke-width="5"/>
  </g>
  <circle cx="256" cy="256" r="74" fill="url(#nucleo)"/>
  <circle cx="256" cy="256" r="74" fill="none" stroke="#e8fbff" stroke-opacity="0.8" stroke-width="3"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = join(__dirname, '..', 'build');
  mkdirSync(out, { recursive: true });
  const png = image.resize({ width: SIZE, height: SIZE }).toPNG();
  writeFileSync(join(out, 'icon.png'), png);
  console.log(`icona scritta: build/icon.png (${png.length} byte, ${image.getSize().width}×${image.getSize().height})`);
  app.quit();
});
