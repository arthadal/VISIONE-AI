// Contratto degli eventi (docs/architecture/VISIONE_EVENT_MODEL.md).
// Un evento è un fatto accaduto. Ogni tipo è registrato qui con categoria, durabilità, processo
// d'origine e schema del payload: il registro è l'unico punto da estendere nelle fasi successive.
import { z } from 'zod';
import { ulid } from '../lib/ulid.ts';
import {
  correlationIdSchema,
  formatIssues,
  visioneEventSchema,
  type Durability,
  type Endpoint,
  type EventCategory,
  type VisioneEvent,
  type Severity
} from './events-base.ts';
import { agentUsageSchema } from './agents.ts';
import {
  processIoSchema,
  processKindSchema,
  processOwnerSchema,
  processStatusSchema,
  runtimeErrorSchema,
  stopIntentSchema
} from './processes.ts';
import { coreStateSnapshotSchema, coreStatusSchema } from './state.ts';
import { agentStatusSchema } from './agents.ts';
import { breakerLevelSchema, directorDecisionKindSchema, messageActSchema, routeCandidateSchema } from './governance.ts';
import { plannerKindSchema, taskErrorSchema, taskKindSchema, taskStatusSchema } from './tasks.ts';
import { memoryKindSchema, memoryOriginSchema, memoryScopeSchema } from './memory.ts';
import { interruptCauseSchema, pttSourceSchema, speechReasonSchema, VOICE_LIMITS, voiceCommandActionSchema, voiceEnginesSchema, voiceIntentSchema, voiceOutcomeSchema, voiceProcessStateSchema, heardOutcomeSchema, enrollPhaseSchema, enrollErrorSchema } from './voice.ts';
import { telemetryAggregateSchema, telemetrySampleSchema } from './telemetry.ts';
import { ASSISTANT_LIMITS, reminderActionSchema, reminderKindSchema, reminderSourceSchema, reminderStatusSchema } from './assistant.ts';
import { OFFLINE_LIMITS, offlineChangeReasonSchema, offlineStateSchema, offlineReplySchema } from './offline.ts';

export * from './events-base.ts';

/** Processo autorizzato a produrre un tipo di evento. */
export type EventOrigin = 'main' | 'core';

export interface EventDefinition<P extends z.ZodType = z.ZodType> {
  readonly category: EventCategory;
  /** durable = persistente nel journal; ephemeral = transitorio, solo sul bus e verso la UI. */
  readonly durability: Durability;
  readonly origin: EventOrigin;
  readonly severity: Severity;
  readonly schema: number;
  readonly payload: P;
}

function defineEvent<P extends z.ZodType>(def: EventDefinition<P>): EventDefinition<P> {
  return def;
}

const pid = z.number().int().nonnegative();
const crashReason = z.enum(['exit', 'start-timeout', 'heartbeat-timeout', 'spawn-error']);
const commandType = z.string().min(1).max(100);
const processId = z.string().min(1).max(64);
const agentId = z.string().min(1).max(64);
const turnId = z.string().min(1).max(64);
const count0 = z.number().int().nonnegative();

/** Uscita di un processo: blocchi nell'ordine di arrivo, al più 16 KiB per evento (i parser ricevono righe intere a parte). */
const outputPayload = z.strictObject({
  processId,
  /** Progressivo per processo e flusso: un buco indica un evento scartato dal bus. */
  seq: z.number().int().positive(),
  text: z.string().max(16_384),
  stream: z.enum(['stdout', 'stderr', 'pty'])
});

/** Fine di un processo: un solo evento terminale per processo (P-30). */
const endPayload = z.strictObject({
  processId,
  pid: pid.nullable(),
  owner: processOwnerSchema,
  status: processStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().max(40).nullable(),
  durationMs: z.number().nonnegative().nullable(),
  error: runtimeErrorSchema.nullable(),
  /** Ultima parte dell'uscita (stderr se presente), per la diagnosi; redatta. */
  tail: z.string().max(2_000),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative()
});

/**
 * Catalogo. Fase 3 (P-20): ciclo di vita dell'app (`app.*`, main), del processo core visto dal
 * supervisore (`core.*`, main), del sistema visto dal core (`system.*`, core).
 * Fase 4 (P-26…P-29): ciclo di vita interno del core, journal, comandi (`command.*`, al posto di
 * `ipc.request/response`), `system.pong`, eventi rifiutati e variazioni dello stato.
 */
