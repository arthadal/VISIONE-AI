// File Manager (Fase 24b, P-72): filesystem REALE, sempre dentro radici consentite.
// Politica: si legge e si scrive solo sotto la home dell'utente e sotto la home di VISIONE; le
// radici protette (progetti esterni: Munder/vecchio JARVIS) sono in negazione assoluta. Nessuna
// shell: solo fs di Node; l'apertura usa `explorer.exe` (associazione predefinita di Windows).
// Ogni mutazione emette un evento durevole e una riga di audit; il resto sono errori reali.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, cpSync, lstatSync, mkdirSync, opendirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { Language } from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { AuditLog } from '../audit/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly size: number | null;
  readonly modifiedAt: number | null;
}

export interface FileRoot {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
}

type RunFn = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;
type StartFn = (file: string, args: readonly string[]) => ChildProcess;

export interface FileManagerDeps {
  readonly home: string;
  readonly visionHome: string;
  readonly protectedRoots: readonly string[];
  readonly events: EventEmitter;
  readonly audit: AuditLog;
  readonly log: Logger;
  /** Lingua di VISIONE (P-108): nomi delle cartelle note. */
  readonly language?: () => Language;
  readonly run?: RunFn;
  readonly start?: StartFn;
  /** Esplora (11/10/2026): sposta nel Cestino di Windows; true se il comando è riuscito. Iniettabile nei test. */
  readonly recycle?: (paths: readonly string[]) => Promise<boolean>;
}

/** Anteprima di testo (Esplora): al più 256 KiB letti, mai un binario. */
export const PREVIEW_TEXT_BYTES = 256 * 1024;

/** Cestino di Windows senza shell: i percorsi viaggiano in una variabile d'ambiente JSON, mai nella riga di comando. */
const RECYCLE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$list = $env:VISIONE_TRASH_JSON | ConvertFrom-Json',
  "foreach ($p in $list) { if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }"
].join('; ');

function recycleWithPowerShell(paths: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], {
      windowsHide: true, timeout: 120_000, env: { ...process.env, VISIONE_TRASH_JSON: JSON.stringify(paths) }
    }, (err) => resolve(!err));
  });
}

/** «nome (2).ext», «nome (3).ext»…: il primo nome libero nella cartella (mai sovrascrivere). */
/**
 * Ciò che Esplora risorse di Windows non mostra (attributi nascosto/sistema): file di configurazione
 * delle cartelle, cache delle miniature, profilo del registro, file temporanei di Office, AppData.
 */
const SYSTEM_NAMES = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', '$recycle.bin', 'system volume information', 'appdata', 'ntuser.ini', 'ntuser.pol']);
export function isSystemClutter(name: string): boolean {
  const n = name.toLowerCase();
  return SYSTEM_NAMES.has(n) || n.startsWith('ntuser.dat') || n.startsWith('~$');
}

