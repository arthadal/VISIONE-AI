// La squadra come un ufficio (24/10/2026): il gruppo che il Director apre per un lavoro del proprietario, i passaggi
// come messaggi, i colleghi chiamati con @nome e i gruppi aperti dagli agenti con la riga «GRUPPO:».
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentManager } from '../../src/core/agents/index.ts';
import { createEventBus } from '../../src/core/bus/index.ts';
import { migrate, openDb, type Db } from '../../src/core/db/index.ts';
import { createEventEmitter, type EventEmitter } from '../../src/core/events/index.ts';
import { createGroups, groupRequest, withoutGroupLines } from '../../src/core/groups/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import type { TaskEngine } from '../../src/core/tasks/index.ts';
import type { Language } from '../../src/shared/contracts/index.ts';
import { splitAttachments, withAttachments } from '../../src/shared/lib/attachments.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

interface FakeTask {
  id: string; rootId: string; kind: string; status: string; title: string; spec: string; assigneeAgentId: string | null; createdBy: string;
  createdAt: number; updatedAt: number; startedAt: number | null; endedAt: number | null; result: { summary: string } | null; error: { code?: string; message: string } | null;
}

const DEFS: Record<string, { id: string; name: string; role: string }> = {
  director: { id: 'director', name: 'Director', role: 'Coordinatore' },
  esecutore: { id: 'esecutore', name: 'Esecutore', role: 'Scrive il codice' },
  revisore: { id: 'revisore', name: 'Revisore', role: 'Controlla' }
};
const AGENTS = Object.values(DEFS).map((d) => ({ agentId: d.id, name: d.name }));

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length > 0) opened.pop()!(); });

function office(lang: Language = 'it', shared?: { db: Db; tasks: Map<string, FakeTask> }) {
  const h = tempHome();
  const db = shared?.db ?? openDb(join(h.dir, 'visione.db'));
  if (!shared) migrate(db);
  const bus = createEventBus();
  const events: EventEmitter = createEventEmitter({ db, journal: createJournal(db), bus });
  const tasks = shared?.tasks ?? new Map<string, FakeTask>();
  let clock = new Date(2026, 9, 24, 9, 0).getTime();
  const tick = (): number => (clock += 1_000);
  let n = 0;
  const add = (t: Omit<FakeTask, 'createdAt' | 'updatedAt' | 'startedAt' | 'endedAt' | 'result' | 'error' | 'spec'> & { spec?: string }): FakeTask => {
    const at = tick();
    const task: FakeTask = { spec: t.title, ...t, createdAt: at, updatedAt: at, startedAt: null, endedAt: null, result: null, error: null };
    tasks.set(task.id, task);
    return task;
  };
  const engine = {
    // Le chiamate nei gruppi (risposte a @nome): un obiettivo con un passo, come il motore vero.
    createGoal(input: { title: string; spec: string; createdBy: string; steps: readonly { title: string; spec: string; assigneeAgentId?: string | null }[] }) {
      const id = `call${++n}`;
      const root = add({ id, rootId: id, kind: 'goal', status: 'running', title: input.title, spec: input.spec, assigneeAgentId: null, createdBy: input.createdBy });
      const s = input.steps[0]!;
      const step = add({ id: `${id}-s`, rootId: id, kind: 'work', status: 'running', title: s.title, spec: s.spec, assigneeAgentId: s.assigneeAgentId ?? null, createdBy: input.createdBy });
      return { root, tasks: [step] };
    },
    get: (id: string) => tasks.get(id) ?? null,
    list: (filter: { rootId?: string }) => [...tasks.values()].filter((t) => t.rootId === filter.rootId).reverse()
  } as unknown as TaskEngine;
  const agents = { get: (id: string) => DEFS[id] ?? null, active: () => Object.values(DEFS) } as unknown as AgentManager;
  const groups = createGroups({ db, events, bus, engine, agents, log: memoryLogger().log, now: tick, language: () => lang, leadAgent: () => 'director' });
  groups.start();
  const created = async (t: FakeTask): Promise<void> => {
    events.emit('task.created', { taskId: t.id, kind: t.kind as 'work', parentId: t.kind === 'goal' ? null : t.rootId, rootId: t.rootId, title: t.title, assigneeAgentId: t.assigneeAgentId, dependsOn: [], priority: 1, createdBy: t.createdBy });
    await bus.idle();
  };
  const status = async (t: FakeTask, to: string, out: { result?: string; error?: string } = {}): Promise<void> => {
    const from = t.status;
    t.status = to;
    t.updatedAt = tick();
    if (to === 'running') t.startedAt = t.updatedAt;
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(to)) t.endedAt = t.updatedAt;
    if (out.result !== undefined) t.result = { summary: out.result };
    if (out.error !== undefined) t.error = { code: 'agent_unavailable', message: out.error };
    events.emit('task.status.changed', { taskId: t.id, rootId: t.rootId, kind: t.kind as 'work', from: from as 'running', to: to as 'running', reason: 'prova', attempt: 0, error: null });
    await bus.idle();
  };
  opened.push(() => { groups.stop(); events.close(); bus.close(); if (!shared) db.close(); });
  return { db, groups, tasks, add, created, status };
}

