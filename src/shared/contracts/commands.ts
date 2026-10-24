// Contratto dei comandi: una richiesta con un proprietario e una risposta (VISIONE_ARCHITECTURE §7).
import { z } from 'zod';
import { correlationIdSchema, eventCategorySchema, visioneEventSchema, severitySchema } from './events.ts';
import { processInfoSchema, processStatusSchema } from './processes.ts';
import { coreStateSnapshotSchema } from './state.ts';
import { agentCompetenceSchema, agentDefinitionSchema, agentStatusSchema } from './agents.ts';
import { agentViewSchema, approvalSchema, approvalStatusSchema, auditEntrySchema } from './governance.ts';
import { planSchema, plannerKindSchema, taskSchema, taskStatusSchema } from './tasks.ts';
import { MEMORY_LIMITS, memoryItemSchema, memoryKindSchema, memoryScopeSchema } from './memory.ts';
import { TERMINAL_LIMITS, terminalColsSchema, terminalRowsSchema, terminalSessionSchema } from './terminal.ts';
import { pttSourceSchema, VOICE_LIMITS, voiceProfileSchema, voiceStateSchema } from './voice.ts';
import { languageSchema } from './language.ts';
import { OFFLINE_LIMITS, offlineReplySchema, offlineStateSchema } from './offline.ts';
import { ASSISTANT_LIMITS, assistantListSchema, reminderActionSchema, reminderSchema } from './assistant.ts';
import { customSkillInputSchema, skillSchema } from './training.ts';
import { codeRootSchema } from './codemap.ts';
import { chatRequestSchema, groupMessageSchema, groupViewSchema } from './groups.ts';

export const actorSchema = z.enum(['ui', 'system']);
export type Actor = z.infer<typeof actorSchema>;

/** Envelope di ogni comando. `id` è anche la chiave di idempotenza. */
export const commandEnvelopeSchema = z.strictObject({
  id: correlationIdSchema,
  type: z.string().min(3).max(100),
  ts: z.number().int().nonnegative(),
  correlationId: correlationIdSchema,
  issuedBy: actorSchema,
  payload: z.unknown()
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

export const commandErrorCodeSchema = z.enum([
  'invalid_command',   // envelope non valido
  'unknown_command',   // tipo non registrato o senza gestore
  'forbidden',         // tipo non consentito a chi lo invia
  'invalid_payload',   // payload non conforme allo schema
  'timeout',           // tempo scaduto (il comando può essere ancora in corso: riprovare con lo stesso id)
  'cancelled',         // annullato
  'core_unavailable',  // core non pronto o caduto
  'shutting_down',     // core in chiusura, non accetta comandi
  'not_found',         // la risorsa indicata non esiste (o non è più controllabile)
  'operation_failed',  // eseguito ma non riuscito: il motivo è nel messaggio
  'internal'           // errore inatteso nel gestore
]);
export type CommandErrorCode = z.infer<typeof commandErrorCodeSchema>;

export const commandErrorSchema = z.strictObject({
  code: commandErrorCodeSchema,
  message: z.string().max(2000),
  retryable: z.boolean()
});
export type CommandError = z.infer<typeof commandErrorSchema>;

export const commandResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ id: z.string(), correlationId: z.string(), ok: z.literal(true), data: z.unknown(), replayed: z.boolean() }),
  z.strictObject({ id: z.string(), correlationId: z.string(), ok: z.literal(false), error: commandErrorSchema })
]);
export type CommandResponse<T = unknown> =
  | { id: string; correlationId: string; ok: true; data: T; replayed: boolean }
  | { id: string; correlationId: string; ok: false; error: CommandError };

const RETRYABLE: ReadonlySet<CommandErrorCode> = new Set(['timeout', 'core_unavailable', 'shutting_down']);

export function commandError(code: CommandErrorCode, message: string): CommandError {
  return { code, message, retryable: RETRYABLE.has(code) };
}

export function failure(id: string, correlationId: string, code: CommandErrorCode, message: string): CommandResponse<never> {
  return { id, correlationId, ok: false, error: commandError(code, message) };
}

// --- Registro dei comandi ----------------------------------------------------------------------

export interface CommandDefinition<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  readonly payload: P;
  readonly result: R;
  /** Modifica stato: la risposta viene conservata per idempotenza (tabella `idempotency`). */
  readonly mutating: boolean;
  /** Può essere inviato dal renderer. */
  readonly uiAllowed: boolean;
  /** Timeout specifico; altrimenti quello della configurazione. */
  readonly timeoutMs?: number;
  /**
   * Comando ad alta frequenza (i fotogrammi del tracciamento del volto, ~10 al secondo): niente
   * `command.accepted`/`command.completed` sul bus, che altrimenti riempirebbero la finestra degli
   * eventi della UI e spingerebbero fuori chat e operazioni. I rifiuti (`command.rejected`) restano.
   */
  readonly quiet?: boolean;
}

function defineCommand<P extends z.ZodType, R extends z.ZodType>(def: CommandDefinition<P, R>): CommandDefinition<P, R> {
  return def;
}

/** Fotogramma più grande accettato dal tracciamento del volto (`vision.face`). */
export const VISION_FRAME_MAX = { width: 160, height: 120 } as const;

export const pingResultSchema = z.strictObject({
  pong: z.literal(true),
  echo: z.string().nullable(),
  coreTs: z.number().int(),
  pid: z.number().int(),
  uptimeMs: z.number().nonnegative()
});
export type PingResult = z.infer<typeof pingResultSchema>;

