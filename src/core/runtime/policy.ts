// Policy del runtime: ultimo controllo prima di creare un processo (VISIONE_SECURITY_MODEL §1-2).
// La UI non arriva mai qui con un comando proprio: eseguibile e argomenti li costruisce il core
// (adapter), e anche il core può avviare solo eseguibili consentiti in cartelle consentite.
import { isAbsolute, relative, resolve } from 'node:path';
import { runtimeError, type RuntimeError } from '../../shared/contracts/index.ts';

/** Limite prudente sotto i 32.767 caratteri della riga di comando di Windows. */
export const MAX_COMMAND_LINE = 30_000;

export interface PolicySpec {
  readonly exe: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RuntimePolicy {
  check(spec: PolicySpec): { ok: true } | { ok: false; error: RuntimeError };
  /** Consente un eseguibile (scoperto dalla discovery o configurato dal core). */
  allowExecutable(path: string): void;
  /** Consente una radice di lavoro (workspace di un agente, cartelle di sistema di VISIONE). */
  allowRoot(path: string): void;
  readonly executables: readonly string[];
  readonly roots: readonly string[];
}

export function createRuntimePolicy(opts: { executables?: readonly string[]; roots?: readonly string[]; platform?: NodeJS.Platform } = {}): RuntimePolicy {
  const win = (opts.platform ?? process.platform) === 'win32';
  const norm = (p: string): string => {
    const r = resolve(p);
    return win ? r.toLowerCase() : r;
  };
  const executables = new Map<string, string>();
  const roots = new Map<string, string>();
  for (const e of opts.executables ?? []) executables.set(norm(e), resolve(e));
  for (const r of opts.roots ?? []) roots.set(norm(r), resolve(r));

  const inside = (dir: string): boolean => {
    const d = norm(dir);
    for (const root of roots.keys()) {
      const rel = relative(root, d);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
    }
    return false;
  };

  return {
    check(spec) {
      const deny = (message: string) => ({ ok: false as const, error: runtimeError('policy_denied', message) });
      const invalid = (message: string) => ({ ok: false as const, error: runtimeError('invalid_spec', message) });
      if (!isAbsolute(spec.exe)) return invalid('l\'eseguibile deve essere un percorso assoluto risolto dalla discovery');
      if (!isAbsolute(spec.cwd)) return invalid('la cartella di lavoro deve essere un percorso assoluto');
      for (const value of [spec.exe, spec.cwd, ...spec.args]) {
        if (typeof value !== 'string' || value.includes('\0')) return invalid('argomento con carattere NUL o non testuale');
      }
      for (const [key, value] of Object.entries(spec.env)) {
        if (key.includes('\0') || key.includes('=') || typeof value !== 'string' || value.includes('\0')) {
          return invalid(`variabile d'ambiente non valida: ${key.slice(0, 40)}`);
        }
      }
      const length = spec.exe.length + spec.args.reduce((n, a) => n + a.length + 3, 0);
      if (length > MAX_COMMAND_LINE) {
        return invalid(`riga di comando di ${length} caratteri (massimo ${MAX_COMMAND_LINE}): passare i testi lunghi via file`);
      }
      if (!executables.has(norm(spec.exe))) return deny(`eseguibile non consentito: ${spec.exe}`);
      if (!inside(spec.cwd)) return deny(`cartella di lavoro fuori dalle radici consentite: ${spec.cwd}`);
      return { ok: true };
    },
    allowExecutable(path) {
      executables.set(norm(path), resolve(path));
    },
    allowRoot(path) {
      roots.set(norm(path), resolve(path));
    },
    get executables() {
      return [...executables.values()];
    },
    get roots() {
      return [...roots.values()];
    }
  };
}
