// Kernel del core: bootstrap in ordine, gestione dei frame dal main, spegnimento cooperativo
// e gestione degli errori fatali. Le dipendenze arrivano dall'esterno (testabile con fake).
//
// Catena (P-25…P-29): comando → router → eventi (validati, journal, poi stato) → bus →
// trasporto verso il main → UI. Lo stato deriva dagli eventi ed è spinto alla UI come evento
// effimero `state.changed`, raggruppato (al più uno ogni `STATE_PUSH_MS`).
//
// CLI Runtime (Fase 5, P-35): policy (radici workspace, agents, runtime) → runtime (unica porta di
// creazione dei processi, eventi `process.*` su questo bus) → adapter del catalogo; canale degli
// hook avviato qui; riconciliazione degli orfani dopo `ready`; stop di tutti i processi e chiusura
// degli hook prima di `system.stopped`.
//
// Orchestrazione (Fase 6, P-37…P-41): policy delle azioni → audit log (catena verificata
// all'avvio) → coda delle approvazioni → Agent Manager (sopra adapter e runtime) → Task Engine →
// Director → canale a file dei messaggi. All'avvio: istanze rimaste aperte → crashed, task
// `running` → di nuovo in coda (o `lost`); dopo la riconciliazione dei processi si riprende a
// pianificare. Allo spegnimento: task sospesi (di nuovo in coda), agenti fermati, poi i processi.
//
// Memoria (Fase 7, P-42…P-44): archivio e Context Builder creati prima dell'Agent Manager (che usa
// il Context Builder per i brief) e legati in ritardo a Task Engine e agenti; turni aperti di un
// core caduto chiusi come `lost` al recupero; `memory.md` reindicizzati all'avvio.
import { dirname, join } from 'node:path';
import { emptyTaskCounts, mainToCoreFrameSchema, formatIssues, languageFromLocale, defaultPersona, DEFAULT_AGENT_NAMES_EN, type AgentDefinitionInput, type CoreStatus, type Language, type TaskStatus } from '../../shared/contracts/index.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import { DEFAULT_CONFIG, loadConfig } from '../../shared/node/config.ts';
import { createFileSink, createLogger, type LogSink } from '../../shared/node/logging.ts';
import { ensureDirs, protectedUserRoots, type VisionePaths } from '../../shared/node/paths.ts';
import { createAdapterRegistry, createBuiltinAdapters, type AgentAdapter, type BuiltinAdapterDeps } from '../adapters/index.ts';
import { createActionGate, createAgentManager, registerAgentCommands, resolveWorkspace, type AgentManager } from '../agents/index.ts';
import { createApprovalQueue } from '../approvals/index.ts';
import { createAuditLog } from '../audit/index.ts';
import { createEventBus } from '../bus/index.ts';
import { createCommandRouter } from '../commands/index.ts';
import { openDatabase, type Db } from '../db/index.ts';
import { createDirector, registerDirectorCommands } from '../director/index.ts';
import { registerEngineCommands } from '../engines/index.ts';
import { registerSetupCommands } from '../setup/index.ts';
import { createEventEmitter, type EventEmitter } from '../events/index.ts';
import { createJournal } from '../journal/index.ts';
import { registerConfigCommands } from '../config/index.ts';
import { createMemory, registerMemoryCommands, type TaskReader } from '../memory/index.ts';
import { createTraining, registerTrainingCommands } from '../training/index.ts';
import { createCodeMap, registerCodeMapCommands } from '../codemap/index.ts';
import { createTerminalManager, registerTerminalCommands, type ShellSpec } from '../terminal/index.ts';
import { createTelemetry, type SystemSampler, type Telemetry } from '../telemetry/index.ts';
import { createMessageChannel, type MessageChannel } from '../messages/index.ts';
import { createActionPolicy } from '../policy/index.ts';
import {
  createCliRuntime,
  createHookServer,
  createRuntimePolicy,
  hookPipeAddress,
  type CliRuntime,
  type ProcessTools,
  type PtyModule
} from '../runtime/index.ts';
import { createLifecycle, createStateStore, recoverState, type DomainCounts, type StateReader, type StateStore } from '../state/index.ts';
import { createAppCatalog, createSystemControl, registerSystemCommands } from '../system/index.ts';
import { createWeather, registerWeatherCommands } from '../weather/index.ts';
import { createFaceService, registerVisionCommands } from '../vision/index.ts';
import { createGroups, registerGroupCommands, type Groups } from '../groups/index.ts';
import { cleanQuip, composeBriefing, createAssistant, quipPrompt, registerAssistantCommands, type BriefingEngine, type BriefingWeather } from '../assistant/index.ts';
import { probeAdapter } from '../engines/index.ts';
import { createFileManager, registerFileCommands } from '../files/index.ts';
import { createSupport, registerSupportCommands } from '../support/index.ts';
import { createTaskEngine, type TaskEngine } from '../tasks/index.ts';
import { createVoiceController, parseVoiceCommand, registerVoiceCommands, registerVoiceModelCommands, type VoiceController } from '../voice/index.ts';
import { createOffline, createWorkerModel, registerOfflineCommands, type Offline } from '../offline/index.ts';
import type { CoreTransport } from './transport.ts';

export { createProcessTransport, type CoreTransport } from './transport.ts';

export type CoreLifecycle = 'running' | 'stopping' | 'stopped' | 'failed';

export interface CoreDeps {
  transport: CoreTransport;
  paths: VisionePaths;
  env: NodeJS.ProcessEnv;
  pid: number;
  /** Pid del main che ha avviato il core (recupero dello stato dell'applicazione). */
  parentPid?: number | null;
  coreVersion: string;
  /** Uscita del processo; nei test un fake. */
  exit: (code: number) => void;
  logSinks?: LogSink[];
  now?: () => number;
  /** Intervallo di raggruppamento delle notifiche di stato (default `STATE_PUSH_MS`). */
  statePushMs?: number;
  /** Adapter dei motori (default: catalogo incluso); i test ne iniettano di finti. */
  adapters?: (deps: BuiltinAdapterDeps) => AgentAdapter[];
  /** Test: forza l'attivazione/disattivazione degli agenti predefiniti (default: dalla configurazione). */
  seedDefaultAgents?: boolean;
  /** Strumenti di processo e PTY del runtime (default: reali). */
  runtime?: { tools?: ProcessTools; loadPty?: () => Promise<PtyModule> };
  /** Shell della vista Terminale (default: PowerShell di Windows); i test ne iniettano una finta. */
  terminalShell?: () => Promise<ShellSpec | null>;
  /** Telemetria di sistema (Fase 14): sampler iniettabile e spegnimento nei test/dispositivi senza. */
  telemetry?: { enabled?: boolean; sampler?: SystemSampler };
  /** Modalità offline (17/10/2026): sonda di rete iniettabile; `enabled: false` = nessuna sonda (test). */
  offline?: { enabled?: boolean; probe?: () => Promise<boolean> };
  /** Canale degli hook occupato: attesa fra i tentativi e quanti (default 1,5 s × 40); i test li accorciano. */
  hooksRetry?: { ms: number; attempts: number };
}

