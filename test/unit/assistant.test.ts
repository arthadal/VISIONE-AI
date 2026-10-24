// Assistente personale (beta.5, P-109): il «quando» in italiano, le richieste, i promemoria con
// l'orologio (orologio e timer finti), i comandi e il passaggio dalla voce. Database vero in una
// cartella temporanea; nessuna rete, nessun motore.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssistant, fireMessage, registerAssistantCommands, type Assistant } from '../../src/core/assistant/index.ts';
import { parseAssistantRequest } from '../../src/core/assistant/intent.ts';
import { describeWhen, parseWhen } from '../../src/core/assistant/when.ts';
import type { ApprovalQueue } from '../../src/core/approvals/index.ts';
import { createEventBus } from '../../src/core/bus/index.ts';
import { createCommandRouter, type CommandRouter } from '../../src/core/commands/index.ts';
import { migrate, openDb } from '../../src/core/db/index.ts';
import type { Director } from '../../src/core/director/index.ts';
import { createEventEmitter, type EventEmitter } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import { createVoiceController } from '../../src/core/voice/index.ts';
import type { CommandEnvelope, CoreToVoice, VisioneEvent } from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import type { VisioneConfig } from '../../src/shared/node/config.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

/** Domenica 11 ottobre 2026, ore 10:00 (ora locale). */
const NOW = new Date(2026, 9, 11, 10, 0).getTime();
const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime();
const MIN = 60_000;

describe('parseWhen', () => {
  const cases: Array<[string, number | null, string]> = [
    ["tra un'ora devo andare a fare la spesa", at(11, 11), 'devo andare a fare la spesa'],
    ["tra mezz'ora chiama Niccolò", at(11, 10, 30), 'chiama Niccolò'],
    ["fra un quarto d'ora", at(11, 10, 15), ''],
    ['tra 10 minuti', at(11, 10, 10), ''],
    ["tra un'ora e mezza", at(11, 11, 30), ''],
    ['tra 2 ore e 15 minuti', at(11, 12, 15), ''],
    ['tra due giorni pagare l\'affitto', at(13, 10), 'pagare l\'affitto'],
    ['alle 15:30 riunione', at(11, 15, 30), 'riunione'],
    ['alle 3 e mezza', at(11, 15, 30), ''],
    ["all'una pranzo", at(11, 13), 'pranzo'],
    ['alle 9 di sera', at(11, 21), ''],
    ['alle 9', at(11, 21), ''],
    ['a mezzogiorno', at(11, 12), ''],
    ['domani alle 15 ho il dentista', at(12, 15), 'ho il dentista'],
    ['domattina chiamare il medico', at(12, 9), 'chiamare il medico'],
    ['lunedì alle 9 e un quarto', at(12, 9, 15), ''],
    ['il 15 ottobre alle 10', at(15, 10), ''],
    ['domani 18:45 calcetto', at(12, 18, 45), 'calcetto'],
    ['venerdì sera cena da Marta', at(16, 20), 'cena da Marta'],
    ['versione 1.10 da rilasciare', null, ''],
    ['scrivi il codice per il login', null, '']
  ];
  for (const [text, expected, rest] of cases) {
    it(`«${text}»`, () => {
      const w = parseWhen(text, NOW);
      if (expected === null) { expect(w).toBeNull(); return; }
      expect(w?.at).toBe(expected);
      expect(w?.rest).toBe(rest);
    });
  }

  it('solo il giorno: ora approssimata (exact false); un\'ora passata oggi è «past»', () => {
    expect(parseWhen('stasera', NOW)).toMatchObject({ at: at(11, 20), exact: false });
    expect(parseWhen('oggi alle 9', NOW)).toMatchObject({ at: at(11, 9), past: true });
  });

  it('il 3/11 e il 15 ottobre passato vanno avanti', () => {
    expect(parseWhen('il 3/11 bolletta', NOW)?.at).toBe(new Date(2026, 10, 3, 9).getTime());
    expect(parseWhen('il 1 ottobre', NOW)?.at).toBe(new Date(2027, 9, 1, 9).getTime());
  });

  it('describeWhen: oggi, domani, giorno della settimana', () => {
    expect(describeWhen(at(11, 15, 30), NOW)).toBe('oggi alle 15:30');
    expect(describeWhen(at(12, 9), NOW)).toBe('domani alle 9:00');
    expect(describeWhen(at(15, 10), NOW)).toBe('giovedì 15 ottobre alle 10:00');
  });
});

