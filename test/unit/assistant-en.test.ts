// Assistente in inglese (P-108, 12/10/2026): il «quando» in inglese, le richieste e le risposte con la
// lingua di VISIONE impostata all'inglese. Stesse regole locali dell'italiano; database vero in una
// cartella temporanea, nessuna rete, nessun motore.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssistant, fireMessage } from '../../src/core/assistant/index.ts';
import { parseAssistantRequest } from '../../src/core/assistant/intent.ts';
import { describeWhenEn, parseWhenEn } from '../../src/core/assistant/when-en.ts';
import { createEventBus } from '../../src/core/bus/index.ts';
import { migrate, openDb } from '../../src/core/db/index.ts';
import { createEventEmitter } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

/** Domenica 11 ottobre 2026, ore 10:00 (ora locale). */
const NOW = new Date(2026, 9, 11, 10, 0).getTime();
const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime();

describe('parseWhenEn', () => {
  const cases: Array<[string, number | null, string]> = [
    ['in an hour I have to go shopping', at(11, 11), 'I have to go shopping'],
    ['in half an hour call Niccolò', at(11, 10, 30), 'call Niccolò'],
    ['in a quarter of an hour', at(11, 10, 15), ''],
    ['in 10 minutes', at(11, 10, 10), ''],
    ['in an hour and a half', at(11, 11, 30), ''],
    ['in 2 hours and 15 minutes', at(11, 12, 15), ''],
    ['in two days pay the rent', at(13, 10), 'pay the rent'],
    ['at 15:30 meeting', at(11, 15, 30), 'meeting'],
    ['at 3:30 pm', at(11, 15, 30), ''],
    ['at half past 3', at(11, 15, 30), ''],
    ['at 9 in the evening', at(11, 21), ''],
    ['at 9', at(11, 21), ''],
    ['at 7am', at(12, 7), ''],
    ['tomorrow at 9 the dentist', at(12, 9), 'the dentist'],
    ['tomorrow morning', at(12, 9), ''],
    ['tonight', at(11, 20), ''],
    ['at noon lunch', at(11, 12), 'lunch'],
    ['on Monday', at(12, 9), ''],
    ['next Friday at 6pm', at(16, 18), ''],
    ['on 15 October', at(15, 9), ''],
    ['October 20th at 10', at(20, 10), ''],
    ['the day after tomorrow at 8', at(13, 8), ''],
    ['dinner at a restaurant', null, '']
  ];
  for (const [text, expected, rest] of cases) {
    it(text, () => {
      const w = parseWhenEn(text, NOW);
      if (expected === null) { expect(w).toBeNull(); return; }
      expect(w?.at).toBe(expected);
      expect(w?.rest).toBe(rest);
    });
  }

  it('describeWhenEn: oggi, domani, poi giorno e mese', () => {
    expect(describeWhenEn(at(11, 15, 30), NOW)).toBe('today at 15:30');
    expect(describeWhenEn(at(12, 9), NOW)).toBe('tomorrow at 9:00');
    expect(describeWhenEn(at(14, 9), NOW)).toBe('Wednesday 14 October at 9:00');
  });
});

describe('parseAssistantRequest in inglese', () => {
  const en = (t: string) => parseAssistantRequest(t, NOW, 'en');
  it('promemoria espliciti: l\'esempio della guida è vero', () => {
    expect(en('remind me in an hour to call Luca')).toEqual({ kind: 'reminder', text: 'Call Luca', when: expect.objectContaining({ at: at(11, 11) }), appointment: false });
    expect(en('Hey Visione, remind me tomorrow at 3pm about the dentist')).toMatchObject({ kind: 'reminder', text: 'The dentist', appointment: true });
    expect(en('remind me to buy milk')).toEqual({ kind: 'reminder', text: 'Buy milk', when: null, appointment: false });
  });
  it('note, agenda, annulla', () => {
    expect(en('take a note that the wifi password is on the router')).toEqual({ kind: 'note', text: 'The wifi password is on the router' });
    expect(en('what do I have to do today?')).toEqual({ kind: 'agenda', day: 'today' });
    expect(en("what's on my schedule tomorrow")).toEqual({ kind: 'agenda', day: 'tomorrow' });
    expect(en('cancel the reminder about the dentist')).toEqual({ kind: 'cancel', query: 'The dentist' });
  });
  it('forma naturale; il lavoro sul codice resta al Director', () => {
    expect(en('in an hour I have to go shopping')).toMatchObject({ kind: 'reminder', text: 'Go shopping' });
    expect(en('tomorrow at 3 I have the dentist')).toMatchObject({ kind: 'reminder', text: 'The dentist', appointment: true, when: expect.objectContaining({ at: at(12, 15) }) });
    expect(en('fix the login bug tomorrow')).toBeNull();
    expect(en('write a sorting function')).toBeNull();
    // Le frasi italiane restano alle regole italiane.
    expect(parseAssistantRequest("ricordami tra un'ora di chiamare Luca", NOW)).toMatchObject({ kind: 'reminder', text: 'Chiamare Luca' });
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('Assistente con la lingua inglese', () => {
  function setup() {
    const h = tempHome();
    const db = openDb(join(h.dir, 'visione.db'));
    migrate(db);
    const bus = createEventBus();
    const events = createEventEmitter({ db, journal: createJournal(db), bus });
    const clock = { t: NOW };
    const assistant = createAssistant({
      db, events, log: memoryLogger().log, now: () => clock.t, language: () => 'en',
      timers: { set: () => 0, clear: () => {} }, saveNote: () => {}
    });
    cleanups.push(() => { assistant.close(); events.close(); bus.close(); db.close(); h.cleanup(); });
    return { assistant, clock };
  }

  it('conferma, chiede il quando, agenda e annullamento in inglese', () => {
    const { assistant } = setup();
    expect(assistant.handle('remind me in an hour to call Luca', 'voice')?.reply).toBe("OK, I'll remind you today at 11:00.");
    expect(assistant.handle('remind me to buy milk', 'voice')?.reply).toBe('When should I remind you?');
    expect(assistant.handle('tomorrow at 9', 'voice')?.reply).toBe("OK, I'll remind you tomorrow at 9:00.");
    expect(assistant.agendaCount('today')).toBe(1);
    expect(assistant.handle('what do I have today?', 'voice')?.reply).toBe('Today you have one thing planned: at 11:00 call Luca.');
    expect(assistant.handle('cancel the reminder about milk', 'voice')?.reply).toBe('Cancelled: buy milk.');
    expect(assistant.handle('what do I have tomorrow?', 'voice')?.reply).toBe('Tomorrow you have nothing planned.');
  });

  it('la frase con cui scatta, anche in ritardo', () => {
    const r = { text: 'Call Luca', kind: 'reminder' as const, dueAt: at(11, 11), notifyAt: at(11, 11) };
    expect(fireMessage(r, at(11, 11), 'en')).toBe('Reminder: call Luca.');
    expect(fireMessage(r, at(11, 12), 'en')).toBe('Late reminder, it was for today at 11:00: call Luca.');
    expect(fireMessage({ ...r, kind: 'appointment', notifyAt: at(11, 10, 45) }, at(11, 10, 45), 'en')).toBe('In 15 minutes: call Luca.');
  });
});
