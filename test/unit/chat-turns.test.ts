// La chat con VISIONE come una conversazione fra persone (22/10/2026), dal database (23/10/2026: prima nasceva dagli
// ultimi 200 eventi della UI e, durante un turno d'agente, la risposta di un gruppo finiva qui).
import { describe, expect, it } from 'vitest';
import { isOwnerRequest, ownerConversation } from '../../src/core/director/index.ts';
import type { TaskEngine } from '../../src/core/tasks/index.ts';
import { requestTurns } from '../../src/renderer/app/chat-logic.ts';
import type { ChatRequestDto } from '../../src/shared/contracts/index.ts';

interface FakeTask { id: string; rootId: string; kind: string; status: string; title: string; spec: string; createdBy: string; createdAt: number; updatedAt: number; endedAt: number | null; result: { summary: string } | null; error: { code?: string; message: string } | null }

function engineOf(tasks: FakeTask[]): TaskEngine {
  // Come il motore vero: dal più recente.
  const newest = [...tasks].reverse();
  return {
    list: (f: { rootsOnly?: boolean; rootId?: string; limit?: number }) => newest.filter((t) => (f.rootsOnly ? t.kind === 'goal' : f.rootId ? t.rootId === f.rootId : true)).slice(0, f.limit ?? 50)
  } as unknown as TaskEngine;
}

let n = 0;
const task = (over: Partial<FakeTask> & { rootId: string }): FakeTask => ({
  id: `t${++n}`, kind: 'work', status: 'succeeded', title: 'passo', createdBy: 'owner:ui', createdAt: 1_000 + n, updatedAt: 2_000 + n, endedAt: 2_000 + n, result: null, error: null, ...over, spec: over.spec ?? over.title ?? 'passo'
});

describe('chat con VISIONE dal database', () => {
  it('solo le sue richieste al Director: niente gruppi, messaggi diretti a un agente, agenti o Director', () => {
    expect(['owner:ui', 'voice', 'owner:voice'].map((by) => isOwnerRequest(by))).toEqual([true, true, true]);
    expect(['owner:group', 'owner:ui:tell', 'agent:director', 'director', 'setup'].map((by) => isOwnerRequest(by))).toEqual([false, false, false, false, false]);
    // Messaggi a un agente salvati fino alla beta.30, senza «:tell»: si riconoscono dal titolo dato da VISIONE.
    expect(['Verifica della procedura guidata', 'Messaggio a esecutore', 'Messaggio a mamma per il compleanno'].map((t) => isOwnerRequest('owner:ui', t))).toEqual([false, false, true]);
  });

  it('dalla più vecchia: risposta vera senza appunti MEMORIA, motivo dell\'insuccesso, annullata, ancora aperta', () => {
    const tasks: FakeTask[] = [];
    const goal = (id: string, title: string, status: string, createdBy = 'owner:ui'): void => {
      tasks.push(task({ id, rootId: id, kind: 'goal', title, status, createdBy }));
    };
    goal('r1', 'Che tempo fa a Roma?', 'succeeded');
    tasks.push(task({ rootId: 'r1', kind: 'plan', result: { summary: '{"steps":[]}' } }));
    tasks.push(task({ rootId: 'r1', result: { summary: 'A Roma ci sono 18 gradi.\nMEMORIA: Roma interessa al proprietario' } }));
    goal('g1', 'Chat «Squadra»: ciao', 'succeeded', 'owner:group');
    tasks.push(task({ rootId: 'g1', result: { summary: 'ciao a te' } }));
    goal('v1', 'Verifica della procedura guidata', 'succeeded', 'owner:ui:tell');
    goal('r2', 'Apri il sito', 'failed', 'voice');
    tasks.push(task({ rootId: 'r2', status: 'failed', error: { code: 'agent_unavailable', message: 'motore non pronto' } }));
    goal('r3', 'Scrivi il report', 'cancelled');
    goal('r4', 'Prepara la lista', 'running');
    const requests = ownerConversation(engineOf(tasks));
    expect(requests.map((r) => [r.id, r.status, r.answer ?? r.reason])).toEqual([
      ['r1', 'succeeded', 'A Roma ci sono 18 gradi.'],
      ['r2', 'failed', 'il motore non è partito (motore non pronto)'],
      ['r3', 'cancelled', null],
      ['r4', 'open', null]
    ]);
    expect(requests[3]!.answeredAt).toBeNull();
  });

  it('in fumetti: domanda e risposta in parole; una richiesta aperta resta senza risposta', () => {
    const r = (over: Partial<ChatRequestDto>): ChatRequestDto => ({ id: 'x', at: 1, text: 'domanda', status: 'open', answer: null, reason: null, answeredAt: null, voice: false, files: [], ...over });
    const turns = requestTurns([
      r({ id: 'a', text: 'Che tempo fa a Roma?', status: 'succeeded', answer: 'A Roma ci sono 18 gradi.', answeredAt: 5 }),
      r({ id: 'b', text: 'Apri il sito', status: 'failed', reason: 'motore non pronto', answeredAt: 6 }),
      r({ id: 'c', text: 'Scrivi il report', status: 'cancelled', answeredAt: 7 }),
      r({ id: 'd', text: 'Fatto niente?', status: 'succeeded', answer: '  ', answeredAt: 8 }),
      r({ id: 'e', text: 'Prepara la lista' })
    ]);
    expect(turns.map((t) => `${t.role}: ${t.text}`)).toEqual([
      'owner: Che tempo fa a Roma?',
      'assistant: A Roma ci sono 18 gradi.',
      'owner: Apri il sito',
      'assistant: Non ci sono riuscita: motore non pronto',
      'owner: Scrivi il report',
      'assistant: Mi sono fermata, come mi hai chiesto.',
      'owner: Fatto niente?',
      'assistant: Fatto.',
      'owner: Prepara la lista'
    ]);
    // Detta a voce: il 🎤 dice che è ciò che ha sentito il microfono (24/10/2026).
    expect(requestTurns([r({ text: 'reale al piccetto', voice: true })]).map((t) => t.text)).toEqual(['🎤 reale al piccetto']);
  });

  it('motivi in parole, voce riconosciuta, «Svuota chat» (24/10/2026)', () => {
    const tasks: FakeTask[] = [];
    tasks.push(task({ id: 'v1', rootId: 'v1', kind: 'goal', title: 'Che ore sono', status: 'failed', createdBy: 'voice' }));
    tasks.push(task({ rootId: 'v1', status: 'timed_out', error: { code: 'timeout', message: 'tentativo oltre 900000 ms' } }));
    tasks.push(task({ id: 'n1', rootId: 'n1', kind: 'goal', title: 'Nuova', status: 'running' }));
    const all = ownerConversation(engineOf(tasks), 50, { lang: 'it' });
    expect(all.map((x) => [x.id, x.voice, x.reason])).toEqual([['v1', true, 'ci voleva troppo tempo e il lavoro si è fermato'], ['n1', false, null]]);
    expect(ownerConversation(engineOf(tasks), 50, { clearedAt: tasks[0]!.createdAt }).map((x) => x.id)).toEqual(['n1']);
    expect(ownerConversation(engineOf(tasks), 50, { lang: 'en' })[0]!.reason).toBe('it was taking too long and the job stopped');
  });
});
