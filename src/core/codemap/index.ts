// Mappa del codice (14/10/2026, P-107l): indice di file, simboli e import delle cartelle di lavoro degli
// agenti (tabelle `code_*`, migrazione 11), aggiornato in background e in modo incrementale (cambia solo
// ciò che ha dimensione o data diverse). Nel brief entra la parte che riguarda il compito (`rank.ts`).
// Nessun programma esterno, nessuna rete: si leggono solo i file delle cartelle di lavoro.
import { readdir, readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { CODEMAP_LIMITS, type CodeRoot } from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { Db, Row } from '../db/index.ts';
import { rankFiles, renderMap, type IndexedFile } from './rank.ts';
import { extractFacts, importKey, langOf, type CodeSymbol, type SymbolKind } from './symbols.ts';

export interface CodeMap {
  /** Cartelle note: quelle degli agenti attivi e quelle già indicizzate. */
  status(): CodeRoot[];
  /** Indicizza ora (incrementale) e risponde a lavoro finito. */
  scan(root: string): Promise<CodeRoot>;
  /** Avvia l'aggiornamento in background se l'indice è vecchio. */
  ensureFresh(root: string): void;
  setEnabled(root: string, enabled: boolean): CodeRoot;
  /** Le righe della sezione del brief per questo compito (vuoto se spenta o niente di pertinente). */
  forTurn(root: string, text: string): string[];
  close(): void;
}

export interface CodeMapDeps {
  db: Db;
  log: Logger;
  now?: () => number;
  /** Cartelle di lavoro degli agenti attivi. */
  roots(): string[];
}

// Cartelle che non sono codice del progetto: dipendenze, risultati di build, ambienti, cache.
const IGNORED = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'bin', 'obj', 'vendor', 'venv', 'env',
  '__pycache__', 'Pods', 'DerivedData', 'release', 'tmp', 'temp', 'logs', 'site-packages', 'bower_components', 'jspm_packages']);

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Una cartella che si può indicizzare: assoluta, esistente, non un disco intero né la cartella utente. */
export function rootProblem(root: string): string | null {
  if (!isAbsolute(root)) return 'percorso non assoluto';
  const abs = resolve(root);
  const trim = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();
  if (trim(abs) === trim(parse(abs).root)) return 'è un disco intero';
  if (abs.toLowerCase() === resolve(homedir()).toLowerCase()) return 'è la cartella utente intera';
  try {
    if (!statSync(abs).isDirectory()) return 'non è una cartella';
  } catch {
    return 'cartella non trovata';
  }
  return null;
}

// Segni della radice di un progetto: da un file citato si risale fino a qui.
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile'];
const SYSTEM_DIRS = /^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|$)/i;

/**
 * Cartelle di progetto citate nel compito («lavora su C:\progetti\negozio\src\cart.ts»): dalla cartella
 * (o dal file) si risale alla radice del progetto, se c'è entro quattro livelli. Al massimo due.
 */
export function mentionedRoots(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s"'«»<>|*?]*/g)) {
    let p = resolve(m[0].replace(/[.,;:)\]]+$/, ''));
    // «C:\progetti\negozio e poi…»: si toglie dal fondo finché il percorso esiste.
    for (let i = 0; i < 3 && !existsQuiet(p); i++) p = dirname(p);
    if (!existsQuiet(p)) continue;
    if (!isDirQuiet(p)) p = dirname(p);
    let root = p;
    for (let up = 0, dir = p; up < 4; up++, dir = dirname(dir)) {
      if (PROJECT_MARKERS.some((mk) => existsQuiet(join(dir, mk)))) {
        root = dir;
        break;
      }
      if (dirname(dir) === dir) break;
    }
    if (SYSTEM_DIRS.test(root) || rootProblem(root) !== null || out.includes(root)) continue;
    out.push(root);
    if (out.length === 2) break;
  }
  return out;
}

