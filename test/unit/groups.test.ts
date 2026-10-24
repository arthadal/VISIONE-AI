// Chat di gruppo locale (22/10/2026): gruppi, @menzioni, risposte degli agenti come in una chat, rimbalzi con un tetto.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentManager } from '../../src/core/agents/index.ts';
import { createEventBus } from '../../src/core/bus/index.ts';
import { migrate, openDb } from '../../src/core/db/index.ts';
import { createEventEmitter } from '../../src/core/events/index.ts';
import { cleanGroupReply, createGroups, groupPrompt, mentionedMembers } from '../../src/core/groups/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import type { TaskEngine } from '../../src/core/tasks/index.ts';
import type { Language } from '../../src/shared/contracts/index.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

interface FakeTask { id: string; rootId: string; kind: string; status: string; title: string; spec: string; assigneeAgentId: string | null; createdBy: string; result: { summary: string } | null; error: { code?: string; message: string } | null }

const DEFS: Record<string, { id: string; name: string; role: string }> = {
  director: { id: 'director', name: 'Director', role: 'Coordinatore' },
  esecutore: { id: 'esecutore', name: 'Esecutore', role: 'Scrive il codice' },
  ricercatore: { id: 'ricercatore', name: 'Ricercatore', role: 'Cerca' }
};

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length > 0) opened.pop()!(); });

function setup(lang: Language = 'it') {
  const h = tempHome();
  const db = openDb(join(h.dir, 'visione.db'));
  migrate(db);
  const bus = createEventBus();
  const events = createEventEmitter({ db, journal: createJournal(db), bus });
  const tasks = new Map<string, FakeTask>();
  const created: FakeTask[] = [];
  let n = 0;
  const engine = {
    createGoal(input: { title: string; spec: string; createdBy: string; steps: readonly { title: string; spec: string; assigneeAgentId?: string | null }[] }) {
      const id = `root${++n}`;
      const root: FakeTask = { id, rootId: id, kind: 'goal', status: 'running', title: input.title, spec: input.spec, assigneeAgentId: null, createdBy: input.createdBy, result: null, error: null };
      const s = input.steps[0]!;
      const step: FakeTask = { id: `step${n}`, rootId: id, kind: 'work', status: 'running', title: s.title, spec: s.spec, assigneeAgentId: s.assigneeAgentId ?? null, createdBy: input.createdBy, result: null, error: null };
      tasks.set(id, root);
      tasks.set(step.id, step);
      created.push(step);
      return { root, tasks: [step] };
    },
    get: (id: string) => tasks.get(id) ?? null,
    list: (filter: { rootId?: string }) => [...tasks.values()].filter((t) => t.rootId === filter.rootId)
  } as unknown as TaskEngine;
  const agents = { get: (id: string) => DEFS[id] ?? null, active: () => Object.values(DEFS) } as unknown as AgentManager;
  let t = new Date(2026, 9, 22, 23, 0).getTime();
  const groups = createGroups({ db, events, bus, engine, agents, log: memoryLogger().log, now: () => (t += 1_000), language: () => lang, leadAgent: () => 'director' });
  groups.start();
  /** L'agente del passo `step` risponde (o fallisce) e il task radice si chiude. */
  const reply = async (step: FakeTask, outcome: { answer?: string; error?: string }): Promise<void> => {
    const root = tasks.get(step.rootId)!;
    if (outcome.answer !== undefined) {
      step.status = 'succeeded'; step.result = { summary: outcome.answer }; root.status = 'succeeded';
    } else {
      step.status = 'failed'; step.error = { code: 'agent_unavailable', message: outcome.error ?? 'errore' }; root.status = 'failed';
    }
    events.emit('task.status.changed', { taskId: root.id, rootId: root.id, kind: 'goal', from: 'running', to: root.status as 'succeeded', reason: 'prova', attempt: 0, error: null });
    await bus.idle();
  };
  opened.push(() => { groups.stop(); events.close(); bus.close(); db.close(); });
  return { groups, created, reply, tasks };
}

describe('menzioni', () => {
  const members = Object.values(DEFS).map((d) => ({ agentId: d.id, name: d.name }));
  it('@nome o @id, senza maiuscole né accenti, nell\'ordine del testo, senza doppioni', () => {
    expect(mentionedMembers('@ricercatore cerca, poi @Esecutore scrive. Grazie @esecutore', members)).toEqual(['ricercatore', 'esecutore']);
    expect(mentionedMembers('ciao a tutti', members)).toEqual([]);
    expect(mentionedMembers('scrivi a mario@example.com', members)).toEqual([]);
  });
});

