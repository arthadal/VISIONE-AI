// Ciò che VISIONE impara dal proprietario (22/10/2026): gusti sulle battute, sue frasi recenti, aggiornamento progetti.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssistant } from '../../src/core/assistant/index.ts';
import { parseLearningRequest } from '../../src/core/assistant/learning.ts';
import { createEventBus } from '../../src/core/bus/index.ts';
import { migrate, openDb } from '../../src/core/db/index.ts';
import { createEventEmitter } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

/** Giovedì 22 ottobre 2026, ore 9:00. */
const NOW = new Date(2026, 9, 22, 9, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length > 0) opened.pop()!(); });

function setup() {
  const h = tempHome();
  const db = openDb(join(h.dir, 'visione.db'));
  migrate(db);
  const bus = createEventBus();
  const events = createEventEmitter({ db, journal: createJournal(db), bus });
  const clock = { t: NOW };
  let n = 0;
  const assistant = createAssistant({ db, events, log: memoryLogger().log, now: () => clock.t, newId: () => `id${++n}` });
  const root = (title: string, by: string, at: number, status = 'succeeded', parent: string | null = null): void => {
    const id = `t${++n}`;
    db.prepare(`INSERT INTO tasks (id, kind, parent_id, root_id, correlation_id, title, spec, status, priority, actions, budget, spec_hash, created_by, created_at, updated_at, ended_at)
      VALUES (?, 'goal', ?, ?, 'c', ?, 'spec', ?, 1, '[]', '{}', 'h', ?, ?, ?, ?)`).run(id, parent, parent ?? id, title, status, by, at, at, status === 'succeeded' || status === 'failed' ? at + MIN : null);
  };
  opened.push(() => { assistant.close(); events.close(); bus.close(); db.close(); });
  return { assistant, clock, root };
}

describe('giudizi sulle battute', () => {
  it('«bella» e «questa no» valgono solo come frase breve e dopo una battuta', () => {
    expect(parseLearningRequest('bella', 'it', true)).toEqual({ kind: 'quip-feedback', verdict: 'liked' });
    expect(parseLearningRequest('Visione, questa no', 'it', true)).toEqual({ kind: 'quip-feedback', verdict: 'disliked' });
    expect(parseLearningRequest('bella', 'it', false)).toBeNull();
    expect(parseLearningRequest('bella questa funzione, sistemami il bug nel file di prova', 'it', true)).toBeNull();
    expect(parseLearningRequest('not that one', 'en', true)).toEqual({ kind: 'quip-feedback', verdict: 'disliked' });
  });

  it('il giudizio si salva, finisce nel tono della prossima battuta, si vede e si cancella', () => {
    const { assistant, clock } = setup();
    expect(assistant.handle('bella', 'voice')).toBeNull(); // nessuna battuta detta: non è per l'Assistente
    assistant.noteQuip('Anche Roma è stata un cantiere.');
    expect(assistant.handle('bella', 'voice')?.reply).toContain('Me la segno');
    expect(assistant.handle('bella', 'voice')).toBeNull(); // una battuta si giudica una volta
    assistant.noteQuip('Il lunedì è un lunedì.');
    clock.t += 31 * MIN; // oltre la mezz'ora non vale più
    expect(assistant.handle('questa no', 'voice')?.reply ?? '').not.toContain('Ricevuto');
    assistant.noteQuip('Il lunedì è un lunedì.');
    expect(assistant.handle('questa no', 'voice')?.reply).toContain('Ricevuto');
    expect(assistant.learning.taste()).toEqual({ liked: ['Anche Roma è stata un cantiere.'], disliked: ['Il lunedì è un lunedì.'] });
    expect(assistant.handle('quali battute mi sono piaciute', 'ui')?.reply).toBe('Ti sono piaciute: «Anche Roma è stata un cantiere.» Non ti sono piaciute: «Il lunedì è un lunedì.»');
    expect(assistant.handle('dimentica le battute', 'ui')?.reply).toBe('Fatto: ho dimenticato 2 giudizi sulle battute.');
    expect(assistant.learning.taste()).toEqual({ liked: [], disliked: [] });
  });
});

describe('impara dalle conversazioni', () => {
  it('le sue frasi recenti, con quando, senza doppioni, frasi d\'una parola, sotto-task o richieste di altri', () => {
    const { assistant, root } = setup();
    root('che faticaccia quel codice ieri', 'voice', NOW - DAY);
    root('che faticaccia quel codice ieri', 'owner:ui', NOW - DAY + MIN);
    root('stop', 'voice', NOW - 10 * MIN);
    root('prepara il preventivo per il cliente', 'owner:ui', NOW - 10 * MIN);
    root('controllo automatico', 'director', NOW - 5 * MIN);
    root('passo interno del piano', 'owner:ui', NOW - 5 * MIN, 'succeeded', 't4');
    root('una cosa vecchia di mesi', 'voice', NOW - 30 * DAY);
    // Messaggi a un agente e gruppi non sono frasi sue a VISIONE (23/10/2026), anche se salvati prima del segno «:tell».
    root('Verifica della procedura guidata', 'owner:ui', NOW - 4 * MIN);
    root('Messaggio a esecutore', 'owner:ui', NOW - 3 * MIN);
    root('scrivi la mail al fornitore', 'owner:ui:tell', NOW - 2 * MIN);
    root('Chat «Squadra»: ciao ragazzi', 'owner:group', NOW - MIN);
    expect(assistant.learning.sayings()).toEqual([
      { text: 'prepara il preventivo per il cliente', ago: 'oggi' },
      { text: 'che faticaccia quel codice ieri', ago: 'ieri' }
    ]);
  });

  it('«come vanno i progetti?»: le sue richieste della settimana per stato', () => {
    const { assistant, root } = setup();
    expect(assistant.handle('come vanno i progetti?', 'voice')?.reply).toContain('nessun progetto da aggiornare');
    root('sito del ristorante', 'owner:ui', NOW - 2 * DAY, 'running');
    root('preventivo cliente', 'voice', NOW - DAY, 'succeeded');
    root('backup del server', 'owner:ui', NOW - 3 * DAY, 'failed');
    root('lavoro di un mese fa', 'owner:ui', NOW - 30 * DAY, 'succeeded');
    const reply = assistant.handle('aggiornami sui progetti', 'voice');
    expect(reply?.reply).toBe('In corso: «sito del ristorante». Conclusi in settimana: «preventivo cliente». Non riusciti: «backup del server».');
    expect(reply?.speak).not.toBe(false);
  });
});
