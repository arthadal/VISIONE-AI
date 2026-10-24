// Fase 4: contratto degli eventi (registro, tipi sconosciuti, serializzazione, separazione da
// comandi e stato) ed Event Bus (once, next, filtri, pulizia, isolamento, ordine).
import { describe, expect, it, vi } from 'vitest';
import { createEventBus, matchesFilter } from '../../src/core/bus/index.ts';
import {
  COMMAND_DEFINITIONS,
  EVENT_DEFINITIONS,
  EVENT_TYPES,
  MAX_PAYLOAD_BYTES,
  createEvent,
  derivedFrom,
  getEventDefinition,
  parseEvent,
  visioneEventSchema,
  serializePayload,
  type VisioneEvent
} from '../../src/shared/contracts/index.ts';

const accepted = (correlationId?: string) =>
  createEvent('command.accepted', { commandId: 'CMD00000001', type: 'system.ping', issuedBy: 'ui' }, correlationId ? { correlationId } : {});
const shutdown = (reason = 'x') => createEvent('app.shutdown', { reason });

describe('contratto degli eventi — Fase 4', () => {
  it('l\'envelope ha tutti i campi richiesti ed è serializzabile', () => {
    const e = createEvent('system.pong', { echo: 'a', pid: 1 }, { target: { kind: 'ui', id: 'main' }, correlationId: 'CORR00000001' });
    // timestamp = ts, schemaVersion = schema (nomi della Fase 3, P-25)
    expect(Object.keys(e).sort()).toEqual(['category', 'causationId', 'correlationId', 'durability', 'id', 'payload', 'schema', 'seq', 'severity', 'source', 'target', 'ts', 'type']);
    expect(visioneEventSchema.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(structuredClone(e)).toEqual(e);
  });

  it('ogni tipo registrato ha uno schema di payload preciso (mai z.unknown/any)', () => {
    for (const type of EVENT_TYPES) {
      const def = EVENT_DEFINITIONS[type];
      expect(def.payload.safeParse(undefined).success, `${type} accetta undefined`).toBe(false);
      expect(def.payload.safeParse({ estraneo: 1 }).success, `${type} accetta campi estranei`).toBe(false);
    }
  });

  it('tipo sconosciuto: nessuna eccezione, risultato esplicito', () => {
    expect(getEventDefinition('agent.unknown.thing')).toBeUndefined();
    expect(getEventDefinition('toString')).toBeUndefined(); // niente prototipo
    const raw = { ...shutdown(), type: 'futuro.evento.ignoto' };
    expect(parseEvent(raw)).toEqual({ ok: false, problem: 'tipo non registrato: futuro.evento.ignoto' });
    for (const junk of [undefined, null, 42, 'evento', [], {}, { type: 'app.started' }, Object.create(null)]) {
      expect(() => parseEvent(junk)).not.toThrow();
      expect(parseEvent(junk).ok).toBe(false);
    }
  });

  it('comando, evento e stato sono concetti separati: nessun nome in comune', () => {
    const commands = Object.keys(COMMAND_DEFINITIONS);
    for (const type of EVENT_TYPES) expect(commands, `${type} è anche un comando`).not.toContain(type);
    // Il ping è un comando, il pong un evento; lo stato si legge con un comando di sola lettura.
    expect(commands).toContain('system.ping');
    expect(EVENT_TYPES).toContain('system.pong');
    expect(EVENT_TYPES).not.toContain('system.ping');
    expect(COMMAND_DEFINITIONS['state.get'].mutating).toBe(false);
    // La UI non scrive lo stato: nessun comando `state.*` è mutante. I soli comandi mutanti della UI
    // sono quelli elencati qui (aggiungerne uno è una decisione esplicita, P-35, P-38): stop di un
    // processo; definizione, archiviazione, stop e avvio di sessione di un agente (P-83), modello e
    // potenza (P-83); obiettivo al Director; annullamento di un task; decisione su un'approvazione.
    // La UI non sceglie mai un eseguibile: `agents.start` avvia una SESSIONE passando dall'Agent
    // Manager e dalle stesse regole di `runTurn` (fiducia, adapter, policy del runtime).
    for (const [type, def] of Object.entries(COMMAND_DEFINITIONS)) if (type.startsWith('state.')) expect(def.mutating, type).toBe(false);
    const uiMutating = Object.entries(COMMAND_DEFINITIONS).filter(([, def]) => def.uiAllowed && def.mutating).map(([type]) => type);
    expect(uiMutating).toEqual(['system.apps.launch',
      // Beta.5 (P-109): promemoria dal widget Agenda (aggiungi, fatto/annulla/rimanda), solo locali.
      'assistant.reminder.add',
      // P-109b: una frase all'Assistente dal widget (liste, timer, ricorrenti) e togliere un elemento di una lista.
      'assistant.ask', 'assistant.list.remove',
      // 22/10/2026: chat di gruppo locale — elenco (crea «Squadra» al primo uso), nuovo gruppo, elimina, messaggio
      // del proprietario: chiama gli agenti del gruppo con le stesse regole della chat diretta (agents.tell).
      // 24/10/2026: «Svuota chat» — la conversazione si mostra da adesso, niente si cancella.
      'groups.list', 'groups.create', 'groups.remove', 'chat.clear', 'groups.post',
      'assistant.reminder.update',
      'system.control.exec', 'files.mkdir', 'files.rename', 'files.delete', 'files.open',
      // Segnala un problema (11/10/2026): pacchetto ripulito che resta sul PC.
      'support.report',
      // Esplora (11/10/2026): Cestino (recuperabile), copia e sposta dentro le radici consentite.
      'files.trash', 'files.copy', 'files.move', 'runtime.stop',
      // P-105: procedura guidata — applica la squadra scelta (agenti validati tutti prima di scriverne
      // uno), apre l'accesso del motore nel terminale (programma del motore, non una shell) e salva una chiave SOLO se il motore l'ha appena verificata presso il
      // servizio, nelle variabili dell'utente Windows (mai in un file di VISIONE).
      // 17/10/2026: «Installa» — l'installatore ufficiale nel terminale; lo script lo dà il motore nel core, mai la UI.
      'setup.apply', 'setup.login', 'setup.install', 'setup.saveKey',
      'engines.restart', 'agents.define', 'agents.archive', 'agents.rename', 'agents.stop', 'agents.start', 'agents.tuning', 'agents.tell',
      // 12/10/2026: «Interrompi» dal pannello dell'agente e «Interrompi tutto» dal Director.
      'agents.interrupt', 'director.interrupt',
      'director.submit', 'tasks.cancel', 'approvals.decide',
      // Fase 7 (P-42): memoria del proprietario: scrittura, promozione a globale, riflessione di un agente fermo.
      'memory.write', 'memory.promote', 'memory.reflect',
      // P-107k: Addestramento, regole di lavoro scelte dall'utente (attiva/togli, scrivi, cancella una sua).
      'training.set', 'training.add', 'training.remove',
      // P-107l: mappa del codice, aggiorna l'indice di una cartella degli agenti e la usa o no nei brief.
      'codemap.scan', 'codemap.set',
      // Fase 8 (P-45, P-46): shell del proprietario (eseguibile scelto dal core), input e dimensioni della
      // vista Terminale, chiusura della shell; impostazioni validate (valgono dal prossimo avvio).
      'terminal.open', 'terminal.input', 'terminal.resize', 'terminal.close', 'config.update',
      // P-105: modelli d'ascolto scaricati su consenso (dimensione e SHA-256 dal manifest, poi la voce riparte).
      // P-106: registrazione e cancellazione dell'impronta vocale del proprietario (solo in locale).
      // 24/10/2026: prova di precisione (voice.accuracy) — la prossima frase si trascrive soltanto e non va al Director.
      'voice.enroll', 'voice.accuracy', 'voice.models.download',
      // 17/10/2026: modalità offline — tasto entra/esci, una frase al modello locale (che non agisce da sé:
      // riscrive per l'Assistente, e annullare va confermato), modello scaricato su consenso e annullabile.
      'offline.set', 'offline.ask', 'offline.model.download', 'offline.model.cancel']);
    for (const type of uiMutating) {
      if (type === 'agents.start') continue; // P-83: sessione dell'agente, non un processo scelto dalla UI
      // P-99: «Riavvia motori» ri-verifica e riavvia SESSIONI esistenti, non avvia processi scelti dalla UI.
      if (type === 'engines.restart') continue;
      expect(type.split('.')[1], type).not.toMatch(/start|spawn|exec|run/i);
    }
  });

  it('persistenti e transitori: la classificazione documentata', () => {
    const durable = EVENT_TYPES.filter((t) => EVENT_DEFINITIONS[t].durability === 'durable');
    const ephemeral = EVENT_TYPES.filter((t) => EVENT_DEFINITIONS[t].durability === 'ephemeral');
    expect(ephemeral.sort()).toEqual([
      'command.accepted', 'command.completed', 'command.rejected',
      // 22/10/2026: un gruppo della chat è cambiato: solo un avviso per rileggere, i messaggi stanno in visione.db.
      'group.changed',
      'memory.search.performed',
      // 17/10/2026: avanzamento del download del modello offline (come quello dei modelli d'ascolto).
      'offline.model.progress',
      'process.input', 'process.starting', 'process.stderr',
      'process.stdout', 'state.changed', 'system.event.rejected', 'system.pong', 'telemetry.sample',
      // 24/10/2026: frase della prova di precisione, solo per la UI.
      'voice.accuracy.heard',
      // P-106: esito dei filtri e registrazione della voce: dati vicini a quelli biometrici, mai nel journal.
      'voice.enroll.progress', 'voice.heard', 'voice.level',
      // P-105: avanzamento del download dei modelli d'ascolto (transitorio come il livello del microfono).
      'voice.models.progress'
    ]);
    expect(durable).toEqual(expect.arrayContaining(['system.lifecycle.changed', 'system.error', 'core.crashed', 'system.journal.degraded', 'system.db.quarantined']));
  });

  it('serializzazione: payload non serializzabili o troppo grandi sono un risultato, non un\'eccezione', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializePayload({ n: 1n }).ok).toBe(false);
    expect(serializePayload(circular)).toMatchObject({ ok: false, problem: expect.stringMatching(/non serializzabile/) });
    expect(serializePayload(undefined).ok).toBe(false);
    expect(serializePayload('x'.repeat(MAX_PAYLOAD_BYTES))).toMatchObject({ ok: false, problem: expect.stringMatching(/troppo grande/) });
    expect(serializePayload({ a: [1, 'b'] })).toEqual({ ok: true, json: '{"a":[1,"b"]}' });
  });

  it('derivedFrom: stessa correlazione, causato dall\'evento d\'origine', () => {
    const cause = accepted('CORR00000009');
    const child = createEvent('system.pong', { echo: null, pid: 1 }, derivedFrom(cause));
    expect(child.correlationId).toBe('CORR00000009');
    expect(child.causationId).toBe(cause.id);
  });

  it('ordine: id monotoni nello stesso millisecondo', () => {
    const events = Array.from({ length: 200 }, () => createEvent('system.pong', { echo: null, pid: 1 }, { now: 1_700_000_000_000 }));
    const ids = events.map((e) => e.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(200);
  });
});

