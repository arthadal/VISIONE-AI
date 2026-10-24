// Segnala un problema (11/10/2026, prima dell'uscita): con un clic il tester prepara un pacchetto da
// allegare a un'email per chi sviluppa VISIONE. Contiene la sua descrizione, le informazioni sul PC e
// sull'app, la configurazione e gli ultimi registri, ripuliti: niente chiavi né token (redazione
// condivisa), niente nome utente, percorso della home, nome del PC o indirizzi email. Il pacchetto
// resta sul PC: VISIONE non lo manda a nessuno.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, freemem, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { redactString, redactValue } from '../../shared/lib/redact.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { AuditLog } from '../audit/index.ts';
import type { CommandRouter } from '../commands/index.ts';

/** Righe di registro per file nel pacchetto: abbastanza per capire, non un archivio intero. */
export const REPORT_LOG_LINES = 3_000;
const LOG_FILES = ['core.jsonl', 'main.jsonl'] as const;

export interface PrivacyContext {
  readonly userHome: string;
  readonly userName: string;
  readonly computerName: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Testo ripulito: segreti redatti, poi home dell'utente → %USERPROFILE% (con \ o / e anche in JSON,
 * dove la barra è raddoppiata), nome utente → <utente>, nome del PC → <pc>, email → <email>.
 */
export function anonymize(text: string, ctx: PrivacyContext): string {
  let out = redactString(text);
  const home = ctx.userHome.replace(/[\\/]+$/, '');
  if (home.length > 3) {
    const parts = home.split(/[\\/]+/).map(escape);
    out = out.replace(new RegExp(parts.join('(?:\\\\\\\\|\\\\|/)'), 'gi'), '%USERPROFILE%');
    // Anche dentro gli indirizzi codificati (anteprime dell'Esplora: «C%3A%5CUsers%5CMario»).
    const encoded = home.split(/[\\/]+/).map((p) => escape(encodeURIComponent(p)));
    out = out.replace(new RegExp(encoded.join('(?:%5C|%2F)'), 'gi'), '%USERPROFILE%');
  }
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  // Prima il nome del PC: spesso contiene quello dell'utente («PC-DI-MARIO»). Un separatore codificato
  // (%5C, %2F) conta come confine di parola.
  for (const [value, mark] of [[ctx.computerName, '<pc>'], [ctx.userName, '<utente>']] as const) {
    if (value.trim().length >= 3) out = out.replace(new RegExp(`(?<=^|[^A-Za-z0-9]|%5C|%2F)${escape(value)}(?![A-Za-z0-9])`, 'gi'), mark);
  }
  return out;
}

/** Le ultime `n` righe non vuote. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(Math.max(0, lines.length - n));
}

/** Nome del pacchetto: «segnalazione-AAAAMMGG-HHMMSS» nell'ora locale. */
export function reportName(now: number): string {
  const d = new Date(now);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `segnalazione-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

type ZipFn = (sourceDir: string, zipFile: string) => Promise<boolean>;

/** Compressione con PowerShell; i percorsi passano in variabili d'ambiente, mai nella riga di comando. */
const zipWithPowerShell: ZipFn = (sourceDir, zipFile) =>
  new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:VISIONE_ZIP_SRC -DestinationPath $env:VISIONE_ZIP_DST -Force'], {
      windowsHide: true, timeout: 120_000, env: { ...process.env, VISIONE_ZIP_SRC: sourceDir, VISIONE_ZIP_DST: zipFile }
    }, (err) => resolve(!err && existsSync(zipFile)));
  });

export interface SupportDeps {
  readonly visionHome: string;
  readonly logsDir: string;
  readonly privacy: PrivacyContext;
  readonly app: Readonly<Record<string, unknown>>;
  /** Stato al momento (agenti, errori…) e configurazione: si ripuliscono qui. */
  readonly snapshot: () => Readonly<Record<string, unknown>>;
  readonly config: () => unknown;
  readonly audit: AuditLog;
  readonly log: Logger;
  readonly now?: () => number;
  readonly zip?: ZipFn;
}

export interface SupportReport { folder: string; file: string; zipped: boolean; files: string[] }

export function createSupport(deps: SupportDeps): { report(note: string, by: string): Promise<SupportReport> } {
  const now = deps.now ?? Date.now;
  const zip = deps.zip ?? zipWithPowerShell;
  const clean = (text: string): string => anonymize(text, deps.privacy);
  return {
    async report(note, by) {
      const dir = join(deps.visionHome, 'segnalazioni');
      const name = reportName(now());
      const folder = join(dir, name);
      mkdirSync(folder, { recursive: true });
      const files: string[] = [];
      const write = (file: string, text: string): void => { writeFileSync(join(folder, file), text, 'utf8'); files.push(file); };
      write('descrizione.txt', `${clean(note.trim() || '(nessuna descrizione)')}\n`);
      const info = {
        creata: new Date(now()).toISOString(),
        app: deps.app,
        sistema: {
          windows: release(), processore: cpus()[0]?.model ?? 'sconosciuto', core: cpus().length,
          memoriaGB: Math.round(totalmem() / 1e8) / 10, liberaGB: Math.round(freemem() / 1e8) / 10,
          lingua: Intl.DateTimeFormat().resolvedOptions().locale
        },
        stato: redactValue(deps.snapshot()),
        configurazione: redactValue(deps.config())
      };
      write('informazioni.json', `${clean(JSON.stringify(info, null, 2))}\n`);
      for (const file of LOG_FILES) {
        const path = join(deps.logsDir, file);
        if (!existsSync(path)) continue;
        try {
          write(file, `${tailLines(readFileSync(path, 'utf8'), REPORT_LOG_LINES).map(clean).join('\n')}\n`);
        } catch (err) {
          deps.log.warn('registro non leggibile per la segnalazione', { file, err });
        }
      }
      const zipFile = `${folder}.zip`;
      const zipped = await zip(folder, zipFile);
      deps.audit.record({ actor: by, action: 'support.report', subject: name, decision: 'done', detail: zipped ? 'zip' : 'cartella' });
      return { folder, file: zipped ? zipFile : folder, zipped, files };
    }
  };
}

export function registerSupportCommands(router: CommandRouter, support: ReturnType<typeof createSupport>): void {
  router.register('support.report', (payload, ctx) => support.report(payload.note, `owner:${ctx.command.issuedBy}`));
}
