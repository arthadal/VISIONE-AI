// Voce nel core (Fase 9, VISIONE_ARCHITECTURE §28, P-12, P-48…P-50): traduce i fatti del processo
// voce in eventi, decide cosa fare di un enunciato (obiettivo, approvazione, stop), parla quando
// serve (sintesi degli obiettivi a voce, annuncio delle approvazioni) e gestisce il ciclo di vita del
// processo. Nessun accesso all'audio: VAD, STT e TTS restano nel processo voce.
//
// L'audio del microfono non passa da qui: il renderer lo manda al processo voce con una porta
// dedicata. Il core vede solo testo e latenze, e li rende eventi per il bus e lo State Store.
import type {
  Approval,
  CommandResult,
  CoreToVoice,
  PttSource,
  SpeechReason,
  TypedEvent,
  VoiceCommandAction,
  VoiceIntent,
  VoiceOutcome,
  VoiceState,
  VoiceToCore
} from '../../shared/contracts/index.ts';
import { VOICE_LIMITS, type Language } from '../../shared/contracts/index.ts';
import { DEFAULT_CONFIG, type VisioneConfig } from '../../shared/node/config.ts';
import type { Logger } from '../../shared/node/logging.ts';
import { installVoiceModel, missingVoiceModels, type VoiceModel } from '../../shared/node/voice-models.ts';
import { windowByName } from '../../shared/lib/window-names.ts';
import { fixTranscript, isPhantomTranscript, parseTalkTo, spokenAnswer, voicePrompt, type TalkCandidate } from './conversation.ts';
import { recommendProfile } from './profile.ts';
import type { AdapterSetupItem } from '../adapters/index.ts';
import { systemSetupItems, toItem } from '../setup/index.ts';
import { resolveGreeting } from '../assistant/index.ts';
import type { ApprovalQueue } from '../approvals/index.ts';
import type { EventBus } from '../bus/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { Director } from '../director/index.ts';
import type { EventEmitter } from '../events/index.ts';

export interface VoiceDeps {
  events: EventEmitter;
  bus: EventBus;
  approvals: ApprovalQueue;
  director: Director;
  /** Saluto di stato all'avvio (11/10/2026): la frase completa, dai fatti reali del kernel. */
  briefing?: (greeting: string) => Promise<string>;
  /** Assistente personale (beta.5, P-109): promemoria, note, agenda. Prima del Director. */
  assistant?: VoiceAssistant;
  /**
   * Modalità offline (17/10/2026): se attiva, la frase che andrebbe al Director va al modello locale, e la
   * sua risposta si dice a voce; un «sì»/«no» risponde prima di tutto a un suo «procedo?».
   */
  offline?: {
    active(): boolean;
    awaitingConfirm(): boolean;
    ask(text: string, source: 'voice', correlationId: string | null, opts?: { rulesDone?: boolean }): Promise<{ reply: string; outcome: string; speak: boolean }>;
  };
  /** Agenti attivi (conversazione a voce, 15/10/2026): per «parla con …» e per controllare la scelta. */
  agents?: () => readonly TalkCandidate[];
  /** L'agente che fa da Director (il pianificatore scelto dal proprietario), se c'è. */
  leadAgent?: () => string | null;
  config: VisioneConfig['voice'];
  /** Configurazione aggiornata (10/10/2026): prima restava quella dell'avvio fino al riavvio di VISIONE. */
  currentConfig?: () => VisioneConfig['voice'];
  log: Logger;
  send(msg: CoreToVoice): void;
  newId(): string;
  now?: () => number;
  /** Timer iniettabili (test): arming/timeout della wake. */
  timers?: VoiceTimers;
  /** Lingua di VISIONE (P-108): le frasi dette da VISIONE la seguono. Predefinita l'italiano. */
  language?: () => Language;
  /** Requisiti di sistema che mancano (runtime di Visual C++, 18/10/2026); nei test finti. */
  systemItems?: () => AdapterSetupItem[];
}

/** Ciò che la voce usa dell'Assistente: una frase → la risposta da dire, o null se non è sua. */
export interface VoiceAssistant {
  handle(text: string, source: 'voice', correlationId?: string | null): { reply: string; speak?: boolean } | null;
}

export interface VoiceTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface VoiceController {
  /** Un fatto del processo voce (o il suo ciclo di vita) inoltrato dal main. */
  handle(msg: VoiceToCore): void;
  status(): VoiceState;
  ptt(action: 'press' | 'release' | 'toggle', source: PttSource): CommandResult<'voice.ptt'>;
  speak(text: string): CommandResult<'voice.speak'>;
  stop(): CommandResult<'voice.stop'>;
  restart(): CommandResult<'voice.restart'>;
  /** Wake word (P-81): accende/spegne l'ascolto della frase. */
  wake(enabled: boolean): CommandResult<'voice.wake'>;
  /** Con chi parla la voce: un agente, o null = il Director. */
  talkTo(agentId: string | null): CommandResult<'voice.talkTo'>;
  /** P-106: registrazione della voce del proprietario. */
  enroll(action: 'start' | 'save' | 'cancel' | 'clear' | 'probe'): CommandResult<'voice.enroll'>;
  /** Prova di precisione (24/10/2026): la prossima frase si trascrive soltanto, non va al Director. */
  accuracy(action: 'arm' | 'cancel'): CommandResult<'voice.accuracy'>;
  /** Prova del PC (16/10/2026): misura la voce VISIONE e consiglia il profilo. Una sola alla volta. */
  benchmark(): Promise<CommandResult<'voice.benchmark'>>;
  dispose(): void;
}

/** Attesa massima della prova del PC: su un PC lento la frase misurata dura una decina di secondi. */
const BENCHMARK_TIMEOUT_MS = 85_000;

