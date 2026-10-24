// Adapter `pty-generic` (VISIONE_AGENT_ARCHITECTURE §7, DECISIONI P-45): qualsiasi CLI locale scelta dal
// proprietario, in un PTY del CLI Runtime. Solo `turns.interactive` e `terminal.input`: stato dal
// processo vivo o uscito, nessun evento di strumento, nessuna logica di dominio basata sull'uscita.
// Un turno = il testo scritto nel PTY (righe confermate con Invio); il turno si chiude quando il testo
// è consegnato. Il risultato si legge nella vista Terminale.
//
// Definizione: `engine.options = { command: "<nome nel PATH o percorso assoluto>", args?: string[] }`.
import { existsSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import { isTerminalProcessStatus, runtimeError, type AgentCapability } from '../../../shared/contracts/index.ts';
import { ulid } from '../../../shared/lib/ulid.ts';
import type { ManagedProcess } from '../../runtime/index.ts';
import type { AdapterContext, AgentAdapter, TurnOutcome } from '../index.ts';
import { AdapterError } from '../errors.ts';

export const PTY_GENERIC_ID = 'pty-generic';
const CAPABILITIES: ReadonlySet<AgentCapability> = new Set(['turns.interactive', 'terminal.input']);
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const START_WAIT_MS = 15_000;

interface Options {
  command: string;
  args: string[];
}

function optionsOf(options: Record<string, unknown> | undefined): { ok: true; value: Options } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const command = options?.command;
  const args = options?.args ?? [];
  if (typeof command !== 'string' || command.length === 0 || command.length > 260) problems.push('engine.options.command: nome o percorso assoluto della CLI (al più 260 caratteri)');
  else if (!isAbsolute(command) && !NAME.test(command)) problems.push('engine.options.command: un nome semplice (cercato nel PATH) o un percorso assoluto');
  if (!Array.isArray(args) || args.length > 20 || args.some((a) => typeof a !== 'string' || a.length > 500 || a.includes('\0'))) {
    problems.push('engine.options.args: al più 20 argomenti testuali di 500 caratteri');
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { command: command as string, args: args as string[] } };
}

export function createPtyGenericAdapter(): AgentAdapter & { attach(runtime: AdapterContext['runtime']): void } {
  const sessions = new Map<string, ManagedProcess>();

  const resolve = async (ctx: AdapterContext, command: string): Promise<{ exe: string; prefixArgs: readonly string[] }> => {
    if (isAbsolute(command)) {
      if (!existsSync(command) || !statSync(command).isFile()) throw new AdapterError(runtimeError('not_found', `CLI non trovata: ${command}`));
      // Scelta esplicita del proprietario nella definizione dell'agente (auditata): eseguibile consentito.
      ctx.runtime.policy.allowExecutable(command);
      return { exe: command, prefixArgs: [] };
    }
    const found = await ctx.runtime.discovery.discover(command, { versionArgs: null });
    if (!found.found) throw new AdapterError(runtimeError('not_found', `CLI non trovata: ${found.problem}`));
    return found;
  };

  const adapter: AgentAdapter & { attach(runtime: AdapterContext['runtime']): void } = {
    id: PTY_GENERIC_ID,
    capabilities: CAPABILITIES,
    attach() {
      // nessuno stato condiviso: la CLI dipende dalla definizione di ogni agente
    },
    async probe() {
      // Il motore è la CLI di ciascun agente: si verifica all'avvio dell'istanza.
      return { available: true, problems: [] };
    },
    validate(def) {
      if (def.engine.adapter !== PTY_GENERIC_ID) return { ok: false, problems: ['adapter diverso'] };
      const o = optionsOf(def.engine.options);
      return o.ok ? { ok: true } : { ok: false, problems: o.problems };
    },
    /** Una CLI generica non ha un catalogo modelli (P-83): mai scelta per un modello esplicito. */
    supportsModel() {
      return false;
    },
    async start(ctx) {
      const o = optionsOf(ctx.definition.engine.options);
      if (!o.ok) throw new AdapterError(runtimeError('invalid_spec', o.problems.join('; ')));
      if (sessions.has(ctx.instance.id)) throw new AdapterError(runtimeError('invalid_spec', 'istanza già avviata'));
      const cli = await resolve(ctx, o.value.command);
      const sessionId = ulid();
      const started = ctx.runtime.start({
        exe: cli.exe, args: [...cli.prefixArgs, ...o.value.args], cwd: ctx.workspaceDir,
        env: ctx.runtime.env(ctx.workspaceDir, { visione: { VISIONE_AGENT_ID: ctx.instance.agentId, VISIONE_AGENT_DIR: ctx.agentDir } }),
        io: 'pty', pty: { cols: 120, rows: 32 }, kind: 'agent-session',
        owner: { agentId: ctx.instance.agentId, sessionId, adapter: PTY_GENERIC_ID }, correlationId: ulid(), gracefulStop: 'ctrl-c'
      });
      if (!started.ok) throw new AdapterError(started.error);
      const p = started.process;
      // Il PTY si apre in modo asincrono: l'istanza è pronta solo con il processo avviato.
      for (let waited = 0; p.status !== 'running'; waited += 20) {
        if (isTerminalProcessStatus(p.status)) {
          const r = await p.done;
          throw new AdapterError(r.error ?? runtimeError('crashed', `la CLI è uscita all'avvio (${r.status})`));
        }
        if (waited >= START_WAIT_MS || ctx.signal.aborted) {
          await ctx.runtime.stop(p.id, { mode: 'force', reason: 'avvio non concluso' });
          throw new AdapterError(runtimeError('timeout', `la CLI non si è avviata entro ${START_WAIT_MS} ms`));
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      sessions.set(ctx.instance.id, p);
      void p.done.then((r) => {
        sessions.delete(ctx.instance.id);
        ctx.emit({ kind: 'process.exited', exit: r.status === 'exited' ? 'clean' : r.status === 'crashed' ? 'crashed' : r.status === 'stopped' || r.status === 'cancelled' ? 'killed' : 'error', ...(r.exitCode === null ? {} : { code: r.exitCode }), tail: r.tail });
      });
      ctx.log.info('CLI generica avviata nel PTY', { exe: basename(cli.exe, extname(cli.exe)) });
      return { id: sessionId, engineSessionId: '', adapter: PTY_GENERIC_ID, startedAt: Date.now(), resumable: false };
    },
    async sendTurn(ctx, input): Promise<TurnOutcome> {
      ctx.emit({ kind: 'turn.started', turnId: input.turnId });
      const p = sessions.get(ctx.instance.id);
      const fail = (message: string): TurnOutcome => {
        const error = runtimeError('crashed', message);
        ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome: 'failed', error });
        return { outcome: 'failed', error, engineSessionId: null };
      };
      if (!p) return fail('la CLI non è in esecuzione');
      // Ogni riga confermata con Invio, come se la digitasse il proprietario.
      const r = p.write(`${input.text.replace(/\r?\n/g, '\r')}\r`);
      if (!r.ok) return fail(r.error.message);
      ctx.emit({ kind: 'message.text', turnId: input.turnId, text: 'testo consegnato alla CLI: l\'esito si legge nel terminale', final: true });
      ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome: 'completed' });
      return { outcome: 'completed', error: null, engineSessionId: null };
    },
    async cancelTurn() {
      // il turno termina alla consegna del testo: niente da annullare
    },
    async stop(ctx, mode) {
      const p = sessions.get(ctx.instance.id);
      if (p) await ctx.runtime.stop(p.id, { mode, reason: 'stop dell\'agente' });
    }
  };
  return adapter;
}
