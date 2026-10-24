// Modalità offline dell'Assistente (17/10/2026, richiesta del proprietario). Senza rete VISIONE passa a un
// modello locale piccolo — scaricato solo su consenso — che fa le cose di base: promemoria, agenda, note,
// timer, liste, aprire le finestre, data e ora. Ci si passa da soli quando cade la rete (impostazione
// `offline.auto`, disattivabile) o col tasto «Entra in modalità offline»; si torna online da soli quando la
// rete torna (salvo l'entrata col tasto, che resta finché non si preme «Torna online").
//
// Ordine di una richiesta: prima le regole che VISIONE ha già (nessun modello), poi il modello locale, che
// riscrive la frase in una forma che le regole capiscono. Il modello non agisce mai da sé: ciò che fa lo fa
// l'Assistente, e annullare qualcosa va confermato.
import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import manifest from '../../shared/offline-model.json' with { type: 'json' };
import type { Language, OfflineChangeReason, OfflineOutcome, OfflineReply, OfflineState, VoiceCommandAction } from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import { installVoiceModel, type DownloadableModel } from '../../shared/node/voice-models.ts';
import { asNamedWindow, normalizeTarget, windowLabel } from '../../shared/lib/window-names.ts';
import { parseAssistantRequest } from '../assistant/index.ts';
import type { CommandRouter } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';
import { createLocalModel, type LocalModel } from './llm.ts';
import { probeNetwork } from './network.ts';

export { createWorkerModel } from './worker-model.ts';
import { answerTimeOrDate, readModelLine, timeOrDateQuestion } from './prompt.ts';

export interface OfflineManifest {
  readonly id: string;
  readonly name: string;
  readonly license: string;
  readonly source: string;
  readonly dir: string;
  readonly minRamBytes: number;
  readonly files: ReadonlyArray<{ readonly name: string; readonly url: string; readonly size: number; readonly sha256: string }>;
}

export const OFFLINE_MODEL: OfflineManifest = manifest;

export const OFFLINE_TIMING = {
  /**
   * Ogni quanto si guarda la rete: più spesso quando manca, per tornare online presto. È una connessione
   * aperta e chiusa, dichiarata nell'informativa; con `offline.auto` spento non si fa.
   */
  probeOnlineMs: 60_000,
  probeOfflineMs: 10_000,
  firstProbeMs: 3_000,
  /** Fallimenti consecutivi prima di dichiarare offline (una connessione persa una volta non basta). */
  failuresToOffline: 2,
  /** Tempo per rispondere «sì» a una conferma. */
  confirmMs: 60_000
} as const;

type Source = 'ui' | 'voice';

export interface OfflineDeps {
  events: EventEmitter;
  log: Logger;
  now: () => number;
  language: () => Language;
  /** Impostazione `offline.auto`, riletta a ogni cambio. */
  auto: () => boolean;
  /** Cartella dei modelli locali (`<home>\models\offline`). */
  modelsDir: string;
  assistant: { handle(text: string, source: Source, correlationId?: string | null): { reply: string; speak?: boolean } | null };
  /** «apri le impostazioni», «chiudi la finestra»…: i comandi di ambiente della voce, eseguiti dalla UI. */
  voiceCommand?: (text: string) => { action: VoiceCommandAction; target: string | null } | null;
  /** Programmi installati (catalogo di Windows): «aprimi la calcolatrice». Assente = solo finestre di VISIONE. */
  apps?: { list(): Promise<ReadonlyArray<{ id: string; name: string }>>; launch(id: string): Promise<{ launched: boolean }> };
  probe?: () => Promise<boolean>;
  model?: (dir: string) => LocalModel;
  install?: typeof installVoiceModel;
  manifest?: OfflineManifest;
  totalMemBytes?: number;
}

export interface OfflineAnswer extends OfflineReply {
  /** Da dire a voce (le conferme delle azioni si vedono a schermo e non si dicono). */
  readonly speak: boolean;
}