export interface CoreHandle {
  readonly lifecycle: CoreLifecycle;
  readonly state: StateReader;
  /** CLI Runtime del core (unica porta di creazione dei processi). */
  readonly runtime: CliRuntime;
  /** Orchestrazione (Fase 6). */
  readonly agents: AgentManager;
  readonly tasks: TaskEngine;
  /** Voce (Fase 9): stato e comandi; il processo voce è del main. */
  readonly voice: VoiceController;
  /** Telemetria di sistema (Fase 14): campioni reali e aggregati. */
  readonly telemetry: Telemetry;
  stop(reason: string, deadlineMs: number): Promise<void>;
  /** Errore non gestito: registra `system.error`, avvisa il main ed esce con codice 1. */
  fail(err: unknown, code: string): void;
}

// Margine per consegnare l'ultimo frame prima dell'uscita del processo.
const EXIT_FLUSH_MS = 50;
/** Tempo concesso ai processi figli dopo un errore fatale del core. */
const FATAL_STOP_MS = 3_000;
/** Canale degli hook occupato dal core di prima: un tentativo ogni 1,5 s per un minuto. */
const HOOKS_RETRY_MS = 1_500;
const HOOKS_START_ATTEMPTS = 40;
/** Tetto della verifica di ogni motore nel saluto di stato (12/10/2026): oltre, «non verificato». */
const BRIEFING_ENGINE_CHECK_MS = 12_000;
/** Tetto del meteo e della battuta nel saluto (22/10/2026): ognuno, dentro quello dei motori. */
const BRIEFING_EXTRA_MS = 4_000;
/** Al più una notifica di stato ogni 16 ms (un fotogramma a 60 Hz). */
export const STATE_PUSH_MS = 16;

/** Conteggi del dominio all'avvio, letti dalle tabelle dei proprietari (prima del recupero). */
function readDomainCounts(db: Db): DomainCounts {
  const one = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
  const tasks = emptyTaskCounts();
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all()) {
    const status = String(r.status) as TaskStatus;
    if (status in tasks) tasks[status] = Number(r.n);
  }
  return {
    agentsDefined: one('SELECT COUNT(*) AS n FROM agent_definitions WHERE archived = 0'),
    agentsLive: one("SELECT COUNT(*) AS n FROM agent_instances WHERE status NOT IN ('stopped', 'crashed')"),
    agentsWorking: one("SELECT COUNT(*) AS n FROM agent_instances WHERE status = 'working'"),
    tasks,
    activeGoals: one("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'goal' AND status IN ('created', 'queued', 'running', 'waiting')"),
    approvalsPending: one("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")
  };
}

