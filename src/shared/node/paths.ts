// Percorsi dei dati di VISIONE, risolti a runtime (mai assoluti nel codice).
// Layout (VISIONE_ARCHITECTURE §10): <home>\config\visione.json · data\visione.db · logs\ ·
// backups\ · runtime\ (stato del main tra un avvio e l'altro, shim degli hook) · chromium\
// (profilo di Electron) · agents\<id>\ (contratto a file con ogni agente) · workspace\ (cartelle
// di lavoro predefinite degli agenti; ogni agente può averne una propria altrove).
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Migrazione una tantum PROTON → VISIONE (P-63): sposta `legacy` su `next` solo se `next` non
 * esiste. Pensata per `config\proton.json` e `data\proton.db(-wal|-shm)`. Se non si può (file in
 * uso, permessi) non lancia: si prosegue con i percorsi nuovi.
 */
function migrateLegacyPath(legacy: string, next: string): void {
  try {
    if (!existsSync(next) && existsSync(legacy)) renameSync(legacy, next);
  } catch {
    /* migrazione best-effort */
  }
}

/**
 * Migra la home storica: prima rinomina l'intera cartella (3 tentativi), poi, se una voce è
 * bloccata da un processo esterno (es. un sensore avviato dalla vecchia home), sposta le voci una a
 * una; quelle rimaste restano al loro posto e `pendingLegacyHome()` le segnala al prossimo avvio.
 */
function migrateLegacyHome(legacy: string, next: string): void {
  if (!existsSync(legacy) || existsSync(next)) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(legacy, next);
      return;
    } catch {
      /* riprova: un handle esterno può bloccare la cartella */
    }
  }
  try {
    mkdirSync(next, { recursive: true });
    for (const name of readdirSync(legacy)) {
      const to = join(next, name);
      if (existsSync(to)) continue;
      try {
        renameSync(join(legacy, name), to);
      } catch {
        /* voce ancora in uso: resta nella home storica e verrà riprovata */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Home storica `PROTON(-dev)` ancora presente (migrazione incompleta), altrimenti null. La usa il
 * main per avvisare a ogni avvio: mai fallire in silenzio (P-63).
 */
export function pendingLegacyHome(env: NodeJS.ProcessEnv, opts: HomeOptions): string | null {
  if (env.VISIONE_HOME?.trim() || env.PROTON_HOME?.trim()) return null;
  const legacy = join(opts.appDataDir, opts.packaged ? 'PROTON' : 'PROTON-dev');
  return existsSync(legacy) ? legacy : null;
}

export interface VisionePaths {
  readonly home: string;
  readonly configFile: string;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly logsDir: string;
  readonly backupsDir: string;
  readonly runtimeDir: string;
  readonly spoolFile: string;
  readonly chromiumDir: string;
  readonly agentsDir: string;
  readonly workspaceDir: string;
  readonly shimsDir: string;
}

export interface HomeOptions {
  /** Cartella dati dell'utente del sistema operativo (Electron: `app.getPath('appData')`). */
  readonly appDataDir: string;
  /** Build installata (profilo `installed`) o sviluppo (profilo `dev`). */
  readonly packaged: boolean;
}

/**
 * `VISIONE_HOME` se impostata (assoluta); per compatibilità si accetta anche il vecchio
 * `PROTON_HOME`. Altrimenti `<appData>\VISIONE(-dev)`, migrando la home storica se esiste.
 */
export function resolveHome(env: NodeJS.ProcessEnv, opts: HomeOptions): string {
  const override = env.VISIONE_HOME?.trim() || env.PROTON_HOME?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error(`VISIONE_HOME deve essere un percorso assoluto: ${override}`);
    return override;
  }
  const dir = opts.packaged ? 'VISIONE' : 'VISIONE-dev';
  const legacyDir = opts.packaged ? 'PROTON' : 'PROTON-dev';
  const home = join(opts.appDataDir, dir);
  migrateLegacyHome(join(opts.appDataDir, legacyDir), home);
  return home;
}

export function resolvePaths(home: string): VisionePaths {
  if (!isAbsolute(home)) throw new Error(`home di VISIONE non assoluta: ${home}`);
  const runtimeDir = join(home, 'runtime');
  const dataDir = join(home, 'data');
  const configFile = join(home, 'config', 'visione.json');
  const dbFile = join(dataDir, 'visione.db');
  migrateLegacyPath(join(home, 'config', 'proton.json'), configFile);
  for (const suffix of ['', '-wal', '-shm'] as const) {
    migrateLegacyPath(join(dataDir, `proton.db${suffix}`), join(dataDir, `visione.db${suffix}`));
  }
  return {
    home,
    configFile,
    dataDir,
    dbFile,
    logsDir: join(home, 'logs'),
    backupsDir: join(home, 'backups'),
    runtimeDir,
    spoolFile: join(runtimeDir, 'main-events.jsonl'),
    chromiumDir: join(home, 'chromium'),
    agentsDir: join(home, 'agents'),
    workspaceDir: join(home, 'workspace'),
    shimsDir: join(runtimeDir, 'shims')
  };
}

export function ensureDirs(paths: VisionePaths): void {
  for (const dir of [join(paths.home, 'config'), paths.dataDir, paths.logsDir, paths.backupsDir, paths.runtimeDir, paths.agentsDir, paths.workspaceDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Progetti di riferimento mai toccabili dall'interno di VISIONE (VISIONE_SECURITY_MODEL §2): il file
 * manager del core e le anteprime del main (Esplora, 11/10/2026) usano la STESSA lista.
 */
export function protectedUserRoots(userHome: string): string[] {
  return [join(userHome, 'munder-difflin'), join(userHome, 'jarvis')];
}
