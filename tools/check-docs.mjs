// Controlli dei documenti di progetto, senza dipendenze: `node tools/check-docs.mjs`.
// Esce con codice 1 se qualcosa non torna.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// P-107af: la copia pubblica (ramo `pubblico`, su GitHub) non ha le note interne né `docs/`: lì si controllano
// solo i suoi file e link e segreti dei documenti che ci sono.
const internal = existsSync(join(root, 'JARVIS_EDITION_PROGRESS.md'));
const required = !internal ? ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'] : [
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CLAUDE.md',
  'JARVIS_EDITION_MISSION.md',
  'JARVIS_EDITION_PROGRESS.md',
  'JARVIS_EDITION_PHASES.md',
  'docs/audit/MUNDER_AUDIT.md',
  'docs/audit/MUNDER_CLI_RUNTIME.md',
  'docs/decisions/DECISIONI.md',
  'docs/decisions/LICENZE_E_PROVENIENZA.md',
  'docs/architecture/VISIONE_ARCHITECTURE.md',
  'docs/architecture/VISIONE_COMPONENT_MAP.md',
  'docs/architecture/VISIONE_DATA_MODEL.md',
  'docs/architecture/VISIONE_EVENT_MODEL.md',
  'docs/architecture/VISIONE_AGENT_ARCHITECTURE.md',
  'docs/architecture/VISIONE_SECURITY_MODEL.md',
  'docs/architecture/VISIONE_TECH_STACK.md'
];
for (const f of required) if (!existsSync(join(root, f))) problems.push(`manca ${f}`);

function markdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    // Cartelle generate o locali (build, installer, backup): non sono documenti del progetto.
    if (['.git', 'node_modules', 'out', 'dist', '.backup'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Riferimenti a file del repository: link Markdown relativi e percorsi tra backtick.
const repoPath = /`((?:docs|tools|src)\/[A-Za-z0-9_./-]+\.(?:md|mjs))`/g;
const mdLink = /\]\((?!https?:|#)([^)#\s]+)(?:#[^)]*)?\)/g;
// Forme di segreto che non devono mai comparire nei documenti.
const secret = /\b(nvapi-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})\b/;

for (const file of markdownFiles(root)) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(repoPath)) {
    if (!existsSync(join(root, m[1]))) problems.push(`${rel}: riferimento inesistente ${m[1]}`);
  }
  for (const m of text.matchAll(mdLink)) {
    const target = resolve(dirname(file), m[1]);
    if (target.startsWith(root) && !existsSync(target)) problems.push(`${rel}: link rotto ${m[1]}`);
  }
  if (secret.test(text)) problems.push(`${rel}: contiene una stringa con forma di segreto`);
}

const progress = internal ? readFileSync(join(root, 'JARVIS_EDITION_PROGRESS.md'), 'utf8') : '';
if (internal) for (const field of ['CURRENT PHASE:', 'CURRENT STEP:', 'STATUS:', 'LAST COMPLETED:',
  'NEXT EXACT ACTION:', 'FILES:', 'TEST:', 'LAST COMMIT:', 'BLOCKERS:', 'IMPORTANT DECISIONS:']) {
  if (!progress.includes(field)) problems.push(`Progress: manca il campo ${field}`);
}

// P-101: le decisioni vecchie vivono negli archivi `DECISIONI_ARCHIVIO_*.md` (copie identiche) e
// valgono le stesse regole: formato completo, nessun numero P-n perso o duplicato.
const decisionDir = join(root, 'docs/decisions');
const decisionFiles = !internal ? [] : ['DECISIONI.md', ...readdirSync(decisionDir).filter((n) => /^DECISIONI_ARCHIVIO_.*\.md$/.test(n)).sort()];
const seen = new Map();
for (const name of decisionFiles) {
  const decisions = readFileSync(join(decisionDir, name), 'utf8');
  for (const block of decisions.split(/\n### /).slice(1)) {
    const id = block.split('\n')[0];
    for (const f of ['**Problema:**', '**Scelta:**', '**Motivazione:**', '**Alternative:**', '**Conseguenze:**']) {
      if (!block.includes(f)) problems.push(`${name} ${id}: manca ${f}`);
    }
    const n = /^P-(\d+)\b/.exec(id)?.[1];
    if (n !== undefined) {
      if (seen.has(n)) problems.push(`decisione P-${n} duplicata (${seen.get(n)} e ${name})`);
      seen.set(n, name);
    }
  }
}
const maxDecision = Math.max(0, ...[...seen.keys()].map(Number));
for (let n = 1; n <= maxDecision; n++) if (!seen.has(String(n))) problems.push(`decisione P-${n} mancante`);

if (problems.length) {
  console.error(`check-docs: ${problems.length} problemi`);
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log(`check-docs: ok (${required.length} documenti richiesti, riferimenti e decisioni verificati)`);