const lines = (o: ReturnType<typeof office>, groupId: string): string[] => o.groups.messages(groupId).messages.map((m) => `${m.authorName}: ${m.text}`);

/** Un lavoro del proprietario con il piano del Director e due passi. */
async function job(o: ReturnType<typeof office>, createdBy = 'owner:ui') {
  const root = o.add({ id: 'r1', rootId: 'r1', kind: 'goal', status: 'running', title: 'Prepara la pagina dei prezzi', assigneeAgentId: null, createdBy });
  const plan = o.add({ id: 'p1', rootId: 'r1', kind: 'plan', status: 'queued', title: 'Piano: Prepara la pagina dei prezzi', assigneeAgentId: 'director', createdBy });
  await o.created(root);
  await o.created(plan);
  return { root, plan };
}

describe('riga «GRUPPO:»', () => {
  it('nome prima della prima menzione, membri menzionati; senza agenti non è un gruppo', () => {
    expect(groupRequest('Sentite qua.\nGRUPPO: Revisione prezzi con @Revisore e @Esecutore', AGENTS)).toEqual({ name: 'Revisione prezzi', members: ['revisore', 'esecutore'] });
    expect(groupRequest('**GRUPPO:** «Sito nuovo» @esecutore', AGENTS)).toEqual({ name: 'Sito nuovo', members: ['esecutore'] });
    expect(groupRequest('GROUP: Pricing review with @Revisore', AGENTS)).toEqual({ name: 'Pricing review', members: ['revisore'] });
    expect(groupRequest('GRUPPO: Solo io con @nessuno', AGENTS)).toBeNull();
    expect(groupRequest('Il gruppo di lavoro va bene', AGENTS)).toBeNull();
    expect(withoutGroupLines('Ecco fatto.\nGRUPPO: Revisione con @Revisore\nCiao')).toBe('Ecco fatto.\nCiao');
  });
});

