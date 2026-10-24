// Superficie esposta dal preload al renderer come `window.visione`. Nient'altro è raggiungibile.
// Lo stato arriva in sola lettura: nessun metodo lo modifica (lo cambia solo il core, dagli eventi).
import type { AgentDefinitionInput, CommandInput, CommandResponse, CommandResult } from './commands.ts';
import type { VisioneEvent } from './events.ts';
import type { CoreStateSnapshot } from './state.ts';
import type { SupervisorSnapshot } from './supervisor.ts';

export type Unsubscribe = () => void;

export interface VisioneApi {
  readonly system: {
    ping(echo?: string): Promise<CommandResponse<CommandResult<'system.ping'>>>;
    status(): Promise<CommandResponse<CommandResult<'system.status'>>>;
    /** P-87: schermo intero della finestra (main), per il tasto «SCHERMO INTERO» dell'apertura. */
    fullscreen(enabled?: boolean): Promise<{ fullscreen: boolean }>;
    /** Riavvio di VISIONE chiesto dal proprietario (impostazioni che valgono dal riavvio): chiusura ordinata e riapertura. */
    relaunch(): Promise<{ ok: boolean }>;
    /**
     * Chiude VISIONE (12/10/2026, richiesta del proprietario), con la stessa chiusura ordinata dell'uscita;
     * con `shutdown` il PC si spegne DOPO che VISIONE ha chiuso tutto.
     */
    quit(options?: { shutdown?: boolean }): Promise<{ ok: boolean }>;
    /** Apre un indirizzo web nel browser predefinito di Windows (solo http/https). */
    openExternal(url: string): Promise<{ ok: boolean }>;
    /** Launcher (Fase 24): applicazioni installate reali e loro avvio. */
    readonly apps: {
      list(): Promise<CommandResponse<CommandResult<'system.apps.list'>>>;
      launch(id: string): Promise<CommandResponse<CommandResult<'system.apps.launch'>>>;
    };
    /** System Control (Fase 24b): metriche reali e azioni di controllo. */
    readonly control: {
      info(): Promise<CommandResponse<CommandResult<'system.control.info'>>>;
      exec(action: CommandInput<'system.control.exec'>): Promise<CommandResponse<CommandResult<'system.control.exec'>>>;
    };
  };
  /** Segnala un problema: pacchetto ripulito da allegare a un'email (resta sul PC). */
  readonly support: {
    report(note: string): Promise<CommandResponse<CommandResult<'support.report'>>>;
  };
  /** File Manager (Fase 24b): filesystem reale dentro le radici consentite. */
  readonly files: {
    roots(): Promise<CommandResponse<CommandResult<'files.roots'>>>;
    list(path: string, hidden?: boolean): Promise<CommandResponse<CommandResult<'files.list'>>>;
    mkdir(path: string, name: string): Promise<CommandResponse<CommandResult<'files.mkdir'>>>;
    rename(path: string, newName: string): Promise<CommandResponse<CommandResult<'files.rename'>>>;
    remove(path: string, recursive?: boolean): Promise<CommandResponse<CommandResult<'files.delete'>>>;
    open(path: string): Promise<CommandResponse<CommandResult<'files.open'>>>;
    search(root: string, query: string): Promise<CommandResponse<CommandResult<'files.search'>>>;
    /** Esplora (11/10/2026): Cestino, copia, sposta, testo per l'anteprima. */
    trash(paths: readonly string[]): Promise<CommandResponse<CommandResult<'files.trash'>>>;
    copy(paths: readonly string[], toDir: string): Promise<CommandResponse<CommandResult<'files.copy'>>>;
    move(paths: readonly string[], toDir: string): Promise<CommandResponse<CommandResult<'files.move'>>>;
    read(path: string): Promise<CommandResponse<CommandResult<'files.read'>>>;
    /**
     * Allegati nei terminali e nelle chat degli agenti (12/10/2026, richiesta del proprietario): il
     * percorso dei file trascinati da Windows (vuoto se il file non viene dal disco).
     */
    pathOf(file: File): string;
    /** Finestra «Apri» di Windows: file o cartelle, anche più d'uno; [] se annullata. */
    pick(kind: 'files' | 'folder'): Promise<string[]>;
    /**
     * Ciò che c'è negli appunti come allegato: i file copiati in Esplora risorse, oppure un'immagine
     * (screenshot) salvata come PNG in `%VISIONE%\allegati`. [] se negli appunti c'è altro.
     */
    fromClipboard(): Promise<string[]>;
  };
  readonly state: {
    /** Snapshot coerente dello stato del core. */
    get(): Promise<CommandResponse<CommandResult<'state.get'>>>;
    /** Snapshot a ogni variazione (spinti dal core, nessun polling). */
    subscribe(listener: (snapshot: CoreStateSnapshot) => void): Unsubscribe;
  };
  readonly events: {
    /** Eventi recenti dal journal (o successivi ad `afterSeq`), con filtri facoltativi. */
    list(query?: CommandInput<'events.list'>): Promise<CommandResponse<CommandResult<'events.list'>>>;
    get(id: string): Promise<CommandResponse<CommandResult<'events.get'>>>;
    subscribe(listener: (event: VisioneEvent) => void): Unsubscribe;
  };
  readonly runtime: {
    /** Processi di questo avvio del core (sola lettura). */
    processes(query?: CommandInput<'runtime.processes'>): Promise<CommandResponse<CommandResult<'runtime.processes'>>>;
    /** Ferma un processo esistente; la UI non avvia processi. */
    stop(processId: string, mode?: 'graceful' | 'force'): Promise<CommandResponse<CommandResult<'runtime.stop'>>>;
  };
  readonly engines: {
    /** Verifica dei motori disponibili (CLI e versione); con `adapter` verifica UN solo motore. */
    probe(refresh?: boolean, adapter?: string): Promise<CommandResponse<CommandResult<'engines.probe'>>>;
    /** P-99: ri-verifica tutti i motori e riavvia le sessioni in errore (esito e motivi reali). */
    restart(): Promise<CommandResponse<CommandResult<'engines.restart'>>>;
  };
  /** P-105: procedura guidata del primo avvio (requisiti dei motori, chiavi verificate e salvate). */
  readonly setup: {
    detect(): Promise<CommandResponse<CommandResult<'setup.detect'>>>;
    verifyKey(adapter: string, envName: string, value?: string): Promise<CommandResponse<CommandResult<'setup.verifyKey'>>>;
    saveKey(adapter: string, envName: string, value: string): Promise<CommandResponse<CommandResult<'setup.saveKey'>>>;
    catalog(): Promise<CommandResponse<CommandResult<'setup.catalog'>>>;
    login(adapter: string, cols?: number, rows?: number): Promise<CommandResponse<CommandResult<'setup.login'>>>;
    /** «Installa» (17/10/2026): l'installatore ufficiale del requisito, nel terminale di VISIONE. */
    install(adapter: string, item: string, cols?: number, rows?: number): Promise<CommandResponse<CommandResult<'setup.install'>>>;
    apply(input: CommandInput<'setup.apply'>): Promise<CommandResponse<CommandResult<'setup.apply'>>>;
  };
  /** Agenti (Fase 6): definizioni del proprietario, stop di un'istanza, avvio esplicito (P-83). */
  readonly agents: {
    list(includeArchived?: boolean): Promise<CommandResponse<CommandResult<'agents.list'>>>;
    define(definition: AgentDefinitionInput): Promise<CommandResponse<CommandResult<'agents.define'>>>;
    archive(agentId: string): Promise<CommandResponse<CommandResult<'agents.archive'>>>;
    /** P-99: rinomina il nome mostrato (display name); l'id interno resta invariato. */
    rename(agentId: string, name: string): Promise<CommandResponse<CommandResult<'agents.rename'>>>;
    stop(agentId: string, mode?: 'graceful' | 'force'): Promise<CommandResponse<CommandResult<'agents.stop'>>>;
    /** Avvia/riprende la sessione reale senza un turno (P-83): la usa la wake word. */
    start(agentId: string): Promise<CommandResponse<CommandResult<'agents.start'>>>;
    /** Modelli e potenza applicabili a un agente, da config e dal probe dell'adapter (P-83). */
    models(agentId: string, refresh?: boolean): Promise<CommandResponse<CommandResult<'agents.models'>>>;
    /** Applica modello/potenza alla definizione: validati dall'adapter, auditati (P-83). */
    tuning(input: CommandInput<'agents.tuning'>): Promise<CommandResponse<CommandResult<'agents.tuning'>>>;
    /** Messaggio diretto a un agente: un task assegnato a lui, sulla sua sessione reale (Fase 21). */
    tell(input: CommandInput<'agents.tell'>): Promise<CommandResponse<CommandResult<'agents.tell'>>>;
    /** «Interrompi»: annulla i task non conclusi dell'agente (12/10/2026). */
    interrupt(agentId: string, reason?: string): Promise<CommandResponse<CommandResult<'agents.interrupt'>>>;
  };
  /** Un obiettivo al Director: piano esplicito, agente pianificatore o RulePlanner. */
  readonly director: {
    submit(input: CommandInput<'director.submit'>): Promise<CommandResponse<CommandResult<'director.submit'>>>;
    /** «Interrompi tutto»: annulla tutti gli obiettivi non conclusi (12/10/2026). */
    interrupt(reason?: string): Promise<CommandResponse<CommandResult<'director.interrupt'>>>;
  };
  readonly tasks: {
    list(query?: CommandInput<'tasks.list'>): Promise<CommandResponse<CommandResult<'tasks.list'>>>;
    get(taskId: string): Promise<CommandResponse<CommandResult<'tasks.get'>>>;
    cancel(taskId: string, reason?: string): Promise<CommandResponse<CommandResult<'tasks.cancel'>>>;
  };
  /** Coda delle approvazioni: la decisione è del proprietario. */
  readonly approvals: {
    list(query?: CommandInput<'approvals.list'>): Promise<CommandResponse<CommandResult<'approvals.list'>>>;
    decide(approvalId: string, decision: 'grant' | 'deny', note?: string): Promise<CommandResponse<CommandResult<'approvals.decide'>>>;
  };
  readonly audit: {
    list(limit?: number): Promise<CommandResponse<CommandResult<'audit.list'>>>;
  };
  /** Memoria (Fase 7): ricerca, scrittura del proprietario, promozione, riflessione. */
  readonly memory: {
    search(query?: CommandInput<'memory.search'>): Promise<CommandResponse<CommandResult<'memory.search'>>>;
    write(input: CommandInput<'memory.write'>): Promise<CommandResponse<CommandResult<'memory.write'>>>;
    promote(itemId: string): Promise<CommandResponse<CommandResult<'memory.promote'>>>;
    reflect(agentId: string, force?: boolean): Promise<CommandResponse<CommandResult<'memory.reflect'>>>;
  };
  /** Terminale come vista (Fase 8): shell del proprietario e sessioni PTY degli agenti. */
  readonly terminal: {
    list(): Promise<CommandResponse<CommandResult<'terminal.list'>>>;
    open(cols?: number, rows?: number): Promise<CommandResponse<CommandResult<'terminal.open'>>>;
    input(processId: string, data: string): Promise<CommandResponse<CommandResult<'terminal.input'>>>;
    resize(processId: string, cols: number, rows: number): Promise<CommandResponse<CommandResult<'terminal.resize'>>>;
    snapshot(processId: string): Promise<CommandResponse<CommandResult<'terminal.snapshot'>>>;
    close(processId: string): Promise<CommandResponse<CommandResult<'terminal.close'>>>;
  };
  /** Impostazioni (Fase 8): valgono dal prossimo avvio del core. */
  readonly config: {
    get(): Promise<CommandResponse<CommandResult<'config.get'>>>;
    update(patch: Record<string, unknown>): Promise<CommandResponse<CommandResult<'config.update'>>>;
  };
  /** Widget del cruscotto (11/10/2026): il meteo lo chiede il core, il renderer resta senza rete. */
  readonly widgets: {
    weather(city: string, language: 'it' | 'en'): Promise<CommandResponse<CommandResult<'widgets.weather'>>>;
  };
  /** Assistente personale (beta.5, P-109): promemoria locali per il widget Agenda. */
  readonly assistant: {
    parse(text: string): Promise<CommandResponse<CommandResult<'assistant.parse'>>>;
    list(status?: 'open' | 'all'): Promise<CommandResponse<CommandResult<'assistant.reminders.list'>>>;
    add(text: string, at?: number): Promise<CommandResponse<CommandResult<'assistant.reminder.add'>>>;
    update(id: string, action: 'done' | 'cancel' | 'snooze', minutes?: number): Promise<CommandResponse<CommandResult<'assistant.reminder.update'>>>;
    /** P-109b: una frase all'Assistente (liste, timer, ricorrenti); `handled: false` se non è per lui. */
    ask(text: string): Promise<CommandResponse<CommandResult<'assistant.ask'>>>;
    lists(): Promise<CommandResponse<CommandResult<'assistant.lists.get'>>>;
    removeItem(id: string): Promise<CommandResponse<CommandResult<'assistant.list.remove'>>>;
  };
  /** Chat di gruppo locale (22/10/2026): gruppi di agenti e messaggi come in una chat fra persone. */
  /** La chat con VISIONE (23/10/2026): storia dal database. */
  readonly chat: {
    history(): Promise<CommandResponse<CommandResult<'chat.history'>>>;
    clear(conversation: string): Promise<CommandResponse<CommandResult<'chat.clear'>>>;
  };
  readonly groups: {
    list(): Promise<CommandResponse<CommandResult<'groups.list'>>>;
    create(name: string, members: readonly { agentId: string; role: string }[]): Promise<CommandResponse<CommandResult<'groups.create'>>>;
    remove(groupId: string): Promise<CommandResponse<CommandResult<'groups.remove'>>>;
    messages(groupId: string): Promise<CommandResponse<CommandResult<'groups.messages'>>>;
    post(groupId: string, text: string): Promise<CommandResponse<CommandResult<'groups.post'>>>;
  };
  /** Modalità offline (17/10/2026): spia, tasto, richieste al modello locale, download su consenso. */
  readonly offline: {
    status(): Promise<CommandResponse<CommandResult<'offline.status'>>>;
    set(active: boolean): Promise<CommandResponse<CommandResult<'offline.set'>>>;
    ask(text: string): Promise<CommandResponse<CommandResult<'offline.ask'>>>;
    download(): Promise<CommandResponse<CommandResult<'offline.model.download'>>>;
    cancelDownload(): Promise<CommandResponse<CommandResult<'offline.model.cancel'>>>;
  };
  /** Addestramento (P-107k): regole di lavoro per gli agenti, scelte dal catalogo o scritte dall'utente. */
  readonly training: {
    list(): Promise<CommandResponse<CommandResult<'training.list'>>>;
    set(id: string, active: boolean): Promise<CommandResponse<CommandResult<'training.set'>>>;
    add(input: { title: string; rule: string; keywords: string[]; always: boolean }): Promise<CommandResponse<CommandResult<'training.add'>>>;
    remove(id: string): Promise<CommandResponse<CommandResult<'training.remove'>>>;
  };
  /** Mappa del codice (P-107l): cartelle di lavoro degli agenti indicizzate da VISIONE. */
  readonly codemap: {
    status(): Promise<CommandResponse<CommandResult<'codemap.status'>>>;
    scan(root: string): Promise<CommandResponse<CommandResult<'codemap.scan'>>>;
    set(root: string, enabled: boolean): Promise<CommandResponse<CommandResult<'codemap.set'>>>;
    preview(root: string, text: string): Promise<CommandResponse<CommandResult<'codemap.preview'>>>;
  };
  /** Widget Umanoide: volto in un fotogramma ridotto e in grigio della webcam (rilevatore di Windows nel core). */
  readonly vision: {
    face(width: number, height: number, gray: string): Promise<CommandResponse<CommandResult<'vision.face'>>>;
  };
  /** Voce (Fase 9): stato, push-to-talk, frase del proprietario, stop, riavvio e wake word. */
  readonly voice: {
    status(): Promise<CommandResponse<CommandResult<'voice.status'>>>;
    ptt(action: 'press' | 'release' | 'toggle', source?: 'ui' | 'shortcut'): Promise<CommandResponse<CommandResult<'voice.ptt'>>>;
    speak(text: string): Promise<CommandResponse<CommandResult<'voice.speak'>>>;
    stop(): Promise<CommandResponse<CommandResult<'voice.stop'>>>;
    restart(): Promise<CommandResponse<CommandResult<'voice.restart'>>>;
    /** Prova del PC (16/10/2026): quanto è veloce la voce VISIONE qui e quale profilo si consiglia. */
    benchmark(): Promise<CommandResponse<CommandResult<'voice.benchmark'>>>;
    /** P-105: modelli d'ascolto presenti o da scaricare. */
    modelsStatus(set?: 'listening' | 'filters'): Promise<CommandResponse<CommandResult<'voice.models.status'>>>;
    /** P-105: scarica su consenso i modelli d'ascolto mancanti (avanzamento: `voice.models.progress`). */
    modelsDownload(set?: 'listening' | 'filters'): Promise<CommandResponse<CommandResult<'voice.models.download'>>>;
    /** P-106: registrazione della voce del proprietario (esito: `voice.enroll.progress`). */
    enroll(action: 'start' | 'save' | 'cancel' | 'clear' | 'probe'): Promise<CommandResponse<CommandResult<'voice.enroll'>>>;
    /** Prova di precisione: la prossima frase si trascrive soltanto (esito: `voice.accuracy.heard`). */
    accuracy(action: 'arm' | 'cancel'): Promise<CommandResponse<CommandResult<'voice.accuracy'>>>;
    wake(enabled: boolean): Promise<CommandResponse<CommandResult<'voice.wake'>>>;
    /** Con chi parla la voce: un agente, o null = il Director. */
    talkTo(agentId: string | null): Promise<CommandResponse<CommandResult<'voice.talkTo'>>>;
  };
  readonly supervisor: {
    get(): Promise<SupervisorSnapshot>;
    subscribe(listener: (snapshot: SupervisorSnapshot) => void): Unsubscribe;
  };
}

/** Canali IPC tra preload e main. */
export const IPC_CHANNELS = {
  command: 'visione:command',
  supervisorGet: 'visione:supervisor:get',
  supervisorPush: 'visione:supervisor',
  /** P-87: schermo intero della finestra principale (renderer → main, nessun comando al core). */
  windowFullscreen: 'visione:window:fullscreen',
  /** Riavvio dell'app (renderer → main): stessa chiusura ordinata dell'uscita, poi riapertura. */
  appRelaunch: 'visione:app:relaunch',
  /** Chiusura dell'app (renderer → main), facoltativamente seguita dallo spegnimento del PC. */
  appQuit: 'visione:app:quit',
  /** Allegati (renderer → main): finestra «Apri» di Windows e appunti (file copiati o immagine). */
  attachPick: 'visione:attach:pick',
  /** Browser (12/10/2026): una pagina web nel browser predefinito di Windows. */
  openExternal: 'visione:open-external',
  attachClipboard: 'visione:attach:clipboard',
  event: 'visione:event',
  statePush: 'visione:state',
  /** Porta audio renderer ↔ processo voce (trasferita dal main, inoltrata dal preload al main world). */
  voicePort: 'visione:voice:port'
} as const;
