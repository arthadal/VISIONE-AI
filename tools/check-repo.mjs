// Igiene del repository, senza dipendenze: `node tools/check-repo.mjs`.
// - nessun segreto nei file versionati o da versionare;
// - nessun file .env versionato;
// - nessun remoto Git tranne `origin` sul repository pubblico (P-107af; prima P-3: Git solo locale), nella copia
//   interna: in un clone o in un fork della copia pubblica (CI, contributori) i remoti sono liberi.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const problems = [];

// Forme ad alta confidenza: il testo normale e i test (che costruiscono i campioni a runtime) non le contengono.
const SECRET = [
  /nvapi-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}\b/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];

const listed = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
let scanned = 0;
for (const file of listed) {
  const base = file.split('/').at(-1) ?? file;
  if (/^\.env(\..*)?$/.test(base)) problems.push(`${file}: file .env nel repository`);
  const full = join(root, file);
  let size;
  try {
    size = statSync(full).size;
  } catch {
    continue; // cancellato nell'albero di lavoro
  }
  if (size > 2_000_000) continue;
  const text = readFileSync(full, 'utf8');
  if (text.includes('\u0000')) continue; // binario
  scanned++;
  const source = /\.(?:[cm]?[jt]sx?|json|css|html|md)$/.test(file);
  // 17/10/2026: uno script di modifica su Windows ha riscritto file interi con a capo CRLF (diff illeggibili in
  // 5 commit). Codice, strumenti e test unitari sono LF; i fixture catturati restano come sono.
  if (/^(?:src|tools|test\/unit|test\/e2e)\//.test(file) && source && text.includes('\r\n')) problems.push(`${file}: a capo CRLF (il repository usa LF)`);
  // 17/10/2026: 3.349 cartelle visione-* (1,25 GB) lasciate in %TEMP% dai test. Le cartelle temporanee dei test
  // nascono solo da tempHome (test/helpers.ts), che le cancella a fine file anche quando un test fallisce.
  if (/^test\//.test(file) && !['test/helpers.ts', 'test/global-setup.ts'].includes(file) && source && /\bmkdtemp(?:Sync)?\s*\(/.test(text)) problems.push(`${file}: cartella temporanea con mkdtemp: usa tempHome di test/helpers.ts (si cancella anche se il test fallisce)`);
  text.split('\n').forEach((line, i) => {
    for (const pattern of SECRET) if (pattern.test(line)) problems.push(`${file}:${i + 1}: forma di segreto (${pattern.source.slice(0, 20)}…)`);
    // 15/10/2026: un «\b» passato da una shell diventa un backspace invisibile e la regex smette di
    // funzionare senza errori (successo due volte). Nei sorgenti nessun carattere di controllo.
    if (source && /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) problems.push(`${file}:${i + 1}: carattere di controllo invisibile (un «\\b» o simile perso da una shell?)`);
  });
}

// P-107af: l'unico remoto ammesso è il repository pubblico scelto dal proprietario (25/10/2026); ci va solo il
// ramo `pubblico`, istantanee senza le note interne. Il controllo serve alla copia interna, quella con le note
// (stesso segnale di tools/check-docs.mjs): in un clone o in un fork della copia pubblica non c'è nulla da
// proteggere, e un fork con `origin` sul proprio account o un remoto `upstream` facevano fallire `npm run check`.
const internal = existsSync(join(root, 'JARVIS_EDITION_PROGRESS.md'));
const PUBLIC = 'https://github.com/arthadal/VISIONE-AI.git';
/** Stesso repository a meno di maiuscole, `.git` finale, barra finale e forma HTTPS/SSH. */
const repoId = (url) => url.trim().toLowerCase()
  .replace(/^git@github\.com:/, 'github.com/')
  .replace(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?/, '')
  .replace(/\/+$/, '')
  .replace(/\.git$/, '');
if (internal) {
  for (const name of git('remote').split('\n').filter(Boolean)) {
    const url = git('remote', 'get-url', name).trim();
    if (name !== 'origin' || repoId(url) !== repoId(PUBLIC)) problems.push(`remoto Git non ammesso: ${name} ${url} (solo origin ${PUBLIC})`);
  }
}

if (problems.length > 0) {
  console.error(`check-repo: ${problems.length} problemi\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`check-repo: ok (${scanned} file senza segreti, nessun .env, ${internal ? 'solo il remoto pubblico' : 'remoti liberi nella copia pubblica'})`);