export function freeName(exists: (name: string) => boolean, name: string): string {
  if (!exists(name)) return name;
  const ext = extname(name); // «.txt», oppure vuoto (anche per «.gitignore»)
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  for (let n = 2; n < 1_000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new CommandFailure('operation_failed', `troppi file con lo stesso nome: ${name.slice(0, 80)}`);
}

export interface FileManager {
  roots(): Promise<FileRoot[]>;
  /** `hidden`: mostra anche ciò che Esplora risorse di Windows nasconde (file di sistema, AppData). */
  list(path: string, hidden?: boolean): { path: string; parent: string | null; entries: FileEntry[] };
  mkdir(path: string, name: string, by: string): { path: string };
  rename(path: string, newName: string, by: string): { from: string; to: string };
  remove(path: string, recursive: boolean, by: string): { path: string; kind: 'file' | 'directory'; recursive: boolean };
  open(path: string, by: string): Promise<{ path: string; opened: boolean }>;
  search(root: string, query: string, limit: number): { results: Array<{ name: string; path: string; kind: 'file' | 'directory' }> };
  /** Nel Cestino (recuperabile): l'eliminazione dell'Esplora. */
  trash(paths: readonly string[], by: string): Promise<{ trashed: string[]; failed: string[] }>;
  copy(paths: readonly string[], toDir: string, by: string): { done: Array<{ from: string; to: string }> };
  move(paths: readonly string[], toDir: string, by: string): { done: Array<{ from: string; to: string }> };
  /** Testo per l'anteprima (≤ 256 KiB; un binario è rifiutato). */
  read(path: string): { path: string; text: string; truncated: boolean; size: number };
}

const INVALID_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
const MAX_DEPTH = 3;

/** Nomi inglesi delle cartelle note (P-108). */
const ROOT_NAMES_EN: Readonly<Record<string, string>> = {
  desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', music: 'Music', videos: 'Videos', home: 'Profile'
};

export function createFileManager(deps: FileManagerDeps): FileManager {
  const canon = (p: string): string => {
    const abs = normalize(resolve(p));
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const inside = (root: string, p: string): boolean => {
    const r = canon(root);
    const f = canon(p);
    return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep);
  };
  const label = (p: string): string => normalize(p).slice(0, 300);
  const safeExists = (p: string): boolean => {
    try {
      return lstatSync(p) !== undefined;
    } catch {
      return false;
    }
  };

  const run: RunFn =
    deps.run ??
    ((file, args, timeout) =>
      new Promise((resolve) => {
        execFile(file, [...args], { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
          resolve({ code, stdout: String(stdout ?? '') });
        });
      }));
  const start: StartFn =
    deps.start ??
    ((file, args) => spawn(file, [...args], { windowsHide: false, detached: true, stdio: 'ignore' }));

  /** Verifica di policy: dentro le radici consentite, fuori da quelle protette. */
  const checkAllowed = (p: string): string => {
    if (!isAbsolute(p)) throw new CommandFailure('invalid_payload', `percorso non assoluto: ${label(p)}`);
    if (!inside(deps.home, p) && !inside(deps.visionHome, p)) {
      throw new CommandFailure('forbidden', `percorso fuori dalle radici consentite: ${label(p)}`);
    }
    for (const root of deps.protectedRoots) {
      if (inside(root, p)) throw new CommandFailure('forbidden', `percorso protetto: ${label(p)}`);
    }
    return normalize(resolve(p));
  };

  const validateName = (name: string): string => {
    const n = name.trim();
    if (n === '' || n.length > 255 || INVALID_NAME.test(n) || n === '.' || n === '..') {
      throw new CommandFailure('invalid_payload', `nome non valido: ${name.slice(0, 80)}`);
    }
    return n;
  };

  const kindOf = (p: string): 'file' | 'directory' => (lstatSync(p).isDirectory() ? 'directory' : 'file');

  const readRoots = async (): Promise<FileRoot[]> => {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'",
      "[pscustomobject]@{ desktop=[Environment]::GetFolderPath('Desktop'); documents=[Environment]::GetFolderPath('MyDocuments');",
      "downloads=[Environment]::ExpandEnvironmentVariables($p.'{374DE290-123F-4565-9164-39C4925E467B}');",
      "pictures=[Environment]::GetFolderPath('MyPictures'); music=[Environment]::GetFolderPath('MyMusic'); videos=[Environment]::GetFolderPath('MyVideos') } | ConvertTo-Json -Compress"
    ].join('; ');
    const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8_000);
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(res.stdout.trim() === '' ? '{}' : res.stdout) as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const defs: Array<[string, string, string]> = [
      ['desktop', 'Desktop', 'desktop'],
      ['documents', 'Documenti', 'documents'],
      ['downloads', 'Download', 'downloads'],
      ['pictures', 'Immagini', 'pictures'],
      ['music', 'Musica', 'music'],
      ['videos', 'Video', 'videos']
    ];
    // (I nomi qui sono quelli italiani: `roots()` li sostituisce con quelli della lingua di VISIONE.)
    const out: FileRoot[] = [];
    for (const [id, name, key] of defs) {
      const v = raw[key];
      if (typeof v !== 'string' || v === '') continue;
      const path = normalize(v);
      out.push({ id, name, path, exists: safeExists(path) });
    }
    // Il profilo utente c'è sempre (l'Esplora ci naviga dentro tutto); senza PowerShell resta solo lui.
    out.push({ id: 'home', name: 'Profilo', path: deps.home, exists: safeExists(deps.home) });
    return out;
  };

  let rootCache: FileRoot[] | null = null;
  const recycle = deps.recycle ?? recycleWithPowerShell;

  /** Copia o sposta: ogni percorso dentro le radici, destinazione libera, mai una cartella dentro sé stessa. */
  const transfer = (mode: 'copy' | 'move', paths: readonly string[], toDir: string, by: string): { done: Array<{ from: string; to: string }> } => {
    const dir = checkAllowed(toDir);
    if (!safeExists(dir) || kindOf(dir) !== 'directory') throw new CommandFailure('not_found', `cartella di destinazione inesistente: ${label(dir)}`);
    const done: Array<{ from: string; to: string }> = [];
    for (const raw of paths) {
      const from = checkAllowed(raw);
      if (!safeExists(from)) throw new CommandFailure('not_found', `inesistente: ${label(from)}`);
      const kind = kindOf(from);
      if (kind === 'directory' && inside(from, dir)) throw new CommandFailure('operation_failed', `una cartella non va dentro sé stessa: ${label(from)}`);
      if (mode === 'move' && canon(dirname(from)) === canon(dir)) continue; // già lì
      const to = join(dir, freeName((n) => safeExists(join(dir, n)), basename(from)));
      checkAllowed(to);
      if (mode === 'copy') {
        cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
        deps.events.emit('file.created', { path: to, kind });
      } else {
        try {
          renameSync(from, to);
        } catch (err) {
          // Un altro disco: copia e poi rimozione dell'originale (solo dopo una copia riuscita).
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
          rmSync(from, { recursive: true, force: false });
        }
        deps.events.emit('file.renamed', { from, to, kind });
      }
      deps.audit.record({ actor: by, action: mode === 'copy' ? 'file.copy' : 'file.move', subject: from.slice(0, 200), decision: 'done', detail: `→ ${to.slice(0, 200)}` });
      done.push({ from, to });
    }
    return { done };
  };

  return {
    async roots() {
      rootCache ??= await readRoots();
      const en = deps.language?.() === 'en';
      return en ? rootCache.map((r) => ({ ...r, name: ROOT_NAMES_EN[r.id] ?? r.name })) : rootCache;
    },
    list(path, hidden = false) {
      const dir = checkAllowed(path);
      if (!safeExists(dir)) throw new CommandFailure('not_found', `cartella inesistente: ${label(dir)}`);
      if (kindOf(dir) !== 'directory') throw new CommandFailure('operation_failed', `non è una cartella: ${label(dir)}`);
      const entries: FileEntry[] = [];
      for (const name of readdirSync(dir).slice(0, 5_000)) {
        const p = join(dir, name);
        if (!hidden && isSystemClutter(name)) continue;
        try {
          let st = lstatSync(p);
          if (st.isSymbolicLink()) {
            // Collegamenti e giunzioni: si mostrano solo se portano a qualcosa di leggibile. Le giunzioni
            // storiche di Windows («Immagini», «Dati applicazioni»…) negano l'accesso: Esplora le nasconde.
            st = statSync(p);
            if (st.isDirectory()) opendirSync(p).closeSync();
          }
          const kind: 'file' | 'directory' = st.isDirectory() ? 'directory' : 'file';
          entries.push({ name, path: p, kind, size: kind === 'file' ? st.size : null, modifiedAt: Number.isFinite(st.mtimeMs) ? Math.floor(st.mtimeMs) : null });
        } catch {
          // Voce illeggibile (lock, permessi): non si inventa nulla, si salta.
        }
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'it') : a.kind === 'directory' ? -1 : 1));
      const up = dirname(dir);
      const parent = inside(deps.home, up) || inside(deps.visionHome, up) ? up : null;
      return { path: dir, parent, entries };
    },
    mkdir(path, name, by) {
      const dir = checkAllowed(path);
      const target = join(dir, validateName(name));
      checkAllowed(target);
      if (safeExists(target)) throw new CommandFailure('operation_failed', `esiste già: ${label(target)}`);
      mkdirSync(target);
      deps.events.emit('file.created', { path: target, kind: 'directory' });
      deps.audit.record({ actor: by, action: 'file.mkdir', subject: target.slice(0, 200), decision: 'done', detail: '' });
      return { path: target };
    },
    rename(path, newName, by) {
      const from = checkAllowed(path);
      if (!safeExists(from)) throw new CommandFailure('not_found', `inesistente: ${label(from)}`);
      const to = join(dirname(from), validateName(newName));
      checkAllowed(to);
      if (safeExists(to)) throw new CommandFailure('operation_failed', `esiste già: ${label(to)}`);
      const kind = kindOf(from);
      renameSync(from, to);
      deps.events.emit('file.renamed', { from, to, kind });
      deps.audit.record({ actor: by, action: 'file.rename', subject: from.slice(0, 200), decision: 'done', detail: `→ ${basename(to)}` });
      return { from, to };
    },
    remove(path, recursive, by) {
      const target = checkAllowed(path);
      if (!safeExists(target)) throw new CommandFailure('not_found', `inesistente: ${label(target)}`);
      const kind = kindOf(target);
      if (kind === 'directory' && !recursive && readdirSync(target).length > 0) {
        throw new CommandFailure('operation_failed', 'directory non vuota: serve la conferma ricorsiva');
      }
      // rmSync con `recursive:false` rifiuta le cartelle: per una cartella (vuota o confermata) si
      // usa comunque la forma ricorsiva — sicura perché il contenuto è stato verificato/confermato.
      rmSync(target, { recursive: kind === 'directory' ? true : recursive, force: false });
      deps.events.emit('file.deleted', { path: target, kind, recursive });
      deps.audit.record({ actor: by, action: 'file.delete', subject: target.slice(0, 200), decision: 'done', detail: recursive ? 'ricorsiva' : '' });
      return { path: target, kind, recursive };
    },
    async open(path, by) {
      const target = checkAllowed(path);
      if (!safeExists(target)) throw new CommandFailure('not_found', `inesistente: ${label(target)}`);
      const opened = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        try {
          const child = start('explorer.exe', [target]);
          child.once('error', () => done(false));
          child.once('spawn', () => {
            child.unref();
            done(true);
          });
        } catch {
          done(false);
        }
      });
      if (!opened) throw new CommandFailure('operation_failed', `apertura non riuscita: ${label(target)}`);
      deps.events.emit('file.opened', { path: target });
      deps.audit.record({ actor: by, action: 'file.open', subject: target.slice(0, 200), decision: 'done', detail: '' });
      return { path: target, opened: true };
    },
    search(root, query, limit) {
      const base = checkAllowed(root);
      if (!safeExists(base) || kindOf(base) !== 'directory') throw new CommandFailure('not_found', `cartella inesistente: ${label(base)}`);
      // Per parole e senza accenti (14/10/2026): «contratto affitto» trova «Contratto_Affitto_2026.pdf»,
      // «attivita» trova «attività.docx». Una parola sola si comporta come prima.
      const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const needles = fold(query).split(/\s+/).filter((w) => w.length > 0);
      const results: Array<{ name: string; path: string; kind: 'file' | 'directory' }> = [];
      const walk = (dir: string, depth: number): void => {
        if (results.length >= limit || depth > MAX_DEPTH) return;
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (results.length >= limit) return;
          const p = join(dir, name);
          try {
            if (deps.protectedRoots.some((r) => inside(r, p))) continue;
            const kind: 'file' | 'directory' = statSync(p).isDirectory() ? 'directory' : 'file';
            const folded = fold(name);
            if (needles.every((w) => folded.includes(w))) results.push({ name, path: p, kind });
            if (kind === 'directory') walk(p, depth + 1);
          } catch {
            // voce non accessibile: si salta
          }
        }
      };
      walk(base, 0);
      results.sort((a, b) => a.name.localeCompare(b.name, 'it'));
      return { results: results.slice(0, limit) };
    },
    async trash(paths, by) {
      const targets = paths.map((p) => checkAllowed(p));
      const present = targets.filter((p) => safeExists(p));
      const kinds = new Map(present.map((p) => [p, kindOf(p)] as const));
      if (present.length > 0) await recycle(present);
      // Esito REALE: è nel Cestino ciò che non c'è più al suo posto.
      const trashed = present.filter((p) => !safeExists(p));
      const failed = targets.filter((p) => !trashed.includes(p));
      for (const p of trashed) {
        deps.events.emit('file.trashed', { path: p, kind: kinds.get(p) ?? 'file' });
        deps.audit.record({ actor: by, action: 'file.trash', subject: p.slice(0, 200), decision: 'done', detail: 'Cestino' });
      }
      if (trashed.length === 0 && failed.length > 0) throw new CommandFailure('operation_failed', `niente spostato nel Cestino: ${label(failed[0]!)}`);
      return { trashed, failed };
    },
    copy(paths, toDir, by) {
      return transfer('copy', paths, toDir, by);
    },
    move(paths, toDir, by) {
      return transfer('move', paths, toDir, by);
    },
    read(path) {
      const file = checkAllowed(path);
      if (!safeExists(file)) throw new CommandFailure('not_found', `inesistente: ${label(file)}`);
      if (kindOf(file) !== 'file') throw new CommandFailure('operation_failed', `non è un file: ${label(file)}`);
      const size = statSync(file).size;
      const buf = Buffer.alloc(Math.min(size, PREVIEW_TEXT_BYTES));
      const fd = openSync(file, 'r');
      let read = 0;
      try {
        read = readSync(fd, buf, 0, buf.length, 0);
      } finally {
        closeSync(fd);
      }
      const bytes = buf.subarray(0, read);
      if (bytes.subarray(0, 8_192).includes(0)) throw new CommandFailure('operation_failed', 'file binario: nessuna anteprima di testo');
      return { path: file, text: new TextDecoder('utf-8').decode(bytes), truncated: size > read, size };
    }
  };
}