export const EVENT_DEFINITIONS = {
  'app.started': defineEvent({
    category: 'system', durability: 'durable', origin: 'main', severity: 'info', schema: 1,
    payload: z.strictObject({ appVersion: z.string(), electronVersion: z.string(), pid })
  }),
  'app.shutdown': defineEvent({
    category: 'system', durability: 'durable', origin: 'main', severity: 'info', schema: 1,
    payload: z.strictObject({ reason: z.string().max(200) })
  }),
  'core.started': defineEvent({
    category: 'system', durability: 'durable', origin: 'main', severity: 'info', schema: 1,
    payload: z.strictObject({ pid, attempt: z.number().int().nonnegative() })
  }),
  'core.ready': defineEvent({
    category: 'system', durability: 'durable', origin: 'main', severity: 'info', schema: 1,
    payload: z.strictObject({ pid, startupMs: z.number().nonnegative() })
  }),
  'core.stopped': defineEvent({
    category: 'system', durability: 'durable', origin: 'main', severity: 'info', schema: 1,
    payload: z.strictObject({ pid: pid.nullable(), exitCode: z.number().int().nullable(), reason: z.string().max(200) })
  }),
  'core.crashed': defineEvent({
    category: 'system', durability: 'durable', origin: 'main', severity: 'error', schema: 1,
    payload: z.strictObject({
      pid: pid.nullable(),
      exitCode: z.number().int().nullable(),
      reason: crashReason,
      detail: z.string().max(2000),
      stderrTail: z.string().max(2000),
      restartsInWindow: z.number().int().nonnegative(),
      willRestart: z.boolean(),
      nextDelayMs: z.number().int().nonnegative().nullable()
    })
  }),
  'core.restarted': defineEvent({
    category: 'system', durability: 'durable', origin: 'main', severity: 'warning', schema: 1,
    payload: z.strictObject({ pid, attempt: z.number().int().positive(), downtimeMs: z.number().nonnegative() })
  }),
  'system.started': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ pid, coreVersion: z.string(), schemaVersion: z.number().int().nonnegative() })
  }),
  'system.ready': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ startupMs: z.number().nonnegative(), journalLastSeq: z.number().int().nonnegative() })
  }),
  'system.stopped': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ reason: z.string().max(200), uptimeMs: z.number().nonnegative() })
  }),
  'system.error': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'error', schema: 1,
    payload: z.strictObject({ code: z.string().max(100), message: z.string().max(2000), fatal: z.boolean() })
  }),
  /** Transizione del ciclo di vita del core; `inferred` = dedotta all'avvio dal journal (uscita non pulita). */
  'system.lifecycle.changed': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      from: coreStatusSchema.nullable(),
      to: coreStatusSchema,
      reason: z.string().max(200),
      inferred: z.boolean()
    })
  }),
  /** Il journal non accetta scritture: gli eventi durevoli attendono in memoria. */
  'system.journal.degraded': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ error: z.string().max(500), pending: z.number().int().nonnegative() })
  }),
  'system.journal.restored': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ flushed: z.number().int().nonnegative(), lost: z.number().int().nonnegative(), downMs: z.number().nonnegative() })
  }),
  /** Database illeggibile all'avvio: messo da parte (mai cancellato) e sostituito da uno nuovo. */
  'system.db.quarantined': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'error', schema: 1,
    payload: z.strictObject({ file: z.string().max(260), reason: z.string().max(500) })
  }),
  /** Risposta diagnostica a `system.ping`: un fatto, prodotto dal gestore del comando. */
  'system.pong': defineEvent({
    category: 'system', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ echo: z.string().max(200).nullable(), pid })
  }),
  /** Un evento ricevuto non è stato accettato (tipo sconosciuto, payload non valido, origine errata). */
  'system.event.rejected': defineEvent({
    category: 'system', durability: 'ephemeral', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ id: z.string().max(64).nullable(), type: z.string().max(100).nullable(), problem: z.string().max(500) })
  }),
  'command.accepted': defineEvent({
    category: 'system', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ commandId: correlationIdSchema, type: commandType, issuedBy: z.string().max(20) })
  }),
  'command.rejected': defineEvent({
    category: 'system', durability: 'ephemeral', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ commandId: correlationIdSchema, type: commandType, code: z.string().max(40), message: z.string().max(500) })
  }),
  'command.completed': defineEvent({
    category: 'system', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({
      commandId: correlationIdSchema,
      type: commandType,
      ok: z.boolean(),
      durationMs: z.number().nonnegative(),
      errorCode: z.string().nullable(),
      replayed: z.boolean()
    })
  }),
  /** Lo stato del core è cambiato: snapshot completo e chiavi di primo livello cambiate. */
  'state.changed': defineEvent({
    category: 'system', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ snapshot: coreStateSnapshotSchema, changed: z.array(z.string().max(40)).max(20) })
  }),

  // --- Fase 5 (P-30…P-34): CLI Runtime ------------------------------------------------------
  /** Processo registrato (eventualmente in coda di avvio). Mai argomenti né ambiente: solo il conteggio. */
  'process.created': defineEvent({
    category: 'process', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      processId, kind: processKindSchema, io: processIoSchema, exe: z.string().max(260), cwd: z.string().max(1024),
      argCount: z.number().int().nonnegative(), owner: processOwnerSchema, restartOf: z.string().max(64).nullable()
    })
  }),
  'process.starting': defineEvent({
    category: 'process', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ processId, waitedMs: z.number().nonnegative() })
  }),
  'process.started': defineEvent({
    category: 'process', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ processId, pid, owner: processOwnerSchema })
  }),
  'process.stdout': defineEvent({
    category: 'process', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: outputPayload
  }),
  'process.stderr': defineEvent({
    category: 'process', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: outputPayload
  }),
  /** Dati scritti sull'ingresso del processo: solo la quantità, mai il contenuto. */
  'process.input': defineEvent({
    category: 'process', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ processId, bytes: z.number().int().nonnegative() })
  }),
  'process.stopping': defineEvent({
    category: 'process', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      processId, pid: pid.nullable(), intent: stopIntentSchema, mode: z.enum(['graceful', 'force']), reason: z.string().max(200)
    })
  }),
  'process.exited': defineEvent({ category: 'process', durability: 'durable', origin: 'core', severity: 'info', schema: 1, payload: endPayload }),
  'process.failed': defineEvent({ category: 'process', durability: 'durable', origin: 'core', severity: 'error', schema: 1, payload: endPayload }),
  'process.crashed': defineEvent({ category: 'process', durability: 'durable', origin: 'core', severity: 'error', schema: 1, payload: endPayload }),
  'process.stopped': defineEvent({ category: 'process', durability: 'durable', origin: 'core', severity: 'info', schema: 1, payload: endPayload }),
  'process.timeout': defineEvent({ category: 'process', durability: 'durable', origin: 'core', severity: 'warning', schema: 1, payload: endPayload }),
  'process.cancelled': defineEvent({ category: 'process', durability: 'durable', origin: 'core', severity: 'info', schema: 1, payload: endPayload }),
  /** Riavvio controllato di un processo di lunga durata (budget limitato, P-32). */
  'process.restarting': defineEvent({
    category: 'process', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ processId, restartOf: processId, attempt: z.number().int().positive(), delayMs: z.number().int().nonnegative() })
  }),
  /** Processo rimasto senza proprietario dopo una caduta del core, deciso all'avvio successivo. */
  'process.reconciled': defineEvent({
    category: 'process', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({
      processId, pid: pid.nullable(), outcome: z.enum(['killed', 'gone', 'pid-reused', 'kill-failed', 'unverified'])
    })
  }),
  'system.cli.discovered': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ name: z.string().max(64), path: z.string().max(1024), kind: z.enum(['exe', 'npm-shim', 'script']), version: z.string().max(100).nullable() })
  }),
  'system.cli.missing': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ name: z.string().max(64), problem: z.string().max(500) })
  }),
  /**
   * P-99 — «Riavvia motori»: ri-verifica di tutti i motori e riavvio delle sessioni rimaste in
   * errore. `probed`/`available` sono i motori verificati e disponibili; `restarted`/`failed` gli
   * agenti riavviati o no, con il motivo reale (nessun «risolto» senza prova).
   */
  'system.engines.restarted': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      probed: count0,
      available: count0,
      restarted: count0,
      failed: count0,
      details: z.array(z.strictObject({
        agentId: z.string().max(64),
        ok: z.boolean(),
        reason: z.string().max(500)
      })).max(50)
    })
  }),

  // --- Eventi normalizzati degli adapter (AgentEvent → bus), indipendenti dal motore ----------
  'agent.session.started': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, sessionId: z.string().max(128).nullable(), engineSessionId: z.string().max(200), adapter: z.string().max(64) })
  }),
  'agent.turn.started': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, turnId, taskId: z.string().max(64).nullable() })
  }),
  'agent.turn.finished': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, turnId, outcome: z.enum(['completed', 'cancelled', 'failed']), error: runtimeErrorSchema.nullable() })
  }),
  /** Testo finale di un blocco di risposta; oltre 4.000 caratteri è troncato (`chars` = lunghezza reale). */
  'agent.message.text': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, turnId, text: z.string().max(4_000), chars: z.number().int().nonnegative(), final: z.boolean() })
  }),
  /** Solo valori riportati dal motore; un campo assente è UNKNOWN, mai stimato. */
  'agent.usage.updated': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, sessionId: z.string().max(128).nullable(), source: z.enum(['turn', 'session']), usage: agentUsageSchema })
  }),
  /**
   * Il motore ha dichiarato l'esaurimento della quota (P-83): l'adapter lo legge dall'output reale
   * della CLI. `scope` = finestra dichiarata dal motore; `resetAt` è solo testo mostrato dalla CLI
   * (nessuna stima), null se il motore non lo dice.
   */
  'agent.limit.reached': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({
      agentId, sessionId: z.string().max(128).nullable(), taskId: z.string().max(64).nullable(), turnId: z.string().max(64).nullable(),
      adapter: z.string().max(64), scope: z.enum(['session', 'weekly', 'monthly', 'fast', 'unknown']),
      message: z.string().max(500), resetAt: z.string().max(120).nullable()
    })
  }),
  'agent.permission.requested': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ agentId, requestId: z.string().max(200), kind: z.string().max(100), target: z.string().max(1000) })
  }),
  'tool.call.started': defineEvent({
    category: 'tool', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, turnId, toolCallId: z.string().max(200), tool: z.string().max(100) })
  }),
  'tool.call.finished': defineEvent({
    category: 'tool', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, turnId, toolCallId: z.string().max(200), tool: z.string().max(100), ok: z.boolean(), durationMs: z.number().nonnegative().nullable() })
  }),

  // --- Fase 6 (P-37…P-41): agenti, task, Director, approvazioni, messaggi, audit -------------
  /** Uno strumento chiesto da un agente è stato negato dalla policy di VISIONE. */
  'tool.call.denied': defineEvent({
    category: 'tool', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ agentId, tool: z.string().max(100), classification: z.enum(['approval', 'block']), reason: z.string().max(500), approvalId: z.string().max(64).nullable() })
  }),
  'agent.definition.created': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, name: z.string().max(80), adapter: z.string().max(64), version: z.number().int().positive(), by: z.string().max(80) })
  }),
  'agent.definition.updated': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, name: z.string().max(80), adapter: z.string().max(64), version: z.number().int().positive(), by: z.string().max(80) })
  }),
  'agent.definition.archived': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ agentId, by: z.string().max(80) })
  }),
  'agent.instance.created': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ instanceId: z.string().max(64), agentId, adapter: z.string().max(64), resumeSessionId: z.string().max(128).nullable() })
  }),
  /** Ogni transizione di un'istanza (VISIONE_AGENT_ARCHITECTURE §2). */
  'agent.status.changed': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ instanceId: z.string().max(64), agentId, from: agentStatusSchema.nullable(), to: agentStatusSchema, reason: z.string().max(200) })
  }),
  /** Breaker dell'agente (anti-loop): closed → steer → constrain → open. */
  'agent.breaker.changed': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ agentId, from: breakerLevelSchema, to: breakerLevelSchema, failures: count0, reason: z.string().max(200) })
  }),
  /** Messaggio accettato da `outbox\` e instradato (al destinatario o al Director). */
  'agent.message.sent': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      messageId: z.string().max(64), conversationId: z.string().max(64), from: agentId, to: z.string().max(64), act: messageActSchema,
      subject: z.string().max(200), hops: count0, taskId: z.string().max(64).nullable()
    })
  }),
  /** File di `outbox\` scartato: non valido, mittente falso, troppi passaggi. Mai eseguito. */
  'agent.message.rejected': defineEvent({
    category: 'agent', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ agentId, file: z.string().max(260), problem: z.string().max(500) })
  }),
  'task.created': defineEvent({
    category: 'task', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      taskId: z.string().max(64), kind: taskKindSchema, parentId: z.string().max(64).nullable(), rootId: z.string().max(64),
      title: z.string().max(200), assigneeAgentId: z.string().max(64).nullable(), dependsOn: z.array(z.string().max(64)).max(10),
      priority: z.number().int().min(0).max(3), createdBy: z.string().max(80)
    })
  }),
  /** Ogni transizione di un task (VISIONE_AGENT_ARCHITECTURE §10): from/to/motivo/tentativo/errore. */
  'task.status.changed': defineEvent({
    category: 'task', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      taskId: z.string().max(64), rootId: z.string().max(64), kind: taskKindSchema, from: taskStatusSchema.nullable(), to: taskStatusSchema,
      reason: z.string().max(200), attempt: count0, error: taskErrorSchema.nullable()
    })
  }),
  'task.assigned': defineEvent({
    category: 'task', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ taskId: z.string().max(64), rootId: z.string().max(64), agentId, previousAgentId: z.string().max(64).nullable(), reason: z.string().max(500) })
  }),
  /** Una dipendenza è terminata: soddisfatta (riuscita) o bloccante (ogni altro esito). */
  'task.dependency.resolved': defineEvent({
    category: 'task', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ taskId: z.string().max(64), dependsOn: z.string().max(64), outcome: z.enum(['satisfied', 'blocked']), dependencyStatus: taskStatusSchema })
  }),
  'task.result.recorded': defineEvent({
    category: 'task', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      taskId: z.string().max(64), rootId: z.string().max(64), outcome: z.enum(['success', 'partial', 'failure']),
      summary: z.string().max(4_000), chars: count0, producedBy: z.string().max(64)
    })
  }),
  'director.goal.received': defineEvent({
    category: 'director', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ rootTaskId: z.string().max(64), planner: plannerKindSchema, chars: count0, by: z.string().max(80) })
  }),
  'director.plan.created': defineEvent({
    category: 'director', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      rootTaskId: z.string().max(64), planner: plannerKindSchema, taskIds: z.array(z.string().max(64)).max(10),
      /** Motivo del ripiego sul RulePlanner (piano dell'agente non valido o non ottenuto). */
      fallback: z.string().max(500).nullable()
    })
  }),
  /** Scelta del Director con la sua spiegazione (router, errori, approvazioni, breaker). */
  'director.decision': defineEvent({
    category: 'director', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      rootTaskId: z.string().max(64).nullable(), taskId: z.string().max(64).nullable(), decision: directorDecisionKindSchema,
      agentId: z.string().max(64).nullable(), reason: z.string().max(500), candidates: z.array(routeCandidateSchema).max(20)
    })
  }),
  /** Sintesi al proprietario quando un obiettivo termina. */
  'director.summary': defineEvent({
    category: 'director', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      rootTaskId: z.string().max(64), outcome: z.enum(['succeeded', 'failed', 'cancelled']),
      counts: z.strictObject({ total: count0, succeeded: count0, failed: count0, cancelled: count0, timedOut: count0, blocked: count0 }),
      text: z.string().max(4_000),
      /**
       * La risposta vera dell'agente (l'ultimo passo riuscito): è ciò che la voce legge (15/10/2026: niente
       * resoconto tecnico a voce). Facoltativa: gli eventi già registrati non ce l'hanno.
       */
      answer: z.string().max(4_000).nullable().optional()
    })
  }),
  'approval.requested': defineEvent({
    category: 'approval', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({
      approvalId: z.string().max(64), kind: z.string().max(100), target: z.string().max(1000), reason: z.string().max(500),
      requestedBy: z.string().max(80), taskId: z.string().max(64).nullable(), agentId: z.string().max(64).nullable()
    })
  }),
  'approval.granted': defineEvent({
    category: 'approval', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ approvalId: z.string().max(64), kind: z.string().max(100), target: z.string().max(1000), decidedBy: z.string().max(80), note: z.string().max(500).nullable() })
  }),
  'approval.denied': defineEvent({
    category: 'approval', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ approvalId: z.string().max(64), kind: z.string().max(100), target: z.string().max(1000), decidedBy: z.string().max(80), note: z.string().max(500).nullable() })
  }),
  // --- Memoria (Fase 7, P-42…P-44) ---------------------------------------------------------
  /** Nuovo elemento di memoria (da `memory.md`, da una riga `MEMORIA:`, da un comando o da una riflessione). */
  'memory.item.written': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      itemId: z.string().max(64), scope: memoryScopeSchema, scopeId: z.string().max(64).nullable(), kind: memoryKindSchema,
      origin: memoryOriginSchema, source: z.string().max(80), pinned: z.boolean(), title: z.string().max(200), redacted: z.boolean()
    })
  }),
  /** Copia nella memoria globale (solo proprietario o Director). */
  'memory.item.promoted': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ itemId: z.string().max(64), globalItemId: z.string().max(64), by: z.string().max(80) })
  }),
  /** Elementi sostituiti da un altro (riassunto della riflessione o riscrittura esplicita). */
  'memory.item.superseded': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ itemIds: z.array(z.string().max(64)).max(200), supersededBy: z.string().max(64), reason: z.string().max(200) })
  }),
  /** `memory.md` di un agente reindicizzato (solo se qualcosa è cambiato). */
  'memory.index.updated': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      agentId, sections: count0, added: count0, restored: count0, retired: count0, superseded: count0, unchanged: count0,
      /** Sezioni oltre il limite, troncate o con un ambito non consentito (finite nella memoria dell'agente). */
      ignored: count0, truncated: count0, scopeDenied: count0, redacted: count0
    })
  }),
  /** Brief del turno composto dal Context Builder (testo in `brief\<turno>.md`). */
  'memory.context.built': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      agentId, taskId: z.string().max(64), turnId, attempt: z.number().int().nonnegative(), chars: count0, file: z.string().max(1024),
      resume: z.boolean(),
      // `skills` dal P-107k (Addestramento): facoltativo, gli eventi già registrati non lo hanno.
      sections: z.strictObject({ resume: count0, chain: count0, team: count0.optional(), pinned: count0, skills: count0.optional(), codemap: count0.optional(), memory: count0, inbox: count0, events: count0 }),
      truncated: z.boolean()
    })
  }),
  'memory.reflection.completed': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      agentId, beforeChars: count0, afterChars: count0, pinned: count0, summarized: count0, kept: count0,
      summaryItemId: z.string().max(64).nullable(), backup: z.string().max(260)
    })
  }),
  /** Riflessione non applicata: il file resta com'era (verifica fallita, file cambiato, agente al lavoro…). */
  'memory.reflection.aborted': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ agentId, reason: z.string().max(500) })
  }),
  'memory.search.performed': defineEvent({
    category: 'memory', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ query: z.string().max(200), agentId: z.string().max(64).nullable(), hits: count0, durationMs: z.number().nonnegative() })
  }),
  /** Errore della memoria che non ferma il turno (file illeggibile, indicizzazione, posta). */
  'memory.error': defineEvent({
    category: 'memory', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ agentId: z.string().max(64).nullable(), stage: z.enum(['index', 'facts', 'inbox', 'context', 'reflection']), message: z.string().max(1000) })
  }),
  // --- Terminale e configurazione (Fase 8, P-45, P-46) ----------------------------------------
  /** Shell del proprietario aperta dalla vista Terminale (l'uscita resta `process.stdout`, flusso `pty`). */
  'terminal.session.opened': defineEvent({
    category: 'terminal', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ processId, title: z.string().max(200), by: z.string().max(80) })
  }),
  'terminal.session.closed': defineEvent({
    category: 'terminal', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ processId, status: processStatusSchema, exitCode: z.number().int().nullable() })
  }),
  /** Configurazione scritta dal proprietario: vale dal prossimo avvio del core. */
  'system.config.changed': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ changed: z.array(z.string().max(120)).max(50), by: z.string().max(80), restartRequired: z.boolean() })
  }),
  // --- Voce (Fase 9, P-48…P-50): fatti del processo voce tradotti dal core ---------------------
  /** Ciclo di vita del processo voce e disponibilità dei motori. */
  'voice.process.changed': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      from: voiceProcessStateSchema, to: voiceProcessStateSchema, reason: z.string().max(500), pid: pid.nullable(),
      engines: voiceEnginesSchema.nullable(), loadMs: z.number().nonnegative().nullable()
    })
  }),
  /** P-105: avanzamento del download dei modelli d'ascolto (`completato` = tutti pronti, la voce riparte). */
  'voice.models.progress': defineEvent({
    category: 'voice', durability: 'ephemeral', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      id: z.string().max(80),
      phase: z.enum(['download', 'verifica', 'estrazione', 'fatto', 'errore', 'completato']),
      received: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      error: z.string().max(500).nullable()
    })
  }),
  'voice.ptt.pressed': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ source: pttSourceSchema })
  }),
  'voice.ptt.released': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ source: pttSourceSchema, heldMs: z.number().nonnegative() })
  }),
  'voice.vad.speech.start': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ mode: z.enum(['ptt', 'barge-in']), audioMs: z.number().nonnegative() })
  }),
  'voice.vad.speech.end': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ mode: z.enum(['ptt', 'barge-in']), audioMs: z.number().nonnegative() })
  }),
  /** Enunciato trascritto (STT locale) con le sue latenze. */
  'voice.stt.final': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      utteranceId: z.string().max(64), text: z.string().max(VOICE_LIMITS.utteranceChars), chars: count0,
      audioMs: z.number().nonnegative(), sttMs: z.number().nonnegative(), latencyMs: z.number().nonnegative()
    })
  }),
  /** Cosa il core ha fatto dell'enunciato: obiettivo, approvazione, stop o niente. */
  'voice.intent': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      utteranceId: z.string().max(64), intent: voiceIntentSchema, outcome: voiceOutcomeSchema,
      rootTaskId: z.string().max(64).nullable(), approvalId: z.string().max(64).nullable(), detail: z.string().max(500)
    })
  }),
  /**
   * Comando di ambiente riconosciuto a voce (Fase 22, P-69): non fa nulla da sé, lo esegue il
   * renderer con il contesto reale della UI (finestra in primo piano, agenti noti). `target` null =
   * «quello selezionato».
   */
  'voice.command': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      utteranceId: z.string().max(64), action: voiceCommandActionSchema, target: z.string().max(120).nullable(),
      text: z.string().max(VOICE_LIMITS.utteranceChars)
    })
  }),
  'voice.tts.requested': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ ttsId: z.string().max(64), reason: speechReasonSchema, chars: count0, rootTaskId: z.string().max(64).nullable() })
  }),
  'voice.tts.started': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ ttsId: z.string().max(64), synthMs: z.number().nonnegative().nullable(), firstAudioMs: z.number().nonnegative().nullable(), responseMs: z.number().nonnegative().nullable() })
  }),
  'voice.tts.finished': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ ttsId: z.string().max(64), playedMs: z.number().nonnegative().nullable(), error: z.string().max(500).nullable() })
  }),
  /** Riproduzione interrotta: `bargeInMs` dall'inizio del parlato del proprietario allo stop confermato. */
  'voice.tts.interrupted': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ ttsId: z.string().max(64), cause: interruptCauseSchema, bargeInMs: z.number().nonnegative().nullable(), playedMs: z.number().nonnegative().nullable() })
  }),
  'voice.error': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ code: z.string().max(80), message: z.string().max(500) })
  }),
  /** Livello del microfono mentre si ascolta: solo verso la UI. */
  'voice.level': defineEvent({
    category: 'voice', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ rms: z.number().min(0).max(1) })
  }),
  /** Wake word configurata nel processo voce (P-81): cosa è attivo e se il motore c'è. */
  'voice.wake.changed': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      enabled: z.boolean(), phrase: z.string().max(VOICE_LIMITS.wakePhraseChars),
      available: z.boolean(), reason: z.string().max(200).nullable()
    })
  }),
  /** Conversazione a voce (15/10/2026): con chi parla la voce adesso (null = il Director), e chi l'ha scelto. */
  'voice.talk.changed': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ talkTo: z.string().max(64).nullable(), by: z.enum(['ui', 'voice']) })
  }),
  /**
   * Wake word «Hey Visione» riconosciuta (P-81): frase, trascrizione reale e comando nella stessa
   * utterance (null = sola frase). `confidence` resta null: Whisper non espone una probabilità.
   */
  'voice.wake.detected': defineEvent({
    category: 'voice', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      phrase: z.string().min(1).max(VOICE_LIMITS.wakePhraseChars),
      text: z.string().max(VOICE_LIMITS.utteranceChars),
      command: z.string().max(VOICE_LIMITS.utteranceChars).nullable(),
      confidence: z.number().min(0).max(1).nullable(),
      audioMs: z.number().nonnegative(), sttMs: z.number().nonnegative()
    })
  }),

  /**
   * P-106: esito dei filtri su un parlato (troppo debole, proprietario, estraneo, troppo corto per
   * giudicare) con la somiglianza all'impronta. Effimero: solo verso la UI, mai nel journal.
   */
  'voice.heard': defineEvent({
    category: 'voice', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ mode: z.enum(['ptt', 'wake']), outcome: heardOutcomeSchema, score: z.number().min(-1).max(1).nullable(), audioMs: z.number().nonnegative() })
  }),
  /** Prova di precisione (24/10/2026): ciò che lo STT ha sentito, da confrontare con la frase letta. Effimero. */
  'voice.accuracy.heard': defineEvent({
    category: 'voice', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: z.strictObject({ text: z.string().max(VOICE_LIMITS.utteranceChars), audioMs: z.number().nonnegative(), sttMs: z.number().nonnegative() })
  }),
  /** P-106: registrazione della voce del proprietario (frasi raccolte, salvata, errori). Effimero. */
  'voice.enroll.progress': defineEvent({
    category: 'voice', durability: 'ephemeral', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      phase: enrollPhaseSchema, count: z.number().int().min(0).max(20), audioMs: z.number().nonnegative().nullable(),
      quality: z.number().min(-1).max(1).nullable(), reason: enrollErrorSchema.nullable()
    })
  }),

  // --- Shell: file e controllo di sistema (Fase 24b, P-72) ----------------------------------------
  'file.created': defineEvent({
    category: 'file', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ path: z.string().max(1_000), kind: z.enum(['file', 'directory']) })
  }),
  'file.renamed': defineEvent({
    category: 'file', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ from: z.string().max(1_000), to: z.string().max(1_000), kind: z.enum(['file', 'directory']) })
  }),
  'file.deleted': defineEvent({
    category: 'file', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({ path: z.string().max(1_000), kind: z.enum(['file', 'directory']), recursive: z.boolean() })
  }),
  /** Esplora (11/10/2026): spostato nel Cestino di Windows (recuperabile). */
  'file.trashed': defineEvent({
    category: 'file', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ path: z.string().max(1_000), kind: z.enum(['file', 'directory']) })
  }),
  'file.opened': defineEvent({
    category: 'file', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ path: z.string().max(1_000) })
  }),
  'system.control.performed': defineEvent({
    category: 'system', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ action: z.string().max(40), by: z.string().max(80) })
  }),
  /** Telemetria di sistema (Fase 14): campione reale a bassa frequenza; effimero (bus e UI soltanto). */
  'telemetry.sample': defineEvent({
    category: 'telemetry', durability: 'ephemeral', origin: 'core', severity: 'debug', schema: 1,
    payload: telemetrySampleSchema
  }),
  /** Aggregato al minuto della telemetria (Fase 14): durevole, conservato con `telemetry_minutes`. */
  'telemetry.aggregate': defineEvent({
    category: 'telemetry', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: telemetryAggregateSchema
  }),
  /** Assistente (beta.5, P-109): promemoria creato (a voce o dal widget Agenda). Testo redatto. */
  'assistant.reminder.created': defineEvent({
    category: 'assistant', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      reminderId: z.string().max(64), kind: reminderKindSchema, text: z.string().max(ASSISTANT_LIMITS.textChars),
      dueAt: z.number().int().nonnegative(), notifyAt: z.number().int().nonnegative(), source: reminderSourceSchema
    })
  }),
  /** Promemoria scattato: `message` è la frase per la voce e la notifica di Windows. */
  'assistant.reminder.fired': defineEvent({
    category: 'assistant', durability: 'durable', origin: 'core', severity: 'warning', schema: 1,
    payload: z.strictObject({
      reminderId: z.string().max(64), kind: reminderKindSchema, text: z.string().max(ASSISTANT_LIMITS.textChars),
      dueAt: z.number().int().nonnegative(), lateMs: z.number().int().nonnegative(), message: z.string().max(700)
    })
  }),
  /** Promemoria chiuso (fatto/annullato) o rimandato. */
  'assistant.reminder.changed': defineEvent({
    category: 'assistant', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      reminderId: z.string().max(64), action: reminderActionSchema, status: reminderStatusSchema, notifyAt: z.number().int().nonnegative()
    })
  }),
  /** P-109b: una lista cambiata (aggiunti, tolti, svuotata); `items` = quanti elementi restano. */
  'assistant.list.changed': defineEvent({
    category: 'assistant', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ list: z.string().max(ASSISTANT_LIMITS.listNameChars), op: z.enum(['add', 'remove', 'clear']), items: z.number().int().nonnegative() })
  }),
  /** Chat di gruppo locale (22/10/2026): un gruppo ha un messaggio nuovo, qualcuno sta scrivendo o è cambiato. */
  'group.changed': defineEvent({
    category: 'agent', durability: 'ephemeral', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ groupId: z.string().max(64) })
  }),
  /** Modalità offline (17/10/2026): cambiata la rete, la modalità o lo stato del modello locale. */
  'offline.changed': defineEvent({
    category: 'assistant', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ state: offlineStateSchema, reason: offlineChangeReasonSchema })
  }),
  'offline.model.progress': defineEvent({
    category: 'assistant', durability: 'ephemeral', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({
      phase: z.enum(['download', 'verifica', 'fatto', 'errore', 'completato', 'annullato']),
      file: z.string().max(80),
      received: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      error: z.string().max(500).nullable()
    })
  }),
  /** Una richiesta trattata offline (scritta o a voce) e la risposta: la UI la mostra sotto la barra. */
  'offline.reply': defineEvent({
    category: 'assistant', durability: 'durable', origin: 'core', severity: 'info', schema: 1,
    payload: z.strictObject({ text: z.string().max(OFFLINE_LIMITS.textChars), source: z.enum(['ui', 'voice']), ...offlineReplySchema.shape })
  }),
  /** Invariante violata senza un proprietario (es. catena dell'audit log rotta). */
  'error.invariant': defineEvent({
    category: 'error', durability: 'durable', origin: 'core', severity: 'critical', schema: 1,
    payload: z.strictObject({ code: z.string().max(100), message: z.string().max(2000) })
  })
} as const;