describe('parseAssistantRequest', () => {
  it('promemoria espliciti e naturali', () => {
    expect(parseAssistantRequest("tra un'ora devo andare a fare la spesa", NOW)).toMatchObject({ kind: 'reminder', text: 'Andare a fare la spesa', when: { at: at(11, 11) }, appointment: false });
    expect(parseAssistantRequest('Ricordami di chiamare Luca alle 15', NOW)).toMatchObject({ kind: 'reminder', text: 'Chiamare Luca', when: { at: at(11, 15) } });
    expect(parseAssistantRequest('Visione, ricordami domani alle 9 e mezza di pagare la bolletta', NOW)).toMatchObject({ text: 'Pagare la bolletta', when: { at: at(12, 9, 30) } });
    expect(parseAssistantRequest('domani alle 15 ho il dentista', NOW)).toMatchObject({ kind: 'reminder', appointment: true, when: { at: at(12, 15) } });
    expect(parseAssistantRequest('svegliami alle 7 domani mattina', NOW)).toMatchObject({ text: 'Sveglia', when: { at: at(12, 7) } });
    expect(parseAssistantRequest('ricordami di comprare il latte', NOW)).toMatchObject({ kind: 'reminder', text: 'Comprare il latte', when: null });
    expect(parseAssistantRequest('ricordati che domani alle 15 ho la riunione', NOW)).toMatchObject({ kind: 'reminder', appointment: true });
  });

  it('note, agenda, annulla', () => {
    expect(parseAssistantRequest('Salvami questo: la chiave è nel cassetto', NOW)).toEqual({ kind: 'note', text: 'La chiave è nel cassetto' });
    expect(parseAssistantRequest('cosa devo fare oggi?', NOW)).toEqual({ kind: 'agenda', day: 'today' });
    expect(parseAssistantRequest('che impegni ho domani', NOW)).toEqual({ kind: 'agenda', day: 'tomorrow' });
    expect(parseAssistantRequest('i miei promemoria', NOW)).toEqual({ kind: 'agenda', day: 'upcoming' });
    expect(parseAssistantRequest('annulla il promemoria della spesa', NOW)).toEqual({ kind: 'cancel', query: 'Spesa' });
  });

  it('il lavoro sul codice e le risposte brevi restano al Director', () => {
    for (const t of ['domani devo sistemare il bug del login', 'fai il commit domani alle 9', 'scrivi una funzione per il login', 'annulla', 'sì', 'domani alle 15', 'accendi le luci']) {
      expect(parseAssistantRequest(t, NOW), t).toBeNull();
    }
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  return {
    set: (fn: () => void, ms: number): unknown => { pending.set(++n, { fn, ms }); return n; },
    clear: (h: unknown): void => { pending.delete(h as number); },
    /** Esegue i timer in attesa (l'orologio va spostato prima). */
    run: (): void => { const list = [...pending.entries()]; pending.clear(); for (const [, t] of list) t.fn(); },
    delays: (): number[] => [...pending.values()].map((t) => t.ms)
  };
}

function setup(dir?: string) {
  const h = dir ? null : tempHome();
  const home = dir ?? h!.dir;
  const db = openDb(join(home, 'visione.db'));
  migrate(db);
  const journal = createJournal(db);
  const bus = createEventBus();
  const seen: VisioneEvent[] = [];
  bus.subscribe((e) => seen.push(e));
  const events = createEventEmitter({ db, journal, bus });
  const clock = { t: NOW };
  const timers = manualTimers();
  const notes: string[] = [];
  const assistant = createAssistant({ db, events, log: memoryLogger().log, now: () => clock.t, timers, saveNote: (text) => { notes.push(text); } });
  const router = createCommandRouter({ db, events, log: memoryLogger().log, defaultTimeoutMs: 2_000 });
  registerAssistantCommands(router, assistant, () => clock.t);
  const close = (): void => { assistant.close(); events.close(); bus.close(); db.close(); };
  cleanups.push(() => { try { close(); } catch { /* già chiuso */ } h?.cleanup(); });
  return { home, db, bus, seen, clock, timers, notes, assistant, router, close, idle: () => bus.idle() };
}

const cmd = (type: string, payload: unknown): CommandEnvelope => {
  const id = ulid();
  return { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui', payload };
};

describe('createAssistant', () => {
  it('«tra 10 minuti devo togliere la pasta»: conferma, scatta all\'ora con voce e notifica', async () => {
    const s = setup();
    s.assistant.start();
    const out = s.assistant.handle('tra 10 minuti devo togliere la pasta', 'voice');
    expect(out?.reply).toBe('Va bene, te lo ricordo oggi alle 10:10.');
    expect(s.assistant.list('open', 10)).toHaveLength(1);
    expect(Math.max(...s.timers.delays())).toBeLessThanOrEqual(MIN);
    s.clock.t = at(11, 10, 10);
    s.timers.run();
    await s.idle();
    const fired = s.seen.find((e) => e.type === 'assistant.reminder.fired');
    expect(fired?.payload).toMatchObject({ text: 'Togliere la pasta', message: 'Promemoria: togliere la pasta.', lateMs: 0 });
    expect(s.assistant.list('open', 10)[0]?.status).toBe('fired');
  });

  it('appuntamento: avviso un quarto d\'ora prima', () => {
    const s = setup();
    const out = s.assistant.handle('domani alle 15 ho il dentista', 'voice');
    expect(out?.reply).toBe('Segnato: il dentista, domani alle 15:00. Ti avviso 15 minuti prima.');
    expect(out?.reminder).toMatchObject({ kind: 'appointment', dueAt: at(12, 15), notifyAt: at(12, 14, 45) });
    expect(fireMessage(out!.reminder!, at(12, 14, 45))).toBe('Tra 15 minuti: il dentista.');
  });

  it('senza quando chiede «quando?» e la frase dopo lo completa; «lascia stare» rinuncia', () => {
    const s = setup();
    expect(s.assistant.handle('ricordami di comprare il latte', 'voice')?.reply).toBe('Quando te lo ricordo?');
    const out = s.assistant.handle('alle 18', 'voice');
    expect(out?.reminder).toMatchObject({ text: 'Comprare il latte', dueAt: at(11, 18) });
    expect(s.assistant.handle('ricordami di chiamare il tecnico', 'voice')?.reply).toBe('Quando te lo ricordo?');
    expect(s.assistant.handle('lascia stare', 'voice')?.reply).toBe('Va bene, lascio stare.');
    expect(s.assistant.list('open', 10)).toHaveLength(1);
  });

  it('un\'ora già passata non crea niente', () => {
    const s = setup();
    expect(s.assistant.handle('ricordami oggi alle 9 di chiamare Luca', 'voice')?.reply).toMatch(/già passata/);
    expect(s.assistant.list('all', 10)).toHaveLength(0);
  });

  it('scaduto a VISIONE chiusa: all\'avvio scatta «in ritardo»', async () => {
    const first = setup();
    first.assistant.handle('tra 10 minuti devo togliere la pasta', 'voice');
    first.close();
    const again = setup(first.home);
    again.clock.t = at(11, 12);
    again.assistant.start();
    expect(again.timers.delays()).toEqual([15_000]); // la voce ha il tempo di partire
    again.timers.run();
    await again.idle();
    const fired = again.seen.find((e) => e.type === 'assistant.reminder.fired');
    expect(fired?.payload).toMatchObject({ message: 'Promemoria in ritardo, era per oggi alle 10:10: togliere la pasta.' });
  });

  it('rimanda, fatto, annulla; due volte «fatto» è un errore', () => {
    const s = setup();
    const r = s.assistant.handle('tra 10 minuti devo togliere la pasta', 'voice')!.reminder!;
    expect(s.assistant.update(r.id, 'snooze', 30)).toMatchObject({ status: 'pending', notifyAt: NOW + 30 * MIN });
    expect(s.assistant.update(r.id, 'done').status).toBe('done');
    expect(() => s.assistant.update(r.id, 'done')).toThrow(/già fatto/);
    expect(s.assistant.list('open', 10)).toHaveLength(0);
  });

  it('agenda a voce, note, annulla a voce', () => {
    const s = setup();
    expect(s.assistant.handle('cosa devo fare oggi', 'voice')?.reply).toBe('Oggi non hai niente in programma.');
    s.assistant.handle('ricordami alle 15 di chiamare Luca', 'voice');
    s.assistant.handle('tra un\'ora devo andare a fare la spesa', 'voice');
    s.assistant.handle('domani alle 9 ho la riunione', 'voice');
    expect(s.assistant.handle('cosa devo fare oggi', 'voice')?.reply).toBe('Oggi hai 2 impegni: alle 11:00 andare a fare la spesa; alle 15:00 chiamare Luca.');
    expect(s.assistant.handle('che impegni ho domani', 'voice')?.reply).toBe('Domani hai un impegno: alle 9:00 la riunione.');
    expect(s.assistant.handle('annulla il promemoria della spesa', 'voice')?.reply).toBe('Annullato: andare a fare la spesa.');
    expect(s.assistant.handle('annulla il promemoria del gatto', 'voice')?.reply).toBe('Non trovo un promemoria su «gatto».');
    expect(s.assistant.handle('salvami questo: la chiave è nel cassetto', 'voice')?.reply).toBe('Salvato nelle note.');
    expect(s.notes).toEqual(['La chiave è nel cassetto']);
    expect(s.assistant.handle('accendi le luci', 'voice')).toBeNull();
  });
});

describe('comandi dell\'Assistente', () => {
  it('add dal widget, parse per l\'anteprima, list e update', async () => {
    const s = setup();
    const parsed = await s.router.dispatch(cmd('assistant.parse', { text: 'domani alle 9 chiamare Luca' }));
    expect(parsed).toMatchObject({ ok: true, data: { at: at(12, 9), label: 'domani alle 9:00', text: 'Chiamare Luca', exact: true } });
    const added = await s.router.dispatch(cmd('assistant.reminder.add', { text: 'domani alle 9 chiamare Luca' }));
    expect(added).toMatchObject({ ok: true, data: { reminder: { text: 'Chiamare Luca', source: 'ui' }, reply: 'Va bene, te lo ricordo domani alle 9:00.' } });
    const missing = await s.router.dispatch(cmd('assistant.reminder.add', { text: 'comprare il pane' }));
    expect(missing).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    const list = await s.router.dispatch(cmd('assistant.reminders.list', {}));
    expect(list.ok && (list.data as { reminders: unknown[] }).reminders).toHaveLength(1);
    const id = (added.ok ? (added.data as { reminder: { id: string } }).reminder.id : '');
    expect(await s.router.dispatch(cmd('assistant.reminder.update', { id, action: 'cancel' }))).toMatchObject({ ok: true, data: { reminder: { status: 'cancelled' } } });
  });
});

describe('voce → Assistente', () => {
  const voiceConfig = {
    enabled: true, modelsDir: null, speaker: 'if_sara', threads: 4, bargeIn: true, pttShortcut: 'Control+Alt+Space',
    vadThreshold: 0.5, minSpeechMs: 120, minSilenceMs: 600, noiseGate: 0.004, denoise: true,
    ownerOnly: { enabled: false, minScore: 0.4, margin: 0.05 }, speakSummaries: true, announceApprovals: true,
    announceStartup: false, startupPhrase: '', tts: { provider: 'kokoro', voice: 'x', rate: '+0%', pitch: '+0Hz' },
    wake: { enabled: false, phrase: 'hey visione', sensitivity: 0.5, commandTimeoutMs: 6_000 }
  } as VisioneConfig['voice'];

  function voiceWith(assistant: Assistant) {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sent: CoreToVoice[] = [];
    const submitted: string[] = [];
    const listeners = new Map<string, (event: { type: string; payload: Record<string, unknown> }) => void>();
    const voice = createVoiceController({
      events: { emit: (type: string, payload: Record<string, unknown>) => { emitted.push({ type, payload }); } } as unknown as EventEmitter,
      bus: { on: (type: string, l: (event: { type: string; payload: Record<string, unknown> }) => void) => { listeners.set(type, l); return { unsubscribe: () => listeners.delete(type), active: true, dropped: 0 }; } } as never,
      approvals: { list: () => [], decide: () => null } as unknown as ApprovalQueue,
      director: { submit: (input: { goal: string }) => { submitted.push(input.goal.split('\n\n(')[0]!); return { rootTaskId: 'r', planner: 'rule', taskIds: ['r'] }; } } as unknown as Director,
      assistant,
      config: voiceConfig,
      log: memoryLogger().log,
      send: (m) => { sent.push(m); },
      newId: () => ulid()
    });
    voice.handle({ type: 'ready', voices: [], filters: { denoise: false, speaker: false, owner: false, ownerOnly: false, noiseGate: 0.004 }, engines: { vad: 'v', stt: 's', tts: 't' }, loadMs: 10 });
    const say = (text: string): void => voice.handle({ type: 'utterance', utteranceId: ulid(), text, audioMs: 500, sttMs: 20, latencyMs: 30 });
    const spoken = (): string[] => sent.flatMap((m) => (m.type === 'speak' ? [m.text] : []));
    return { voice, emitted, submitted, listeners, say, spoken };
  }

  it('«tra un\'ora devo…» va all\'Assistente, non al Director; il codice resta al Director', () => {
    const s = setup();
    const v = voiceWith(s.assistant);
    v.say("tra un'ora devo andare a fare la spesa");
    expect(v.submitted).toEqual([]);
    // La conferma si vede a schermo (evento) ma non si dice: niente frasi fatte (15/10/2026).
    expect(v.spoken()).toEqual([]);
    expect(v.emitted.find((e) => e.type === 'voice.intent')?.payload.detail).toBe('Va bene, te lo ricordo oggi alle 11:00.');
    expect(v.emitted.find((e) => e.type === 'voice.intent')?.payload).toMatchObject({ intent: 'assistant', outcome: 'assisted' });
    v.say('sistema il bug del login');
    expect(v.submitted).toEqual(['sistema il bug del login']);
  });

  it('il promemoria scattato lo dice la voce', () => {
    const s = setup();
    const v = voiceWith(s.assistant);
    v.listeners.get('assistant.reminder.fired')?.({ type: 'assistant.reminder.fired', payload: { message: 'Promemoria: togliere la pasta.' } });
    expect(v.spoken()).toContain('Promemoria: togliere la pasta.');
  });
});

// Secondo giro (P-109b, 15/10/2026): ricorrenti, timer e liste. NOW è domenica 11 ottobre alle 10:00.
describe('secondo giro: le frasi', () => {
  it('ricorrenti: ogni giorno, ogni lunedì, dal lunedì al venerdì, ogni sera; anche in inglese', () => {
    expect(parseAssistantRequest('ricordami ogni giorno alle 8 di prendere la pillola', NOW)).toMatchObject({
      kind: 'reminder', text: 'Prendere la pillola', repeat: 'daily', when: { at: at(12, 8), exact: true }
    });
    expect(parseAssistantRequest('ogni lunedì alle 9 ho la palestra', NOW)).toMatchObject({ kind: 'reminder', text: 'La palestra', repeat: 'weekly', when: { at: at(12, 9) } });
    expect(parseAssistantRequest('dal lunedì al venerdì alle 7 svegliami', NOW)).toMatchObject({ kind: 'reminder', text: 'Sveglia', repeat: 'weekdays', when: { at: at(12, 7) } });
    expect(parseAssistantRequest('ogni sera ricordami di chiudere il gas', NOW)).toMatchObject({ text: 'Chiudere il gas', repeat: 'daily', when: { at: at(11, 20), exact: false } });
    expect(parseAssistantRequest('remind me every Monday at 9 to take out the trash', NOW, 'en')).toMatchObject({ kind: 'reminder', text: 'Take out the trash', repeat: 'weekly', when: { at: at(12, 9) } });
    // Senza «ricordami» né «ho/devo» resta al Director.
    expect(parseAssistantRequest('ogni giorno controlla i log del server', NOW)).toBeNull();
  });

  it('timer: durata prima o dopo, a cosa serve, senza durata chiede', () => {
    expect(parseAssistantRequest('metti un timer di 10 minuti per la pasta', NOW)).toEqual({ kind: 'timer', seconds: 600, label: 'la pasta' });
    expect(parseAssistantRequest("timer di un'ora e mezza", NOW)).toEqual({ kind: 'timer', seconds: 5400, label: '' });
    expect(parseAssistantRequest('fai partire un timer di 2 minuti e 30 secondi', NOW)).toEqual({ kind: 'timer', seconds: 150, label: '' });
    expect(parseAssistantRequest('metti un timer', NOW)).toEqual({ kind: 'timer', seconds: null, label: '' });
    expect(parseAssistantRequest('set a timer for 5 minutes', NOW, 'en')).toEqual({ kind: 'timer', seconds: 300, label: '' });
    expect(parseAssistantRequest('start a 3 minute timer for the eggs', NOW, 'en')).toEqual({ kind: 'timer', seconds: 180, label: 'the eggs' });
  });

  it('liste: aggiungi, leggi, togli, svuota; nome predefinito «spesa»', () => {
    expect(parseAssistantRequest('aggiungi latte e uova alla lista della spesa', NOW)).toEqual({ kind: 'list', op: 'add', list: 'spesa', items: ['latte', 'uova'] });
    expect(parseAssistantRequest('metti il pane, le Mele e un po\' di zucchero nella lista', NOW)).toEqual({ kind: 'list', op: 'add', list: 'spesa', items: ['pane', 'mele', 'zucchero'] });
    expect(parseAssistantRequest("cosa c'è nella lista della spesa?", NOW)).toEqual({ kind: 'list', op: 'read', list: 'spesa', items: [] });
    expect(parseAssistantRequest('togli il latte dalla lista della spesa', NOW)).toEqual({ kind: 'list', op: 'remove', list: 'spesa', items: ['latte'] });
    expect(parseAssistantRequest('svuota la lista dei regali', NOW)).toEqual({ kind: 'list', op: 'clear', list: 'regali', items: [] });
    expect(parseAssistantRequest('add milk and eggs to my shopping list', NOW, 'en')).toEqual({ kind: 'list', op: 'add', list: 'shopping', items: ['milk', 'eggs'] });
    expect(parseAssistantRequest("what's on my shopping list", NOW, 'en')).toEqual({ kind: 'list', op: 'read', list: 'shopping', items: [] });
    expect(parseAssistantRequest('take the milk off my shopping list', NOW, 'en')).toEqual({ kind: 'list', op: 'remove', list: 'shopping', items: ['milk'] });
    expect(parseAssistantRequest('clear my gift list', NOW, 'en')).toEqual({ kind: 'list', op: 'clear', list: 'gift', items: [] });
  });
});

describe('secondo giro: l\'Assistente', () => {
  it('timer: conferma, «tempo scaduto» all\'ora giusta; senza durata chiede «di quanto?»', async () => {
    const s = setup();
    s.assistant.start();
    expect(s.assistant.handle('metti un timer di 10 minuti per la pasta', 'voice')?.reply).toBe('Timer di 10 minuti avviato per la pasta.');
    s.clock.t = at(11, 10, 10);
    s.timers.run();
    await s.idle();
    expect(s.seen.find((e) => e.type === 'assistant.reminder.fired')?.payload).toMatchObject({ kind: 'timer', message: 'Tempo scaduto: la pasta.' });
    expect(s.assistant.handle('metti un timer', 'voice')?.reply).toBe('Di quanto?');
    expect(s.assistant.handle('5 minuti', 'voice')?.reply).toBe('Timer di 5 minuti avviato.');
    expect(s.assistant.handle('annulla il timer', 'voice')?.reply).toBe('Annullato: timer.');
    expect(s.assistant.handle('annulla il timer', 'voice')?.reply).toBe('Non c\'è nessun timer attivo.');
  });

  it('ricorrente: scatta e si ripresenta alla volta dopo; annullarlo ferma la serie', async () => {
    const s = setup();
    s.assistant.start();
    expect(s.assistant.handle('ricordami ogni giorno alle 8 di prendere la pillola', 'voice')?.reply)
      .toBe('Va bene, te lo ricordo ogni giorno alle 8:00. La prima volta domani alle 8:00.');
    s.clock.t = at(12, 8);
    s.timers.run();
    await s.idle();
    const open = s.assistant.list('open', 10);
    expect(open.map((r) => [r.status, r.dueAt, r.repeat])).toEqual([['fired', at(12, 8), 'daily'], ['pending', at(13, 8), 'daily']]);
    // Quello già scattato resta da spuntare; «annulla» colpisce la volta in attesa e ferma la serie.
    expect(s.assistant.handle('annulla il promemoria della pillola', 'voice')?.reply).toBe('Annullato: prendere la pillola.');
    expect(s.assistant.list('open', 10).filter((r) => r.status === 'pending')).toEqual([]);
  });

  it('liste: aggiunge senza doppioni, legge, toglie, svuota', () => {
    const s = setup();
    const say = (t: string): string | undefined => s.assistant.handle(t, 'voice')?.reply;
    expect(say('aggiungi latte e uova alla lista della spesa')).toBe('Aggiunto alla lista della spesa: latte e uova.');
    expect(say('metti il latte nella lista della spesa')).toBe('C\'è già nella lista della spesa.');
    expect(say('cosa c\'è nella lista della spesa?')).toBe('Nella lista della spesa: latte e uova.');
    expect(say('togli il latte dalla lista della spesa')).toBe('Tolto dalla lista della spesa: latte.');
    expect(say('togli il burro dalla lista della spesa')).toBe('Non trovo burro nella lista della spesa.');
    expect(s.assistant.lists()).toMatchObject([{ name: 'spesa', items: [{ text: 'uova' }] }]);
    expect(say('svuota la lista della spesa')).toBe('Ho svuotato la lista della spesa (1 elemento).');
    expect(say('leggimi la lista della spesa')).toBe('La lista della spesa è vuota.');
  });

  it('comandi: ask dal widget (anche «non è per me»), liste, togli un elemento, tipo nell\'anteprima', async () => {
    const s = setup();
    const ask = await s.router.dispatch(cmd('assistant.ask', { text: 'aggiungi pane alla lista della spesa' }));
    expect(ask).toMatchObject({ ok: true, data: { handled: true, reply: 'Aggiunto alla lista della spesa: pane.' } });
    expect(await s.router.dispatch(cmd('assistant.ask', { text: 'scrivi una funzione di ordinamento' }))).toMatchObject({ ok: true, data: { handled: false, reply: null } });
    const lists = await s.router.dispatch(cmd('assistant.lists.get', {}));
    const id = lists.ok ? (lists.data as { lists: Array<{ items: Array<{ id: string }> }> }).lists[0]!.items[0]!.id : '';
    expect(await s.router.dispatch(cmd('assistant.list.remove', { id }))).toMatchObject({ ok: true, data: { removed: true } });
    expect(await s.router.dispatch(cmd('assistant.list.remove', { id }))).toMatchObject({ ok: true, data: { removed: false } });
    await s.idle();
    expect(s.seen.filter((e) => e.type === 'assistant.list.changed').map((e) => e.payload)).toEqual([
      { list: 'spesa', op: 'add', items: 1 }, { list: 'spesa', op: 'remove', items: 0 }
    ]);
    expect(await s.router.dispatch(cmd('assistant.parse', { text: 'metti un timer di 3 minuti' }))).toMatchObject({ ok: true, data: { request: 'timer' } });
    expect(await s.router.dispatch(cmd('assistant.parse', { text: 'domani alle 9 chiamare Luca' }))).toMatchObject({ ok: true, data: { request: null } });
  });
});

describe('domande sugli impegni (17/10/2026)', () => {
  const now = at(17, 10);
  it('una domanda è l\'agenda, non un promemoria', () => {
    // Prima: «domani sono libero o ho impegni?» creava il promemoria «sono libero o ho impegni» per domani alle 9.
    expect(parseAssistantRequest('domani sono libero o ho impegni?', now)).toEqual({ kind: 'agenda', day: 'tomorrow' });
    expect(parseAssistantRequest('ho qualcosa domani?', now)).toEqual({ kind: 'agenda', day: 'tomorrow' });
    expect(parseAssistantRequest('oggi ho impegni?', now)).toEqual({ kind: 'agenda', day: 'today' });
    expect(parseAssistantRequest('cosa c\'è in agenda per lunedì', now)).toEqual({ kind: 'agenda', day: 'upcoming' });
    expect(parseAssistantRequest('sono libera stasera?', now)).toEqual({ kind: 'agenda', day: 'today' });
  });
  it('le affermazioni restano promemoria', () => {
    expect(parseAssistantRequest('domani alle 15 ho il dentista', now)).toMatchObject({ kind: 'reminder', text: 'Il dentista' });
    expect(parseAssistantRequest('ricordami domani se ho impegni', now)).toMatchObject({ kind: 'reminder' });
  });
});

export type { CommandRouter };
