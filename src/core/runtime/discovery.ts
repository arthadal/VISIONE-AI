// Individuazione delle CLI (MUNDER_CLI_RUNTIME §1): ricerca nel PATH fatta dal core (nessuna
// shell, nessun `where`), candidati noti forniti dall'adapter, shim npm `.cmd` decodificati nel
// loro eseguibile reale (mai `cmd.exe`), versione letta con un processo di prova del runtime.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, normalize } from 'node:path';

export interface ResolvedCli {
  readonly name: string;
  /** File trovato (eseguibile o shim). */
  readonly path: string;
  /** Eseguibile da avviare e argomenti da anteporre (shim npm decodificato). */
  readonly exe: string;
  readonly prefixArgs: readonly string[];
  readonly kind: 'exe' | 'npm-shim' | 'script';
  readonly version: string | null;
}

export type DiscoveryResult = ({ found: true } & ResolvedCli) | { found: false; name: string; problem: string };

export interface DiscoverOptions {
  /**
   * Percorsi assoluti provati se il PATH non contiene la CLI; come funzione, calcolati
   * dall'ambiente dato al runtime (non da quello del processo che lo ospita).
   */
  readonly candidates?: readonly string[] | ((env: Readonly<Record<string, string | undefined>>) => readonly string[]);
  /** Argomenti per leggere la versione (default `--version`); null = non leggerla. */
  readonly versionArgs?: readonly string[] | null;
  readonly refresh?: boolean;
}

export interface CliDiscovery {
  discover(name: string, opts?: DiscoverOptions): Promise<DiscoveryResult>;
  invalidate(name?: string): void;
}

export interface DiscoveryDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Esegue la CLI per la versione (processo `probe` del runtime). */
  readonly readVersion: (cli: ResolvedCli, args: readonly string[]) => Promise<string | null>;
  readonly onResult?: (result: DiscoveryResult) => void;
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function envValue(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const found = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : env[found];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Ricerca nel PATH come `where` (Munder) e come la shell: vince l'ordine delle cartelle scelto
 * dall'utente; nella stessa cartella .exe prima dello shim .cmd, poi le altre estensioni di PATHEXT.
 */
export function searchPath(name: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string[] {
  const win = platform === 'win32';
  const dirs = (envValue(env, 'PATH') ?? '').split(win ? ';' : delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const exts = win
    ? ['.exe', '.cmd', ...(envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter((e) => e && e !== '.exe' && e !== '.cmd')]
    : [''];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * Decodifica uno shim npm `.cmd` (formato generato da cmd-shim): `"%dp0%\…\cli.exe" %*` oppure
 * `"%_prog%" "%dp0%\…\cli.js" %*` con `_prog` = node accanto allo shim o node nel PATH.
 */
export function decodeNpmShim(shimPath: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): { exe: string; prefixArgs: string[] } | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const dp0 = dirname(shimPath);
  const line = text.split(/\r?\n/).reverse().find((l) => l.includes('%*'));
  if (!line) return null;
  const tokens = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '').filter((t) => !t.includes('%COMSPEC%'));
  if (tokens.length === 0) return null;
  const expand = (t: string): string => normalize(t.replaceAll('%dp0%', dp0 + '\\').replaceAll('%~dp0', dp0 + '\\'));
  const [first, ...rest] = tokens;
  if (first === '%_prog%') {
    const local = join(dp0, 'node.exe');
    const node = existsSync(local) ? local : searchPath('node', env, platform)[0];
    if (!node) return null;
    return { exe: node, prefixArgs: rest.map(expand) };
  }
  if (first === undefined || !first.includes('%dp0%')) return null;
  const exe = expand(first);
  return isAbsolute(exe) && isFile(exe) ? { exe, prefixArgs: rest.map(expand) } : null;
}

export function resolveCliFile(name: string, file: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): Omit<ResolvedCli, 'version'> | null {
  const ext = extname(file).toLowerCase();
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    const decoded = decodeNpmShim(file, env, platform);
    return decoded ? { name, path: file, exe: decoded.exe, prefixArgs: decoded.prefixArgs, kind: 'npm-shim' } : null;
  }
  if (platform === 'win32' && ext !== '.exe' && ext !== '.com') return null; // script senza interprete noto
  return { name, path: file, exe: file, prefixArgs: [], kind: 'exe' };
}

export function createCliDiscovery(deps: DiscoveryDeps): CliDiscovery {
  const platform = deps.platform ?? process.platform;
  const cache = new Map<string, DiscoveryResult>();

  return {
    async discover(name, opts = {}) {
      const cached = cache.get(name);
      if (cached && !opts.refresh) return cached;
      let result: DiscoveryResult;
      if (!SAFE_NAME.test(name)) {
        result = { found: false, name, problem: 'nome di comando non valido' };
      } else {
        const candidates = typeof opts.candidates === 'function' ? opts.candidates(deps.env) : (opts.candidates ?? []);
        const files = [...searchPath(name, deps.env, platform), ...candidates.filter((c) => isAbsolute(c) && isFile(c))];
        let resolved: Omit<ResolvedCli, 'version'> | null = null;
        for (const file of files) {
          resolved = resolveCliFile(name, file, deps.env, platform);
          if (resolved) break;
        }
        if (!resolved) {
          result = {
            found: false,
            name,
            problem: files.length > 0 ? `trovato ma non avviabile senza shell: ${files.join(', ')}` : `non trovato nel PATH né nei percorsi noti`
          };
        } else {
          const versionArgs = opts.versionArgs === undefined ? ['--version'] : opts.versionArgs;
          const version = versionArgs === null ? null : await deps.readVersion({ ...resolved, version: null }, versionArgs).catch(() => null);
          result = { found: true, ...resolved, version };
        }
      }
      cache.set(name, result);
      deps.onResult?.(result);
      return result;
    },
    invalidate(name) {
      if (name === undefined) cache.clear();
      else cache.delete(name);
    }
  };
}