export type EventType = keyof typeof EVENT_DEFINITIONS;
export type EventPayload<T extends EventType> = z.output<(typeof EVENT_DEFINITIONS)[T]['payload']>;
export type TypedEvent<T extends EventType> = Omit<VisioneEvent, 'type' | 'payload'> & { type: T; payload: EventPayload<T> };

export const EVENT_TYPES = Object.keys(EVENT_DEFINITIONS) as EventType[];

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_DEFINITIONS, type);
}

/** Definizione registrata per un tipo; `undefined` per un tipo sconosciuto (mai un'eccezione). */
export function getEventDefinition(type: string): EventDefinition | undefined {
  return isEventType(type) ? EVENT_DEFINITIONS[type] : undefined;
}

export function isEvent<T extends EventType>(event: VisioneEvent, type: T): event is TypedEvent<T> {
  return event.type === type;
}

export const DEFAULT_SOURCE: Record<EventOrigin, Endpoint> = {
  main: { kind: 'system', id: 'main' },
  core: { kind: 'visione', id: 'core' }
};

export interface CreateEventOptions {
  source?: Endpoint;
  target?: Endpoint | null;
  correlationId?: string;
  causationId?: string | null;
  severity?: Severity;
  now?: number;
}

/** Opzioni per un evento derivato da un altro: stessa correlazione, causato da quell'evento. */
export function derivedFrom(cause: Pick<VisioneEvent, 'id' | 'correlationId'>): Pick<CreateEventOptions, 'correlationId' | 'causationId'> {
  return { correlationId: cause.correlationId, causationId: cause.id };
}

