// Modelli voce (Fase 9, P-48): download SOLO su richiesta esplicita del proprietario, con
// dimensione e SHA-256 verificati contro `src/shared/voice-models.json`. Nessun download a runtime.
//   node tools/voice-models.mjs            scarica ciò che manca in <home>\models\voice
//   node tools/voice-models.mjs --check    dice solo cosa c'è e cosa manca
//   node tools/voice-models.mjs --dir <d>  cartella dei modelli diversa
// <home> = VISIONE_HOME, altrimenti %APPDATA%\VISIONE-dev (come l'app in sviluppo).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'src', 'shared', 'voice-models.json'), 'utf8'));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const dirArg = args.indexOf('--dir');
const home = process.env.VISIONE_HOME?.trim() || process.env.PROTON_HOME?.trim() || join(process.env.APPDATA ?? '', 'VISIONE-dev');
// Migrazione una tantum (P-63): la home storica PROTON-dev diventa VISIONE-dev.
{
  const legacy = join(process.env.APPDATA ?? '', 'PROTON-dev');
  try { if (!existsSync(home) && existsSync(legacy)) renameSync(legacy, home); } catch { /* best-effort */ }
}
const modelsDir = dirArg >= 0 ? resolve(args[dirArg + 1]) : join(home, 'models', 'voice');
// tar.exe di Windows (bsdtar) estrae i .tar.bz2 senza dipendenze in più. Percorso esplicito: il tar
// GNU di Git Bash scambierebbe "C:" per un host remoto.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const present = (m) => m.files.every((f) => existsSync(join(modelsDir, m.dir, f)));
const mb = (n) => (n / 1048576).toFixed(1);

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function fetchTo(m, part) {
  const res = await fetch(m.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${m.id}: HTTP ${res.status}`);
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let bytes = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (bytes - shown > 50 * 1048576) {
      shown = bytes;
      console.log(`  ${m.id}: ${mb(bytes)} / ${mb(m.size)} MB`);
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (bytes !== m.size) throw new Error(`${m.id}: dimensione ${bytes} ≠ ${m.size} attesa`);
  return hash.digest('hex');
}

async function install(m) {
  const target = join(modelsDir, m.archive ? `${m.dir}.download` : join(m.dir, m.files[0]));
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.part`;
  // Archivio rimasto da un tentativo precedente (estrazione fallita): si riverifica senza riscaricarlo.
  if (existsSync(target) && statSync(target).size === m.size) renameSync(target, part);
  const sha256 = existsSync(part) && statSync(part).size === m.size ? await hashFile(part) : await fetchTo(m, part);
  if (m.sha256 && sha256 !== m.sha256) {
    rmSync(part);
    throw new Error(`${m.id}: SHA-256 ${sha256} ≠ ${m.sha256} atteso (file scartato)`);
  }
  if (!m.sha256) console.log(`  ${m.id}: SHA-256 ${sha256} (da fissare nel manifest)`);
  renameSync(part, target);
  if (m.archive) {
    const r = spawnSync(tar, ['-xjf', target, '-C', modelsDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${m.id}: estrazione fallita (tar ${r.status})`);
    rmSync(target);
  }
  if (!present(m)) throw new Error(`${m.id}: file attesi assenti dopo l'installazione`);
}

let failed = 0;
for (const m of manifest.models) {
  if (present(m)) {
    console.log(`ok       ${m.id} (${m.license}) in ${join(modelsDir, m.dir)}`);
    continue;
  }
  console.log(`${checkOnly ? 'manca   ' : 'scarico '} ${m.id} (${mb(m.size)} MB, ${m.license}) da ${m.url}`);
  if (checkOnly) {
    failed++;
    continue;
  }
  try {
    await install(m);
    console.log(`ok       ${m.id}`);
  } catch (err) {
    failed++;
    console.error(`errore   ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