/** Approvazioni che una frase non può decidere: il proprietario le conferma dalla UI. */
const CRITICAL_APPROVAL_KINDS: ReadonlySet<string> = new Set(['trust', 'workspace']);

// Italiano e inglese insieme (P-108): le parole delle due lingue non si confondono fra loro.
const APPROVE = /^(si|va bene|va bene cosi|approva|approvo|confermo|ok|okay|procedi|fallo|d accordo|perfetto|yes|yeah|yep|sure|go ahead|approve|approved|i approve|confirm|confirmed|do it|proceed)\b/;
const DENY = /^(no|nega|nego|rifiuta|rifiuto|annulla|non approvare|non confermo|no grazie|nope|deny|denied|reject|refuse|cancel|don't|do not|no thanks)\b/;
/** Oltre queste parole un «no…»/«sì…» senza richieste in attesa è un obiettivo, non una risposta. */
const SHORT_ANSWER_WORDS = 3;
const STOP = /^(stop|fermati|ferma|basta|silenzio|taci|chiudi|zitto|be quiet|quiet|silence|shut up|enough|that's enough|hush)\b/;

/** Intento di un enunciato (italiano o inglese): regole locali, nessun modello (P-12). */
export function parseVoiceIntent(raw: string): VoiceIntent {
  const text = normalizeVoice(raw);
  if (text.length === 0) return 'empty';
  if (STOP.test(text)) return 'stop';
  if (DENY.test(text)) return 'deny';
  if (APPROVE.test(text)) return 'approve';
  return 'goal';
}

export interface ParsedVoiceCommand {
  readonly action: VoiceCommandAction;
  readonly target: string | null;
}

/** Normalizzazione condivisa (minuscole, senza accenti, solo lettere/numeri/spazi/apostrofi). */
function normalizeVoice(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s'°]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Toglie articoli e la parola «agente» (o «agent») dall'inizio di un riferimento. */
function stripAgentWords(s: string): string {
  return s
    .trim()
    .replace(/^(?:l'|all'|un')\s*/, '')
    .replace(/^(?:il|lo|la|i|gli|le|un|una|the|an|a|my)(?:\s+|$)/, '')
    .replace(/^(?:agente|agent)(?:\s+|$)/, '')
    .replace(/^(?:di|del|della|dell|a|al|allo|alla|of|for)\s+/, '')
    .replace(/\s+agent$/, '')
    .trim();
}

// «Trovami il file del contratto» / «find the file called budget»: serve il nome della cosa (file,
// documento, cartella, foto, PDF…), altrimenti la frase resta un obiettivo per il Director.
const FIND_FILE = /^(?:trovami|trova|cercami|cerca|mi trovi|dov'e|dov e|dove e|dove sta|dove si trova|find me|find|search for|look for|locate|where is|where's|where s|where are)\s+(?:(?:il|lo|la|i|gli|le|l'|un|una|mio|mia|miei|mie|the|my|a|an|some)\s*)*(?:file|files|documento|documenti|cartella|cartelle|foto|immagine|immagini|pdf|document|documents|folder|folders|photo|photos|picture|pictures|image|images|pdfs)\b\s*(.*)$/;
const FIND_LINK = /^(?:che si chiama|chiamat[oaie]|di nome|del|della|dello|dell'|dei|delle|degli|di|sul|sulla|sui|sulle|su|con|per|relativ[oaie] a|called|named|about|for|of|with|on)\s+/;
const FIND_STOP = new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'l', 'un', 'una', 'di', 'del', 'della', 'dello', 'dei', 'delle', 'degli', 'e', 'per', 'con', 'su', 'a', 'al', 'alla', 'da', 'in', 'mio', 'mia', 'dell', 'all', 'sull', 'nell', 'nel', 'nella', 'the', 'of', 'an', 'and', 'for', 'to', 'my', 'please']);

/** Le parole da cercare nei nomi dei file: senza articoli né preposizioni (null se non resta niente). */
function findQuery(rest: string): string | null {
  const words = rest.replace(FIND_LINK, '').replace(/\b(?:per favore|please)\b/g, ' ').split(/[\s']+/).filter((w) => w.length > 0 && !FIND_STOP.has(w));
  const query = words.join(' ').slice(0, 120).trim();
  return query.length > 0 ? query : null;
}

/**
 * Comandi di ambiente a voce (Fase 22, P-69): regole locali, nessun modello. Riconosce SOLO le
 * forme esplicite; tutto il resto resta un obiettivo per il Director. Il bersaglio è il nome/id
 * pronunciato (normalizzato) oppure null = «quello selezionato» (lo risolve il renderer).
 */
export function parseVoiceCommand(raw: string): ParsedVoiceCommand | null {
  const text = normalizeVoice(raw);
  if (text.length === 0) return null;
  if (/^(chi sta lavorando|chi lavora|stato del sistema|riepilogo|che cosa sta succedendo|who is working|who's working|system status|status report|what's happening|what is happening)\b/.test(text)) {
    return { action: 'status', target: null };
  }
  const find = text.match(FIND_FILE);
  if (find) return { action: 'find-file', target: findQuery(find[1] ?? '') };
  const open = text.match(/^(?:apri|aprimi|mostra|visualizza|fammi vedere|open|show me|show|display)\s+(.+)$/);
  if (open) {
    // «Mostra la lista della spesa» è per l'Assistente (P-109b), non un agente da aprire.
    if (/\b(?:lista|list)\b/.test(open[1]!)) return null;
    const body = stripAgentWords(open[1]!);
    if (/^(?:director|direttore)\b/.test(body)) return { action: 'open-director', target: null };
    // «apri il terminale di X» / «open X's terminal», «open the terminal of X»
    const terminal = body.split(/\b(?:terminale|terminal)\b/);
    if (terminal.length > 1) {
      const before = stripAgentWords((terminal[0] ?? '').trim().replace(/'s$|\s+s$/, ''));
      const after = stripAgentWords((terminal[1] ?? '').trim().replace(/^(?:di|del|della|dell|of|for)\s+/, ''));
      const target = after.length > 0 ? after : before;
      return { action: 'open-terminal', target: target.length > 0 ? target.slice(0, 120) : null };
    }
    // «apri le impostazioni»: una finestra di VISIONE, non un agente (17/10/2026).
    const window = windowByName(body);
    if (window) return { action: 'open-window', target: window };
    return { action: 'open-agent', target: body.length > 0 ? body.slice(0, 120) : null };
  }
  const close = text.match(/^(?:chiudi|chiudimi|nascondi|close|hide)\s+(.+)$/);
  if (close) {
    const body = close[1]!;
    if (/\b(?:terminale|terminal)\b/.test(body)) {
      const parts = body.split(/\b(?:terminale|terminal)\b/);
      const after = stripAgentWords((parts[1] ?? '').trim().replace(/^(?:di|del|della|dell|of|for)\s+/, ''));
      const before = stripAgentWords((parts[0] ?? '').trim().replace(/'s$|\s+s$/, ''));
      const target = after.length > 0 ? after : before;
      return { action: 'close-terminal', target: target.length > 0 ? target.slice(0, 120) : null };
    }
    if (/\b(finestra|pannello|agente|director|direttore|window|panel|agent)\b/.test(body)) return { action: 'close-window', target: null };
    return null; // «chiudi» da solo resta STOP (ferma la voce)
  }
  return null;
}

/** Frase di avvio predefinita: in inglese, se la lingua è l'inglese e il proprietario non l'ha cambiata. */
export const DEFAULT_STARTUP_PHRASE_EN = 'VISIONE online. All systems operational.';
export function startupPhraseFor(phrase: string, lang: Language): string {
  return lang === 'en' && phrase === DEFAULT_CONFIG.voice.startupPhrase ? DEFAULT_STARTUP_PHRASE_EN : phrase;
}

export function createVoiceController(deps: VoiceDeps): VoiceController {
  const cfg = (): VisioneConfig['voice'] => deps.currentConfig?.() ?? deps.config;
  const lang = (): Language => deps.language?.() ?? 'it';
  const now = deps.now ?? Date.now;
  const timers: VoiceTimers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let state: VoiceState = {
    status: 'off', since: now(), reason: null, pid: null, engines: null, listening: false, speaking: null, lastUtterance: null,
    wake: { enabled: false, phrase: cfg().wake.phrase, available: false, armed: false },
    voices: [],
    filters: { denoise: false, speaker: false, owner: false, ownerOnly: false, noiseGate: 0 },
    talkTo: null
  };
  let heldAt: number | null = null;
  /** Timer dell'arming della wake: scaduto, il push-to-talk si disarma. */
  let wakeTimer: unknown = null;
  /** Primo `wake-state` dal processo: anche identico ai default, va reso noto alla UI. */
  let wakeKnown = false;
  /** Prova di precisione: la prossima frase è una prova, non una richiesta. */
  let accuracyArmed = false;
  /** Frase di avvio: una sola volta per sessione del core, alla prima disponibilità della voce. */
  let announced = false;
  /**
   * Saluto subito e notizie dopo (24/10/2026, dal proprietario: la voce deve parlare appena compaiono le
   * particelle). Le notizie si preparano mentre la voce si carica e si dicono finito il saluto: una frase nuova
   * interromperebbe quella in corso.
   */
  let briefingEarly: Promise<string> | null = null;
  let greetingId: string | null = null;
  let briefingAfterGreeting: string | null = null;
  /** Obiettivi aperti nati da un enunciato: quando finiscono, VISIONE li legge. */
  const voiceGoals = new Set<string>();
  /** Prova del PC in corso: chi la chiede di nuovo aspetta la stessa risposta. */
  let bench: { promise: Promise<CommandResult<'voice.benchmark'>>; settle(r: CommandResult<'voice.benchmark'> | CommandFailure): void } | null = null;

  const send = (msg: CoreToVoice): void => deps.send(msg);

  const clearWakeTimer = (): void => {
    if (wakeTimer !== null) {
      timers.clear(wakeTimer);
      wakeTimer = null;
    }
  };

  const emitProcess = (from: VoiceState['status'], to: VoiceState['status'], reason: string, pid: number | null, engines: VoiceState['engines'], loadMs: number | null): void => {
    deps.events.emit('voice.process.changed', { from, to, reason: reason.slice(0, 500), pid, engines, loadMs });
  };

  const transition = (to: VoiceState['status'], reason: string, opts: { pid?: number | null; engines?: VoiceState['engines']; loadMs?: number | null } = {}): void => {
    const from = state.status;
    if (to !== 'ready') {
      clearWakeTimer();
      state = { ...state, wake: { ...state.wake, armed: false } };
    }
    state = {
      ...state,
      status: to,
      since: now(),
      reason: to === 'ready' ? null : reason.slice(0, 500),
      pid: opts.pid !== undefined ? opts.pid : state.pid,
      engines: opts.engines !== undefined ? opts.engines : state.engines,
      listening: to === 'ready' ? state.listening : false,
      speaking: to === 'ready' ? state.speaking : null
    };
    emitProcess(from, to, reason, state.pid, to === 'ready' ? state.engines : null, opts.loadMs ?? null);
  };

  /** Perché si sta parlando: dopo una risposta (non un promemoria o un avviso) si resta in ascolto. */
  const spokenFor = new Map<string, SpeechReason>();
  const say = (text: string, reason: SpeechReason, rootTaskId: string | null): string | null => {
    const trimmed = text.trim().slice(0, VOICE_LIMITS.speakChars);
    if (trimmed.length === 0) return null;
    if (state.status !== 'ready') return null;
    const ttsId = deps.newId();
    send({ type: 'speak', ttsId, text: trimmed });
    state = { ...state, speaking: ttsId };
    spokenFor.set(ttsId, reason);
    if (spokenFor.size > 50) spokenFor.delete(spokenFor.keys().next().value!);
    deps.events.emit('voice.tts.requested', { ttsId, reason, chars: trimmed.length, rootTaskId });
    return ttsId;
  };

  const handleIntent = (utteranceId: string, text: string): void => {
    // Trascrizione inventata da Whisper sul rumore (16/10/2026: «e e e e…» mandato al Director, che ha
    // risposto per 25 s): non è una richiesta, si ignora.
    if (isPhantomTranscript(text)) {
      deps.events.emit('voice.intent', { utteranceId, intent: 'empty', outcome: 'ignored', rootTaskId: null, approvalId: null, detail: 'trascrizione inventata dal rumore: ignorata' });
      return;
    }
    const command = parseVoiceCommand(text);
    const intent: VoiceIntent = command ? 'command' : parseVoiceIntent(text);
    const done = (outcome: VoiceOutcome, detail: string, extra: { rootTaskId?: string | null; approvalId?: string | null } = {}): void => {
      deps.events.emit('voice.intent', {
        utteranceId, intent, outcome, rootTaskId: extra.rootTaskId ?? null, approvalId: extra.approvalId ?? null, detail: detail.slice(0, 500)
      });
    };
    // «parla con Esecutore», «passami il Director»: cambia l'interlocutore, nessuna frase in risposta.
    const talk = parseTalkTo(text, deps.agents?.() ?? []);
    if (talk) {
      setTalkTo(talk.target, 'voice');
      deps.events.emit('voice.intent', { utteranceId, intent: 'command', outcome: 'commanded', rootTaskId: null, approvalId: null, detail: `interlocutore: ${talk.target ?? 'Director'}` });
      return;
    }
    // Offline, «apri X» passa dalla modalità offline: finestre di VISIONE o programmi installati (17/10/2026).
    if (command?.action === 'open-agent' && deps.offline?.active()) {
      void deps.offline.ask(text, 'voice', utteranceId).then((out) => {
        done('commanded', `offline: ${out.reply}`);
        if (out.speak) say(out.reply, 'reply', null);
      }, (err: unknown) => done('failed', err instanceof Error ? err.message : String(err)));
      return;
    }
    // Comandi di ambiente (Fase 22, P-69): li esegue il renderer col contesto della UI.
    if (command) {
      deps.events.emit('voice.command', {
        utteranceId, action: command.action, target: command.target, text: text.trim().slice(0, VOICE_LIMITS.utteranceChars)
      });
      done('commanded', `comando di ambiente: ${command.action}${command.target ? ` · ${command.target}` : ''}`);
      return;
    }
    if (intent === 'empty') {
      done('ignored', 'enunciato vuoto');
      return;
    }
    const offline = deps.offline;
    const askOffline = (rulesDone: boolean): void => {
      void offline!.ask(text, 'voice', utteranceId, { rulesDone }).then((out) => {
        deps.events.emit('voice.intent', { utteranceId, intent: 'assistant', outcome: 'assisted', rootTaskId: null, approvalId: null, detail: `offline (${out.outcome}): ${out.reply}`.slice(0, 500) });
        if (out.speak) say(out.reply, 'reply', null);
      }, (err: unknown) => {
        deps.log.warn('richiesta offline non riuscita', { err });
        done('failed', err instanceof Error ? err.message : String(err));
      });
    };
    if (offline?.awaitingConfirm() && (intent === 'approve' || intent === 'deny')) {
      askOffline(false);
      return;
    }
    // Assistente (beta.5): «ricordami…», «salvami…», «cosa devo fare oggi», «annulla il promemoria…»,
    // «tra un'ora devo…». Prima di approva/nega: «annulla il promemoria» non è un «no».
    if (intent === 'goal' || intent === 'deny') {
      let answer: { reply: string; speak?: boolean } | null = null;
      try {
        answer = deps.assistant?.handle(text, 'voice', utteranceId) ?? null;
      } catch (err) {
        deps.log.warn('richiesta all\'Assistente non riuscita', { err });
      }
      if (answer) {
        deps.events.emit('voice.intent', { utteranceId, intent: 'assistant', outcome: 'assisted', rootTaskId: null, approvalId: null, detail: answer.reply.slice(0, 500) });
        // Le conferme delle azioni si vedono a schermo e non si dicono (15/10/2026: niente frasi fatte);
        // risposte vere, domande e problemi sì.
        if (answer.speak !== false) say(answer.reply, 'reply', null);
        return;
      }
    }
    if (intent === 'stop') {
      send({ type: 'stop', ttsId: null, cause: 'owner' });
      done('stopped', 'riproduzione fermata a voce');
      return;
    }
    // 24/10/2026, sul PC del proprietario: in conversazione «No, chiedi al direttore di farlo…» finiva scartato come
    // rifiuto senza nulla da rifiutare. Senza richieste in attesa una frase lunga è un nuovo obiettivo.
    const pendingNow = intent === 'approve' || intent === 'deny' ? deps.approvals.list({ status: 'pending', limit: 10 }) : [];
    const answerOnly = pendingNow.length > 0 || text.trim().split(/\s+/).length <= SHORT_ANSWER_WORDS;
    if ((intent === 'approve' || intent === 'deny') && answerOnly) {
      const pending = pendingNow;
      if (pending.length === 0) {
        done('no-pending', 'nessuna richiesta in attesa');
        return;
      }
      if (pending.length > 1) {
        done('ambiguous', `${pending.length} richieste in attesa: si decide dalla UI`);
        return;
      }
      const approval: Approval = pending[0]!;
      if (CRITICAL_APPROVAL_KINDS.has(approval.kind)) {
        done('needs-ui', `una frase non decide ${approval.kind}: conferma dalla UI`, { approvalId: approval.id });
        return;
      }
      const decision = intent === 'approve' ? 'grant' : 'deny';
      deps.approvals.decide(approval.id, decision, 'voice', { note: 'deciso a voce', correlationId: utteranceId });
      done('decided', `${decision === 'grant' ? 'approvata' : 'negata'}: ${approval.kind}`, { approvalId: approval.id });
      return;
    }
    // Offline: niente agenti; la frase va al modello locale (le regole dell'Assistente le ha già provate).
    if (intent === 'goal' && offline?.active()) {
      askOffline(true);
      return;
    }
    // intent === 'goal': la frase va all'agente scelto come un passo solo; senza una scelta va al Director che
    // pianifica e distribuisce alla squadra come per la chat (24/10/2026, dal proprietario: a voce rispondeva il
    // Director da solo e non poteva chiamare i colleghi). La risposta torna a voce (onSummary).
    try {
      const chosen = state.talkTo !== null && (deps.agents?.() ?? []).some((a) => a.id === state.talkTo) ? state.talkTo : null;
      const goal = voicePrompt(text, lang());
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Richiesta a voce';
      // La nota «rispondi a voce» solo nel passo: nell'obiettivo il brief la ripeteva una seconda volta.
      const out = chosen
        ? deps.director.submit({ goal: text.trim(), title, plan: { steps: [{ key: 'risposta', title, spec: goal, agentId: chosen }] } }, 'voice', { correlationId: utteranceId, causationId: null })
        : deps.director.submit({ goal, title }, 'voice', { correlationId: utteranceId, causationId: null });
      const target = chosen ?? deps.leadAgent?.() ?? null;
      voiceGoals.add(out.rootTaskId);
      done('submitted', `${chosen ? `all'agente ${chosen}` : target ? `al Director (${target})` : 'al Director'} (${out.planner})`, { rootTaskId: out.rootTaskId });
    } catch (err) {
      deps.log.warn('obiettivo a voce rifiutato', { err });
      done('failed', err instanceof Error ? err.message : String(err));
    }
  };

  const onApproval = (event: TypedEvent<'approval.requested'>): void => {
    if (cfg().announceApprovals && state.status === 'ready') say(`${lang() === 'en' ? 'Approval request' : 'Richiesta di approvazione'}: ${event.payload.reason}`, 'approval', event.payload.taskId);
  };
  const onSummary = (event: TypedEvent<'director.summary'>): void => {
    const rootTaskId = event.payload.rootTaskId;
    if (!voiceGoals.delete(rootTaskId)) return;
    if (!cfg().speakSummaries) return;
    // A voce la risposta dell'agente, non il resoconto tecnico; se non c'è, cosa è andato storto.
    const answer = event.payload.answer ? spokenAnswer(event.payload.answer) : '';
    if (answer) say(answer, 'summary', rootTaskId);
    else if (event.payload.outcome !== 'succeeded') say(lang() === 'en' ? `No answer: the request ${event.payload.outcome === 'cancelled' ? 'was cancelled' : 'failed'}.` : `Nessuna risposta: la richiesta è ${event.payload.outcome === 'cancelled' ? 'stata annullata' : 'fallita'}.`, 'summary', rootTaskId);
  };

  /** Interlocutore della voce: un agente attivo, o null = il Director. */
  const setTalkTo = (agentId: string | null, by: 'ui' | 'voice'): string | null => {
    if (agentId !== null && !(deps.agents?.() ?? []).some((a) => a.id === agentId)) throw new CommandFailure('invalid_payload', `agente sconosciuto o archiviato: ${agentId}`);
    if (state.talkTo !== agentId) {
      state = { ...state, talkTo: agentId };
      deps.events.emit('voice.talk.changed', { talkTo: agentId, by });
    }
    return agentId;
  };

  // Promemoria scattato (beta.5): lo dice l'Umanoide, anche se la frase non era a voce.
  const onReminder = (event: TypedEvent<'assistant.reminder.fired'>): void => {
    if (state.status === 'ready') say(event.payload.message, 'reminder', null);
  };
  const offApproval = deps.bus.on('approval.requested', onApproval);
  const offReminder = deps.bus.on('assistant.reminder.fired', onReminder);
  const offSummary = deps.bus.on('director.summary', onSummary);

  const press = (source: PttSource, autoEnd: boolean): CommandResult<'voice.ptt'> => {
    if (state.listening) return { listening: true };
    send({ type: 'ptt', down: true, autoEnd });
    heldAt = now();
    state = { ...state, listening: true };
    deps.events.emit('voice.ptt.pressed', { source });
    return { listening: true };
  };
  const release = (source: PttSource): CommandResult<'voice.ptt'> => {
    if (!state.listening) return { listening: false };
    // Un arming della wake si chiude dal suo percorso (evento con la sua origine reale).
    if (state.wake.armed) {
      releaseWake();
      return { listening: false };
    }
    send({ type: 'ptt', down: false, autoEnd: false });
    const heldMs = heldAt === null ? 0 : Math.max(0, now() - heldAt);
    heldAt = null;
    state = { ...state, listening: false };
    deps.events.emit('voice.ptt.released', { source, heldMs });
    return { listening: false };
  };
  const doPtt = (action: 'press' | 'release' | 'toggle', source: PttSource): CommandResult<'voice.ptt'> => {
    if (state.status !== 'ready') throw new CommandFailure('operation_failed', 'il processo voce non è pronto');
    if (action === 'toggle') return state.listening ? release(source) : press(source, true);
    return action === 'press' ? press(source, false) : release(source);
  };

  /**
   * Arma il push-to-talk che si chiude da solo: dopo la sola frase di attivazione (P-81) o, in conversazione
   * (17/10/2026), dopo una risposta detta. Se entro `timeoutMs` non comincia nessun parlato si disarma; appena
   * il parlato comincia il timer si ferma e la frase la chiude solo il silenzio (prima il timer di 6 s
   * troncava anche chi stava ancora parlando).
   */
  let armedSource: PttSource = 'wake';
  const armWake = (source: PttSource = 'wake', timeoutMs = cfg().wake.commandTimeoutMs): void => {
    if (state.status !== 'ready' || state.wake.armed) return;
    clearWakeTimer();
    send({ type: 'ptt', down: true, autoEnd: true });
    heldAt = now();
    armedSource = source;
    state = { ...state, listening: true, wake: { ...state.wake, armed: true } };
    deps.events.emit('voice.ptt.pressed', { source });
    wakeTimer = timers.set(() => {
      wakeTimer = null;
      if (!state.wake.armed) return;
      send({ type: 'ptt', down: false, autoEnd: false });
      const heldMs = heldAt === null ? 0 : Math.max(0, now() - heldAt);
      heldAt = null;
      state = { ...state, listening: false, wake: { ...state.wake, armed: false } };
      deps.events.emit('voice.ptt.released', { source: armedSource, heldMs });
    }, timeoutMs);
  };

  /** Fine dell'arming (enunciato arrivato, wake spenta o processo caduto). */
  const releaseWake = (): void => {
    clearWakeTimer();
    if (!state.wake.armed) return;
    if (state.listening) send({ type: 'ptt', down: false, autoEnd: false });
    const heldMs = heldAt === null ? 0 : Math.max(0, now() - heldAt);
    heldAt = null;
    state = { ...state, listening: false, wake: { ...state.wake, armed: false } };
    deps.events.emit('voice.ptt.released', { source: armedSource, heldMs });
  };

  return {
    handle(msg) {
      switch (msg.type) {
        case 'process':
          if (msg.phase === 'starting') {
            transition('starting', 'avvio del processo voce', { pid: msg.pid });
            if (!announced && briefingEarly === null && cfg().announceStartup && cfg().startupBriefing && deps.briefing) briefingEarly = deps.briefing('');
          }
          else {
            transition('off', msg.reason || `processo voce uscito${msg.code !== null ? ` (codice ${msg.code})` : ''}`, { pid: null });
            bench?.settle(new CommandFailure('operation_failed', 'il processo voce è uscito durante la prova'));
          }
          return;
        case 'benchmark':
          if (!bench) return; // risposta a una prova già scaduta
          deps.log.info('voce: prova del PC', { rtf: msg.rtf, audioS: msg.audioS, spentMs: msg.spentMs, reason: msg.reason });
          // Runtime di Visual C++ mancante (PC vergine, 18/10/2026): la guidata offre «Installa» al posto di un motivo tecnico.
          const runtime = msg.rtf === null ? (deps.systemItems ?? systemSetupItems)()[0] : undefined;
          bench.settle({ rtf: msg.rtf, audioS: msg.audioS, spentMs: msg.spentMs, reason: runtime ? runtime.detail : msg.reason, recommended: recommendProfile(msg.rtf, lang()), runtime: runtime ? toItem(runtime) : null });
          return;
        case 'ready':
          // Voci installate nel sistema: la procedura guidata mostra quelle della lingua scelta.
          state = { ...state, voices: msg.voices, filters: msg.filters };
          transition('ready', 'motori voce caricati', { pid: state.pid, engines: msg.engines, loadMs: msg.loadMs });
          // Wake (P-81): il core è la fonte della configurazione; il processo risponde con la realtà.
          send({ type: 'wake', enabled: cfg().wake.enabled, phrase: cfg().wake.phrase });
          // Avvio (Fase 24, P-71): frase originale, sincronizzata al fatto reale «voce pronta».
          if (!announced) {
            announced = true;
            if (cfg().announceStartup) {
              // «{saluto}» diventa il saluto dell'ora (22/10/2026).
              const greeting = resolveGreeting(startupPhraseFor(cfg().startupPhrase, lang()), new Date(now()).getHours(), lang());
              greetingId = say(greeting, 'owner', null);
              if (cfg().startupBriefing && deps.briefing) {
                // Le notizie (motori verificati, meteo, PC) dopo il saluto; se la raccolta fallisce resta il saluto.
                void (briefingEarly ?? deps.briefing('')).then(
                  (text) => {
                    deps.log.info('saluto di stato', { text });
                    if (text.trim() === '') return;
                    if (greetingId !== null && state.speaking === greetingId) briefingAfterGreeting = text;
                    else say(text, 'owner', null);
                  },
                  (err: unknown) => deps.log.warn('saluto di stato non composto', { err })
                );
              }
            }
          }
          return;
        case 'unavailable':
          transition('unavailable', msg.reason, { pid: state.pid, engines: null });
          return;
        case 'heard':
          deps.events.emit('voice.heard', { mode: msg.mode, outcome: msg.outcome, score: msg.score, audioMs: msg.audioMs });
          return;
        case 'enroll':
          // L'impronta salvata o cancellata cambia lo stato dei filtri (la UI lo legge da lì).
          if (msg.phase === 'saved' || msg.phase === 'cleared') state = { ...state, filters: { ...state.filters, owner: msg.phase === 'saved' } };
          deps.events.emit('voice.enroll.progress', { phase: msg.phase, count: msg.count, audioMs: msg.audioMs, quality: msg.quality, reason: msg.reason });
          return;
        case 'error':
          deps.events.emit('voice.error', { code: msg.code, message: msg.message });
          return;
        case 'vad':
          // Ascolto armato (wake o conversazione): cominciato il parlato, il timer non chiude più la frase.
          if (msg.phase === 'start' && state.wake.armed) clearWakeTimer();
          deps.events.emit(msg.phase === 'start' ? 'voice.vad.speech.start' : 'voice.vad.speech.end', { mode: msg.mode, audioMs: msg.audioMs });
          return;
        case 'level':
          deps.events.emit('voice.level', { rms: msg.rms });
          return;
        case 'utterance': {
          // La wake aveva armato il push-to-talk: l'enunciato è arrivato, si disarma (P-81).
          if (state.wake.armed) releaseWake();
          const text = fixTranscript(msg.text, lang());
          // Prova di precisione: la frase letta si confronta nella UI; non è una richiesta né una conversazione.
          if (accuracyArmed) {
            accuracyArmed = false;
            deps.events.emit('voice.accuracy.heard', { text, audioMs: msg.audioMs, sttMs: msg.sttMs });
            return;
          }
          deps.events.emit('voice.stt.final', {
            utteranceId: msg.utteranceId, text, chars: text.length, audioMs: msg.audioMs, sttMs: msg.sttMs, latencyMs: msg.latencyMs
          });
          state = { ...state, lastUtterance: { text, at: now() } };
          handleIntent(msg.utteranceId, text);
          return;
        }
        case 'wake': {
          const command = fixTranscript(msg.command.trim(), lang());
          const heard = fixTranscript(msg.text, lang());
          deps.events.emit('voice.wake.detected', {
            phrase: msg.phrase, text: msg.text, command: command.length > 0 ? command : null, confidence: null,
            audioMs: msg.audioMs, sttMs: msg.sttMs
          });
          if (command.length > 0) {
            // Comando nella stessa utterance: stesso percorso di un enunciato normale.
            const utteranceId = deps.newId();
            deps.events.emit('voice.stt.final', {
              utteranceId, text: heard, chars: heard.length, audioMs: msg.audioMs, sttMs: msg.sttMs, latencyMs: msg.sttMs
            });
            state = { ...state, lastUtterance: { text: heard, at: now() } };
            handleIntent(utteranceId, command);
          } else {
            armWake('wake');
          }
          return;
        }
        case 'wake-state': {
          const armed = msg.enabled ? state.wake.armed : false;
          const changed = !wakeKnown || msg.enabled !== state.wake.enabled || msg.phrase !== state.wake.phrase || msg.available !== state.wake.available;
          wakeKnown = true;
          state = { ...state, wake: { enabled: msg.enabled, phrase: msg.phrase, available: msg.available, armed } };
          if (!msg.enabled && armed) releaseWake();
          if (changed) deps.events.emit('voice.wake.changed', { enabled: msg.enabled, phrase: msg.phrase, available: msg.available, reason: msg.reason });
          if (msg.reason !== null) deps.log.warn('wake non disponibile', { reason: msg.reason });
          return;
        }
        case 'tts':
          if (msg.phase === 'started') {
            deps.events.emit('voice.tts.started', { ttsId: msg.ttsId, synthMs: msg.synthMs, firstAudioMs: msg.firstAudioMs, responseMs: null });
          } else if (msg.phase === 'finished') {
            deps.events.emit('voice.tts.finished', { ttsId: msg.ttsId, playedMs: msg.playedMs, error: msg.error });
            if (state.speaking === msg.ttsId) state = { ...state, speaking: null };
            if (msg.ttsId === greetingId) {
              greetingId = null;
              const news = briefingAfterGreeting;
              briefingAfterGreeting = null;
              if (news !== null && state.speaking === null) say(news, 'owner', null);
            }
            // Conversazione (17/10/2026): finita una risposta, si resta in ascolto senza «hey visione».
            const reason = spokenFor.get(msg.ttsId);
            spokenFor.delete(msg.ttsId);
            const followUpMs = cfg().followUpMs;
            if ((reason === 'reply' || reason === 'summary') && msg.error === null && followUpMs > 0 && state.speaking === null && !state.listening) {
              armWake('conversation', followUpMs);
            }
          } else if (msg.phase === 'interrupted') {
            deps.events.emit('voice.tts.interrupted', { ttsId: msg.ttsId, cause: msg.cause ?? 'process', bargeInMs: msg.bargeInMs, playedMs: msg.playedMs });
            if (state.speaking === msg.ttsId) state = { ...state, speaking: null };
            // Saluto interrotto (dal proprietario o da un'altra frase): le notizie non si recitano dopo.
            if (msg.ttsId === greetingId) {
              greetingId = null;
              briefingAfterGreeting = null;
            }
          } else {
            deps.events.emit('voice.error', { code: 'tts-failed', message: msg.error ?? 'sintesi non riuscita' });
            deps.events.emit('voice.tts.finished', { ttsId: msg.ttsId, playedMs: null, error: msg.error });
            if (state.speaking === msg.ttsId) state = { ...state, speaking: null };
          }
          return;
      }
    },

    status() {
      return state;
    },

    ptt: doPtt,

    speak(text) {
      if (state.status !== 'ready') throw new CommandFailure('operation_failed', 'il processo voce non è pronto');
      const ttsId = say(text, 'owner', null);
      if (ttsId === null) throw new CommandFailure('operation_failed', 'processo voce non disponibile');
      return { ttsId };
    },

    stop() {
      const stopped = state.speaking !== null;
      send({ type: 'stop', ttsId: null, cause: 'owner' });
      return { stopped };
    },

    restart() {
      send({ type: 'control', action: 'restart' });
      return { requested: true };
    },

    talkTo(agentId) {
      return { talkTo: setTalkTo(agentId, 'ui') };
    },

    wake(enabled) {
      if (state.status !== 'ready') throw new CommandFailure('operation_failed', 'il processo voce non è pronto');
      // Spegnere la wake chiude subito un'eventuale attesa armata.
      if (!enabled) releaseWake();
      send({ type: 'wake', enabled, phrase: cfg().wake.phrase });
      return { enabled, phrase: cfg().wake.phrase };
    },

    enroll(action) {
      if (state.status !== 'ready') throw new CommandFailure('operation_failed', 'il processo voce non è pronto');
      send({ type: 'enroll', action });
      return { sent: true };
    },

    accuracy(action) {
      if (action === 'arm' && state.status !== 'ready') throw new CommandFailure('operation_failed', 'il processo voce non è pronto');
      accuracyArmed = action === 'arm';
      return { armed: accuracyArmed };
    },

    benchmark() {
      if (bench) return bench.promise;
      // La prova non usa l'ascolto: basta che il processo voce sia vivo (anche senza i modelli dell'ascolto).
      if (state.status === 'off' || state.status === 'failed') return Promise.reject(new CommandFailure('operation_failed', 'il processo voce non è attivo'));
      let settle!: (r: CommandResult<'voice.benchmark'> | CommandFailure) => void;
      const promise = new Promise<CommandResult<'voice.benchmark'>>((resolve, reject) => {
        // Sotto il limite del comando (90 s): la UI riceve un motivo, non un tempo scaduto generico.
        const timer = timers.set(() => settle(new CommandFailure('operation_failed', 'la prova del PC non ha risposto entro 85 s')), BENCHMARK_TIMEOUT_MS);
        settle = (r) => {
          timers.clear(timer);
          bench = null;
          if (r instanceof CommandFailure) reject(r);
          else resolve(r);
        };
      });
      bench = { promise, settle };
      send({ type: 'benchmark' });
      return promise;
    },

    dispose() {
      clearWakeTimer();
      bench?.settle(new CommandFailure('shutting_down', 'voce chiusa durante la prova'));
      offApproval.unsubscribe();
      offReminder.unsubscribe();
      offSummary.unsubscribe();
      voiceGoals.clear();
    }
  };
}

export function registerVoiceCommands(deps: { router: CommandRouter; voice: VoiceController }): void {
  const { router, voice } = deps;
  router.register('voice.status', () => voice.status());
  router.register('voice.ptt', (payload) => voice.ptt(payload.action, payload.source ?? 'ui'));
  router.register('voice.speak', (payload) => voice.speak(payload.text));
  router.register('voice.stop', () => voice.stop());
  router.register('voice.restart', () => voice.restart());
  router.register('voice.wake', (payload) => voice.wake(payload.enabled));
  router.register('voice.talkTo', (payload) => voice.talkTo(payload.agentId));
  router.register('voice.enroll', (payload) => voice.enroll(payload.action));
  router.register('voice.accuracy', (payload) => voice.accuracy(payload.action));
  router.register('voice.benchmark', () => voice.benchmark());
}

/**
 * Modelli d'ascolto scaricati dall'app su consenso (P-105): nell'installer non ci sono (pesano ~210 MB).
 * Un download alla volta; finito tutto, la voce riparte e l'ascolto diventa disponibile.
 */
export function registerVoiceModelCommands(deps: {
  router: CommandRouter;
  events: EventEmitter;
  modelsDir: string;
  restart: () => void;
  log: Logger;
  install?: typeof installVoiceModel;
  models?: readonly VoiceModel[];
}): void {
  const { router, events, modelsDir, log } = deps;
  const install = deps.install ?? installVoiceModel;
  const ROLES = { listening: ['vad', 'stt'], filters: ['speaker', 'denoise'] } as const;
  const missing = (set: 'listening' | 'filters' = 'listening'): VoiceModel[] => missingVoiceModels(modelsDir, ROLES[set], deps.models);
  let running = false;
  const progress = (id: string, phase: 'download' | 'verifica' | 'estrazione' | 'fatto' | 'errore' | 'completato', received: number, total: number, error: string | null = null): void => {
    events.emit('voice.models.progress', { id, phase, received, total, error });
  };

  router.register('voice.models.status', (payload) => ({
    modelsDir,
    complete: missing(payload?.set).length === 0,
    downloading: running,
    missing: missing(payload?.set).map((m) => ({ id: m.id, role: m.role, size: m.size, license: m.license, url: m.url }))
  }));

  router.register('voice.models.download', (payload) => {
    const todo = missing(payload?.set);
    const totalBytes = todo.reduce((n, m) => n + m.size, 0);
    if (todo.length === 0) return { started: false, alreadyComplete: true, totalBytes: 0 };
    if (running) return { started: false, alreadyComplete: false, totalBytes };
    running = true;
    log.info('download dei modelli d\'ascolto avviato', { models: todo.map((m) => m.id), totalBytes });
    void (async () => {
      try {
        for (const m of todo) {
          await install(m, modelsDir, { onProgress: (phase, received, total) => progress(m.id, phase, received, total) });
        }
        progress('tutti', 'completato', totalBytes, totalBytes);
        log.info('modelli d\'ascolto pronti: riavvio della voce', {});
        deps.restart();
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        log.warn('download dei modelli d\'ascolto non riuscito', { reason });
        progress('tutti', 'errore', 0, totalBytes, reason);
      } finally {
        running = false;
      }
    })();
    return { started: true, alreadyComplete: false, totalBytes };
  });
}