/** Crea un evento validando il payload con lo schema registrato. Lancia se non è valido. */
export function createEvent<T extends EventType>(type: T, payload: EventPayload<T>, opts: CreateEventOptions = {}): TypedEvent<T> {
  const def = EVENT_DEFINITIONS[type];
  const parsed = def.payload.parse(payload) as EventPayload<T>;
  const ts = opts.now ?? Date.now();
  const id = ulid(ts);
  return {
    id,
    seq: null,
    ts,
    type,
    category: def.category,
    source: opts.source ?? DEFAULT_SOURCE[def.origin],
    target: opts.target ?? null,
    correlationId: opts.correlationId ?? id,
    causationId: opts.causationId ?? null,
    severity: opts.severity ?? def.severity,
    durability: def.durability,
    schema: def.schema,
    payload: parsed
  };
}

export type ParseEventResult = { ok: true; event: VisioneEvent } | { ok: false; problem: string };

/**
 * Valida un evento ricevuto da un altro processo: envelope, tipo registrato, coerenza con il
 * registro (categoria, durabilità, schema) e payload. `origin` limita i tipi accettati.
 * Non lancia mai: un evento sconosciuto o malformato è un risultato, non un'eccezione.
 */
export function parseEvent(raw: unknown, origin?: EventOrigin): ParseEventResult {
  const envelope = visioneEventSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, problem: formatIssues(envelope.error) };
  const event = envelope.data;
  const def = getEventDefinition(event.type);
  if (!def) return { ok: false, problem: `tipo non registrato: ${event.type}` };
  if (origin !== undefined && def.origin !== origin) {
    return { ok: false, problem: `${event.type} non può provenire da ${origin}` };
  }
  if (def.category !== event.category || def.durability !== event.durability || def.schema !== event.schema) {
    return { ok: false, problem: `${event.type}: categoria, durabilità o schema diversi dal registro` };
  }
  const payload = def.payload.safeParse(event.payload);
  if (!payload.success) return { ok: false, problem: `${event.type}: ${formatIssues(payload.error)}` };
  return { ok: true, event: { ...event, payload: payload.data } };
}

/** Dimensione massima del payload serializzato di un evento (64 KiB). */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export type SerializeResult = { ok: true; json: string } | { ok: false; problem: string };

/** Serializza il payload per il journal; un payload non serializzabile o troppo grande è un risultato. */
export function serializePayload(payload: unknown): SerializeResult {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch (err) {
    return { ok: false, problem: `payload non serializzabile: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (json === undefined) return { ok: false, problem: 'payload non serializzabile: undefined' };
  if (json.length > MAX_PAYLOAD_BYTES) return { ok: false, problem: `payload troppo grande: ${json.length} > ${MAX_PAYLOAD_BYTES}` };
  return { ok: true, json };
}

const SEVERITY_RANK: Record<Severity, number> = { debug: 0, info: 1, warning: 2, error: 3, critical: 4 };

export function severityAtLeast(severity: Severity, min: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}
