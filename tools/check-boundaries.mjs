// Confini architetturali del codice (VISIONE_ARCHITECTURE §1), senza dipendenze:
// `node tools/check-boundaries.mjs`. Esce con codice 1 alla prima violazione trovata.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const problems = [];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const rel = (p) => relative(root, p).replaceAll('\\', '/');
const IMPORT = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const list = [];
  for (const m of text.matchAll(IMPORT)) list.push({ spec: m[3], typeOnly: Boolean(m[2]) });
  for (const m of text.matchAll(DYNAMIC)) list.push({ spec: m[1], typeOnly: false });
  return list.map((i) => ({
    ...i,
    target: i.spec.startsWith('.') ? rel(resolve(dirname(file), i.spec)) : null
  }));
}

const all = files(src);
const graph = new Map();

for (const file of all) {
  const from = rel(file);
  const imports = importsOf(file);
  graph.set(from, imports.filter((i) => i.target && !i.typeOnly).map((i) => i.target));
  const fail = (msg) => problems.push(`${from}: ${msg}`);

  for (const { spec, typeOnly, target } of imports) {
    const isElectron = spec === 'electron';
    const isNode = spec.startsWith('node:');

    if (target && !target.startsWith('src/')) fail(`import fuori da src: ${spec}`);

    // Il core decide e non conosce Electron.
    if (from.startsWith('src/core/') && isElectron) fail('il core non deve importare electron');

    // Il main parla con il core solo attraverso il processo, mai importandolo.
    if (from.startsWith('src/main/') && target?.startsWith('src/core/')) fail(`il main non importa il core (${spec})`);

    // Il renderer: solo sé stesso, i contratti condivisi, React e le librerie della UI approvate in
    // LICENZE_E_PROVENIENZA (Fase 8: three per la scena 3D, xterm per il terminale; P-45, P-47;
    // G2/P-74: i due font self-hosted OFL-1.1).
    if (from.startsWith('src/renderer/')) {
      const ok = target
        ? target.startsWith('src/renderer/') || target.startsWith('src/shared/contracts/')
        : spec === 'three' || spec.startsWith('three/') || ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@xterm/xterm', '@xterm/addon-fit', '@xterm/xterm/css/xterm.css'].includes(spec)
          || spec.startsWith('@fontsource/chakra-petch/') || spec.startsWith('@fontsource/jetbrains-mono/');
      if (!ok) fail(`il renderer non può importare ${spec}`);
      if (target?.startsWith('src/shared/contracts/') && !typeOnly) fail(`il renderer importa solo tipi dai contratti (${spec})`);
    }

    // Il preload: electron, i canali IPC, utilità pure; dai contratti solo tipi (niente zod nel preload).
    if (from.startsWith('src/preload/')) {
      const ok = isElectron
        || (target && typeOnly && target.startsWith('src/shared/contracts/'))
        || target === 'src/shared/contracts/api.ts'
        || target?.startsWith('src/shared/lib/');
      if (!ok) fail(`il preload non può importare ${spec}`);
    }

    // shared non dipende dai processi; contracts e lib girano anche nel renderer.
    if (from.startsWith('src/shared/')) {
      if (target && !target.startsWith('src/shared/')) fail(`shared non può importare ${spec}`);
      if ((from.startsWith('src/shared/contracts/') || from.startsWith('src/shared/lib/')) && (isNode || isElectron)) {
        fail(`contracts e lib devono restare indipendenti dalla piattaforma (${spec})`);
      }
      if (target?.startsWith('src/shared/node/') && !from.startsWith('src/shared/node/')) fail(`solo shared/node importa shared/node (${spec})`);
    }

    // Un modulo del core espone solo index.ts agli altri moduli.
    if (target?.startsWith('src/core/')) {
      const [, , mod] = target.split('/');
      const fromMod = from.startsWith('src/core/') ? from.split('/')[2] : null;
      const isIndex = target === `src/core/${mod}/index.ts`;
      if (fromMod !== mod && !isIndex && target.split('/').length > 3) fail(`import interno di core/${mod}: usare index.ts (${spec})`);
    }
  }

  // La UI è guidata dagli eventi: niente polling nel renderer (P-29).
  if (from.startsWith('src/renderer/') && /\bsetInterval\s*\(/.test(readFileSync(file, 'utf8'))) {
    fail('polling vietato nel renderer (setInterval): usare le sottoscrizioni di window.visione');
  }

  // Nessun modulo fuori da core/adapters/<motore>/ conosce un motore.
  if (!/^src\/core\/adapters\/[^/]+\//.test(from)) {
    const text = readFileSync(file, 'utf8');
    const m = text.match(/\b(opencode|claude|anthropic|nvidia)/i);
    if (m) fail(`nome di motore "${m[0]}" fuori da core/adapters/<motore>/`);
  }
}

// Nessun ciclo tra import di valori.
const state = new Map();
const stack = [];
function visit(node) {
  if (state.get(node) === 2) return;
  if (state.get(node) === 1) {
    problems.push(`ciclo di import: ${stack.slice(stack.indexOf(node)).concat(node).join(' → ')}`);
    return;
  }
  state.set(node, 1);
  stack.push(node);
  for (const next of graph.get(node) ?? []) if (graph.has(next)) visit(next);
  stack.pop();
  state.set(node, 2);
}
for (const node of graph.keys()) visit(node);

if (problems.length > 0) {
  console.error(`check-boundaries: ${problems.length} problemi\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`check-boundaries: ok (${all.length} file, confini e cicli verificati)`);
