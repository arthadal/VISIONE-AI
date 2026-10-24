// Modulo `engines`: comandi del CLI Runtime e dei motori (Fase 5). Flusso UI → core → policy →
// runtime → processo: la UI legge i processi, chiede lo stop di uno esistente e la verifica dei
// motori; non avvia mai un processo né sceglie un eseguibile. I motori sono visti solo come
// `AgentAdapter` generici.
// P-99: verifica di UN motore (menu del pannello MOTORI) e «Riavvia motori» — ri-verifica reale di
// tutti i motori più riavvio delle sessioni rimaste in errore, con esito e motivi onesti.
import type { EngineProbe } from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { AdapterRegistry, AgentAdapter } from '../adapters/index.ts';
import type { AgentManager } from '../agents/index.ts';
import type { AuditLog } from '../audit/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';
import type { CliRuntime } from '../runtime/index.ts';

export interface EngineRestartResult {
  probes: EngineProbe[];
  restarted: Array<{ agentId: string; ok: boolean; reason: string }>;
  failed: number;
}

/** Un adapter del registro, verificato realmente (`probe`, refresh) con errori contenuti. */
export async function probeAdapter(adapter: AgentAdapter, refresh: boolean, log: Logger): Promise<EngineProbe> {
  try {
    const probe = await adapter.probe({ refresh });
    return {
      adapter: adapter.id,
      available: probe.available,
      version: probe.version ?? null,
      path: probe.path ?? null,
      command: probe.command ?? null,
      problems: probe.problems.slice(0, 20).map((p) => p.slice(0, 500))
    };
  } catch (err) {
    log.error('verifica del motore non riuscita', { adapter: adapter.id, err });
    return { adapter: adapter.id, available: false, version: null, path: null, command: null, problems: [String(err instanceof Error ? err.message : err).slice(0, 500)] };
  }
}

/**
 * P-99 — «Riavvia motori»: ri-verifica reale (refresh) di tutti i motori e, per gli agenti la cui
 * ultima istanza è in `error`/`crashed` (il processo del motore non c'è più), riavvio della sessione
 * tramite l'Agent Manager (stesse regole di fiducia/adapter). Un'istanza viva in errore viene prima
 * fermata (transizione terminale) e poi riavviata; gli agenti fermi non si toccano: riavviarli non
 * serve e lo dice il risultato. Evento e audit registrano l'esito vero.
 */
export async function restartEngines(deps: {
  adapters: AdapterRegistry;
  agents: AgentManager | null;
  audit: AuditLog;
  events: EventEmitter;
  log: Logger;
  correlationId: string;
}): Promise<EngineRestartResult> {
  const probes = await Promise.all(deps.adapters.list().map((adapter) => probeAdapter(adapter, true, deps.log)));
  const restarted: EngineRestartResult['restarted'] = [];
  if (deps.agents !== null) {
    // `breakerOf` non serve qui: la vista si usa solo per leggere l'ultima istanza reale di ogni
    // agente (anche `crashed`, che non è più nel registro delle istanze vive).
    for (const view of deps.agents.views({ includeArchived: false, breakerOf: () => 'closed' })) {
      const status = view.instance?.status ?? null;
      if (status !== 'error' && status !== 'crashed') continue;
      const agentId = view.definition.id;
      if (status === 'error') {
        // Istanza ancora viva in errore: la si chiude (terminale) prima di riavviare la sessione.
        await deps.agents.stop(agentId, { mode: 'force', reason: 'riavvio motori', by: 'system:engines', correlationId: deps.correlationId });
      }
      const out = await deps.agents.ensure(agentId, 'system:engines', deps.correlationId);
      restarted.push({
        agentId,
        ok: out.started,
        reason: out.started ? `sessione riavviata (${out.status ?? 'avvio'})` : (out.reason ?? 'avvio non riuscito')
      });
    }
  }
  const failed = restarted.filter((r) => !r.ok).length;
  const available = probes.filter((p) => p.available).length;
  deps.audit.record({
    actor: 'system:engines',
    action: 'engines.restart',
    subject: 'motori',
    decision: failed > 0 ? 'partial' : 'done',
    detail: `verificati ${probes.length} · disponibili ${available} · agenti riavviati ${restarted.length - failed} · falliti ${failed}`
      + (restarted.length > 0 ? ` · ${restarted.map((r) => `${r.agentId}:${r.ok ? 'ok' : 'no'}`).join(', ')}` : ''),
    correlationId: deps.correlationId
  });
  deps.events.emit('system.engines.restarted', {
    probed: probes.length,
    available,
    restarted: restarted.length - failed,
    failed,
    details: restarted.slice(0, 50)
  }, { source: { kind: 'visione', id: 'engines' }, correlationId: deps.correlationId });
  return { probes, restarted, failed };
}

export function registerEngineCommands(deps: {
  router: CommandRouter;
  runtime: CliRuntime;
  adapters: AdapterRegistry;
  /** P-99: aggiornato dal kernel dopo la creazione (late binding); assente nei test più vecchi. */
  agents?: () => AgentManager | null;
  audit?: AuditLog;
  events?: EventEmitter;
  log: Logger;
}): void {
  const { router, runtime, adapters, log } = deps;

  router.register('runtime.processes', (payload) => ({
    processes: runtime
      .list(payload.live ? { live: true } : {})
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, payload.limit)
  }));

  router.register('runtime.stop', async (payload, ctx) => {
    const outcome = await runtime.stop(payload.processId, { mode: payload.mode, reason: `stop richiesto (${ctx.command.issuedBy})` });
    if (!outcome.ok) {
      const missing = outcome.error.code === 'unknown_process' || outcome.error.code === 'not_running';
      throw new CommandFailure(missing ? 'not_found' : 'operation_failed', `${outcome.error.code}: ${outcome.error.message}`);
    }
    return { processId: payload.processId, status: outcome.result.status, alreadyFinished: outcome.alreadyFinished };
  });

  router.register('engines.probe', async (payload) => {
    const selected = payload.adapter === undefined ? adapters.list() : adapters.list().filter((a) => a.id === payload.adapter);
    if (payload.adapter !== undefined && selected.length === 0) {
      throw new CommandFailure('not_found', `motore sconosciuto: ${payload.adapter}`);
    }
    const engines = await Promise.all(selected.map((adapter) => probeAdapter(adapter, payload.refresh, log)));
    return { engines };
  });

  router.register('engines.restart', async (_payload, ctx) => {
    if (!deps.agents || !deps.audit || !deps.events) {
      throw new CommandFailure('operation_failed', 'riavvio motori non disponibile in questo contesto');
    }
    return restartEngines({
      adapters,
      agents: deps.agents(),
      audit: deps.audit,
      events: deps.events,
      log,
      correlationId: ctx.command.correlationId
    });
  });
}