function existsQuiet(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDirQuiet(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface Entry {
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
  readonly mtime: number;
}

async function walk(root: string, isClosed: () => boolean): Promise<{ entries: Entry[]; truncated: boolean }> {
  const entries: Entry[] = [];
  const stack = [''];
  let seen = 0;
  while (stack.length > 0 && !isClosed()) {
    const dir = stack.pop()!;
    let list;
    try {
      list = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of list) {
      const rel = dir === '' ? d.name : `${dir}/${d.name}`;
      if (d.isDirectory()) {
        if (!d.name.startsWith('.') && !IGNORED.has(d.name)) stack.push(rel);
        continue;
      }
      if (!d.isFile() || langOf(d.name) === null) continue;
      if (entries.length >= CODEMAP_LIMITS.maxFiles) return { entries, truncated: true };
      try {
        const st = await stat(join(root, rel));
        if (st.size <= CODEMAP_LIMITS.maxFileBytes) entries.push({ rel, abs: join(root, rel), size: st.size, mtime: Math.floor(st.mtimeMs) });
      } catch {
        // sparito durante la lettura
      }
      if (++seen % 200 === 0) await yieldNow();
    }
  }
  return { entries, truncated: false };
}

function rowToRoot(r: Row | undefined, root: string, scanning: boolean, inUse: boolean): CodeRoot {
  return {
    root,
    enabled: r ? Number(r.enabled) === 1 : true,
    files: r ? Number(r.files) : 0,
    symbols: r ? Number(r.symbols) : 0,
    scannedAt: r && r.scanned_at !== null && r.scanned_at !== undefined ? Number(r.scanned_at) : null,
    durationMs: r && r.duration_ms !== null && r.duration_ms !== undefined ? Number(r.duration_ms) : null,
    truncated: r ? Number(r.truncated) === 1 : false,
    scanning,
    inUse,
    error: r && typeof r.error === 'string' ? r.error.slice(0, 300) : null
  };
}

export function createCodeMap(deps: CodeMapDeps): CodeMap {
  const { db, log } = deps;
  const now = deps.now ?? Date.now;
  const running = new Map<string, Promise<CodeRoot>>();
  const cache = new Map<string, IndexedFile[]>();
  let closed = false;

  const q = {
    root: db.prepare('SELECT * FROM code_roots WHERE root = ?'),
    roots: db.prepare('SELECT * FROM code_roots ORDER BY root'),
    ensureRoot: db.prepare('INSERT INTO code_roots (root) VALUES (?) ON CONFLICT(root) DO NOTHING'),
    setEnabled: db.prepare('UPDATE code_roots SET enabled = ? WHERE root = ?'),
    finish: db.prepare('UPDATE code_roots SET files = ?, symbols = ?, scanned_at = ?, duration_ms = ?, truncated = ?, error = ? WHERE root = ?'),
    fail: db.prepare('UPDATE code_roots SET scanned_at = ?, error = ? WHERE root = ?'),
    files: db.prepare('SELECT id, path, size, mtime FROM code_files WHERE root = ?'),
    upsertFile: db.prepare(`INSERT INTO code_files (root, path, lang, size, mtime, lines) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(root, path) DO UPDATE SET lang = excluded.lang, size = excluded.size, mtime = excluded.mtime, lines = excluded.lines
      RETURNING id`),
    clearSymbols: db.prepare('DELETE FROM code_symbols WHERE file_id = ?'),
    clearEdges: db.prepare('DELETE FROM code_edges WHERE file_id = ?'),
    symbol: db.prepare('INSERT INTO code_symbols (file_id, name, kind, line, exported) VALUES (?, ?, ?, ?, ?)'),
    edge: db.prepare('INSERT INTO code_edges (file_id, target) VALUES (?, ?)'),
    dropFile: db.prepare('DELETE FROM code_files WHERE id = ?'),
    countSymbols: db.prepare('SELECT COUNT(*) AS n FROM code_symbols s JOIN code_files f ON f.id = s.file_id WHERE f.root = ?'),
    loadSymbols: db.prepare('SELECT s.file_id, s.name, s.kind, s.line, s.exported FROM code_symbols s JOIN code_files f ON f.id = s.file_id WHERE f.root = ? ORDER BY s.file_id, s.line'),
    loadEdges: db.prepare('SELECT e.file_id, e.target FROM code_edges e JOIN code_files f ON f.id = e.file_id WHERE f.root = ?')
  };

  const norm = (root: string): string => resolve(root);
  const inUse = (): Set<string> => new Set(deps.roots().map(norm));

  const load = (root: string): IndexedFile[] => {
    const hit = cache.get(root);
    if (hit) return hit;
    const symbols = new Map<number, CodeSymbol[]>();
    for (const r of q.loadSymbols.all(root)) {
      const id = Number(r.file_id);
      const list = symbols.get(id) ?? [];
      list.push({ name: String(r.name), kind: String(r.kind) as SymbolKind, line: Number(r.line), exported: Number(r.exported) === 1 });
      symbols.set(id, list);
    }
    const edges = new Map<number, string[]>();
    for (const r of q.loadEdges.all(root)) {
      const id = Number(r.file_id);
      const list = edges.get(id) ?? [];
      list.push(String(r.target));
      edges.set(id, list);
    }
    const files = q.files.all(root).map((r) => {
      const id = Number(r.id);
      const path = String(r.path);
      return { id, path, key: importKey(path), symbols: symbols.get(id) ?? [], imports: edges.get(id) ?? [] };
    });
    cache.set(root, files);
    return files;
  };

  const runScan = async (root: string): Promise<CodeRoot> => {
    const started = now();
    q.ensureRoot.run(root);
    const problem = rootProblem(root);
    if (problem) {
      q.fail.run(started, problem, root);
      return rowToRoot(q.root.get(root), root, false, inUse().has(root));
    }
    try {
      const { entries, truncated } = await walk(root, () => closed);
      const known = new Map(q.files.all(root).map((r) => [String(r.path), { id: Number(r.id), size: Number(r.size), mtime: Number(r.mtime) }]));
      const changed = entries.filter((e) => {
        const k = known.get(e.rel);
        return !k || k.size !== e.size || k.mtime !== e.mtime;
      });
      const present = new Set(entries.map((e) => e.rel));
      const gone = [...known.entries()].filter(([path]) => !present.has(path)).map(([, k]) => k.id);
      for (let i = 0; i < changed.length && !closed; i += 100) {
        const batch: { e: Entry; text: string }[] = [];
        for (const e of changed.slice(i, i + 100)) {
          try {
            const text = await readFile(e.abs, 'utf8');
            // Binario con un'estensione da testo: niente simboli, ma il percorso resta.
            batch.push({ e, text: text.slice(0, 4096).includes('\u0000') ? '' : text });
          } catch {
            // sparito o bloccato: alla prossima
          }
        }
        db.transaction(() => {
          for (const { e, text } of batch) {
            const facts = extractFacts(e.rel, text);
            const id = Number(q.upsertFile.get(root, e.rel, facts.lang, e.size, e.mtime, facts.lines)?.id);
            q.clearSymbols.run(id);
            q.clearEdges.run(id);
            for (const s of facts.symbols) q.symbol.run(id, s.name, s.kind, s.line, s.exported ? 1 : 0);
            for (const target of facts.imports) q.edge.run(id, target);
          }
        });
        await yieldNow();
      }
      // In chiusura il giro è incompleto: niente cancellazioni di file solo perché non ancora visti.
      if (closed) return rowToRoot(undefined, root, false, false);
      if (gone.length > 0) db.transaction(() => { for (const id of gone) q.dropFile.run(id); });
      const symbols = Number(q.countSymbols.get(root)?.n ?? 0);
      q.finish.run(entries.length, symbols, now(), now() - started, truncated ? 1 : 0, null, root);
      if (changed.length > 0 || gone.length > 0) cache.delete(root);
      log.info('mappa del codice aggiornata', { root, files: entries.length, changed: changed.length, removed: gone.length, ms: now() - started });
    } catch (err) {
      // Database già chiuso dall'arresto del core: niente da registrare.
      if (closed) return rowToRoot(undefined, root, false, false);
      q.fail.run(now(), `errore: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), root);
      log.warn('mappa del codice non aggiornata', { root, err: err instanceof Error ? err.message : String(err) });
    }
    return rowToRoot(q.root.get(root), root, false, inUse().has(root));
  };

  const scan = (raw: string): Promise<CodeRoot> => {
    const root = norm(raw);
    const current = running.get(root);
    if (current) return current;
    const job = runScan(root).finally(() => running.delete(root));
    running.set(root, job);
    return job;
  };

  const ensureFresh = (raw: string): void => {
    const root = norm(raw);
    if (closed || running.has(root)) return;
    const row = q.root.get(root);
    if (row && Number(row.enabled) !== 1) return;
    const last = row && row.scanned_at !== null && row.scanned_at !== undefined ? Number(row.scanned_at) : 0;
    if (now() - last < CODEMAP_LIMITS.rescanMs) return;
    scan(root).catch((err: unknown) => log.warn('mappa del codice non aggiornata', { root, err: err instanceof Error ? err.message : String(err) }));
  };

  return {
    status() {
      const using = inUse();
      const out = new Map<string, CodeRoot>();
      for (const r of q.roots.all()) {
        const root = String(r.root);
        out.set(root, rowToRoot(r, root, running.has(root), using.has(root)));
      }
      for (const root of using) if (!out.has(root)) out.set(root, rowToRoot(undefined, root, running.has(root), true));
      return [...out.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || a.root.localeCompare(b.root));
    },
    scan,
    ensureFresh,
    setEnabled(raw, enabled) {
      const root = norm(raw);
      q.ensureRoot.run(root);
      q.setEnabled.run(enabled ? 1 : 0, root);
      return rowToRoot(q.root.get(root), root, running.has(root), inUse().has(root));
    },
    forTurn(raw, text) {
      // Prima le cartelle citate nel compito (sono la richiesta esplicita), poi quella dell'agente. Una
      // cartella citata per la prima volta si indicizza ora in background: la usano i turni successivi
      // (di solito gli esecutori, dopo il piano del Director).
      const roots = [...new Set([...mentionedRoots(text), norm(raw)])];
      for (const root of roots) {
        const row = q.root.get(root);
        if (row && Number(row.enabled) !== 1) continue;
        ensureFresh(root);
        const files = load(root);
        if (files.length === 0) continue;
        const lines = renderMap(root, files.length, rankFiles(files, text));
        if (lines.length > 0) return lines;
      }
      return [];
    },
    close() {
      closed = true;
    }
  };
}

export function registerCodeMapCommands(router: CommandRouter, map: CodeMap): void {
  const known = (root: string): string => {
    const abs = resolve(root);
    if (!map.status().some((r) => r.root === abs)) throw new CommandFailure('not_found', `cartella non usata dagli agenti: ${abs}`);
    return abs;
  };
  router.register('codemap.status', () => ({ roots: map.status() }));
  router.register('codemap.scan', async (payload) => ({ root: await map.scan(known(payload.root)) }));
  router.register('codemap.set', (payload) => ({ root: map.setEnabled(known(payload.root), payload.enabled) }));
  router.register('codemap.preview', (payload) => {
    const lines = map.forTurn(known(payload.root), payload.text);
    return { text: lines.join('\n'), files: Math.max(0, lines.length - 1) };
  });
}