describe('chat di gruppo', () => {
  it('al primo uso nasce «Squadra» con tutti gli agenti attivi, il capo per primo', () => {
    const { groups } = setup();
    const [squadra] = groups.list();
    expect(squadra?.name).toBe('Squadra');
    expect(squadra?.members.map((m) => m.agentId)).toEqual(['director', 'esecutore', 'ricercatore']);
    expect(groups.list()).toHaveLength(1); // non si ricrea
  });

  it('senza @ risponde il capo; con @ chi è chiamato; l\'agente riceve il filo e il modo di rispondere', () => {
    const { groups, created } = setup();
    const id = groups.list()[0]!.id;
    expect(groups.post(id, 'Ciao a tutti, come va?').called).toEqual(['director']);
    expect(groups.post(id, '@Esecutore mi sistemi il pulsante?').called).toEqual(['esecutore']);
    const spec = created[1]!.spec;
    expect(spec).toContain('Sei Esecutore, Scrive il codice, nella chat di gruppo «Squadra»');
    expect(spec).toContain('Proprietario: Ciao a tutti, come va?');
    expect(spec).toContain('Proprietario: @Esecutore mi sistemi il pulsante?');
    expect(spec).toContain('Scrivi come in una chat fra persone');
    expect(created[1]!.createdBy).toBe('owner:group');
    expect(groups.messages(id).typing.map((x) => x.name)).toEqual(['Director', 'Esecutore']);
  });

  it('la risposta arriva nel gruppo come un messaggio dell\'agente; chi è chiamato con @ risponde a sua volta, con un tetto', async () => {
    const { groups, created, reply } = setup();
    const id = groups.list()[0]!.id;
    groups.post(id, 'Chi mi aiuta col sito?');
    await reply(created[0]!, { answer: 'Ci penso io: @Esecutore prepari la pagina?' });
    expect(created[1]!.assigneeAgentId).toBe('esecutore');
    expect(created[1]!.createdBy).toBe('agent:director');
    await reply(created[1]!, { answer: 'Fatto! @Ricercatore controlli i testi?' });
    await reply(created[2]!, { answer: 'Controllati. @Director tutto ok.' });
    expect(created).toHaveLength(3); // terzo rimbalzo: oltre il tetto, nessuna nuova chiamata
    const { messages, typing } = groups.messages(id);
    expect(messages.map((m) => `${m.authorName}: ${m.text}`)).toEqual([
      'Tu: Chi mi aiuta col sito?',
      'Director: Ci penso io: @Esecutore prepari la pagina?',
      'Esecutore: Fatto! @Ricercatore controlli i testi?',
      'Ricercatore: Controllati. @Director tutto ok.'
    ]);
    expect(typing).toEqual([]);
    expect(groups.list()[0]!.last).toMatchObject({ authorName: 'Ricercatore', text: 'Controllati. @Director tutto ok.' });
  });

  it('se un agente non riesce, VISIONE lo dice in parole semplici', async () => {
    const { groups, created, reply } = setup();
    const id = groups.list()[0]!.id;
    groups.post(id, 'Prova');
    await reply(created[0]!, { error: 'motore non pronto: chiave mancante' });
    expect(groups.messages(id).messages.at(-1)).toMatchObject({ author: 'visione', text: 'Director non è riuscito a rispondere: il motore non è partito (motore non pronto: chiave mancante)' });
  });

  it('nuovo gruppo: nome, membri esistenti con un ruolo; si elimina; errori chiari', () => {
    const { groups } = setup();
    const g = groups.create({ name: '  Sito  web ', members: [{ agentId: 'esecutore', role: 'pagine' }, { agentId: 'fantasma', role: 'x' }, { agentId: 'esecutore', role: 'doppio' }] });
    expect(g).toMatchObject({ name: 'Sito web', members: [{ agentId: 'esecutore', role: 'pagine', name: 'Esecutore' }] });
    expect(() => groups.create({ name: ' ', members: [{ agentId: 'esecutore', role: '' }] })).toThrow(/nome/);
    expect(() => groups.create({ name: 'Vuoto', members: [{ agentId: 'fantasma', role: '' }] })).toThrow(/almeno un agente/);
    expect(groups.remove(g.id)).toBe(true);
    expect(groups.list().map((x) => x.name)).toEqual(['Squadra']);
    expect(() => groups.post(g.id, 'ci sei?')).toThrow(/non trovato/);
  });

  it('una risposta che continua il filo («Tu: …», «Esecutore: …») perde il nome in testa (VM, 23/10/2026)', async () => {
    const names = ['Tu', 'Proprietario', 'VISIONE', 'Director', 'Esecutore'];
    expect(cleanGroupReply('Tu: Ciao tutti, bello il lavoro di oggi!', names)).toBe('Ciao tutti, bello il lavoro di oggi!');
    expect(cleanGroupReply('**Esecutore:** Esecutore: pronto!', names)).toBe('pronto!');
    expect(cleanGroupReply('Nota: domani piove', names)).toBe('Nota: domani piove');
    expect(cleanGroupReply('Ciao: tutto bene', names)).toBe('Ciao: tutto bene');
    const { groups, created, reply } = setup();
    const id = groups.list()[0]!.id;
    groups.post(id, 'Ciao squadra');
    await reply(created[0]!, { answer: 'Tu: Ciao tutti, bene grazie!' });
    expect(groups.messages(id).messages.at(-1)).toMatchObject({ authorName: 'Director', text: 'Ciao tutti, bene grazie!' });
  });

  it('il testo per l\'agente in inglese', () => {
    const text = groupPrompt({ lang: 'en', group: 'Team', me: { name: 'Coder', role: '' }, others: [{ name: 'Director', role: 'lead' }], thread: [{ authorName: 'You', text: 'hi' }] });
    expect(text).toContain('You are Coder, in the group chat "Team" with the owner and Director (lead).');
    expect(text).toContain('You: hi');
  });
});