export function startCore(deps: CoreDeps): CoreHandle {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { transport, paths } = deps;

  ensureDirs(paths);
  const loaded = loadConfig(paths.configFile, { env: deps.env, createIfMissing: true });
  const log = createLogger({
    proc: 'core',
    level: loaded.config.logging.level,
    sinks: deps.logSinks ?? [createFileSink(paths.logsDir, 'core')],
    now
  });
  for (const problem of loaded.problems) log.warn('configurazione: uso i default', { problem });
  // Il file come letto all'avvio, senza gli override dell'ambiente (impostazioni dalla UI, P-46).
  const bootFileConfig = loadConfig(paths.configFile, { env: {} });

  // Un file corrotto viene messo da parte; gli altri errori (lock, permessi) fermano l'avvio e il
  // supervisore riprova con backoff.
  const opened = openDatabase(paths.dbFile, {
    backupFile: (from) => join(paths.backupsDir, `visione-v${from}-${startedAt}.db`),
    now
  });
  const { db, migration } = opened;
  if (opened.quarantined) log.error('database illeggibile messo da parte', { file: opened.quarantined, reason: opened.quarantineReason });
  if (migration.applied.length > 0) log.info('database migrato', { ...migration });

  let store: StateStore | null = null;
  const journal = createJournal(db, {
    onCorruptRow: (seq, problem) => {
      log.warn('riga del journal illeggibile saltata', { seq, problem });
      store?.apply({ kind: 'corrupt-row' });
    }
  });
  const recovered = recoverState(journal, deps.parentPid ?? null);
  const state = createStateStore({
    domain: readDomainCounts(db),
    bootId: ulid(startedAt),
    pid: deps.pid,
    startedAt,
    appVersion: deps.env.VISIONE_APP_VERSION ?? deps.coreVersion,
    coreVersion: deps.coreVersion,
    dbSchema: migration.to,
    edition: deps.env.VISIONE_EDITION === 'tester' ? 'tester' : 'sviluppo',
    quarantined: opened.quarantined,
    recovered
  }, { now, onListenerError: (err) => log.error('errore in un osservatore dello stato', { err }) });
  store = state;

  const bus = createEventBus({
    onListenerError: (err, event, name) => log.error('errore in un sottoscrittore del bus', { type: event.type, subscriber: name ?? null, err }),
    onOverflow: (dropped, event, name) => log.warn('coda del bus piena: evento scartato', { dropped, type: event.type, subscriber: name ?? null }),
    onLeakWarning: (subscribers) => log.warn('troppi sottoscrittori attivi sul bus: possibile perdita', { subscribers })
  });

  let events: EventEmitter;
  const syncPending = (): void => {
    const health = events.health();
    if (health.status === 'degraded' && health.pending !== state.snapshot().database.pendingWrites) {
      state.apply({ kind: 'journal', status: 'degraded', pending: health.pending, lastError: health.lastError, lastSeq: null, flushed: 0 });
    }
  };
  events = createEventEmitter({
    db,
    journal,
    bus,
    now,
    onCommitted: (committed) => {
      for (const event of committed) state.apply({ kind: 'event', event });
      syncPending();
    },
    onJournalChange: (change) => {
      const h = change.health;
      state.apply({ kind: 'journal', status: h.status, pending: h.pending, lastError: h.lastError, lastSeq: change.lastSeq, flushed: change.flushed });
      if (h.status === 'degraded') {
        log.error('journal non disponibile: eventi durevoli in attesa', { error: h.lastError, pending: h.pending });
        events.emit('system.journal.degraded', { error: h.lastError, pending: h.pending });
      } else {
        log.info('journal di nuovo disponibile', { flushed: change.flushed, lost: change.lost, downMs: change.downMs });
        events.emit('system.journal.restored', { flushed: change.flushed, lost: change.lost, downMs: change.downMs });
      }
    },
    onRejected: (event, problem) => log.error('evento scartato', { type: event.type, problem })
  });
  const forward = bus.subscribe((event) => transport.send({ kind: 'evt', event }), { name: 'transport' });

  // Notifiche di stato raggruppate: le chiavi cambiate si accumulano fino all'invio.
  const pushMs = deps.statePushMs ?? STATE_PUSH_MS;
  const changedKeys = new Set<string>();
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const pushState = (): void => {
    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = null;
    if (changedKeys.size === 0) return;
    const changed = [...changedKeys];
    changedKeys.clear();
    events.emit('state.changed', { snapshot: state.snapshot(), changed });
  };
  state.subscribe((_snapshot, changed) => {
    for (const key of changed) changedKeys.add(key);
    pushTimer ??= setTimeout(pushState, pushMs);
  });

  const lifecycle = createLifecycle({
    previous: recovered.previousRun,
    emitChange: (from, to, reason, inferred) => {
      // Una caduta dedotta all'avvio (VISIONE chiusa di forza: aggiornamento, PC spento) è passata e già recuperata: un
      // avviso, non un errore rosso nella schermata d'avvio (VM beta.31, 23/10/2026).
      events.emit('system.lifecycle.changed', { from, to, reason, inferred }, { severity: to === 'crashed' ? (inferred ? 'warning' : 'error') : 'info' });
    },
    onRejected: (result) => log.warn('transizione del ciclo di vita rifiutata', { ...result })
  });

  if (opened.quarantined) {
    events.emit('system.db.quarantined', { file: opened.quarantined, reason: opened.quarantineReason ?? 'sconosciuto' });
  }
  events.emit('system.started', { pid: deps.pid, coreVersion: deps.coreVersion, schemaVersion: migration.to });

  const previous: CoreStatus | null = recovered.previousRun;
  const unclean = previous !== null && previous !== 'stopped';
  if (unclean) {
    log.warn('l\'avvio precedente non si è chiuso in modo pulito: recupero', { previous });
    if (previous !== 'crashed') lifecycle.transition('crashed', `uscita non pulita (ultimo stato: ${previous})`, { inferred: true });
    lifecycle.transition('recovering', 'recupero dopo uscita non pulita');
  } else {
    lifecycle.transition('starting', 'avvio');
  }

  const router = createCommandRouter({
    db,
    events,
    log: log.child('commands'),
    defaultTimeoutMs: loaded.config.ipc.commandTimeoutMs,
    now
  });
  // Catalogo dei programmi installati: lo usano il launcher e la modalità offline («aprimi la calcolatrice»).
  const apps = createAppCatalog();
  registerSystemCommands({
    router,
    journal,
    state: state.reader,
    info: { coreVersion: deps.coreVersion, pid: deps.pid, startedAt, schemaVersion: migration.to },
    apps,
    control: createSystemControl({ home: paths.home, events }),
    now
  });
  // Widget Meteo (11/10/2026): rete solo verso i due host del meteo, solo a widget acceso.
  // Un solo servizio meteo per widget e saluto: stessa memoria, nessuna richiesta doppia a MET.
  const weather = createWeather({ userAgent: `VISIONE/${deps.env.VISIONE_APP_VERSION ?? deps.coreVersion} (widget meteo; +https://github.com/arthadal)` });
  registerWeatherCommands(router, weather);
  // Widget Umanoide (11/10/2026): volto nella webcam col rilevatore di Windows, solo a webcam accesa.
  const faces = createFaceService({ log: (line) => log.warn(line) });
  registerVisionCommands(router, faces);

  const runtimeConfig = loaded.config.runtime;
  const hooks = createHookServer({ address: hookPipeAddress(paths.home), log: log.child('hooks'), responseTimeoutMs: runtimeConfig.hookResponseMs });
  const runtime = createCliRuntime({
    db,
    events,
    log: log.child('runtime'),
    // Le cartelle degli agenti fuori da queste radici le aggiungerà chi crea l'agente (allowRoot).
    policy: createRuntimePolicy({ roots: [paths.workspaceDir, paths.agentsDir, paths.runtimeDir] }),
    inheritedEnv: deps.env,
    systemCwd: paths.runtimeDir,
    stopGraceMs: runtimeConfig.stopGraceMs,
    maxProcesses: runtimeConfig.maxProcesses,
    versionTimeoutMs: runtimeConfig.versionTimeoutMs,
    now,
    ...(deps.runtime?.tools ? { tools: deps.runtime.tools } : {}),
    ...(deps.runtime?.loadPty ? { loadPty: deps.runtime.loadPty } : {}),
    onCliResult: (r) => {
      if (r.found) events.emit('system.cli.discovered', { name: r.name, path: r.path.slice(0, 1024), kind: r.kind, version: r.version });
      else events.emit('system.cli.missing', { name: r.name, problem: r.problem.slice(0, 500) });
    }
  });
  // --- Orchestrazione (Fase 6) -------------------------------------------------------------
  const userHome = deps.env.USERPROFILE ?? deps.env.HOME;
  // Progetti di riferimento mai scrivibili dall'interno di VISIONE (VISIONE_SECURITY_MODEL §2).
  const protectedRoots = userHome ? protectedUserRoots(userHome) : [];
  // P-102: percorsi custoditi = ciò che governa la policy (config, dati, shim degli hook) più i file
  // dei motori dichiarati dagli adapter (aggiunti sotto, quando il registro esiste: stesso array).
  const guardedPatterns: RegExp[] = [];
  const policy = createActionPolicy({
    protectedRoots,
    guardedRoots: [dirname(paths.configFile), paths.dataDir, paths.runtimeDir],
    guardedPatterns
  });
  const trustedAgents = new Set(loaded.config.policy.trustedAgents);
  if (trustedAgents.size > 0) log.info('modalità fiducia attiva', { agents: [...trustedAgents] });
  // 24/10/2026, dal proprietario: «il Director deve essere sempre autorizzato» e «anche loro, se sono io a chiederlo
  // a loro o tramite il Director»: ogni lavoro degli agenti parte da una sua richiesta, quindi tutta la squadra è in
  // fiducia. Blocchi e percorsi custoditi restano per chi passa dal controllo delle azioni.
  const isTrustedAgent = (agentId: string): boolean => trustedAgents.has(agentId) || agentId !== '';
  const audit = createAuditLog(db, { now });
  // --- Shell: File Manager (Fase 24b, P-72) -------------------------------------------------
  if (userHome) {
    registerFileCommands({
      router,
      files: createFileManager({ home: userHome, visionHome: paths.home, protectedRoots, events, audit, log: log.child('files'), language: () => language })
    });
  } else {
    log.warn('file manager non attivo: home utente non determinabile');
  }
  // --- Segnala un problema (11/10/2026): pacchetto ripulito da allegare a un'email ----------------
  registerSupportCommands(router, createSupport({
    visionHome: paths.home,
    logsDir: paths.logsDir,
    privacy: { userHome: userHome ?? '', userName: deps.env.USERNAME ?? '', computerName: deps.env.COMPUTERNAME ?? '' },
    app: { versione: deps.env.VISIONE_APP_VERSION ?? deps.coreVersion, core: deps.coreVersion, edizione: deps.env.VISIONE_EDITION === 'tester' ? 'tester' : 'sviluppo', schema: migration.to },
    snapshot: () => state.snapshot() as unknown as Record<string, unknown>,
    config: () => loaded.config,
    audit,
    log: log.child('support')
  }));
  const chain = audit.verify();
  if (!chain.ok) {
    log.error('catena dell\'audit log rotta', { ...chain });
    events.emit('error.invariant', { code: 'audit-chain-broken', message: `audit log alterato alla riga ${chain.brokenAt} (${chain.checked} righe verificate)` });
  }
  const approvals = createApprovalQueue({ db, events, audit, now });
  let agents: AgentManager | null = null;
  const decideAction = createActionGate({
    policy, approvals, audit, events, log: log.child('policy'),
    rootsOf: (agentId) => {
      const def = agents?.get(agentId);
      return def ? [resolveWorkspace(def, paths.workspaceDir), join(paths.agentsDir, agentId)] : [];
    },
    isTrusted: (agentId) => isTrustedAgent(agentId)
  });
  const adapters = createAdapterRegistry((deps.adapters ?? createBuiltinAdapters)({ runtime, shimDir: paths.shimsDir, decideAction, isTrusted: (agentId) => isTrustedAgent(agentId) }));
  for (const a of adapters.list()) guardedPatterns.push(...(a.guardedPatterns ?? []));
  registerEngineCommands({ router, runtime, adapters, log: log.child('engines'), agents: () => agents, audit, events });
  // Terminale come vista e impostazioni (Fase 8, P-45, P-46): sopra runtime, bus e audit esistenti.
  const terminal = createTerminalManager({
    runtime, bus, events, audit, log: log.child('terminal'), cwd: paths.workspaceDir,
    inputAllowed: (owner) => owner.adapter !== null && (adapters.get(owner.adapter)?.capabilities.has('terminal.input') ?? false),
    // P-94: il × di una scheda d'agente ferma la sessione dall'Agent Manager (creato più sotto:
    // legame in ritardo come per gli altri riferimenti).
    stopAgentSession: (agentId, reason, correlationId) => agents?.stop(agentId, { mode: 'force', reason, by: 'owner:terminal', correlationId }) ?? Promise.resolve(false),
    ...(deps.terminalShell ? { resolveShell: deps.terminalShell } : {})
  });
  registerTerminalCommands({ router, terminal });
  registerSetupCommands({ router, adapters, log: log.child('setup'), agents: () => agents, openTerminal: (opts) => terminal.open(opts), shell: () => terminal.shell(), language: () => language });
  // P-105: chi comanda si applica subito, senza riavvio (letto dal Director a ogni invio).
  let plannerDefault = loaded.config.director.plannerAgentId;
  let voiceConfig = loaded.config.voice;
  // Lingua di VISIONE (P-108): `ui.language`, o quella di Windows passata dal main. Voce e Assistente la seguono.
  const languageOf = (set: Language | undefined): Language => set ?? languageFromLocale(deps.env.VISIONE_LOCALE ?? Intl.DateTimeFormat().resolvedOptions().locale);
  let language = languageOf(loaded.config.ui.language);
  let weatherCity = loaded.config.ui.weatherCity;
  // Modalità offline: `offline.auto` vale subito (legame in ritardo: il modulo nasce dopo l'Assistente).
  let offlineAuto = loaded.config.offline.auto;
  let offlineRef: Offline | null = null;
  let groupsRef: Groups | null = null;
  // Procedura guidata finita almeno una volta: prima, il saluto d'avvio è solo un benvenuto.
  let setupDone = loaded.config.setup.completedVersion > 0;
  registerConfigCommands({ router, events, audit, file: paths.configFile, bootFileConfig: bootFileConfig.config, onApplied: (config) => { plannerDefault = config.director.plannerAgentId; voiceConfig = config.voice; language = languageOf(config.ui.language); weatherCity = config.ui.weatherCity; offlineAuto = config.offline.auto; setupDone = config.setup.completedVersion > 0; offlineRef?.configChanged(); } });
  // Memoria e Context Builder (Fase 7): leggono task e agenti, creati dopo (legame in ritardo).
  let engineRef: TaskEngine | null = null;
  const taskReader: TaskReader = {
    get: (id) => engineRef?.get(id) ?? null,
    children: (id) => engineRef?.children(id) ?? [],
    list: (filter) => engineRef?.list(filter) ?? []
  };
  // Addestramento (P-107k): regole di lavoro scelte dall'utente, nel brief solo quando servono.
  const training = createTraining({
    db, now, language: () => language,
    // Gli ultimi 50 obiettivi dell'utente: le regole spente che li avrebbero riguardati diventano consigli.
    recentTexts: () => engineRef?.list({ rootsOnly: true, limit: 50 }).map((t) => `${t.title}\n${t.spec.slice(0, 1_000)}`) ?? []
  });
  registerTrainingCommands(router, training);
  // Mappa del codice (P-107l): indice delle cartelle di lavoro degli agenti attivi, nel brief solo la parte pertinente.
  const codeMap = createCodeMap({ db, log: log.child('codemap'), now, roots: () => agents?.active().map((d) => resolveWorkspace(d, paths.workspaceDir)) ?? [] });
  registerCodeMapCommands(router, codeMap);
  const memory = createMemory({
    db, events, log: log.child('memory'), journal, agentsDir: paths.agentsDir, config: loaded.config.memory, now, tasks: taskReader, skills: training,
    codeMap: { forTurn: (def, text) => codeMap.forTurn(resolveWorkspace(def, paths.workspaceDir), text) },
    language: () => language,
    // I gruppi nascono dopo la memoria: legati in ritardo.
    team: (taskId) => groupsRef?.teamBrief(taskId) ?? [],
    agents: { ids: () => agents?.active().map((d) => d.id) ?? [], isBusy: (id) => agents?.isBusy(id) ?? false }
  });
  const manager = createAgentManager({
    db, events, log: log.child('agents'), adapters, runtime, hooks, audit, approvals, policy,
    agentsDir: paths.agentsDir, workspaceDir: paths.workspaceDir, now, context: memory.context,
    defaultModel: loaded.config.agents.defaultModel.trim()
  });
  agents = manager;
  /** L'adapter dichiara di accettare il modello? (P-83: nessun modello passato a un motore estraneo.) */
  const adapterSupportsModel = (adapterId: string, model: string): boolean => adapters.get(adapterId)?.supportsModel?.(model) === true;
  // Agenti predefiniti al primo avvio (Fase 12.6): solo se il registro è vuoto. I ruoli non nominano un
  // motore; si assegna a ciascuno un adapter del registro (nessun provider cablato). Un errore non ferma l'avvio.
  const seedDefaultAgents = deps.seedDefaultAgents ?? loaded.config.agents.seedDefaults;
  const defaultModel = loaded.config.agents.defaultModel.trim();
  if (seedDefaultAgents && manager.active().length === 0) {
    const adapterIds = adapters.list().map((a) => a.id);
    if (adapterIds.length === 0) log.warn('nessun motore disponibile per gli agenti predefiniti');
    loaded.config.agents.defaults.forEach((seed, i) => {
      const wanted = seed.model?.trim() || defaultModel;
      // P-83: il modello predefinito si assegna solo ai motori che lo dichiarano (prima poteva
      // finire su un motore che non lo accetta e rendere l'agente inavviabile).
      const definitionFor = (adapter: string): AgentDefinitionInput => {
        const model = wanted && adapterSupportsModel(adapter, wanted) ? wanted : '';
        // Inglese (P-108): i tre agenti predefiniti con nome e ruolo inglesi, se non sono stati cambiati.
        const english = language === 'en' ? DEFAULT_AGENT_NAMES_EN[seed.id] : undefined;
        return {
          id: seed.id,
          name: english && DEFAULT_CONFIG.agents.defaults.some((d) => d.id === seed.id && d.name === seed.name) ? english.name : seed.name,
          role: english && DEFAULT_CONFIG.agents.defaults.some((d) => d.id === seed.id && d.role === seed.role) ? english.role : seed.role,
          competences: seed.competences,
          engine: { adapter, ...(model ? { model } : {}) },
          persona: defaultPersona(language),
          workspace: { root: seed.id, isolation: 'shared' },
          permissions: 'read-only',
          limits: { maxTurnMinutes: 10, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
        };
      };
      // P-91: la rotazione parte dal seed, ma sceglie il primo motore che ACCETTA la definizione.
      // Un adapter configurato per-agente (pty-generic senza `command`) non è assegnabile a un seed
      // e prima faceva fallire la creazione, consumando un giro di rotazione. La validazione avviene
      // nel percorso reale (`define` valida prima di scrivere): nessun effetto su un motore scartato.
      const start = i % adapterIds.length;
      const order = [...adapterIds.slice(start), ...adapterIds.slice(0, start)];
      let lastError: unknown = null;
      for (const candidate of order) {
        try {
          manager.define(definitionFor(candidate), 'system:defaults', `seed-${seed.id}`);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError !== null) {
        log.warn('agente predefinito non creato: nessun motore accetta la definizione', { id: seed.id, err: lastError });
      }
    });
    if (manager.active().length > 0) log.info('agenti predefiniti creati', { count: manager.active().length });
  }
  // Fase 20 (P-66): completa il modello dei seed già esistenti che non ne hanno uno (idempotente:
  // dopo l'applicazione `engine.model` è valorizzato e il blocco non riscrive nulla).
  if (seedDefaultAgents && defaultModel !== '') {
    for (const seed of loaded.config.agents.defaults) {
      const current = manager.get(seed.id);
      if (!current || current.engine.model) continue;
      const wanted = seed.model?.trim() || defaultModel;
      if (!adapterSupportsModel(current.engine.adapter, wanted)) {
        log.info('modello predefinito non applicato: il motore non lo dichiara', { id: seed.id, adapter: current.engine.adapter, model: wanted });
        continue;
      }
      try {
        manager.define({
          id: current.id,
          name: current.name,
          role: current.role,
          competences: current.competences,
          engine: { ...current.engine, model: wanted },
          persona: current.persona,
          workspace: current.workspace,
          permissions: current.permissions,
          limits: current.limits
        }, 'system:default-model', `default-model-${seed.id}`);
        log.info('modello predefinito applicato a un agente seed', { id: seed.id, model: wanted });
      } catch (err) {
        log.warn('modello predefinito non applicato', { id: seed.id, err });
      }
    }
  }
  // P-83: un modello che l'adapter non dichiara (rimasto su un agente da un avvio precedente) rende
  // l'agente inavviabile: si riparte dal default del motore, con log e audit della modifica
  // (nessuna configurazione riscritta in silenzio).
  for (const def of manager.active()) {
    const model = def.engine.model;
    const adapter = adapters.get(def.engine.adapter);
    if (!model || !adapter?.supportsModel || adapter.supportsModel(model)) continue;
    try {
      manager.define({
        id: def.id, name: def.name, role: def.role, competences: def.competences,
        engine: { ...def.engine, model: undefined },
        persona: def.persona, workspace: def.workspace, permissions: def.permissions, limits: def.limits
      }, 'system:model-repair', `model-repair-${def.id}`);
      log.warn('modello non applicabile rimosso: si usa il default del motore', { id: def.id, adapter: def.engine.adapter, model });
    } catch (err) {
      log.warn('riparazione del modello non riuscita', { id: def.id, model, err });
    }
  }
  // P-83: agente di ripiego per il limite di quota. Se `defaultModel` è configurato, si garantisce
  // un agente con l'adapter che lo dichiara: è il bersaglio del reinstradamento del Director.
  // Mai creato senza un modello reale.
  const limitFallback = loaded.config.agents.limitFallback;
  if (seedDefaultAgents && limitFallback.enabled && defaultModel !== '' && !manager.get(limitFallback.agentId)) {
    const adapter = adapters.list().find((a) => a.supportsModel?.(defaultModel) === true);
    if (!adapter) {
      log.warn('nessun motore dichiara il modello predefinito: agente di ripiego non creato', { model: defaultModel });
    } else {
      try {
        manager.define({
          id: limitFallback.agentId,
          name: limitFallback.name,
          role: 'Ripiego quando un motore raggiunge il limite di quota',
          competences: ['general', 'reasoning'],
          engine: { adapter: adapter.id, model: defaultModel },
          persona: defaultPersona(language),
          workspace: { root: limitFallback.agentId, isolation: 'shared' },
          permissions: 'read-only',
          limits: { maxTurnMinutes: 10, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
        }, 'system:fallback', `limit-fallback-${limitFallback.agentId}`);
        log.info('agente di ripiego per il limite creato', { id: limitFallback.agentId, adapter: adapter.id, model: defaultModel });
      } catch (err) {
        log.warn('agente di ripiego non creato', { id: limitFallback.agentId, err });
      }
    }
  }
  // P-91: agente coder, garantito come il ripiego. Il modello è quello configurato in
  // `agents.coder.model` (vuoto = `agents.defaultModel`); senza un modello che un adapter dichiari,
  // l'agente non viene creato (nessun motore o modello inventato).
  const coder = loaded.config.agents.coder;
  if (seedDefaultAgents && coder.enabled && !manager.get(coder.agentId)) {
    const model = coder.model.trim() || defaultModel;
    if (model === '') {
      log.info('agente coder non creato: nessun modello configurato', { id: coder.agentId });
    } else {
      const adapter = adapters.list().find((a) => a.supportsModel?.(model) === true);
      if (!adapter) {
        log.warn('nessun motore dichiara il modello del coder: agente non creato', { model });
      } else {
        try {
          manager.define({
            id: coder.agentId,
            name: coder.name,
            role: 'Programmatore: scrive e modifica codice nella propria cartella di lavoro',
            competences: ['code'],
            engine: { adapter: adapter.id, model },
            persona: defaultPersona(language),
            workspace: { root: coder.agentId, isolation: 'shared' },
            permissions: 'workspace-write',
            limits: { maxTurnMinutes: 10, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
          }, 'system:coder', `coder-${coder.agentId}`);
          log.info('agente coder creato', { id: coder.agentId, adapter: adapter.id, model });
        } catch (err) {
          log.warn('agente coder non creato', { id: coder.agentId, err });
        }
      }
    }
  }
  // P-93: agente analista Nemo Ultra, garantito come il coder. Stesso contratto: creato solo se
  // manca e solo con un modello configurato che un adapter dichiara (nessun modello inventato).
  // Permessi `read-only` (analizza e riferisce, non scrive); mai sovrascritto se esiste già.
  const ultra = loaded.config.agents.ultra;
  if (seedDefaultAgents && ultra.enabled && !manager.get(ultra.agentId)) {
    const model = ultra.model.trim();
    if (model === '') {
      log.info('agente ultra non creato: nessun modello configurato', { id: ultra.agentId });
    } else {
      const adapter = adapters.list().find((a) => a.supportsModel?.(model) === true);
      if (!adapter) {
        log.warn('nessun motore dichiara il modello di ultra: agente non creato', { model });
      } else {
        try {
          manager.define({
            id: ultra.agentId,
            name: ultra.name,
            role: 'Analista: ragiona sui dati e riferisce (sola lettura)',
            competences: ['reasoning', 'general'],
            engine: { adapter: adapter.id, model },
            persona: defaultPersona(language),
            workspace: { root: ultra.agentId, isolation: 'shared' },
            permissions: 'read-only',
            limits: { maxTurnMinutes: 10, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
          }, 'system:ultra', `ultra-${ultra.agentId}`);
          log.info('agente ultra creato', { id: ultra.agentId, adapter: adapter.id, model });
        } catch (err) {
          log.warn('agente ultra non creato', { id: ultra.agentId, err });
        }
      }
    }
  }
  const directorConfig = loaded.config.director;
  const engine = createTaskEngine({
    db, events, log: log.child('tasks'), audit, executor: manager, maxConcurrent: directorConfig.maxConcurrentTasks,
    defaultBudget: { timeoutMs: directorConfig.taskTimeoutMs, maxAttempts: directorConfig.maxAttempts }, now
  });
  engineRef = engine;
  // Il Director risponde agli agenti tramite il canale, che a sua volta consegna al Director.
  let channel: MessageChannel | null = null;
  const director = createDirector({
    engine, agents: manager, approvals, policy, audit, events, bus, log: log.child('director'),
    agentsDir: paths.agentsDir, workspaceDir: paths.workspaceDir,
    limitFallbackAgentId: limitFallback.enabled ? limitFallback.agentId : null, journal,
    defaultPlannerAgentId: () => plannerDefault,
    reply: (to, act, body) => {
      channel?.send({ conversationId: to.conversationId, inReplyTo: to.id, from: 'director', to: to.from, act, subject: `Re: ${to.subject}`.slice(0, 200), body, taskId: to.taskId, hops: Math.min(to.hops + 1, 12), requiresReply: false });
    }
  });
  engine.setHooks(director.hooks);
  const messages = createMessageChannel({
    db, events, log: log.child('messages'), agentsDir: paths.agentsDir, scanMs: directorConfig.outboxScanMs, now,
    isAgent: (id) => manager.get(id) !== null,
    onDirectorMessage: (m) => director.onMessage(m)
  });
  channel = messages;
  registerAgentCommands({ router, manager, breakerOf: director.breakerOf });
  registerDirectorCommands({
    router, director, engine, approvals, audit, agents: manager,
    language: () => language,
    // I gruppi nascono dopo: «Svuota chat» della chat con VISIONE è nella loro tabella.
    chatClearedAt: () => groupsRef?.clearedAt('main') ?? 0
  });
  registerMemoryCommands({ router, memory, tasks: taskReader, agentExists: (id) => manager.get(id) !== null });
  // Assistente personale (beta.5, P-109): promemoria locali, «salvami» nella memoria globale, agenda.
  const assistant = createAssistant({
    db, events, log: log.child('assistant'), now, language: () => language,
    saveNote: (text, correlationId) => {
      memory.store.write({ scope: 'global', scopeId: null, kind: 'note', title: '', content: text, source: 'owner:voice', origin: 'command', pinned: false }, correlationId ? { correlationId } : undefined);
    }
  });
  registerAssistantCommands(router, assistant, now, () => language);
  // Chat di gruppo locale (22/10/2026): il proprietario e gli agenti, come in una chat fra persone.
  const groups = createGroups({
    db, events, bus, engine, agents: manager, log: log.child('groups'), now, language: () => language,
    leadAgent: () => (plannerDefault && manager.get(plannerDefault) ? plannerDefault : null)
  });
  groupsRef = groups;
  registerGroupCommands(router, groups);
  // Modalità offline (17/10/2026): senza rete le cose di base vanno a un modello locale scaricato su
  // consenso; prima le regole dell'Assistente, poi il modello, che riscrive la frase per le regole.
  const offline = createOffline({
    events, log: log.child('offline'), now, language: () => language,
    auto: () => offlineAuto,
    modelsDir: loaded.config.offline.modelsDir ?? join(paths.home, 'models', 'offline'),
    assistant: { handle: (text, source, correlationId) => assistant.handle(text, source, correlationId) },
    voiceCommand: parseVoiceCommand,
    apps,
    // Il modello gira in un filo di lavoro (`out/main/offline-worker.js`): il suo caricamento è sincrono e nel
    // filo del core fermava il battito per il supervisore (riavvio del core, visto nel collaudo del 17/10).
    model: (dir) => createWorkerModel({ dir, language: () => language, entry: () => join(__dirname, 'offline-worker.js') }),
    ...(deps.offline?.probe ? { probe: deps.offline.probe } : {})
  });
  offlineRef = offline;
  registerOfflineCommands(router, offline);
  // Voce (Fase 9): il core traduce i fatti del processo voce in eventi e decide gli enunciati.
  const voice = createVoiceController({
    events,
    bus,
    approvals,
    director,
    assistant,
    offline,
    // Conversazione a voce (15/10/2026): «parla con …» e la frase all’agente scelto o al Director.
    agents: () => manager.active().map((d) => ({ id: d.id, name: d.name })),
    leadAgent: () => (plannerDefault && manager.get(plannerDefault) ? plannerDefault : null),
    briefing: (greeting) => briefing(greeting),
    config: loaded.config.voice,
    currentConfig: () => voiceConfig,
    language: () => language,
    log: log.child('voice'),
    send: (msg) => transport.send({ kind: 'voice', msg }),
    newId: () => ulid(now()),
    now
  });
  registerVoiceCommands({ router, voice });
  // Saluto di stato all'avvio (11/10/2026): solo fatti reali; i motori si verificano con un tetto di
  // 5 s (un motore lento non fa tacere VISIONE: si salta quella parte).
  // Saluto del 22/10/2026 («dice meteo, fa qualche battuta… e se ha fatto qualcosa mentre non c'ero»): meteo della
  // città scelta nel widget, battuta scritta da un modello rapido degli agenti, lavori conclusi dopo il suo ultimo
  // comando. Ogni pezzo ha il suo tetto e, se manca, si salta: mai un fatto inventato, mai un silenzio.
  const withCap = <T,>(p: Promise<T>, ms: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p.catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
  };
  const briefingExtras = async (): Promise<{ weather: BriefingWeather | null; quip: string | null; meanwhile: { done: string[]; failed: string[] } | null }> => {
    const at = new Date(now());
    const hour = at.getHours();
    const city = weatherCity.trim();
    const report = city ? await withCap(weather.report(city, language), BRIEFING_EXTRA_MS) : null;
    const day = report ? (hour >= 18 ? report.days[1] : report.days[0]) ?? null : null;
    const forecast: BriefingWeather | null = report ? {
      place: report.place.name,
      tempC: report.now.tempC,
      symbol: report.now.symbol,
      day: day ? { when: hour >= 18 ? 'tomorrow' : 'today', minC: day.minC, maxC: day.maxC, symbol: day.symbol } : null
    } : null;
    // La battuta: dal primo motore degli agenti attivi che ha un servizio rapido.
    const active = manager.active();
    const quick = [...new Set(active.map((d) => d.engine.adapter))].map((id) => adapters.get(id)).find((a) => a?.quickText);
    const pending = engine.list({ rootsOnly: true, status: ['created', 'queued', 'running', 'waiting', 'blocked'], limit: 20 }).length;
    // La battuta impara (22/10/2026): le sue frasi recenti come ispirazione, i suoi «bella» e «questa no» come tono.
    const taste = assistant.learning.taste();
    const ask = quipPrompt({ hour, weekday: at.getDay(), pending, sayings: assistant.learning.sayings(), liked: taste.liked, disliked: taste.disliked }, language);
    // Una battuta scartata (avanzi del ragionamento, più frasi lunghe) si richiede una volta, nello stesso tetto.
    let quip: string | null = null;
    const quipDeadline = now() + BRIEFING_EXTRA_MS;
    for (let attempt = 0; quick?.quickText && quip === null && attempt < 2; attempt++) {
      const left = quipDeadline - now();
      if (left < 500) break;
      quip = cleanQuip(await withCap(quick.quickText(active.filter((d) => d.engine.adapter === quick.id), { ...ask, maxTokens: 80, prefer: 'quality' }, left), left + 500));
    }
    if (quip) assistant.noteQuip(quip);
    // «Mentre non c'eri»: VISIONE non sa quando si è alzato dal PC; sa quando le ha dato l'ultimo comando.
    const lastOwner = audit.list(1_000).filter((e) => e.ts < startedAt && (e.actor.startsWith('owner') || e.actor === 'voice')).pop();
    let meanwhile: { done: string[]; failed: string[] } | null = null;
    if (lastOwner) {
      const ended = engine.list({ rootsOnly: true, status: ['succeeded', 'failed', 'timed_out'], limit: 50 }).filter((t) => t.endedAt !== null && t.endedAt > lastOwner.ts);
      meanwhile = { done: ended.filter((t) => t.status === 'succeeded').map((t) => t.title), failed: ended.filter((t) => t.status !== 'succeeded').map((t) => t.title) };
    }
    return { weather: forecast, quip, meanwhile };
  };
  const briefing = async (greeting: string): Promise<string> => {
    if (!setupDone) return composeBriefing({ greeting, firstRun: true, pc: null, engines: [], unclean: false, unfinished: [], approvals: 0, agentsInError: [], agenda: null }, language);
    // All'avvio il primo campione della telemetria arriva dopo qualche secondo (il processore serve un
    // secondo campione per la percentuale): si aspetta al più 4 s, in parallelo alla verifica dei motori.
    const telemetryReady = (async () => {
      for (let waited = 0; waited < 4_000 && typeof telemetry.last()?.cpuPercent !== 'number'; waited += 250) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    // Meteo, battuta e «mentre non c'eri» in parallelo alla verifica dei motori.
    const extrasReady = briefingExtras();
    // Verifica VERA (12/10/2026): programma cercato di nuovo (refresh) e, dove l'adapter la offre,
    // l'accesso che serve agli agenti attivi (account, chiave, servizio locale, modelli ancora attivi presso il fornitore).
    // Ogni motore ha il suo tetto: chi non finisce in tempo è «non verificato», mai «pronto».
    const active = manager.active();
    const used = [...new Set(active.map((d) => d.engine.adapter))];
    const engines = await Promise.all(used.map(async (id): Promise<BriefingEngine> => {
      const adapter = adapters.get(id);
      // Il nome detto è quello che l'adapter dichiara, senza la spiegazione fra parentesi: nessun
      // nome di motore scritto qui.
      const name = (adapter?.label ?? id).replace(/\s*\(.*\)\s*$/, '');
      if (!adapter) return { name, ok: false, detail: language === 'en' ? 'engine not available in VISIONE' : 'motore non presente in VISIONE' };
      const check = (async (): Promise<{ ok: boolean; detail: string }> => {
        if (adapter.health) return adapter.health(active.filter((d) => d.engine.adapter === id));
        const probe = await probeAdapter(adapter, true, log.child('briefing'));
        return { ok: probe.available, detail: probe.problems[0] ?? '' };
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        check.catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) })),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BRIEFING_ENGINE_CHECK_MS); })
      ]).finally(() => clearTimeout(timer));
      if (result === null) return { name, ok: null };
      if (!result.ok) log.warn('motore non pronto al saluto di stato', { adapter: id, detail: result.detail.slice(0, 300) });
      return result.ok ? { name, ok: true } : { name, ok: false, detail: result.detail.slice(0, 160) };
    }));
    const [extras] = await Promise.all([extrasReady, telemetryReady]);
    const last = telemetry.last();
    const pc = last ? {
      cpuPercent: typeof last.cpuPercent === 'number' ? last.cpuPercent : null,
      ramPercent: typeof last.ramUsedBytes === 'number' && typeof last.ramTotalBytes === 'number' && last.ramTotalBytes > 0 ? (last.ramUsedBytes / last.ramTotalBytes) * 100 : null
    } : null;
    const views = manager.views({ includeArchived: false, breakerOf: director.breakerOf });
    return composeBriefing({
      greeting,
      weather: extras.weather,
      quip: extras.quip,
      meanwhile: extras.meanwhile,
      pc,
      engines,
      unclean,
      unfinished: engine.list({ rootsOnly: true, status: ['created', 'queued', 'running', 'waiting', 'blocked'], limit: 20 }).map((t) => t.title),
      approvals: approvals.list({ status: 'pending', limit: 50 }).length,
      agentsInError: views.filter((v) => v.instance?.status === 'error' || v.instance?.status === 'crashed').map((v) => v.definition.name),
      agenda: assistant.agendaCount('today') > 0 ? assistant.agenda('today') : null
    }, language);
  };
  // P-105: modelli d'ascolto scaricati su consenso dalla procedura guidata (stessa cartella del main).
  registerVoiceModelCommands({ router, events, modelsDir: loaded.config.voice.modelsDir ?? join(paths.home, 'models', 'voice'), restart: () => void voice.restart(), log: log.child('voice-models') });
  // Telemetria di sistema (Fase 14, P-59): campionatori locali reali; i valori non disponibili sono
  // `null` (la UI mostra N/D). Il campionatore Windows è un processo PowerShell che si chiude col core.
  const telemetry = createTelemetry({
    db, events, log: log.child('telemetry'), now,
    enabled: deps.telemetry?.enabled ?? loaded.config.telemetry.enabled,
    intervalMs: loaded.config.telemetry.intervalMs,
    systemEnabled: loaded.config.telemetry.system,
    sensorsEnabled: loaded.config.telemetry.sensors.enabled,
    sensorsUrl: loaded.config.telemetry.sensors.url,
    ...(deps.telemetry?.sampler ? { sampler: deps.telemetry.sampler } : {})
  });
  // Recupero (P-37, P-38): nessun processo di un avvio precedente è ancora controllato; i turni
  // rimasti aperti diventano `lost` e il brief di ripresa lo dichiara (P-43).
  const recoveredAgents = manager.recover();
  const recoveredTasks = engine.recover();
  if (recoveredAgents > 0 || recoveredTasks.requeued > 0 || recoveredTasks.lost > 0) {
    log.warn('orchestrazione recuperata dopo un avvio non chiuso', { instances: recoveredAgents, ...recoveredTasks });
  }
  // `memory.md` scritti mentre il core era fermo.
  memory.refreshAll();
  director.start();
  groups.start();
  assistant.start();
  if (deps.offline?.enabled !== false) offline.start();
  // Mappa del codice (P-107l): le cartelle degli agenti attivi si indicizzano poco dopo l'avvio, in
  // background, così il primo compito trova già la mappa.
  const codeMapWarmup = setTimeout(() => {
    // Dopo un errore fatale il database è chiuso e lo spegnimento ordinato (che cancella il timer) non c'è stato.
    if (phase !== 'running') return;
    for (const def of manager.active()) codeMap.ensureFresh(resolveWorkspace(def, paths.workspaceDir));
  }, 5_000);
  codeMapWarmup.unref();
  let reconciling: Promise<void> = Promise.resolve();

  let phase: CoreLifecycle = 'running';
  let stopping: Promise<void> | null = null;

  // Il canale degli hook serve solo ai motori che li usano: se non parte, il core resta su e
  // l'errore è visibile (stato ed eventi). Dopo un riavvio per heartbeat (PC vergine sotto carico,
  // 18/10/2026) il core di prima può tenere il pipe ancora qualche secondo: EADDRINUSE. Si riprova finché
  // si libera; prima il tentativo era uno solo e i motori con hook restavano senza fino al riavvio.
  const hooksStarted = (async (): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await hooks.start();
        if (attempt > 1) log.info('canale degli hook pronto', { attempt });
        return true;
      } catch (err) {
        const busy = (err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE';
        if (!busy || attempt >= (deps.hooksRetry?.attempts ?? HOOKS_START_ATTEMPTS) || phase !== 'running') {
          log.error('canale degli hook non disponibile', { address: hooks.address, err, attempt });
          events.emit('system.error', { code: 'hooks-unavailable', message: (err instanceof Error ? err.message : String(err)).slice(0, 2000), fatal: false });
          return false;
        }
        if (attempt === 1) log.warn('canale degli hook occupato (core di prima?): riprovo', { address: hooks.address });
        await new Promise((resolve) => setTimeout(resolve, deps.hooksRetry?.ms ?? HOOKS_RETRY_MS));
      }
    }
  })();

  const exitSoon = (code: number): void => {
    setTimeout(() => deps.exit(code), EXIT_FLUSH_MS);
  };

  const stop = (reason: string, deadlineMs: number): Promise<void> => {
    if (stopping) return stopping;
    phase = 'stopping';
    log.info('spegnimento', { reason });
    lifecycle.transition('stopping', reason);
    router.close();
    stopping = (async () => {
      const share = Math.max(0, Math.floor(deadlineMs / 3));
      await router.settled(share);
      // Orchestrazione: nessun nuovo turno; i turni in corso tornano in coda (ripresi al prossimo avvio).
      messages.close();
      const suspended = await engine.suspend(reason, Math.floor(share / 2));
      if (suspended > 0) log.info('task sospesi allo spegnimento', { count: suspended });
      director.stop();
      groups.stop();
      await manager.stopAll(`core: ${reason}`, Math.floor(share / 2));
      // Nessun processo sopravvive al core: stop ordinato con grazia ridotta, poi kill dell'albero.
      const stoppedProcesses = await runtime.stopAll(`core: ${reason}`, share);
      if (stoppedProcesses > 0) log.info('processi fermati allo spegnimento', { count: stoppedProcesses });
      await reconciling;
      await hooksStarted;
      await hooks.close();
      events.emit('system.stopped', { reason, uptimeMs: now() - startedAt });
      lifecycle.transition('stopped', reason);
      telemetry.stop();
      if (!events.flushPending()) log.error('eventi durevoli non scritti allo spegnimento', { pending: events.health().pending });
      pushState();
      await bus.idle();
      events.close();
      forward.unsubscribe();
      voice.dispose();
      terminal.dispose();
      faces.close();
      assistant.close();
      await offline.close();
      clearTimeout(codeMapWarmup);
      codeMap.close();
      bus.close();
      db.close();
      phase = 'stopped';
      transport.send({ kind: 'stopped' });
      log.info('core fermato', { reason });
    })();
    return stopping;
  };

  const fail = (err: unknown, code: string): void => {
    if (phase === 'failed') return;
    phase = 'failed';
    const message = err instanceof Error ? err.message : String(err);
    log.error('errore fatale nel core', { code, err });
    try {
      lifecycle.transition('crashed', code.slice(0, 200));
      // Per ultimo, così l'ultimo errore registrato è quello con codice e messaggio.
      events.emit('system.error', { code, message: message.slice(0, 2000), fatal: true });
      pushState();
    } catch (emitErr) {
      log.error('impossibile registrare l\'errore fatale', { err: emitErr });
    }
    // Tentativo di non lasciare processi orfani; quelli rimasti li chiude la riconciliazione.
    const cleanup = runtime.stopAll(`core: errore fatale ${code}`.slice(0, 200), FATAL_STOP_MS).catch(() => 0);
    faces.close();
    assistant.close();
    void Promise.allSettled([bus.idle(), cleanup, hooks.close(), offline.close()]).finally(() => {
      transport.send({ kind: 'fatal', message: `${code}: ${message}`.slice(0, 2000) });
      try {
        telemetry.stop();
      } catch {
        // la telemetria non deve impedire l'uscita
      }
      try {
        events.close();
        db.close();
      } catch {
        // il database potrebbe essere la causa dell'errore
      }
      exitSoon(1);
    });
  };

  const dispatch = (raw: unknown): void => {
    void router.dispatch(raw).then((response) => transport.send({ kind: 'res', response }));
  };

  const handleFrame = (raw: unknown): void => {
    const parsed = mainToCoreFrameSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('frame non valido dal main', { issues: formatIssues(parsed.error) });
      state.apply({ kind: 'invalid-frame' });
      // Un comando malformato riceve comunque una risposta, così il main non attende il timeout.
      const maybe = raw as { kind?: unknown; command?: unknown } | null;
      if (maybe?.kind === 'cmd') dispatch(maybe.command);
      return;
    }
    const frame = parsed.data;
    switch (frame.kind) {
      case 'cmd':
        dispatch(frame.command);
        return;
      case 'cancel':
        router.cancel(frame.id, frame.reason);
        return;
      case 'ingest': {
        const outcome = events.ingestFromMain(frame.events);
        for (const r of outcome.rejected) {
          log.warn('evento del main rifiutato', r);
          events.emit('system.event.rejected', r);
        }
        transport.send({ kind: 'ingested', ids: outcome.accepted });
        return;
      }
      case 'hb':
        transport.send({ kind: 'hb-ack', n: frame.n });
        return;
      case 'shutdown':
        void stop(frame.reason, frame.deadlineMs).then(() => exitSoon(0), (err: unknown) => fail(err, 'shutdown-failed'));
        return;
      case 'voice':
        voice.handle(frame.msg);
        return;
    }
  };

  transport.onFrame(handleFrame);
  transport.onDisconnect(() => {
    state.apply({ kind: 'ipc', status: 'disconnected' });
    void stop('main-disconnected', 5_000).then(() => exitSoon(0), (err: unknown) => fail(err, 'shutdown-failed'));
  });

  lifecycle.transition('ready', unclean ? 'recupero completato' : 'avvio completato');
  const startupMs = now() - startedAt;
  events.emit('system.ready', { startupMs, journalLastSeq: state.snapshot().database.journalLastSeq });
  pushState();
  telemetry.start();
  transport.send({ kind: 'ready', pid: deps.pid, coreVersion: deps.coreVersion, startupMs });
  log.info('core pronto', { pid: deps.pid, startupMs, schemaVersion: migration.to, recovered: unclean });

  // Ciclo eventi fermo (tester, stable 38: «nessuna risposta dal core entro 6000 ms» su un comando voce che risponde
  // subito): ogni blocco oltre 2 s finisce nel registro, così il pacchetto «Segnala un problema» lo mostra. Un
  // salto molto più lungo è di solito il PC in sospensione.
  let lastBeat = performance.now();
  const stallWatch = setInterval(() => {
    const t = performance.now();
    const stalledMs = Math.round(t - lastBeat - 500);
    lastBeat = t;
    if (stalledMs > 2_000) log.warn('ciclo eventi del core fermo', { stalledMs, phase });
  }, 500);
  // unref: non tiene vivo il processo, che esce da sé dopo lo spegnimento.
  stallWatch.unref();

  // Processi lasciati vivi da un avvio precedente caduto (P-32): dopo `ready`, per non ritardarlo.
  reconciling = runtime.reconcile().then(
    (report) => {
      if (report.checked > 0) log.warn('processi di un avvio precedente riconciliati', { checked: report.checked });
    },
    (err: unknown) => log.error('riconciliazione dei processi non riuscita', { err })
  ).then(() => {
    // Dopo la riconciliazione: nessun orfano può ancora lavorare per un task ripreso.
    if (phase !== 'running') return;
    messages.start();
    engine.schedule();
  });

  return {
    get lifecycle() {
      return phase;
    },
    state: state.reader,
    runtime,
    agents: manager,
    tasks: engine,
    voice,
    telemetry,
    stop,
    fail
  };
}
