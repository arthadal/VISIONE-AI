// Terminale come vista (VISIONE_ARCHITECTURE §18, DECISIONI P-45). Nessun processo nuovo fuori dal
// CLI Runtime: le sessioni sono i processi PTY del runtime (shell aperte dal proprietario, sessioni
// degli agenti). L'uscita non si duplica: è `process.stdout` (flusso `pty`) sul bus; qui si tiene solo
// uno scrollback limitato per chi apre la vista dopo. L'uscita di un terminale non è mai fonte di
// stato di dominio. Input e ridimensionamento solo per le sessioni interattive.
import { basename, join } from 'node:path';
import {
  isTerminalProcessStatus,
  TERMINAL_LIMITS,
  type ProcessInfo,
  type ProcessOwner,
  type TerminalSession
} from '../../shared/contracts/index.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { AuditLog } from '../audit/index.ts';
import type { EventBus } from '../bus/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';
import type { CliRuntime } from '../runtime/index.ts';

export interface ShellSpec {
  readonly exe: string;
  readonly args: readonly string[];
}

export interface TerminalManagerDeps {
  runtime: CliRuntime;
  bus: EventBus;
  events: EventEmitter;
  audit: AuditLog;
  log: Logger;
  /** Cartella di lavoro delle shell (dentro le radici del runtime). */
  cwd: string;
  /** Il proprietario può scrivere nel PTY di questo processo d'agente (capacità `terminal.input`). */
  inputAllowed(owner: ProcessOwner): boolean;
  /**
   * Chiusura di una sessione PTY di un agente dalla vista Terminale (P-94): passa dall'Agent Manager
   * (transizione `stopping`→`stopped`, nessun «crash» e nessun processo orfano). Assente o `false`
   * (agente già non vivo): il processo viene comunque terminato direttamente dal runtime.
   */
  stopAgentSession?: (agentId: string, reason: string, correlationId: string) => Promise<boolean>;
  /** Shell del proprietario (default: PowerShell di Windows trovata dalla discovery). */
  resolveShell?: () => Promise<ShellSpec | null>;
}

export interface TerminalManager {
  list(): TerminalSession[];
  /**
   * Shell del proprietario; con `command`, quel programma al posto della shell (P-105: accesso a un
   * motore avviato senza passare da PowerShell, che blocca gli script `.ps1` con il criterio predefinito).
   */
  open(opts: { cols: number; rows: number; by: string; correlationId: string; command?: { exe: string; args: readonly string[] } }): Promise<TerminalSession>;
  /** La shell di sistema (PowerShell trovata dalla discovery, quindi consentita dalla policy): serve a «Installa». */
  shell(): Promise<ShellSpec | null>;
  input(processId: string, data: string): number;
  resize(processId: string, cols: number, rows: number): boolean;
  snapshot(processId: string): { session: TerminalSession; text: string; truncated: boolean; seq: number };
  close(processId: string, by: string, correlationId: string): Promise<boolean>;
  dispose(): void;
}

interface Scroll {
  text: string;
  truncated: boolean;
  seq: number;
}

const SOURCE = { kind: 'visione', id: 'terminal' } as const;