export const systemStatusSchema = z.strictObject({
  coreVersion: z.string(),
  pid: z.number().int(),
  startedAt: z.number().int(),
  uptimeMs: z.number().nonnegative(),
  schemaVersion: z.number().int().nonnegative(),
  journal: z.strictObject({ lastSeq: z.number().int().nonnegative(), count: z.number().int().nonnegative() })
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;

export const eventPageSchema = z.strictObject({
  events: z.array(visioneEventSchema),
  lastSeq: z.number().int().nonnegative()
});
export type EventPage = z.infer<typeof eventPageSchema>;

export const eventsListPayloadSchema = z.strictObject({
  /** Eventi con `seq` maggiore di questo, in ordine crescente. Assente: gli ultimi `limit`. */
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  /** Filtri facoltativi (in AND). */
  types: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  categories: z.array(eventCategorySchema).min(1).max(20).optional(),
  correlationId: correlationIdSchema.optional(),
  minSeverity: severitySchema.optional()
});
export type EventsListQuery = z.input<typeof eventsListPayloadSchema>;

/** Esito della verifica di un motore (discovery + versione); nessun dato inventato. */
export const engineProbeSchema = z.strictObject({
  adapter: z.string().max(64),
  available: z.boolean(),
  version: z.string().max(100).nullable(),
  path: z.string().max(1024).nullable(),
  /** P-99: comando reale eseguito per la verifica (eseguibile risolto + `--version`), se il motore ne ha uno. */
  command: z.string().max(1024).nullable(),
  problems: z.array(z.string().max(500)).max(20)
});
export type EngineProbe = z.infer<typeof engineProbeSchema>;

/**
 * Procedura guidata (P-105): un requisito di un motore, rilevato davvero, con la guida in italiano.
 * Mai il valore di una chiave: solo presenza ed esito della verifica.
 */
export const setupItemSchema = z.strictObject({
  id: z.string().max(64),
  label: z.string().max(120),
  ok: z.boolean(),
  optional: z.boolean(),
  /** Indispensabile ai modelli di questo profilo (`endpointProfile` del catalogo), anche se facoltativo per il motore. */
  forProfile: z.string().max(64).optional(),
  detail: z.string().max(500),
  steps: z.array(z.string().max(400)).max(12),
  commands: z.array(z.string().max(300)).max(8),
  link: z.string().max(300).optional(),
  action: z
    .union([
      z.strictObject({ kind: z.literal('login-terminal'), args: z.array(z.string().max(64)).max(8) }),
      z.strictObject({ kind: z.literal('env-key'), envName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }),
      /**
       * «Installa» (17/10/2026): l'installatore ufficiale parte nel terminale di VISIONE. Il comando lo tiene
       * il core (`setup.install` lo rilegge dal motore): qui solo da dove arriva e se Windows chiederà il permesso.
       */
      // `verb` (22/10/2026): «Attiva» per un'impostazione (la grafica integrata di Ollama), non un download.
      z.strictObject({ kind: z.literal('install'), source: z.string().max(200), admin: z.boolean(), verb: z.enum(['install', 'enable']).optional() })
    ])
    .optional()
});
export type SetupItem = z.infer<typeof setupItemSchema>;
export const setupEngineSchema = z.strictObject({ adapter: z.string().max(64), items: z.array(setupItemSchema).max(20) });
export type SetupEngine = z.infer<typeof setupEngineSchema>;
export const keyCheckSchema = z.strictObject({ ok: z.boolean(), detail: z.string().max(500) });
/** P-105: un modello scegliibile nei menu della procedura, già nel formato della definizione. */
export const catalogEntrySchema = z.strictObject({
  model: z.string().max(200),
  label: z.string().max(200),
  group: z.string().max(60),
  endpointProfile: z.string().max(64).optional(),
  recommended: z.boolean().optional(),
  suggestedFor: z.enum(['director', 'code', 'review', 'research']).optional()
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
/** P-105: un agente della squadra scelta nella procedura (nome visibile in VISIONE, motore, modello). */
export const teamMemberSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().max(200).default(''),
  competences: z.array(agentCompetenceSchema).min(1).max(5).default(['general']),
  adapter: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  endpointProfile: z.string().max(64).optional()
});
export type TeamMember = z.input<typeof teamMemberSchema>;

/** Definizione scritta dal proprietario: autore, data e versione li decide il core. */
export const agentDefinitionInputSchema = agentDefinitionSchema.omit({ createdBy: true, createdAt: true, version: true });
export type AgentDefinitionInput = z.input<typeof agentDefinitionInputSchema>;

export const COMMAND_DEFINITIONS = {
  'system.ping': defineCommand({
    payload: z.strictObject({ echo: z.string().max(200).optional() }),
    result: pingResultSchema,
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  'system.status': defineCommand({
    payload: z.strictObject({}),
    result: systemStatusSchema,
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Launcher (Fase 24, P-71): applicazioni realmente installate (Start Menu), sola lettura. */
  'system.apps.list': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({
      apps: z.array(z.strictObject({ id: z.string().max(200), name: z.string().max(200) })).max(500),
      source: z.literal('get-startapps')
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 15_000
  }),
  /** Avvia un'app installata per id del catalogo (`shell:AppsFolder`); id validato, nessuna shell. */
  'system.apps.launch': defineCommand({
    payload: z.strictObject({ id: z.string().min(1).max(200) }),
    result: z.strictObject({ id: z.string(), launched: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Informazioni REALI della macchina (Fase 24b): niente stime; le voci non ottenibili restano null. */
  'system.control.info': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({
      hostname: z.string().max(200),
      windows: z.string().max(200),
      cpuModel: z.string().max(200),
      cpuCount: z.number().int().nonnegative(),
      loadavg: z.array(z.number()).length(3).nullable(),
      memTotalBytes: z.number().nonnegative(),
      memFreeBytes: z.number().nonnegative(),
      disk: z.strictObject({ path: z.string().max(500), totalBytes: z.number().nonnegative(), freeBytes: z.number().nonnegative() }).nullable(),
      uptimeSec: z.number().nonnegative()
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /**
   * Widget Meteo (11/10/2026): previsione per una città scelta dal proprietario. Unica rete del core
   * verso l'esterno per i widget, solo verso i due host del meteo (VISIONE_SECURITY_MODEL §3).
   */
  'widgets.weather': defineCommand({
    payload: z.strictObject({
      city: z.string().trim().min(2).max(80).regex(/^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]*$/u),
      language: languageSchema
    }),
    result: z.strictObject({
      place: z.strictObject({ name: z.string().max(120), region: z.string().max(120).nullable(), country: z.string().max(120).nullable(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
      now: z.strictObject({ at: z.string().max(40), tempC: z.number().nullable(), symbol: z.string().max(60).nullable(), windMs: z.number().nullable(), humidity: z.number().nullable() }),
      days: z.array(z.strictObject({ date: z.string().max(10), minC: z.number().nullable(), maxC: z.number().nullable(), symbol: z.string().max(60).nullable() })).max(10),
      updatedAt: z.string().max(40).nullable(),
      fetchedAt: z.number().int(),
      cached: z.boolean(),
      source: z.literal('met.no')
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 25_000
  }),
  /**
   * Widget Umanoide (11/10/2026): dove sta il volto in un fotogramma ridotto della webcam (grigio,
   * al più 160×120), cercato dal rilevatore di volti di Windows (Windows.Media.FaceAnalysis) in un
   * PowerShell del core. Il fotogramma non si salva e non esce dal PC; il comando è silenzioso.
   */
  'vision.face': defineCommand({
    payload: z.strictObject({
      width: z.number().int().min(16).max(VISION_FRAME_MAX.width),
      height: z.number().int().min(16).max(VISION_FRAME_MAX.height),
      gray: z.string().max(Math.ceil((VISION_FRAME_MAX.width * VISION_FRAME_MAX.height) / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/)
    }),
    result: z.strictObject({
      faces: z.array(z.strictObject({ x: z.number(), y: z.number(), w: z.number().nonnegative(), h: z.number().nonnegative() })).max(5),
      ms: z.number().nonnegative()
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 4_000,
    quiet: true
  }),
  /**
   * Assistente (beta.5, P-109): il «quando» di una frase, per l'anteprima del widget Agenda mentre si
   * scrive. Regole locali, nessun modello; silenzioso (si chiama a ogni pausa della tastiera).
   */
  'assistant.parse': defineCommand({
    payload: z.strictObject({ text: z.string().max(ASSISTANT_LIMITS.textChars) }),
    result: z.strictObject({
      at: z.number().int().nonnegative().nullable(), exact: z.boolean(), past: z.boolean(),
      label: z.string().max(80).nullable(), text: z.string().max(ASSISTANT_LIMITS.textChars), appointment: z.boolean(),
      /** P-109b: che richiesta è (null = nessuna): l'anteprima del «quando» serve solo ai promemoria. */
      request: z.enum(['reminder', 'timer', 'list', 'note', 'agenda', 'cancel']).nullable()
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 2_000,
    quiet: true
  }),
  /** Promemoria aperti (in attesa o scattati e non chiusi), o anche i chiusi recenti. */
  'assistant.reminders.list': defineCommand({
    payload: z.strictObject({ status: z.enum(['open', 'all']).default('open'), limit: z.number().int().min(1).max(ASSISTANT_LIMITS.listMax).default(100) }),
    result: z.strictObject({ reminders: z.array(reminderSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Nuovo promemoria dal widget: il «quando» dalla frase o da `at`. Risponde con la conferma. */
  'assistant.reminder.add': defineCommand({
    payload: z.strictObject({ text: z.string().trim().min(1).max(ASSISTANT_LIMITS.textChars), at: z.number().int().nonnegative().optional() }),
    result: z.strictObject({ reminder: reminderSchema, reply: z.string().max(700) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Fatto, annulla, rimanda di `minutes` (predefinito 10). */
  /** P-109b: una frase all'Assistente dal widget, come a voce (liste, timer, ricorrenti, agenda). */
  'assistant.ask': defineCommand({
    payload: z.strictObject({ text: z.string().trim().min(1).max(ASSISTANT_LIMITS.textChars) }),
    result: z.strictObject({ handled: z.boolean(), reply: z.string().max(700).nullable() }),
    mutating: true,
    uiAllowed: true
  }),
  'assistant.lists.get': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ lists: z.array(assistantListSchema).max(ASSISTANT_LIMITS.lists) }),
    mutating: false,
    uiAllowed: true
  }),
  'assistant.list.remove': defineCommand({
    payload: z.strictObject({ id: z.string().min(1).max(64) }),
    result: z.strictObject({ removed: z.boolean() }),
    mutating: true,
    uiAllowed: true
  }),
  // Chat di gruppo locale (22/10/2026): gruppi di agenti, messaggi del proprietario, risposte come in una chat.
  'groups.list': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ groups: z.array(groupViewSchema).max(100) }),
    mutating: true,
    uiAllowed: true
  }),
  'groups.create': defineCommand({
    payload: z.strictObject({
      name: z.string().trim().min(1).max(60),
      members: z.array(z.strictObject({ agentId: z.string().min(1).max(64), role: z.string().max(80) })).min(1).max(8)
    }),
    result: z.strictObject({ group: groupViewSchema }),
    mutating: true,
    uiAllowed: true
  }),
  'groups.remove': defineCommand({
    payload: z.strictObject({ groupId: z.string().min(1).max(64) }),
    result: z.strictObject({ removed: z.boolean() }),
    mutating: true,
    uiAllowed: true
  }),
  'groups.messages': defineCommand({
    payload: z.strictObject({ groupId: z.string().min(1).max(64), limit: z.number().int().min(1).max(200).optional() }),
    result: z.strictObject({
      messages: z.array(groupMessageSchema).max(200),
      typing: z.array(z.strictObject({ agentId: z.string().max(64), name: z.string().max(200) })).max(16)
    }),
    mutating: false,
    uiAllowed: true
  }),
  /** La chat con VISIONE (23/10/2026): le sue richieste e le risposte, dalla più vecchia alla più recente. */
  'chat.history': defineCommand({
    payload: z.strictObject({ limit: z.number().int().min(1).max(200).optional() }),
    result: z.strictObject({ requests: z.array(chatRequestSchema).max(200) }),
    mutating: false,
    uiAllowed: true
  }),
  /** «Svuota chat» (24/10/2026): la conversazione si mostra da adesso; niente si cancella. «main» = chat con VISIONE. */
  'chat.clear': defineCommand({
    payload: z.strictObject({ conversation: z.string().min(1).max(64) }),
    result: z.strictObject({ clearedAt: z.number().int() }),
    mutating: true,
    uiAllowed: true
  }),
  'groups.post': defineCommand({
    payload: z.strictObject({ groupId: z.string().min(1).max(64), text: z.string().trim().min(1).max(4_000) }),
    result: z.strictObject({ message: groupMessageSchema, called: z.array(z.string().max(64)).max(8) }),
    mutating: true,
    uiAllowed: true
  }),
  'assistant.reminder.update': defineCommand({
    payload: z.strictObject({
      id: z.string().min(1).max(64), action: reminderActionSchema,
      minutes: z.number().int().min(1).max(ASSISTANT_LIMITS.snoozeMaxMinutes).optional()
    }),
    result: z.strictObject({ reminder: reminderSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Azioni di controllo reali (Fase 24b). `lock`/`shutdown`/`restart` richiedono `confirm: true`. */
  'system.control.exec': defineCommand({
    payload: z.strictObject({
      action: z.enum(['volume-up', 'volume-down', 'mute-toggle', 'task-manager', 'settings', 'lock', 'sleep', 'shutdown', 'restart', 'start-menu']),
      confirm: z.literal(true).optional()
    }),
    result: z.strictObject({ action: z.string().max(40), performed: z.boolean(), note: z.string().max(300).nullable() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 15_000
  }),
  // --- File Manager (Fase 24b, P-72): filesystem reale, dentro radici consentite ------------------
  'files.roots': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({
      roots: z.array(z.strictObject({ id: z.string().max(40), name: z.string().max(80), path: z.string().max(1_000), exists: z.boolean() })).max(20
      )
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  'files.list': defineCommand({
    payload: z.strictObject({ path: z.string().min(1).max(1_000), hidden: z.boolean().optional() }),
    result: z.strictObject({
      path: z.string().max(1_000),
      parent: z.string().max(1_000).nullable(),
      entries: z.array(z.strictObject({
        name: z.string().max(255), path: z.string().max(1_000), kind: z.enum(['file', 'directory']),
        size: z.number().nonnegative().nullable(), modifiedAt: z.number().nonnegative().nullable()
      })).max(5_000)
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 15_000
  }),
  'files.mkdir': defineCommand({
    payload: z.strictObject({ path: z.string().min(1).max(1_000), name: z.string().min(1).max(255) }),
    result: z.strictObject({ path: z.string().max(1_000) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  'files.rename': defineCommand({
    payload: z.strictObject({ path: z.string().min(1).max(1_000), newName: z.string().min(1).max(255) }),
    result: z.strictObject({ from: z.string().max(1_000), to: z.string().max(1_000) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  'files.delete': defineCommand({
    payload: z.strictObject({ path: z.string().min(1).max(1_000), confirm: z.literal(true), recursive: z.boolean().default(false) }),
    result: z.strictObject({ path: z.string().max(1_000), kind: z.enum(['file', 'directory']), recursive: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 15_000
  }),
  'files.open': defineCommand({
    payload: z.strictObject({ path: z.string().min(1).max(1_000) }),
    result: z.strictObject({ path: z.string().max(1_000), opened: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Esplora (11/10/2026): nel Cestino di Windows (recuperabile), per più file insieme. */
  /** Segnala un problema: pacchetto ripulito (descrizione, PC, app, registri) da allegare a un'email. Resta sul PC. */
  'support.report': defineCommand({
    payload: z.strictObject({ note: z.string().max(4_000) }),
    result: z.strictObject({ folder: z.string().max(1_000), file: z.string().max(1_000), zipped: z.boolean(), files: z.array(z.string().max(200)).max(20) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 150_000
  }),
  'files.trash': defineCommand({
    payload: z.strictObject({ paths: z.array(z.string().min(1).max(1_000)).min(1).max(100) }),
    result: z.strictObject({ trashed: z.array(z.string().max(1_000)).max(100), failed: z.array(z.string().max(1_000)).max(100) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 120_000
  }),
  /** Esplora: copia in una cartella (nome «(2)» se esiste già: mai sovrascrivere). */
  'files.copy': defineCommand({
    payload: z.strictObject({ paths: z.array(z.string().min(1).max(1_000)).min(1).max(100), toDir: z.string().min(1).max(1_000) }),
    result: z.strictObject({ done: z.array(z.strictObject({ from: z.string().max(1_000), to: z.string().max(1_000) })).max(100) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 300_000
  }),
  /** Esplora: sposta in una cartella (stesse regole della copia). */
  'files.move': defineCommand({
    payload: z.strictObject({ paths: z.array(z.string().min(1).max(1_000)).min(1).max(100), toDir: z.string().min(1).max(1_000) }),
    result: z.strictObject({ done: z.array(z.strictObject({ from: z.string().max(1_000), to: z.string().max(1_000) })).max(100) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 300_000
  }),
  /** Esplora: testo per l'anteprima (al più 256 KiB, nessun binario). */
  'files.read': defineCommand({
    payload: z.strictObject({ path: z.string().min(1).max(1_000) }),
    result: z.strictObject({ path: z.string().max(1_000), text: z.string().max(300_000), truncated: z.boolean(), size: z.number().nonnegative() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  'files.search': defineCommand({
    payload: z.strictObject({ root: z.string().min(1).max(1_000), query: z.string().min(1).max(120), limit: z.number().int().min(1).max(200).default(50) }),
    result: z.strictObject({
      results: z.array(z.strictObject({ name: z.string().max(255), path: z.string().max(1_000), kind: z.enum(['file', 'directory']) })).max(200)
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 20_000
  }),
  'events.list': defineCommand({
    payload: eventsListPayloadSchema,
    result: eventPageSchema,
    mutating: false,
    uiAllowed: true
  }),
  'events.get': defineCommand({
    payload: z.strictObject({ id: z.string().min(1).max(64) }),
    result: z.strictObject({ event: visioneEventSchema.nullable() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Snapshot dello stato corrente del core, in sola lettura. */
  'state.get': defineCommand({
    payload: z.strictObject({}),
    result: coreStateSnapshotSchema,
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Processi di questo avvio del core, dal più recente (sola lettura; mai argomenti né ambiente). */
  'runtime.processes': defineCommand({
    payload: z.strictObject({
      live: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50)
    }),
    result: z.strictObject({ processes: z.array(processInfoSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /**
   * Ferma un processo già avviato dal core (la UI non può avviarne). Idempotente: un processo già
   * terminato risponde con il suo esito e `alreadyFinished`.
   */
  'runtime.stop': defineCommand({
    payload: z.strictObject({
      processId: z.string().min(1).max(64),
      mode: z.enum(['graceful', 'force']).default('graceful')
    }),
    result: z.strictObject({ processId: z.string(), status: processStatusSchema, alreadyFinished: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /** Verifica dei motori: discovery delle CLI e versione, con processi `probe` decisi dal core. */
  'engines.probe': defineCommand({
    payload: z.strictObject({
      refresh: z.boolean().default(false),
      /** P-99: verifica UN motore (menu del pannello MOTORI); assente = tutti. */
      adapter: z.string().min(1).max(64).optional()
    }),
    result: z.strictObject({ engines: z.array(engineProbeSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /** P-105: requisiti di tutti i motori per la procedura guidata (sola lettura, ripetibile). */
  'setup.detect': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ engines: z.array(setupEngineSchema).max(10), checkedAt: z.number().int() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 45_000
  }),
  /** P-105: modelli scegliibili per ogni motore (menu a tendina della procedura). */
  'setup.catalog': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ engines: z.array(z.strictObject({ adapter: z.string().max(64), label: z.string().max(120), models: z.array(catalogEntrySchema).max(300) })).max(10) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /**
   * P-105: applica la squadra scelta: definisce (o aggiorna) gli agenti con nome, motore e modello,
   * dopo averli validati TUTTI; con `archiveOthers` archivia gli agenti attivi non scelti.
   */
  'setup.apply': defineCommand({
    payload: z.strictObject({ agents: z.array(teamMemberSchema).min(1).max(10), archiveOthers: z.boolean().default(true) }),
    result: z.strictObject({ defined: z.array(z.string().max(64)), archived: z.array(z.string().max(64)) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 60_000
  }),
  /**
   * P-105: terminale di VISIONE con il programma di accesso del motore (es. login dell'account), avviato
   * direttamente e non da PowerShell. Le credenziali le gestisce il motore: VISIONE non le vede.
   */
  'setup.login': defineCommand({
    payload: z.strictObject({ adapter: z.string().min(1).max(64), cols: terminalColsSchema.default(110), rows: terminalRowsSchema.default(26) }),
    result: z.strictObject({ session: terminalSessionSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /**
   * «Installa» nella procedura guidata (17/10/2026): l'installatore ufficiale del requisito `item` del motore,
   * in un terminale di VISIONE che la persona vede. Lo script lo dà il motore nel core, mai la UI.
   */
  'setup.install': defineCommand({
    payload: z.strictObject({ adapter: z.string().min(1).max(64), item: z.string().min(1).max(64), cols: terminalColsSchema.default(110), rows: terminalRowsSchema.default(26) }),
    result: z.strictObject({ session: terminalSessionSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /**
   * P-105: verifica reale di una chiave presso il servizio del motore. `value` assente = quella già
   * nell'ambiente. Il valore non finisce in risultati, eventi o log.
   */
  'setup.verifyKey': defineCommand({
    payload: z.strictObject({
      adapter: z.string().min(1).max(64),
      envName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      value: z.string().min(1).max(4_096).optional()
    }),
    result: keyCheckSchema,
    mutating: false,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /**
   * P-105: verifica la chiave e, solo se valida, la salva nelle variabili dell'utente Windows (come
   * `setx`) e la rende visibile ai processi dei motori avviati da adesso. Mai in un file di VISIONE.
   */
  'setup.saveKey': defineCommand({
    payload: z.strictObject({
      adapter: z.string().min(1).max(64),
      envName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      value: z.string().min(1).max(4_096)
    }),
    result: z.strictObject({ saved: z.boolean(), check: keyCheckSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 45_000
  }),
  /**
   * P-99 — «Riavvia motori»: ri-verifica reale di tutti i motori (refresh) e riavvio della sessione
   * degli agenti rimasti in errore/schiantati, dove ha senso. Esito e motivi onesti nel risultato,
   * nell'evento `system.engines.restarted` e nell'audit.
   */
  'engines.restart': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({
      probes: z.array(engineProbeSchema),
      restarted: z.array(z.strictObject({
        agentId: z.string().max(64),
        ok: z.boolean(),
        reason: z.string().max(500)
      })).max(50),
      failed: z.number().int().nonnegative()
    }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 60_000
  }),

  // --- Fase 6 (P-37…P-41): agenti, Director, task, approvazioni, audit ----------------------
  'agents.list': defineCommand({
    payload: z.strictObject({ includeArchived: z.boolean().default(false) }),
    result: z.strictObject({ agents: z.array(agentViewSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Crea o aggiorna la definizione di un agente (proprietario). Valida schema e adapter. */
  'agents.define': defineCommand({
    payload: z.strictObject({ definition: agentDefinitionInputSchema }),
    result: z.strictObject({ agentId: z.string(), version: z.number().int().positive(), created: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Archivia una definizione (mai cancellata) dopo aver fermato l'istanza viva. */
  'agents.archive': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64) }),
    result: z.strictObject({ agentId: z.string(), alreadyArchived: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /**
   * P-99 — rinomina il nome mostrato (display name) di un agente, Director incluso. L'id interno
   * non cambia; definizione validata dall'adapter, versione +1, evento/audit, effetto immediato.
   */
  'agents.rename': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64), name: z.string().trim().min(1).max(80) }),
    result: z.strictObject({ agentId: z.string(), name: z.string().max(80), version: z.number().int().positive(), changed: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Ferma l'istanza viva di un agente (sessione salvata, riprendibile). */
  'agents.stop': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64), mode: z.enum(['graceful', 'force']).default('graceful') }),
    result: z.strictObject({ agentId: z.string(), stopped: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /**
   * Avvia o riprende la sessione di un agente senza un turno (P-83): alla wake «Hey Visione» la UI
   * apre la finestra dell'agente e chiede questa sessione reale. Nessun avvio implicito di processi:
   * il comando passa dall'Agent Manager e dalle stesse regole di `runTurn` (fiducia, adapter).
   */
  'agents.start': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64) }),
    result: z.strictObject({
      agentId: z.string(),
      started: z.boolean(),
      status: agentStatusSchema.nullable(),
      approvalId: z.string().nullable(),
      reason: z.string().max(500).nullable()
    }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 60_000
  }),
  /**
   * Modelli applicabili a un agente (P-83): quelli configurati (corrente, altri agenti con lo stesso
   * adapter, `agents.defaultModel`) più quelli sondati dalla CLI dell'adapter; ognuno
   * validato dall'adapter. `effort` (la «potenza») è null se il motore non la dichiara.
   */
  'agents.models': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64), refresh: z.boolean().default(false) }),
    result: z.strictObject({
      agentId: z.string(),
      adapter: z.string(),
      current: z.string().nullable(),
      selectable: z.boolean(),
      models: z.array(z.strictObject({
        id: z.string().min(1).max(200),
        source: z.enum(['configured', 'probe']),
        detail: z.string().max(200).nullable()
      })),
      effort: z.strictObject({ current: z.string().max(32).nullable(), options: z.array(z.string().max(32)).max(12) }).nullable(),
      live: z.boolean(),
      applies: z.enum(['next-turn', 'next-session'])
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 25_000
  }),
  /** Applica modello e/o potenza (effort) alla definizione dell'agente: validati, auditati, visibili. */
  'agents.tuning': defineCommand({
    payload: z.strictObject({
      agentId: z.string().min(1).max(64),
      model: z.string().max(200).optional(),
      effort: z.string().max(32).nullable().optional()
    }),
    result: z.strictObject({
      agentId: z.string(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      version: z.number().int().positive(),
      applies: z.enum(['next-turn', 'next-session']),
      live: z.boolean()
    }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 20_000
  }),
  /**
   * Messaggio diretto del proprietario a un agente (Fase 21, P-67): crea un task assegnato a
   * quell'agente — nessuna pianificazione, nessun passaggio dal Director — eseguito sulla sua
   * sessione reale. Il risultato torna con gli eventi `task.*`/`agent.*` di quell'agente soltanto.
   */
  'agents.tell': defineCommand({
    payload: z.strictObject({
      agentId: z.string().min(1).max(64),
      text: z.string().min(1).max(20_000),
      title: z.string().min(1).max(200).optional()
    }),
    result: z.strictObject({ agentId: z.string(), taskId: z.string(), taskIds: z.array(z.string()) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /**
   * Un obiettivo al Director. Risponde appena il piano è registrato (o, con un planner agente, appena
   * è avviato il turno di pianificazione): l'avanzamento arriva con eventi e `tasks.get`.
   */
  /**
   * «Interrompi» dal pannello di un agente (12/10/2026, richiesta del proprietario): annulla i task non
   * conclusi assegnati a quell'agente (il turno in corso si ferma con l'annullamento del motore).
   */
  'agents.interrupt': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64), reason: z.string().max(200).optional() }),
    result: z.strictObject({ agentId: z.string(), cancelled: z.array(z.string()) }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /** «Interrompi tutto» dal pannello del Director: annulla tutti gli obiettivi non conclusi (e i loro task). */
  'director.interrupt': defineCommand({
    payload: z.strictObject({ reason: z.string().max(200).optional() }),
    result: z.strictObject({ cancelled: z.array(z.string()), goals: z.number().int().nonnegative() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  'director.submit': defineCommand({
    payload: z.strictObject({
      goal: z.string().min(1).max(20_000),
      title: z.string().min(1).max(200).optional(),
      /** Piano esplicito del proprietario (validato: dipendenze, cicli, limiti). */
      plan: planSchema.optional(),
      /** Agente che produce il piano (AgentPlanner); senza piano né planner: RulePlanner. */
      plannerAgentId: z.string().min(1).max(64).optional()
    }),
    result: z.strictObject({
      rootTaskId: z.string(),
      correlationId: z.string(),
      planner: plannerKindSchema,
      taskIds: z.array(z.string())
    }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  'tasks.list': defineCommand({
    payload: z.strictObject({
      rootId: z.string().min(1).max(64).optional(),
      status: z.array(taskStatusSchema).min(1).max(9).optional(),
      /** Solo le radici (obiettivi). */
      rootsOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50)
    }),
    result: z.strictObject({ tasks: z.array(taskSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  'tasks.get': defineCommand({
    payload: z.strictObject({ taskId: z.string().min(1).max(64) }),
    result: z.strictObject({ task: taskSchema, children: z.array(taskSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Annulla un task e, a cascata, i discendenti non terminati. Idempotente. */
  'tasks.cancel': defineCommand({
    payload: z.strictObject({ taskId: z.string().min(1).max(64), reason: z.string().max(200).optional() }),
    result: z.strictObject({ taskId: z.string(), cancelled: z.array(z.string()), alreadyFinished: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  'approvals.list': defineCommand({
    payload: z.strictObject({ status: approvalStatusSchema.optional(), limit: z.number().int().min(1).max(200).default(50) }),
    result: z.strictObject({ approvals: z.array(approvalSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Decisione del proprietario su una richiesta in coda. Solo dalla UI; idempotente. */
  'approvals.decide': defineCommand({
    payload: z.strictObject({ approvalId: z.string().min(1).max(64), decision: z.enum(['grant', 'deny']), note: z.string().max(500).optional() }),
    result: z.strictObject({ approval: approvalSchema, alreadyDecided: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Audit log (sola lettura) con la verifica della catena di hash. */
  'audit.list': defineCommand({
    payload: z.strictObject({ limit: z.number().int().min(1).max(500).default(100) }),
    result: z.strictObject({
      entries: z.array(auditEntrySchema),
      chain: z.strictObject({ ok: z.boolean(), checked: z.number().int().nonnegative(), brokenAt: z.number().int().nullable() })
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Memoria (Fase 7): ricerca FTS5 in tutti gli ambiti o in quelli di un agente/task; senza testo = recenti. */
  'memory.search': defineCommand({
    payload: z.strictObject({
      query: z.string().max(500).default(''),
      /** Ambiti leggibili da questo agente (globale + propria + task della stessa radice di `taskId`). */
      agentId: z.string().min(1).max(64).optional(),
      taskId: z.string().min(1).max(64).optional(),
      includeInactive: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20)
    }),
    result: z.strictObject({ items: z.array(memoryItemSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Scrittura del proprietario in qualunque ambito (il testo è redatto); duplicato = elemento esistente. */
  'memory.write': defineCommand({
    payload: z.strictObject({
      scope: memoryScopeSchema,
      scopeId: z.string().min(1).max(64).nullable().default(null),
      kind: memoryKindSchema.default('fact'),
      title: z.string().max(MEMORY_LIMITS.titleChars).default(''),
      content: z.string().min(1).max(MEMORY_LIMITS.contentChars),
      pinned: z.boolean().default(false)
    }),
    result: z.strictObject({ item: memoryItemSchema, created: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Copia un elemento nella memoria globale. Idempotente. */
  'memory.promote': defineCommand({
    payload: z.strictObject({ itemId: z.string().min(1).max(64) }),
    result: z.strictObject({ item: memoryItemSchema, created: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Riflessione su `memory.md` di un agente fermo: sotto soglia solo con `force`. */
  'memory.reflect': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64), force: z.boolean().default(false) }),
    result: z.strictObject({ applied: z.boolean(), reason: z.string(), beforeChars: z.number().int(), afterChars: z.number().int() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 30_000
  }),
  /** Addestramento (P-107k): catalogo di VISIONE e regole dell'utente, con stato e costo in token. */
  'training.list': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ skills: z.array(skillSchema), perTurn: z.number().int().positive(), recent: z.number().int().nonnegative() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Attiva o toglie una regola (del catalogo o dell'utente). */
  'training.set': defineCommand({
    payload: z.strictObject({ id: z.string().min(1).max(64), active: z.boolean() }),
    result: z.strictObject({ skill: skillSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Regola scritta dall'utente: serve almeno una parola chiave, oppure «sempre». */
  'training.add': defineCommand({
    payload: customSkillInputSchema,
    result: z.strictObject({ skill: skillSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Cancella una regola scritta dall'utente (quelle del catalogo si tolgono con `training.set`). */
  'training.remove': defineCommand({
    payload: z.strictObject({ id: z.string().min(1).max(64) }),
    result: z.strictObject({ removed: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Mappa del codice (P-107l): cartelle di lavoro degli agenti e stato del loro indice. */
  'codemap.status': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ roots: z.array(codeRootSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Aggiorna ora l'indice di una cartella già nota (degli agenti o già indicizzata). */
  'codemap.scan': defineCommand({
    payload: z.strictObject({ root: z.string().min(1).max(1024) }),
    result: z.strictObject({ root: codeRootSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 180_000
  }),
  /** Usa o no la mappa di una cartella nei brief degli agenti. */
  'codemap.set': defineCommand({
    payload: z.strictObject({ root: z.string().min(1).max(1024), enabled: z.boolean() }),
    result: z.strictObject({ root: codeRootSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Cosa riceverebbe un agente per questo compito: la sezione del brief, senza eseguire niente. */
  'codemap.preview': defineCommand({
    payload: z.strictObject({ root: z.string().min(1).max(1024), text: z.string().trim().min(1).max(4_000) }),
    result: z.strictObject({ text: z.string().max(4_000), files: z.number().int().nonnegative() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Terminale (Fase 8, P-45): sessioni PTY visibili (shell del proprietario e agenti). */
  'terminal.list': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ sessions: z.array(terminalSessionSchema) }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Apre una shell del proprietario nella cartella di lavoro: l'eseguibile lo sceglie il core. */
  'terminal.open': defineCommand({
    payload: z.strictObject({ cols: terminalColsSchema.default(100), rows: terminalRowsSchema.default(30) }),
    result: z.strictObject({ session: terminalSessionSchema }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 15_000
  }),
  'terminal.input': defineCommand({
    payload: z.strictObject({ processId: z.string().min(1).max(64), data: z.string().min(1).max(TERMINAL_LIMITS.inputChars) }),
    result: z.strictObject({ bytes: z.number().int().nonnegative() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  'terminal.resize': defineCommand({
    payload: z.strictObject({ processId: z.string().min(1).max(64), cols: terminalColsSchema, rows: terminalRowsSchema }),
    result: z.strictObject({ resized: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Scrollback tenuto dal core per una sessione (all'apertura della vista). */
  'terminal.snapshot': defineCommand({
    payload: z.strictObject({ processId: z.string().min(1).max(64) }),
    // `seq`: ultimo blocco `process.stdout` compreso nel testo (la vista scarta quelli già visti).
    result: z.strictObject({ session: terminalSessionSchema, text: z.string(), truncated: z.boolean(), seq: z.number().int().nonnegative() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Chiude una shell del proprietario (le sessioni degli agenti si fermano con `agents.stop`). */
  'terminal.close': defineCommand({
    payload: z.strictObject({ processId: z.string().min(1).max(64) }),
    result: z.strictObject({ closed: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 15_000
  }),
  /** Configurazione (Fase 8, P-46): lettura e scrittura validata; vale dal prossimo avvio del core. */
  'config.get': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({
      config: z.record(z.string(), z.unknown()), file: z.string(), source: z.enum(['file', 'defaults']),
      problems: z.array(z.string()), restartRequired: z.boolean()
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  'config.update': defineCommand({
    payload: z.strictObject({ patch: z.record(z.string(), z.unknown()) }),
    result: z.strictObject({ config: z.record(z.string(), z.unknown()), changed: z.array(z.string()), restartRequired: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Voce (Fase 9, P-48…P-50): stato, push-to-talk, frase del proprietario, stop, riavvio del processo. */
  'voice.status': defineCommand({
    payload: z.strictObject({}),
    result: voiceStateSchema,
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** `press`/`release` dal pulsante (tenere premuto), `toggle` dalla scorciatoia globale. */
  'voice.ptt': defineCommand({
    payload: z.strictObject({ action: z.enum(['press', 'release', 'toggle']), source: pttSourceSchema.default('ui') }),
    result: z.strictObject({ listening: z.boolean() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  'voice.speak': defineCommand({
    payload: z.strictObject({ text: z.string().trim().min(1).max(VOICE_LIMITS.speakChars) }),
    result: z.strictObject({ ttsId: z.string() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  'voice.stop': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ stopped: z.boolean() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /**
   * Prova del PC per il profilo della voce (16/10/2026): una frase con la voce VISIONE, senza riprodurla.
   * `rtf` = calcolo / durata (null = non misurabile, con `reason`); `recommended` = il profilo consigliato.
   * Su un PC lento la prova dura una decina di secondi.
   */
  'voice.benchmark': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({
      rtf: z.number().min(0).max(100).nullable(),
      audioS: z.number().min(0).max(600),
      spentMs: z.number().min(0),
      reason: z.string().max(300).nullable(),
      recommended: voiceProfileSchema,
      /** Un requisito di sistema che manca alla voce VISIONE (runtime di Visual C++, 18/10/2026), con «Installa». */
      runtime: setupItemSchema.nullable()
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 90_000
  }),
  'voice.restart': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ requested: z.boolean() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Wake word (P-81): accende/spegne l'ascolto della frase; lo stato arriva da `voice.wake.changed`. */
  /** Con chi parla la voce (15/10/2026): un agente, o null = il Director. */
  'voice.talkTo': defineCommand({
    payload: z.strictObject({ agentId: z.string().min(1).max(64).nullable() }),
    result: z.strictObject({ talkTo: z.string().nullable() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  'voice.wake': defineCommand({
    payload: z.strictObject({ enabled: z.boolean() }),
    result: z.strictObject({ enabled: z.boolean(), phrase: z.string() }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /**
   * P-106: registrazione della voce del proprietario. `start` → le frasi dette col push-to-talk diventano
   * impronte; `save` le unisce e salva l'impronta in locale; `cancel` scarta; `clear` cancella l'impronta.
   * `probe`: la prossima frase si giudica soltanto (evento `voice.heard`), senza trascriverla né
   * mandarla al Director (prova nella procedura). L'esito arriva con `voice.enroll.progress`.
   */
  'voice.enroll': defineCommand({
    payload: z.strictObject({ action: z.enum(['start', 'save', 'cancel', 'clear', 'probe']) }),
    result: z.strictObject({ sent: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /**
   * Prova di precisione (24/10/2026): `arm` → la prossima frase detta si trascrive soltanto (evento
   * `voice.accuracy.heard`), senza mandarla al Director; `cancel` annulla. La precisione la calcola la UI.
   */
  'voice.accuracy': defineCommand({
    payload: z.strictObject({ action: z.enum(['arm', 'cancel']) }),
    result: z.strictObject({ armed: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /**
   * P-105: modelli d'ascolto (VAD e STT) presenti o da scaricare, con dimensione e licenza. P-106: `set`
   * `filters` = i modelli facoltativi dei filtri (impronta vocale e pulizia del rumore).
   */
  'voice.models.status': defineCommand({
    payload: z.strictObject({ set: z.enum(['listening', 'filters']).optional() }),
    result: z.strictObject({
      modelsDir: z.string().max(1_000),
      complete: z.boolean(),
      downloading: z.boolean(),
      missing: z.array(z.strictObject({ id: z.string().max(80), role: z.string().max(10), size: z.number().int().nonnegative(), license: z.string().max(40), url: z.string().max(400) })).max(10)
    }),
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /**
   * P-105: scarica su consenso i modelli d'ascolto mancanti (dimensione e SHA-256 verificati) e poi
   * riavvia la voce. Risponde subito; l'avanzamento arriva con `voice.models.progress`.
   */
  'voice.models.download': defineCommand({
    payload: z.strictObject({ set: z.enum(['listening', 'filters']).optional() }),
    result: z.strictObject({ started: z.boolean(), alreadyComplete: z.boolean(), totalBytes: z.number().int().nonnegative() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  /** Modalità offline (17/10/2026): rete, modalità attiva, modello locale. */
  'offline.status': defineCommand({
    payload: z.strictObject({}),
    result: offlineStateSchema,
    mutating: false,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Tasto «Entra in modalità offline» / «Torna online». */
  'offline.set': defineCommand({
    payload: z.strictObject({ active: z.boolean() }),
    result: offlineStateSchema,
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  }),
  /** Una richiesta scritta mentre si è offline: la tratta il modello locale (può doverlo prima caricare). */
  'offline.ask': defineCommand({
    payload: z.strictObject({ text: z.string().trim().min(1).max(OFFLINE_LIMITS.textChars) }),
    result: offlineReplySchema,
    mutating: true,
    uiAllowed: true,
    timeoutMs: 120_000
  }),
  /** Scarica su consenso il modello locale (dimensione e SHA-256 verificati); avanzamento con `offline.model.progress`. */
  'offline.model.download': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ started: z.boolean(), alreadyComplete: z.boolean(), totalBytes: z.number().int().nonnegative() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 10_000
  }),
  'offline.model.cancel': defineCommand({
    payload: z.strictObject({}),
    result: z.strictObject({ cancelled: z.boolean() }),
    mutating: true,
    uiAllowed: true,
    timeoutMs: 5_000
  })
} as const;

/** Registro dei comandi; iniettabile nel router e nel main (i test usano registri propri). */
export type CommandRegistry = Readonly<Record<string, CommandDefinition>>;

export type CommandType = keyof typeof COMMAND_DEFINITIONS;
export type CommandPayload<T extends CommandType> = z.output<(typeof COMMAND_DEFINITIONS)[T]['payload']>;
export type CommandInput<T extends CommandType> = z.input<(typeof COMMAND_DEFINITIONS)[T]['payload']>;
export type CommandResult<T extends CommandType> = z.output<(typeof COMMAND_DEFINITIONS)[T]['result']>;

export function isCommandType(type: string): type is CommandType {
  return Object.hasOwn(COMMAND_DEFINITIONS, type);
}