export function registerFileCommands(deps: { router: CommandRouter; files: FileManager }): void {
  const { router, files } = deps;
  router.register('files.roots', async () => ({ roots: await files.roots() }));
  router.register('files.list', (payload) => files.list(payload.path, payload.hidden === true));
  router.register('files.mkdir', (payload, ctx) => files.mkdir(payload.path, payload.name, `owner:${ctx.command.issuedBy}`));
  router.register('files.rename', (payload, ctx) => files.rename(payload.path, payload.newName, `owner:${ctx.command.issuedBy}`));
  router.register('files.delete', (payload, ctx) => files.remove(payload.path, payload.recursive, `owner:${ctx.command.issuedBy}`));
  router.register('files.open', (payload, ctx) => files.open(payload.path, `owner:${ctx.command.issuedBy}`));
  router.register('files.search', (payload) => files.search(payload.root, payload.query, payload.limit));
  router.register('files.trash', (payload, ctx) => files.trash(payload.paths, `owner:${ctx.command.issuedBy}`));
  router.register('files.copy', (payload, ctx) => files.copy(payload.paths, payload.toDir, `owner:${ctx.command.issuedBy}`));
  router.register('files.move', (payload, ctx) => files.move(payload.paths, payload.toDir, `owner:${ctx.command.issuedBy}`));
  router.register('files.read', (payload) => files.read(payload.path));
}