describe('gruppo di lavoro aperto dal Director', () => {
  it('ogni passaggio diventa un messaggio, in ordine, come in un ufficio', async () => {
    const o = office();
    const { root, plan } = await job(o);
    const [g] = o.groups.list().filter((x) => x.workRootId === 'r1');
    expect(g).toMatchObject({ name: 'Prepara la pagina dei prezzi', createdBy: 'director', createdByName: 'Director', members: [{ agentId: 'director' }] });
    await o.status(plan, 'running');
    expect(o.groups.messages(g!.id).typing.map((x) => x.name)).toEqual(['Director']);
    const a = o.add({ id: 'w1', rootId: 'r1', kind: 'work', status: 'queued', title: 'Scrivi la pagina', assigneeAgentId: 'esecutore', createdBy: 'owner:ui' });
    const b = o.add({ id: 'w2', rootId: 'r1', kind: 'work', status: 'queued', title: 'Controlla i testi', assigneeAgentId: 'revisore', createdBy: 'owner:ui' });
    await o.status(plan, 'succeeded', { result: '{"steps":[]}' });
    await o.created(a);
    await o.created(b);
    await o.status(a, 'running');
    expect(o.groups.messages(g!.id).typing.map((x) => x.name)).toEqual(['Esecutore']);
    await o.status(a, 'succeeded', { result: 'Pagina pronta con tre piani di prezzo.\nMEMORIA: la pagina è in prezzi.html' });
    await o.status(b, 'running');
    await o.status(b, 'failed', { error: 'motore non pronto' });
    root.status = 'failed';
    await o.status(root, 'failed');
    expect(lines(o, g!.id)).toEqual([
      'Director: Nuovo lavoro dal proprietario: «Prepara la pagina dei prezzi». Lo organizzo io.',
      'Director: Ecco come ci dividiamo il lavoro:\n• @Esecutore: Scrivi la pagina\n• @Revisore: Controlla i testi',
      'Director: @Esecutore, tocca a te: Scrivi la pagina',
      'Esecutore: Pagina pronta con tre piani di prezzo.',
      'Director: @Revisore, tocca a te: Controlla i testi',
      'Revisore: Non ci sono riuscito: il motore non è partito (motore non pronto).',
      "Director: Non ce l'abbiamo fatta: l'ho detto al proprietario."
    ]);
    expect(o.groups.list().find((x) => x.id === g!.id)!.members.map((m) => m.agentId)).toEqual(['director', 'esecutore', 'revisore']);
    expect(o.groups.messages(g!.id).typing).toEqual([]);
  });

  it('dopo un riavvio i messaggi mancanti si scrivono, senza doppioni', async () => {
    const o = office();
    const { root, plan } = await job(o);
    const w = o.add({ id: 'w1', rootId: 'r1', kind: 'work', status: 'queued', title: 'Scrivi la pagina', assigneeAgentId: 'esecutore', createdBy: 'owner:ui' });
    await o.status(plan, 'succeeded', { result: '{}' });
    await o.created(w);
    const id = o.groups.list().find((x) => x.workRootId === 'r1')!.id;
    const before = lines(o, id).length;
    // Il core è fermo mentre il passo finisce: nessun evento.
    const t0 = plan.endedAt!;
    Object.assign(w, { status: 'succeeded', startedAt: t0 + 5, endedAt: t0 + 9, result: { summary: 'Fatta.' } });
    Object.assign(root, { status: 'succeeded', endedAt: t0 + 10 });
    const again = office('it', { db: o.db, tasks: o.tasks });
    expect(lines(again, id).slice(before)).toEqual([
      'Director: @Esecutore, tocca a te: Scrivi la pagina',
      'Esecutore: Fatta.',
      'Director: Lavoro finito: ho portato la risposta al proprietario.'
    ]);
    again.groups.start();
    await again.status(w, 'succeeded');
    expect(lines(again, id)).toHaveLength(before + 3);
  });

  it('un collega chiamato con @nome nel risultato risponde nel gruppo; «GRUPPO:» apre un gruppo nuovo dell\'agente', async () => {
    const o = office();
    const { plan } = await job(o);
    const w = o.add({ id: 'w1', rootId: 'r1', kind: 'work', status: 'queued', title: 'Scrivi la pagina', assigneeAgentId: 'esecutore', createdBy: 'owner:ui' });
    await o.status(plan, 'succeeded', { result: '{}' });
    await o.created(w);
    await o.status(w, 'running');
    await o.status(w, 'succeeded', { result: 'Pagina pronta. @Revisore mi controlli i prezzi?\nGRUPPO: Prezzi 2027 con @Revisore' });
    const work = o.groups.list().find((x) => x.workRootId === 'r1')!;
    expect(lines(o, work.id)).toContain('Esecutore: Pagina pronta. @Revisore mi controlli i prezzi?');
    const calls = [...o.tasks.values()].filter((t) => t.kind === 'work' && t.id.startsWith('call'));
    expect(calls.map((t) => [t.assigneeAgentId, t.createdBy])).toEqual([['revisore', 'agent:esecutore'], ['revisore', 'agent:esecutore']]);
    const opened = o.groups.list().find((x) => x.name === 'Prezzi 2027')!;
    expect(opened).toMatchObject({ createdBy: 'esecutore', createdByName: 'Esecutore', workRootId: null, members: [{ agentId: 'esecutore' }, { agentId: 'revisore' }] });
    expect(lines(o, opened.id)).toEqual(['Esecutore: Pagina pronta. @Revisore mi controlli i prezzi?']);
    // Il Revisore risponde nel gruppo di lavoro, come un collega.
    const answer = calls.find((t) => t.spec.includes('«Prepara la pagina dei prezzi»'))!;
    const answerRoot = o.tasks.get(answer.rootId)!;
    answer.status = 'succeeded'; answer.result = { summary: 'Controllati, tutto giusto.' };
    await o.status(answerRoot, 'succeeded');
    expect(lines(o, work.id).at(-1)).toBe('Revisore: Controllati, tutto giusto.');
  });

  it('il brief del passo dice con chi lavora e come parlare ai colleghi; a voce no; in inglese in inglese', async () => {
    const o = office();
    await job(o);
    const w = o.add({ id: 'w1', rootId: 'r1', kind: 'work', status: 'queued', title: 'Scrivi', assigneeAgentId: 'esecutore', createdBy: 'owner:ui' });
    await o.created(w);
    expect(o.groups.teamBrief('w1')).toEqual([
      'Lavori in squadra con Director: il proprietario vede il lavoro nel gruppo «Prepara la pagina dei prezzi».',
      'Per chiedere qualcosa a un collega scrivi nel risultato @nome e la domanda: ti risponde nel gruppo.',
      'Per aprire un gruppo nuovo con dei colleghi scrivi una riga «GRUPPO: nome del gruppo con @nome @nome».'
    ]);
    expect(o.groups.teamBrief('p1')).toEqual([]);
    const voice = office('en');
    await job(voice, 'voice');
    const v = voice.add({ id: 'w1', rootId: 'r1', kind: 'work', status: 'queued', title: 'Write', assigneeAgentId: 'esecutore', createdBy: 'voice' });
    await voice.created(v);
    expect(voice.groups.teamBrief('w1')).toEqual([]);
    expect(lines(voice, voice.groups.list().find((x) => x.workRootId === 'r1')!.id)[0]).toBe('Director: New job from the owner: "Prepara la pagina dei prezzi". I\'ll organize it.');
  });

  it('niente gruppo di lavoro per le chiamate nei gruppi e i messaggi a un agente; «Squadra» c\'è lo stesso', async () => {
    const o = office();
    await job(o);
    const tell = o.add({ id: 't1', rootId: 't1', kind: 'goal', status: 'running', title: 'Messaggio a esecutore', assigneeAgentId: null, createdBy: 'owner:ui:tell' });
    const step = o.add({ id: 't1-s', rootId: 't1', kind: 'work', status: 'queued', title: 'Messaggio a esecutore', assigneeAgentId: 'esecutore', createdBy: 'owner:ui:tell' });
    await o.created(tell);
    await o.created(step);
    const names = o.groups.list().map((g) => g.name);
    expect(names).toContain('Squadra');
    expect(names.filter((x) => x === 'Messaggio a esecutore')).toEqual([]);
    expect(o.groups.list().filter((g) => g.workRootId !== null)).toHaveLength(1);
  });
});

describe('allegati nei gruppi (24/10/2026)', () => {
  it('chi è chiamato riceve i file in righe «📎» (il motore li copia); nel filo e nel titolo solo «[allegati: …]»', async () => {
    const o = office();
    const g = o.groups.create({ name: 'Prova', members: [{ agentId: 'esecutore', role: 'Scrive il codice' }] });
    o.groups.post(g.id, withAttachments('Guarda questo errore', ['C:/Users/m/Desktop/errore.png']));
    const call = [...o.tasks.values()].find((t) => t.kind === 'work')!;
    expect(splitAttachments(call.spec).files.map((f) => f.path)).toEqual(['C:/Users/m/Desktop/errore.png']);
    expect(call.spec).toContain('Guarda questo errore [allegati: errore.png]');
    expect(call.title).toContain('[allegati: errore.png]');
    expect(call.title).not.toContain('Desktop');
  });
});