export interface Offline {
  state(): OfflineState;
  /** Le richieste vanno al modello locale. */
  active(): boolean;
  /** C'è una domanda «confermi?» in attesa di un sì o di un no. */
  awaitingConfirm(): boolean;
  set(active: boolean): OfflineState;
  ask(text: string, source: Source, correlationId: string | null, opts?: { rulesDone?: boolean }): Promise<OfflineAnswer>;
  download(): { started: boolean; alreadyComplete: boolean; totalBytes: number };
  cancelDownload(): boolean;
  /** Impostazioni cambiate: si rilegge `offline.auto`. */
  configChanged(): void;
  start(): void;
  close(): Promise<void>;
}

// Fine parola esplicita: `\b` non vede le lettere accentate («sì»).
const YES = /^\s*(?:s[iì]|ok|okay|va\s+bene|conferma|confermo|certo|esatto|yes|yep|yeah|sure|confirm)(?=$|[\s,.!?])/i;
const NO = /^\s*(?:no|non\s+farlo|lascia\s+stare|annulla|niente|nope|don'?t|never\s*mind|cancel)(?=$|[\s,.!?])/i;

export function createOffline(deps: OfflineDeps): Offline {
  const { events, log, now } = deps;
  const m = deps.manifest ?? OFFLINE_MODEL;
  const dir = join(deps.modelsDir, m.dir);
  const model = (deps.model ?? ((d) => createLocalModel({ dir: d, language: deps.language })))(dir);
  const probe = deps.probe ?? (() => probeNetwork());
  const install = deps.install ?? installVoiceModel;
  const ramOk = (deps.totalMemBytes ?? totalmem()) >= m.minRamBytes;
  const sizeBytes = m.files.reduce((n, f) => n + f.size, 0);
  const en = (): boolean => deps.language() === 'en';

  let network: OfflineState['network'] = 'unknown';
  let manual = false;
  let failures = 0;
  let since = now();
  let loading = false;
  let loadError: string | null = null;
  let download: { abort: AbortController; received: number } | null = null;
  let downloadError: string | null = null;
  let pending: { text: string; until: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = true;
  let lastKey = '';

  const present = (): boolean => m.files.every((f) => existsSync(join(dir, f.name)));
  const isActive = (): boolean => manual || (deps.auto() && network === 'offline');

  const state = (): OfflineState => {
    const status = download ? 'downloading' : !present() ? 'missing' : loadError ? 'error' : model.loaded() ? 'ready' : loading ? 'loading' : 'idle';
    return {
      network, active: isActive(), manual, auto: deps.auto(),
      model: {
        status, name: m.name, license: m.license, sizeBytes,
        received: download?.received ?? 0,
        error: (loadError ?? downloadError)?.slice(0, 500) ?? null
      },
      ramOk, since
    };
  };

  /** Applica il cambio: carica o libera il modello e lo dice alla UI (solo se qualcosa è cambiato davvero). */
  const changed = (reason: OfflineChangeReason): void => {
    const s = state();
    const key = `${s.network}|${s.active}|${s.manual}|${s.auto}|${s.model.status}`;
    if (key === lastKey) return;
    const wasActive = lastKey.split('|')[1] === 'true';
    lastKey = key;
    if (s.active !== wasActive) since = now();
    events.emit('offline.changed', { state: { ...s, since }, reason });
    if (s.active && !wasActive) {
      log.info('modalità offline attiva', { manual: s.manual, network: s.network, model: s.model.status });
      warm();
    } else if (!s.active && wasActive) {
      log.info('modalità offline finita: si torna agli agenti', { network: s.network });
      void model.release().then(() => changed('model'));
    }
  };

  /** Carica il modello in sottofondo appena si entra offline: quando arriva la domanda è già pronto. */
  const warm = (): void => {
    if (!present() || model.loaded() || loading || download) return;
    loading = true;
    loadError = null;
    const t0 = now();
    void model.load().then(
      () => { log.info('modello locale pronto', { ms: now() - t0 }); },
      (err: unknown) => {
        loadError = err instanceof Error ? err.message : String(err);
        log.warn('modello locale non caricato', { reason: loadError.slice(0, 300) });
      }
    ).finally(() => {
      loading = false;
      // Uscito dall'offline mentre caricava: si libera subito.
      if (!isActive()) void model.release();
      changed('model');
    });
  };

  const schedule = (ms: number): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, ms);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    timer = null;
    // Automatico spento: nessuna connessione di controllo (informativa, punto 4); la spia lo dice.
    if (!deps.auto()) {
      if (network !== 'unknown') { network = 'unknown'; failures = 0; changed('setting'); }
      schedule(OFFLINE_TIMING.probeOnlineMs);
      return;
    }
    let ok = false;
    try { ok = await probe(); } catch { ok = false; }
    if (closed) return;
    if (ok) {
      failures = 0;
      if (network !== 'online') { network = 'online'; changed('network'); }
    } else {
      failures++;
      if (failures >= OFFLINE_TIMING.failuresToOffline && network !== 'offline') {
        network = 'offline';
        log.warn('rete assente', { failures });
        changed('network');
      }
    }
    schedule(network === 'offline' ? OFFLINE_TIMING.probeOfflineMs : OFFLINE_TIMING.probeOnlineMs);
  };

  const finish = (text: string, source: Source, out: { reply: string; outcome: OfflineOutcome; understood?: string | null; speak?: boolean }): OfflineAnswer => {
    const answer: OfflineAnswer = { reply: out.reply.slice(0, 700), outcome: out.outcome, understood: out.understood?.slice(0, 500) ?? null, speak: out.speak ?? true };
    events.emit('offline.reply', { text: text.slice(0, 500), source, reply: answer.reply, outcome: answer.outcome, understood: answer.understood });
    return answer;
  };

  const capabilities = (): string => (en()
    ? 'Offline I can do: reminders, agenda, notes, timers, lists, opening VISIONE windows and programs, date and time.'
    : 'Offline so fare: promemoria, agenda, note, timer, liste, aprire le finestre di VISIONE e i programmi, data e ora.');

  type Done = { reply: string; speak: boolean; outcome: OfflineOutcome };
  const emitCommand = (action: VoiceCommandAction, target: string | null, line: string, correlationId: string | null): void => {
    events.emit('voice.command', { utteranceId: (correlationId ?? `offline-${now()}`).slice(0, 64), action, target, text: line.slice(0, 500) });
  };

  /**
   * «apri X» che non è una finestra di VISIONE (17/10/2026): un programma installato (catalogo di Windows,
   * nome uguale o unico che comincia così); se non c'è, lo dice invece di «Fatto».
   */
  const open = async (target: string | null): Promise<Done> => {
    const said = (target ?? '').trim();
    const wanted = normalizeTarget(said);
    if (wanted.length >= 2 && deps.apps) {
      const named = (await deps.apps.list().catch(() => [])).map((a) => ({ app: a, n: normalizeTarget(a.name) }));
      const starts = named.filter((x) => x.n.startsWith(wanted));
      const contains = named.filter((x) => x.n.includes(wanted));
      const pick = named.find((x) => x.n === wanted) ?? (starts.length === 1 ? starts[0] : undefined) ?? (contains.length === 1 ? contains[0] : undefined);
      if (pick) {
        const out = await deps.apps.launch(pick.app.id).catch(() => ({ launched: false }));
        log.info('programma aperto offline', { name: pick.app.name, launched: out.launched });
        return out.launched
          ? { reply: en() ? `Opening ${pick.app.name}.` : `Apro ${pick.app.name}.`, speak: false, outcome: 'assisted' }
          : { reply: en() ? `I could not open ${pick.app.name}.` : `Non sono riuscito ad aprire ${pick.app.name}.`, speak: true, outcome: 'error' };
      }
      const many = starts.length > 1 ? starts : contains;
      if (many.length > 1) {
        const names = many.slice(0, 3).map((x) => x.app.name).join(', ');
        return { reply: en() ? `I found more than one: ${names}. Which one?` : `Ne trovo più di uno: ${names}. Quale?`, speak: true, outcome: 'unknown' };
      }
    }
    return { reply: en() ? `I can't find “${said}” among VISIONE windows or installed programs.` : `Non trovo «${said}» tra le finestre di VISIONE né tra i programmi installati.`, speak: true, outcome: 'unknown' };
  };

  /** Esegue una frase che le regole capiscono (o un comando di ambiente). */
  const perform = async (line: string, source: Source, correlationId: string | null): Promise<Done | null> => {
    const command = deps.voiceCommand?.(line);
    if (command?.action === 'open-agent') return open(command.target);
    const window = command?.action === 'open-window' ? asNamedWindow(command.target) : null;
    if (window) {
      emitCommand('open-window', window, line, correlationId);
      const label = windowLabel(window, en() ? 'en' : 'it');
      return { reply: en() ? `Opening ${label}.` : `Apro ${label}.`, speak: false, outcome: 'assisted' };
    }
    if (command) {
      emitCommand(command.action, command.target, line, correlationId);
      return { reply: en() ? 'Done.' : 'Fatto.', speak: false, outcome: 'assisted' };
    }
    const out = deps.assistant.handle(line, source, correlationId);
    return out ? { reply: out.reply, speak: out.speak !== false, outcome: 'assisted' } : null;
  };

  const ask = async (raw: string, source: Source, correlationId: string | null, opts: { rulesDone?: boolean } = {}): Promise<OfflineAnswer> => {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
    const lang = deps.language();
    // 1. Risposta a un «confermi?».
    // Solo una risposta breve («sì», «no grazie»): «annulla il promemoria della palestra» è una richiesta nuova.
    const short = text.split(' ').length <= 3;
    if (pending && now() <= pending.until && short && (YES.test(text) || NO.test(text))) {
      const todo = pending;
      pending = null;
      if (NO.test(text) && !YES.test(text)) return finish(text, source, { reply: en() ? 'OK, I left it as it was.' : 'Va bene, lascio com\'era.', outcome: 'answered', speak: true });
      const done = await perform(todo.text, source, correlationId);
      return finish(text, source, { reply: done?.reply ?? (en() ? 'I could not do it.' : 'Non ci sono riuscito.'), outcome: done ? done.outcome : 'error', understood: todo.text, speak: true });
    }
    pending = null;
    if (text.length === 0) return finish(text, source, { reply: capabilities(), outcome: 'unknown' });
    // 2. Le regole di sempre, senza modello.
    const asked = timeOrDateQuestion(text);
    if (asked) return finish(text, source, { reply: answerTimeOrDate(asked, now(), lang), outcome: 'answered' });
    if (!opts.rulesDone) {
      const done = await perform(text, source, correlationId);
      if (done) return finish(text, source, { reply: done.reply, outcome: done.outcome, speak: done.speak });
    }
    // 3. Il modello locale riscrive la frase.
    const s = state();
    if (s.model.status === 'missing' || s.model.status === 'downloading') {
      return finish(text, source, {
        reply: en()
          ? `I didn't understand, and the offline model isn't downloaded: ${capabilities().replace('Offline I can do: ', 'try exact phrases about ')}`
          : `Non ho capito, e il modello offline non è scaricato: senza, capisco solo le frasi esatte («ricordami tra un'ora di…», «cosa devo fare oggi», «metti un timer di 10 minuti»).`,
        outcome: 'unknown'
      });
    }
    let line: string;
    const t0 = now();
    try {
      line = await model.rewrite(text);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      changed('model');
      log.warn('modello locale: richiesta non riuscita', { reason: loadError.slice(0, 300) });
      return finish(text, source, { reply: en() ? 'The offline model is not working right now.' : 'Il modello offline non risponde in questo momento.', outcome: 'error' });
    }
    log.info('richiesta offline', { ms: now() - t0, chars: text.length });
    changed('model');
    const read = readModelLine(line);
    if (read.kind === 'refuse') {
      return finish(text, source, {
        reply: en() ? 'I can\'t do that offline: it needs the network. Ask me again when you are back online.' : 'Offline non posso farlo: serve la rete. Chiedimelo quando torni online.',
        outcome: 'refused', understood: line
      });
    }
    if (read.kind === 'time' || read.kind === 'date') return finish(text, source, { reply: answerTimeOrDate(read.kind, now(), lang), outcome: 'answered', understood: line });
    const req = parseAssistantRequest(read.text, now(), lang);
    const command = deps.voiceCommand?.(read.text);
    if (!req && !command) return finish(text, source, { reply: `${en() ? 'I didn\'t understand.' : 'Non ho capito.'} ${capabilities()}`, outcome: 'unknown', understood: read.text });
    // Annullare va confermato: il modello piccolo a volte copia un esempio invece della frase.
    if (req?.kind === 'cancel') {
      pending = { text: read.text, until: now() + OFFLINE_TIMING.confirmMs };
      return finish(text, source, { reply: en() ? `I understood: “${read.text}”. Shall I go ahead? (yes / no)` : `Ho capito: «${read.text}». Procedo? (sì / no)`, outcome: 'confirm', understood: read.text });
    }
    const done = await perform(read.text, source, correlationId);
    if (!done) return finish(text, source, { reply: `${en() ? 'I didn\'t understand.' : 'Non ho capito.'} ${capabilities()}`, outcome: 'unknown', understood: read.text });
    return finish(text, source, { reply: done.reply, outcome: done.outcome, understood: read.text, speak: done.speak });
  };

  return {
    state: () => ({ ...state(), since }),
    active: isActive,
    awaitingConfirm: () => pending !== null && now() <= pending.until,
    set(active) {
      manual = active;
      changed('manual');
      return { ...state(), since };
    },
    ask,
    download() {
      if (present()) return { started: false, alreadyComplete: true, totalBytes: sizeBytes };
      if (download) return { started: false, alreadyComplete: false, totalBytes: sizeBytes };
      const abort = new AbortController();
      download = { abort, received: 0 };
      downloadError = null;
      changed('model');
      log.info('download del modello offline avviato', { model: m.id, bytes: sizeBytes });
      void (async () => {
        let before = 0;
        try {
          for (const f of m.files) {
            const entry: DownloadableModel = { id: `${m.id}/${f.name}`, url: f.url, archive: false, dir: m.dir, size: f.size, sha256: f.sha256, files: [f.name] };
            if (existsSync(join(dir, f.name))) { before += f.size; continue; }
            await install(entry, deps.modelsDir, {
              signal: abort.signal,
              onProgress: (phase, received) => {
                if (download) download.received = before + received;
                if (phase === 'download' || phase === 'verifica') events.emit('offline.model.progress', { phase, file: f.name.slice(0, 80), received: before + received, total: sizeBytes, error: null });
              }
            });
            before += f.size;
          }
          events.emit('offline.model.progress', { phase: 'completato', file: '', received: sizeBytes, total: sizeBytes, error: null });
          log.info('modello offline scaricato e verificato', { model: m.id });
        } catch (err) {
          const aborted = abort.signal.aborted;
          downloadError = aborted ? null : (err instanceof Error ? err.message : String(err)).slice(0, 500);
          events.emit('offline.model.progress', { phase: aborted ? 'annullato' : 'errore', file: '', received: before, total: sizeBytes, error: downloadError });
          if (!aborted) log.warn('download del modello offline non riuscito', { reason: downloadError });
        } finally {
          download = null;
          changed('model');
          if (isActive()) warm();
        }
      })();
      return { started: true, alreadyComplete: false, totalBytes: sizeBytes };
    },
    cancelDownload() {
      if (!download) return false;
      download.abort.abort();
      return true;
    },
    configChanged: () => {
      changed('setting');
      // Riacceso: si guarda subito la rete, senza aspettare il prossimo giro.
      if (deps.auto()) schedule(OFFLINE_TIMING.firstProbeMs);
    },
    start() {
      closed = false;
      lastKey = '';
      changed('network');
      schedule(OFFLINE_TIMING.firstProbeMs);
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      download?.abort.abort();
      await model.release();
    }
  };
}

export function registerOfflineCommands(router: CommandRouter, offline: Offline): void {
  router.register('offline.status', () => offline.state());
  router.register('offline.set', (payload) => offline.set(payload.active));
  router.register('offline.ask', async (payload, ctx) => {
    const out = await offline.ask(payload.text, 'ui', ctx.command.correlationId);
    return { reply: out.reply, outcome: out.outcome, understood: out.understood };
  });
  router.register('offline.model.download', () => offline.download());
  router.register('offline.model.cancel', () => ({ cancelled: offline.cancelDownload() }));
}