describe('Event Bus — Fase 4', () => {
  it('once: un solo evento, poi la sottoscrizione è chiusa', async () => {
    const bus = createEventBus();
    const got: string[] = [];
    const sub = bus.once((e) => got.push(e.id), { filter: { types: ['app.shutdown'] } });
    const events = [accepted(), shutdown('a'), shutdown('b')];
    for (const e of events) bus.publish(e);
    await bus.idle();
    expect(got).toEqual([events[1]?.id]);
    expect(sub.active).toBe(false);
    expect(sub.dropped).toBe(0);
    expect(bus.stats().subscribers).toBe(0);
  });

  it('next: risolve con il primo evento che corrisponde; timeout, annullamento e chiusura rigettano', async () => {
    const bus = createEventBus();
    const waiting = bus.next({ correlationId: 'CORR0000000A' });
    bus.publish(accepted('CORR0000000B'));
    const match = accepted('CORR0000000A');
    bus.publish(match);
    expect((await waiting).id).toBe(match.id);

    await expect(bus.next({ types: ['app.started'] }, { timeoutMs: 20 })).rejects.toThrow(/entro 20 ms/);
    const ctrl = new AbortController();
    const aborted = bus.next(undefined, { signal: ctrl.signal });
    ctrl.abort();
    await expect(aborted).rejects.toThrow(/annullata/);
    const pending = bus.next();
    bus.close();
    await expect(pending).rejects.toThrow(/chiuso/);
    expect(bus.stats().subscribers).toBe(0);
  });

  it('filtri dichiarativi: tipi e prefissi, categorie, correlazione, gravità, durabilità', () => {
    const e = accepted('CORR00000001');
    expect(matchesFilter(e, { types: ['command.*'] })).toBe(true);
    expect(matchesFilter(e, { types: ['command.completed'] })).toBe(false);
    expect(matchesFilter(e, { categories: ['system'], durability: 'ephemeral' })).toBe(true);
    expect(matchesFilter(e, { correlationId: 'ALTRO000001' })).toBe(false);
    expect(matchesFilter(e, { minSeverity: 'debug' })).toBe(true);
    expect(matchesFilter(e, { minSeverity: 'warning' })).toBe(false);
    expect(matchesFilter(createEvent('system.error', { code: 'x', message: 'y', fatal: false }), { minSeverity: 'error' })).toBe(true);
    expect(matchesFilter(e, { types: ['command.*'], where: () => false })).toBe(false);
  });

  it('on: sottoscrizione tipizzata a un solo tipo', async () => {
    const bus = createEventBus();
    const echoes: Array<string | null> = [];
    bus.on('system.pong', (e) => { echoes.push(e.payload.echo); });
    bus.publish(accepted());
    bus.publish(createEvent('system.pong', { echo: 'eco', pid: 1 }));
    await bus.idle();
    expect(echoes).toEqual(['eco']);
  });

  it('unsubscribe è idempotente e un AbortSignal chiude la sottoscrizione (pulizia esplicita)', async () => {
    const bus = createEventBus();
    const got: string[] = [];
    const ctrl = new AbortController();
    const a = bus.subscribe((e) => got.push(`a:${e.type}`), { signal: ctrl.signal });
    const b = bus.subscribe((e) => got.push(`b:${e.type}`));
    expect(bus.stats().subscribers).toBe(2);
    ctrl.abort();
    b.unsubscribe();
    b.unsubscribe();
    expect(a.active || b.active).toBe(false);
    expect(bus.stats().subscribers).toBe(0);
    bus.publish(shutdown());
    await bus.idle();
    expect(got).toEqual([]);
    const late = bus.subscribe(() => undefined, { signal: ctrl.signal }); // segnale già scattato
    expect(late.active).toBe(false);
  });

  it('avviso di possibile perdita quando i sottoscrittori superano la soglia', () => {
    const onLeakWarning = vi.fn();
    const bus = createEventBus({ maxSubscribers: 3, onLeakWarning });
    const subs = Array.from({ length: 5 }, () => bus.subscribe(() => undefined));
    expect(onLeakWarning).toHaveBeenCalledOnce();
    expect(onLeakWarning).toHaveBeenCalledWith(4);
    for (const s of subs) s.unsubscribe();
    expect(bus.stats().subscribers).toBe(0);
  });

  it('isolamento: eccezioni, promesse rigettate e filtri che lanciano non fermano gli altri', async () => {
    const onListenerError = vi.fn();
    const bus = createEventBus({ onListenerError });
    const got: string[] = [];
    bus.subscribe(() => { throw new Error('sincrono'); }, { name: 'sync' });
    bus.subscribe(() => Promise.reject(new Error('asincrono')), { name: 'async' });
    bus.subscribe(() => undefined, { filter: () => { throw new Error('filtro'); }, name: 'filtro' });
    bus.subscribe((e) => got.push(e.type));
    bus.publish(shutdown());
    bus.publish(accepted());
    await bus.idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(['app.shutdown', 'command.accepted']);
    expect(onListenerError).toHaveBeenCalledTimes(6);
    expect(onListenerError.mock.calls.map((c) => c[2]).sort()).toEqual(['async', 'async', 'filtro', 'filtro', 'sync', 'sync']);
    expect(bus.stats().listenerErrors).toBe(6);
  });

  it('ordine: ogni sottoscrittore riceve gli eventi nell\'ordine di pubblicazione', async () => {
    const bus = createEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((e) => a.push(e.id));
    bus.subscribe((e) => b.push(e.id), { filter: { types: ['system.pong'] } });
    const published: VisioneEvent[] = [];
    for (let i = 0; i < 300; i++) {
      const e = i % 2 === 0 ? createEvent('system.pong', { echo: String(i), pid: 1 }, { now: 5 }) : accepted();
      published.push(e);
      bus.publish(e);
    }
    await bus.idle();
    expect(a).toEqual(published.map((e) => e.id));
    expect(b).toEqual(published.filter((e) => e.type === 'system.pong').map((e) => e.id));
  });

  it('close: annulla tutto e ignora le pubblicazioni successive', async () => {
    const bus = createEventBus();
    const got: string[] = [];
    bus.subscribe((e) => got.push(e.type));
    bus.close();
    bus.publish(shutdown());
    await bus.idle();
    expect(got).toEqual([]);
    expect(bus.subscribe(() => undefined).active).toBe(false);
    expect(bus.stats()).toMatchObject({ subscribers: 0, published: 0 });
  });
});