export function createTerminalManager(deps: TerminalManagerDeps): TerminalManager {
  const { runtime, events, audit, log } = deps;
  const scrolls = new Map<string, Scroll>();
  const shells = new Set<string>();

  const defaultShell = async (): Promise<ShellSpec | null> => {
    const found = await runtime.discovery.discover('powershell', {
      candidates: (env) => [join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
      versionArgs: null
    });
    return found.found ? { exe: found.exe, args: [...found.prefixArgs, '-NoLogo'] } : null;
  };

  // Scrollback dai blocchi già pubblicati dal runtime: nessuna seconda copia dell'uscita sul bus.
  const sub = deps.bus.subscribe((e) => {
    const p = e.payload as { processId?: string; seq?: number; text?: string; stream?: string };
    if (e.type !== 'process.stdout' || p.stream !== 'pty' || typeof p.processId !== 'string') return;
    const s = scrolls.get(p.processId) ?? { text: '', truncated: false, seq: 0 };
    s.text += p.text ?? '';
    if (s.text.length > TERMINAL_LIMITS.scrollbackChars) {
      s.text = s.text.slice(-TERMINAL_LIMITS.scrollbackChars);
      s.truncated = true;
    }
    s.seq = Math.max(s.seq, p.seq ?? 0);
    scrolls.set(p.processId, s);
    // Le sessioni terminate restano consultabili solo in numero limitato.
    if (scrolls.size > 64) {
      const ended = runtime.list().filter((x) => x.io === 'pty' && x.endedAt !== null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
      for (const x of ended.slice(TERMINAL_LIMITS.keptClosed)) scrolls.delete(x.id);
    }
  }, { name: 'terminal', filter: { types: ['process.stdout'] } });

  const toSession = (p: ProcessInfo): TerminalSession => {
    const shell = shells.has(p.id);
    return {
      processId: p.id, kind: p.kind, owner: p.owner, status: p.status,
      interactive: shell || (p.kind === 'agent-session' && deps.inputAllowed(p.owner)),
      title: shell ? `shell · ${basename(p.exe)}` : p.owner.agentId ? `agente ${p.owner.agentId}` : basename(p.exe),
      createdAt: p.createdAt, endedAt: p.endedAt
    };
  };

  const ptyProcesses = (): ProcessInfo[] => {
    const all = runtime.list().filter((p) => p.io === 'pty');
    const live = all.filter((p) => !isTerminalProcessStatus(p.status));
    const ended = all.filter((p) => isTerminalProcessStatus(p.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, TERMINAL_LIMITS.keptClosed);
    return [...live, ...ended].sort((a, b) => a.createdAt - b.createdAt);
  };

  const find = (processId: string): ProcessInfo => {
    const p = runtime.list().find((x) => x.id === processId && x.io === 'pty');
    if (!p) throw new CommandFailure('not_found', `sessione di terminale sconosciuta: ${processId}`);
    return p;
  };

  const interactive = (processId: string): ProcessInfo => {
    const p = find(processId);
    if (!toSession(p).interactive) throw new CommandFailure('forbidden', 'sessione in sola lettura: la guida il suo adapter');
    if (isTerminalProcessStatus(p.status)) throw new CommandFailure('operation_failed', `sessione terminata (${p.status})`);
    return p;
  };

  return {
    list: () => ptyProcesses().map(toSession),

    async open({ cols, rows, by, correlationId, command }) {
      const liveShells = [...shells].filter((id) => {
        const p = runtime.get(id);
        return p !== undefined && !isTerminalProcessStatus(p.status);
      });
      if (liveShells.length >= TERMINAL_LIMITS.maxShells) throw new CommandFailure('operation_failed', `già ${TERMINAL_LIMITS.maxShells} shell aperte`);
      const shell = command ?? (await (deps.resolveShell ?? defaultShell)());
      if (!shell) throw new CommandFailure('operation_failed', 'nessuna shell disponibile su questo sistema');
      const started = runtime.start({
        exe: shell.exe, args: [...shell.args], cwd: deps.cwd, env: runtime.env(deps.cwd), io: 'pty', pty: { cols, rows },
        kind: 'terminal', owner: {}, correlationId, gracefulStop: 'none'
      });
      if (!started.ok) throw new CommandFailure('operation_failed', `shell non avviata: ${started.error.message}`.slice(0, 2_000));
      const p = started.process;
      shells.add(p.id);
      const session = toSession(p.info());
      audit.record({ actor: by, action: 'terminal.open', subject: p.id, decision: 'done', detail: session.title, correlationId });
      events.emit('terminal.session.opened', { processId: p.id, title: session.title, by }, { source: SOURCE, target: { kind: 'terminal', id: p.id }, correlationId });
      void p.done.then((r) => {
        events.emit('terminal.session.closed', { processId: p.id, status: r.status, exitCode: r.exitCode }, { source: SOURCE, target: { kind: 'terminal', id: p.id }, correlationId });
      });
      log.info('shell aperta', { processId: p.id, exe: basename(shell.exe) });
      return session;
    },

    input(processId, data) {
      const p = interactive(processId);
      const r = runtime.get(p.id)?.write(data);
      if (!r?.ok) throw new CommandFailure('operation_failed', r ? r.error.message : 'processo non più controllato');
      return Buffer.byteLength(data, 'utf8');
    },

    resize(processId, cols, rows) {
      // Il ridimensionamento non è input: vale anche per le sessioni in sola lettura degli agenti. Senza, la
      // TUI del motore restava a 120 colonne in una finestra di ~55 e i ridisegni si sovrapponevano (17/10/2026).
      const p = find(processId);
      if (isTerminalProcessStatus(p.status)) throw new CommandFailure('operation_failed', `sessione terminata (${p.status})`);
      const r = runtime.get(p.id)?.resize(cols, rows);
      return r?.ok ?? false;
    },

    snapshot(processId) {
      const p = find(processId);
      const s = scrolls.get(processId);
      // Nessun blocco ancora ricevuto dal bus: la coda tenuta dal processo stesso.
      const text = s?.text ?? runtime.get(processId)?.tail() ?? '';
      return { session: toSession(p), text, truncated: s?.truncated ?? false, seq: s?.seq ?? 0 };
    },

    async close(processId, by, correlationId) {
      const p = find(processId);
      if (isTerminalProcessStatus(p.status)) return false;
      const agentId = shells.has(processId) ? null : p.owner.agentId;
      // P-94: il × di una scheda termina la sessione. Per una shell si ferma il processo; per la
      // sessione di un agente si passa dall'Agent Manager (stato `stopped`, nessun «processo del motore
      // terminato» e nessun turno appeso). Un processo d'agente orfano (istanza non più viva) si ferma
      // comunque qui: la scheda non resta mai viva senza il suo agente.
      audit.record({ actor: by, action: 'terminal.close', subject: processId, decision: 'done', detail: agentId ?? '', correlationId });
      if (agentId && deps.stopAgentSession) {
        const reason = `sessione terminale chiusa (${by})`;
        const stopped = await deps.stopAgentSession(agentId, reason, correlationId);
        if (stopped) return true;
      }
      await runtime.stop(processId, { mode: 'force', reason: `terminale chiuso (${by})` });
      return true;
    },

    shell: () => (deps.resolveShell ?? defaultShell)(),

    dispose() {
      sub.unsubscribe();
    }
  };
}

export function registerTerminalCommands(deps: { router: CommandRouter; terminal: TerminalManager }): void {
  const { router, terminal } = deps;
  router.register('terminal.list', () => ({ sessions: terminal.list() }));
  router.register('terminal.open', async (p, ctx) => ({
    session: await terminal.open({ cols: p.cols, rows: p.rows, by: `owner:${ctx.command.issuedBy}`, correlationId: ctx.command.correlationId || ulid() })
  }));
  router.register('terminal.input', (p) => ({ bytes: terminal.input(p.processId, p.data) }));
  router.register('terminal.resize', (p) => ({ resized: terminal.resize(p.processId, p.cols, p.rows) }));
  router.register('terminal.snapshot', (p) => terminal.snapshot(p.processId));
  router.register('terminal.close', async (p, ctx) => ({ closed: await terminal.close(p.processId, `owner:${ctx.command.issuedBy}`, ctx.command.correlationId) }));
}
