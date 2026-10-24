// Provider di sensori opzionale (Fase 14, P-60): LibreHardwareMonitor (MPL-2.0) per le temperature
// reali CPU/GPU. NON viene distribuito con VISIONE: si scarica solo su richiesta e si avvia l'utente
// (richiede privilegi di amministratore per il driver di lettura). VISIONE legge i sensori SOLO su
// loopback (http://127.0.0.1:8085/data.json): nessun host esterno.
//   node tools/sensors.mjs fetch   scarica LHM in <home>\tools\LibreHardwareMonitor (se manca)
//   node tools/sensors.mjs start   prepara la config (web server su loopback) e avvia LHM
//   node tools/sensors.mjs check   dice se è presente e se il web server risponde
// <home> = VISIONE_HOME, altrimenti %APPDATA%\VISIONE-dev (come l'app in sviluppo).
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.VISIONE_HOME?.trim() || process.env.PROTON_HOME?.trim() || join(process.env.APPDATA ?? '', 'VISIONE-dev');
// Migrazione una tantum (P-63): la home storica PROTON-dev diventa VISIONE-dev.
{
  const legacy = join(process.env.APPDATA ?? '', 'PROTON-dev');
  try { if (!existsSync(home) && existsSync(legacy)) renameSync(legacy, home); } catch { /* best-effort */ }
}
const dir = join(home, 'tools', 'LibreHardwareMonitor');
const exe = join(dir, 'LibreHardwareMonitor.exe');
const configFile = join(dir, 'LibreHardwareMonitor.config');
const URL_ZIP = 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest/download/LibreHardwareMonitor.zip';
const PORT = 8085;
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const mode = (process.argv[2] ?? 'check').toLowerCase();

// Config che abilita il web server locale (solo loopback). Non sovrascrive una config esistente.
function ensureConfig() {
  if (existsSync(configFile)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(configFile, `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="runWebServerMenuItem" value="true" />
    <add key="listenerIp" value="127.0.0.1" />
    <add key="listenerPort" value="${PORT}" />
    <add key="authenticationEnabled" value="false" />
  </appSettings>
</configuration>
`, 'utf8');
  return true;
}

async function download() {
  if (process.platform !== 'win32') {
    console.error('sensors: supportato solo su Windows');
    process.exit(1);
  }
  if (existsSync(exe)) {
    console.log(`ok       LibreHardwareMonitor già presente in ${dir}`);
    return;
  }
  console.log(`scarico  LibreHardwareMonitor (MPL-2.0) da ${URL_ZIP}`);
  const res = await fetch(URL_ZIP, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const zip = join(home, 'tools', 'librehardwaremonitor.zip');
  mkdirSync(dirname(zip), { recursive: true });
  const out = createWriteStream(zip);
  for await (const chunk of res.body) if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(tar, ['-xf', zip, '-C', dir], { stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(exe)) throw new Error('estrazione fallita (tar)');
  rmSync(zip, { force: true });
  console.log(`ok       LibreHardwareMonitor in ${dir}`);
}

async function check() {
  const present = existsSync(exe);
  console.log(`${present ? 'ok      ' : 'manca   '} LibreHardwareMonitor ${present ? `in ${dir}` : '(esegui `npm run sensors:fetch`)'}`);
  if (!present) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/data.json`, { signal: AbortSignal.timeout(1200) });
    console.log(res.ok ? `ok       web server su http://127.0.0.1:${PORT} (temperature disponibili)` : `web server: HTTP ${res.status} (avvia con \`npm run sensors:start\`)`);
    return res.ok;
  } catch {
    console.log('web server non attivo: avvia con `npm run sensors:start` (chiede i privilegi, serve il driver)');
    return false;
  }
}

async function start() {
  if (process.platform !== 'win32') {
    console.error('sensors:start: supportato solo su Windows');
    process.exit(1);
  }
  if (!existsSync(exe)) {
    console.error('LibreHardwareMonitor non presente: esegui prima `npm run sensors:fetch`');
    process.exit(1);
  }
  const created = ensureConfig();
  if (created) console.log(`config scritta (${configFile}): web server su 127.0.0.1:${PORT}`);
  else console.log(`config esistente lasciata intatta (${configFile})`);
  console.log('avvio LibreHardwareMonitor (richiede privilegi di amministratore)...');
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('avviato. Verifica con `npm run sensors:check`.');
}

if (mode === 'fetch') await download();
else if (mode === 'start') await start();
else await check();
