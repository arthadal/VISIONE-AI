// Voce nel core (Fase 9): traduzione dei fatti in eventi, intenti in italiano, approvazioni a voce,
// ciclo di vita e push-to-talk. Dipendenze finte: nessun processo, nessun motore.
import { describe, expect, it } from 'vitest';
import type { Approval } from '../../src/shared/contracts/index.ts';
import type { VisioneConfig } from '../../src/shared/node/config.ts';
import type { ApprovalQueue } from '../../src/core/approvals/index.ts';
import type { EventBus } from '../../src/core/bus/index.ts';
import type { Director } from '../../src/core/director/index.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { createVoiceController, parseVoiceIntent } from '../../src/core/voice/index.ts';
import { fixTranscript, isPhantomTranscript, parseTalkTo, spokenAnswer, voicePrompt } from '../../src/core/voice/conversation.ts';
import { withoutFacts } from '../../src/core/memory/markdown.ts';
import type { CoreToVoice } from '../../src/shared/contracts/index.ts';
import { memoryLogger } from '../helpers.ts';

const config: VisioneConfig['voice'] = {
  enabled: true,
  modelsDir: null,
  speaker: 'if_sara',
  threads: 4,
  bargeIn: true,
  followUpMs: 8_000,
  pttShortcut: 'Control+Alt+Space',
  vadThreshold: 0.5,
  minSpeechMs: 120,
  minSilenceMs: 600,
  noiseGate: 0.004,
  denoise: true,
  ownerOnly: { enabled: false, minScore: 0.4, margin: 0.05 },
  speakSummaries: true,
  announceApprovals: true,
  announceStartup: false,
  startupPhrase: 'VISIONE online. Sistemi operativi.',
  startupBriefing: false,
  volume: 250,
  tts: { provider: 'kokoro', voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz' },
  wake: { enabled: false, phrase: 'hey visione', sensitivity: 0.5, commandTimeoutMs: 6_000 }
};

function approval(id: string, kind = 'command'): Approval {
  return {
    id, kind, target: 'x', reason: 'motivo', requestedBy: 'agent', taskId: null, agentId: null,
    correlationId: 'c', status: 'pending', decidedBy: null, note: null, requestedAt: 0, decidedAt: null
  };
}

interface MakeOpts {
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
  agents?: Array<{ id: string; name: string }>;
  lead?: string | null;
  assistant?: (text: string) => { reply: string; speak?: boolean } | null;
  briefing?: (greeting: string) => Promise<string>;
}

function make(over: Partial<VisioneConfig['voice']> = {}, opts: MakeOpts = {}) {
  const clock = { t: 1_700_000_000_000 };
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sent: CoreToVoice[] = [];
  /** La frase del proprietario (senza la nota «rispondi a voce» che il core aggiunge per l'agente). */
  const submitted: Array<{ goal: string; by: string }> = [];
  /** Cosa arriva davvero al Director: testo completo e agente del passo unico, se c'è. */
  const requests: Array<{ goal: string; agentId: string | null; spec: string | null }> = [];
  const decided: Array<[string, string]> = [];
  const listeners = new Map<string, (event: { type: string; payload: Record<string, unknown> }) => void>();
  let pending: Approval[] = [];
  let n = 0;

  const events = { emit: (type: string, payload: Record<string, unknown>) => { emitted.push({ type, payload }); } } as unknown as EventEmitter;
  const approvals = {
    list: () => pending,
    decide: (id: string, decision: string) => { decided.push([id, decision]); return null; }
  } as unknown as ApprovalQueue;
  const director = {
    submit: (input: { goal: string; plan?: { steps: Array<{ agentId?: string; spec?: string }> } }, by: string) => {
      submitted.push({ goal: input.goal.split('\n\n(')[0]!, by });
      requests.push({ goal: input.goal, agentId: input.plan?.steps[0]?.agentId ?? null, spec: input.plan?.steps[0]?.spec ?? null });
      return { rootTaskId: 'root1', planner: input.plan ? ('explicit' as const) : ('rule' as const), taskIds: ['root1'] };
    }
  } as unknown as Director;
  const bus = {
    on: (type: string, listener: (event: { type: string; payload: Record<string, unknown> }) => void) => {
      listeners.set(type, listener);
      return { unsubscribe: () => listeners.delete(type), active: true, dropped: 0 };
    }
  } as unknown as EventBus;

  const voice = createVoiceController({
    events, bus, approvals, director, config: { ...config, ...over },
    log: memoryLogger().log,
    send: (m) => { sent.push(m); },
    newId: () => `u${++n}`,
    now: () => clock.t,
    ...(opts.timers ? { timers: opts.timers } : {}),
    ...(opts.agents ? { agents: () => opts.agents! } : {}),
    ...(opts.lead !== undefined ? { leadAgent: () => opts.lead ?? null } : {}),
    ...(opts.assistant ? { assistant: { handle: (text: string) => opts.assistant!(text) } } : {}),
    ...(opts.briefing ? { briefing: opts.briefing } : {})
  });
  const fire = (type: string, payload: Record<string, unknown>): void => listeners.get(type)?.({ type, payload });
  const ready = (): void => voice.handle({ type: 'ready', voices: [], filters: { denoise: false, speaker: false, owner: false, ownerOnly: false, noiseGate: 0.004 }, engines: { vad: 'v', stt: 's', tts: 't' }, loadMs: 10 });
  return { voice, clock, emitted, sent, submitted, requests, decided, fire, ready, setPending: (a: Approval[]) => { pending = a; } };
}

describe('conversazione a voce (15/10/2026)', () => {
  const agents = [{ id: 'esecutore', name: 'Esecutore' }, { id: 'analista-1', name: 'Analista' }];
  it('18/10/2026: la richiesta a voce porta data e ora del PC (a «che ore sono?» l\'agente non lancia comandi)', () => {
    const at = new Date(2026, 9, 18, 3, 12);
    expect(voicePrompt('che ore sono', 'it', at)).toContain('Ora: domenica 18/10/2026, 03:12.');
    expect(voicePrompt('what time is it', 'en', at)).toContain('Now: Sunday 18/10/2026, 03:12.');
  });
  it('«parla con …»: agente per nome o id, Director, anche in inglese; i nomi che non esistono non sono una scelta', () => {
    expect(parseTalkTo('Parla con Esecutore.', agents)).toEqual({ target: 'esecutore' });
    expect(parseTalkTo("passami l'analista", agents)).toEqual({ target: 'analista-1' });
    expect(parseTalkTo('adesso parla con il Director', agents)).toEqual({ target: null });
    expect(parseTalkTo('voglio parlare con il direttore', agents)).toEqual({ target: null });
    expect(parseTalkTo('talk to the executor', [{ id: 'executor', name: 'Executor' }])).toEqual({ target: 'executor' });
    expect(parseTalkTo('parla con Mario', agents)).toBeNull();
    expect(parseTalkTo('controlla i test', agents)).toBeNull();
  });

  it('la risposta dell\'agente si legge senza markdown, codice e tabelle; lunga, si taglia a fine frase', () => {
    expect(spokenAnswer('## Esito\n**Fatto**: ho corretto `login.ts`.\n\n- primo punto\n- secondo punto\n\n```ts\nconst x = 1;\n```\n| a | b |\n|---|---|\nVedi [la guida](https://x.y).')).toBe(
      'Esito. Fatto: ho corretto login.ts. primo punto; secondo punto. Vedi la guida.'
    );
    const long = spokenAnswer('Frase di prova abbastanza lunga. '.repeat(80));
    expect(long.length).toBeLessThanOrEqual(1_200);
    expect(long.endsWith('lunga.')).toBe(true);
  });

  it('le righe MEMORIA non si leggono: sono appunti per gli altri agenti (16/10/2026, ripetevano la risposta)', () => {
    const answer = 'Ho sentito soltanto una serie di "e" ripetute. Dimmi pure cosa ti serve.\n\nMEMORIA: la richiesta vocale era solo una serie di "e".\n- MEMORIA [fisso]: il proprietario parla da fuori casa.';
    expect(spokenAnswer(answer)).toBe('Ho sentito soltanto una serie di "e" ripetute. Dimmi pure cosa ti serve.');
    expect(withoutFacts(answer)).toBe('Ho sentito soltanto una serie di "e" ripetute. Dimmi pure cosa ti serve.');
    // Una frase che cita la parola senza essere un appunto resta.
    expect(spokenAnswer('La memoria: ho liberato 2 GB.')).toBe('La memoria: ho liberato 2 GB.');
  });

  it('trascrizioni inventate da Whisper sul rumore: una parola ripetuta, frasi fantasma note', () => {
    expect(isPhantomTranscript('e e e e e e e e e e e e e e e e e e e e e e e e')).toBe(true);
    expect(isPhantomTranscript('Sottotitoli creati dalla comunità Amara.org')).toBe(true);
    expect(isPhantomTranscript('Grazie per la visione.')).toBe(true);
    // Rumori annotati (24/10/2026: «[Musica» diventava una richiesta al Director).
    for (const noise of ['[Musica', '[Musica]', '(applausi)', '♪ ♪', '*risate*', ' [MUSIC] ']) expect(isPhantomTranscript(noise)).toBe(true);
    expect(isPhantomTranscript('[Musica] metti la musica')).toBe(false);
    expect(isPhantomTranscript('no no no')).toBe(false);
    expect(isPhantomTranscript('che tempo fa domani a Roma')).toBe(false);
    expect(isPhantomTranscript('ricordami di chiamare Marco alle cinque e di comprare il latte')).toBe(false);
    expect(isPhantomTranscript('grazie per la visione del documento di ieri')).toBe(false);
  });

  it('errori ricorrenti dello STT corretti solo in italiano e solo verso parole sicure (24/10/2026)', () => {
    expect(fixTranscript('Annulla il Pro Memoria delle 5.', 'it')).toBe('Annulla il Promemoria delle 5.');
    expect(fixTranscript('Pro-memorie di oggi', 'it')).toBe('Promemorie di oggi');
    expect(fixTranscript('Buonotte visione. Turna online, chudi tutto e riavia il pc. Legi le notizie.', 'it')).toBe('Buonanotte visione. Torna online, chiudi tutto e riavvia il pc. Leggi le notizie.');
    // Parole vere non si toccano; in inglese nessuna correzione.
    expect(fixTranscript('la memoria del pro, la buona notte, il turno', 'it')).toBe('la memoria del pro, la buona notte, il turno');
    expect(fixTranscript('turna pro memoria', 'en')).toBe('turna pro memoria');
  });
});

describe('parseVoiceIntent', () => {
  it('riconosce obiettivo, approvazione, rifiuto, stop e vuoto', () => {
    expect(parseVoiceIntent('accendi le luci')).toBe('goal');
    expect(parseVoiceIntent('  ')).toBe('empty');
    expect(parseVoiceIntent('sì')).toBe('approve');
    expect(parseVoiceIntent('va bene')).toBe('approve');
    expect(parseVoiceIntent('no')).toBe('deny');
    expect(parseVoiceIntent('rifiuta questa azione')).toBe('deny');
    expect(parseVoiceIntent('stop')).toBe('stop');
    expect(parseVoiceIntent('basta così')).toBe('stop');
  });
});

describe('createVoiceController', () => {
  it('ciclo di vita: starting → ready → unavailable, con evento voice.process.changed', () => {
    const { voice, emitted, ready } = make();
    voice.handle({ type: 'process', phase: 'starting', pid: 123, code: null, reason: '' });
    ready();
    voice.handle({ type: 'unavailable', reason: 'modelli assenti' });
    const changes = emitted.filter((e) => e.type === 'voice.process.changed').map((e) => e.payload.to);
    expect(changes).toEqual(['starting', 'ready', 'unavailable']);
    expect(voice.status()).toMatchObject({ status: 'unavailable', reason: 'modelli assenti', pid: 123 });
  });

  it('push-to-talk: eventi e ordine al processo, con durata della pressione', () => {
    const { voice, clock, emitted, sent, ready } = make();
    ready();
    expect(voice.ptt('press', 'ui')).toEqual({ listening: true });
    expect(sent).toContainEqual({ type: 'ptt', down: true, autoEnd: false });
    clock.t += 250;
    expect(voice.ptt('release', 'ui')).toEqual({ listening: false });
    expect(emitted.find((e) => e.type === 'voice.ptt.released')?.payload.heldMs).toBe(250);
  });

  it('la voce non pronta rifiuta il push-to-talk', () => {
    const { voice } = make();
    expect(() => voice.ptt('press', 'ui')).toThrow();
  });

  it('trascrizione inventata dal rumore («e e e e…», 16/10/2026): niente al Director, niente a voce', () => {
    const { voice, emitted, sent, submitted, ready } = make({ announceStartup: false });
    ready();
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'e e e e e e e e e e e e e e e e e e e e e e e e', audioMs: 4_020, sttMs: 1_376, latencyMs: 1_382 });
    expect(submitted).toEqual([]);
    expect(emitted.find((e) => e.type === 'voice.intent')?.payload).toMatchObject({ intent: 'empty', outcome: 'ignored' });
    expect(sent.some((m) => m.type === 'speak')).toBe(false);
  });

  it('prova di precisione (24/10/2026): la frase armata va solo alla UI, corretta; la successiva torna al Director', () => {
    const { voice, emitted, sent, submitted, ready } = make({ announceStartup: false });
    expect(() => voice.accuracy('arm')).toThrow();
    ready();
    expect(voice.accuracy('arm')).toEqual({ armed: true });
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'Annulla il Pro Memoria delle 5.', audioMs: 2_000, sttMs: 300, latencyMs: 320 });
    expect(submitted).toEqual([]);
    expect(emitted.find((e) => e.type === 'voice.accuracy.heard')?.payload).toEqual({ text: 'Annulla il Promemoria delle 5.', audioMs: 2_000, sttMs: 300 });
    expect(emitted.some((e) => e.type === 'voice.stt.final' || e.type === 'voice.intent')).toBe(false);
    expect(sent.some((m) => m.type === 'speak')).toBe(false);
    voice.handle({ type: 'utterance', utteranceId: 'u2', text: 'accendi le luci', audioMs: 900, sttMs: 40, latencyMs: 50 });
    expect(submitted).toEqual([{ goal: 'accendi le luci', by: 'voice' }]);
    expect(voice.accuracy('arm')).toEqual({ armed: true });
    expect(voice.accuracy('cancel')).toEqual({ armed: false });
  });

  it('enunciato → al Director, con evento voice.intent e NESSUNA frase fatta (15/10/2026)', () => {
    const { voice, emitted, sent, submitted, requests, ready } = make({ announceStartup: false });
    ready();
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'accendi le luci', audioMs: 900, sttMs: 40, latencyMs: 50 });
    expect(submitted).toEqual([{ goal: 'accendi le luci', by: 'voice' }]);
    // All'agente arriva la frase più la richiesta di rispondere in parlato.
    expect(requests[0]!.goal).toMatch(/^accendi le luci\n\n\(Detto a voce a VISIONE/);
    expect(emitted.find((e) => e.type === 'voice.intent')?.payload).toMatchObject({ intent: 'goal', outcome: 'submitted', rootTaskId: 'root1' });
    expect(sent.some((m) => m.type === 'speak')).toBe(false);
  });

  it('conversazione: la frase va all\'agente scelto (anche a voce, «parla con …»), senza scelta al Director', () => {
    const agents = [{ id: 'esecutore', name: 'Esecutore' }, { id: 'analista', name: 'Analista' }];
    const { voice, emitted, sent, requests, ready } = make({ announceStartup: false }, { agents, lead: 'analista' });
    ready();
    // Senza scelta (24/10/2026): al Director SENZA piano già fatto, così pianifica e distribuisce alla squadra.
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'che ore sono a Tokyo', audioMs: 900, sttMs: 40, latencyMs: 50 });
    expect(requests.at(-1)?.agentId).toBeNull();
    expect(requests.at(-1)?.goal).toMatch(/^che ore sono a Tokyo\n\n\(Detto a voce a VISIONE/);
    // «parla con Esecutore»: cambia l'interlocutore, nessuna frase, nessun obiettivo.
    voice.handle({ type: 'utterance', utteranceId: 'u2', text: 'Parla con Esecutore.', audioMs: 900, sttMs: 40, latencyMs: 50 });
    expect(requests).toHaveLength(1);
    expect(voice.status().talkTo).toBe('esecutore');
    expect(emitted.find((e) => e.type === 'voice.talk.changed')?.payload).toEqual({ talkTo: 'esecutore', by: 'voice' });
    voice.handle({ type: 'utterance', utteranceId: 'u3', text: 'controlla i test', audioMs: 900, sttMs: 40, latencyMs: 50 });
    expect(requests.at(-1)?.agentId).toBe('esecutore');
    // Dalla UI, e ritorno al Director.
    expect(voice.talkTo(null)).toEqual({ talkTo: null });
    expect(() => voice.talkTo('nessuno')).toThrow(/agente sconosciuto/);
    expect(sent.some((m) => m.type === 'speak')).toBe(false);
  });

  it('Assistente: le conferme delle azioni non si dicono, le risposte e le domande sì', () => {
    const { voice, sent, ready } = make({ announceStartup: false }, {
      assistant: (text) => (text.includes('timer') ? { reply: 'Timer di 10 minuti avviato.', speak: false } : text.includes('oggi') ? { reply: 'Oggi hai la riunione alle dieci.' } : null)
    });
    ready();
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'metti un timer di 10 minuti', audioMs: 900, sttMs: 40, latencyMs: 50 });
    expect(sent.some((m) => m.type === 'speak')).toBe(false);
    voice.handle({ type: 'utterance', utteranceId: 'u2', text: 'cosa devo fare oggi', audioMs: 900, sttMs: 40, latencyMs: 50 });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'speak', text: 'Oggi hai la riunione alle dieci.' }));
  });

  it('"approva"/"no": decide l\'unica richiesta in attesa', () => {
    const { voice, decided, setPending, ready } = make();
    ready();
    setPending([approval('a1')]);
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'approva', audioMs: 500, sttMs: 20, latencyMs: 30 });
    expect(decided).toEqual([['a1', 'grant']]);
    decided.length = 0;
    voice.handle({ type: 'utterance', utteranceId: 'u2', text: 'no', audioMs: 400, sttMs: 20, latencyMs: 30 });
    expect(decided).toEqual([['a1', 'deny']]);
  });

  it('nessuna richiesta, più richieste o richiesta critica: non decide a voce', () => {
    const { voice, emitted, setPending, ready } = make();
    ready();
    setPending([]);
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'approva', audioMs: 300, sttMs: 10, latencyMs: 10 });
    expect(emitted.find((e) => e.type === 'voice.intent')?.payload.outcome).toBe('no-pending');

    setPending([approval('a1'), approval('a2')]);
    voice.handle({ type: 'utterance', utteranceId: 'u2', text: 'approva', audioMs: 300, sttMs: 10, latencyMs: 10 });
    expect(emitted.filter((e) => e.type === 'voice.intent').at(-1)?.payload.outcome).toBe('ambiguous');

    setPending([approval('a3', 'trust')]);
    voice.handle({ type: 'utterance', utteranceId: 'u3', text: 'approva', audioMs: 300, sttMs: 10, latencyMs: 10 });
    expect(emitted.filter((e) => e.type === 'voice.intent').at(-1)?.payload.outcome).toBe('needs-ui');
  });

  it('«No, chiedi al direttore…» senza richieste in attesa è un obiettivo, non un rifiuto (24/10/2026)', () => {
    const { voice, emitted, submitted, setPending, ready } = make({ announceStartup: false });
    ready();
    setPending([]);
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'No, chiedi al direttore di farlo', audioMs: 900, sttMs: 20, latencyMs: 30 });
    expect(emitted.find((e) => e.type === 'voice.intent')?.payload.outcome).toBe('submitted');
    expect(submitted).toEqual([{ goal: 'No, chiedi al direttore di farlo', by: 'voice' }]);
  });

  it('"stop" ferma la riproduzione', () => {
    const { voice, sent, ready } = make();
    ready();
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'stop', audioMs: 300, sttMs: 10, latencyMs: 10 });
    expect(sent).toContainEqual({ type: 'stop', ttsId: null, cause: 'owner' });
  });

  it('a fine richiesta si legge la RISPOSTA dell\'agente (ripulita), non il resoconto tecnico', () => {
    const { voice, emitted, sent, fire, ready } = make({ announceStartup: false });
    ready();
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'accendi le luci', audioMs: 900, sttMs: 40, latencyMs: 50 });
    sent.length = 0;
    fire('director.summary', { rootTaskId: 'root1', outcome: 'succeeded', counts: {}, text: 'Obiettivo "accendi le luci": succeeded.\n- passo (a): succeeded', answer: '**Fatto**: ho acceso le luci.' });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'speak', text: 'Fatto: ho acceso le luci.' }));
    expect(emitted.filter((e) => e.type === 'voice.tts.requested').at(-1)?.payload).toMatchObject({ reason: 'summary' });
  });

  it('richiesta senza risposta: riuscita resta in silenzio, fallita lo dice in breve', () => {
    const { voice, sent, fire, ready } = make({ announceStartup: false });
    ready();
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'accendi le luci', audioMs: 900, sttMs: 40, latencyMs: 50 });
    fire('director.summary', { rootTaskId: 'root1', outcome: 'succeeded', counts: {}, text: 'x', answer: null });
    expect(sent.some((m) => m.type === 'speak')).toBe(false);
    voice.handle({ type: 'utterance', utteranceId: 'u2', text: 'accendi le luci', audioMs: 900, sttMs: 40, latencyMs: 50 });
    fire('director.summary', { rootTaskId: 'root1', outcome: 'failed', counts: {}, text: 'x' });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'speak', text: 'Nessuna risposta: la richiesta è fallita.' }));
  });

  it('una richiesta di approvazione viene annunciata a voce', () => {
    const { sent, fire, ready } = make();
    ready();
    fire('approval.requested', { approvalId: 'a1', kind: 'command', target: 'x', reason: 'scrivere il file', requestedBy: 'agent', taskId: null, agentId: null });
    expect(sent.some((m) => m.type === 'speak' && m.text.includes('scrivere il file'))).toBe(true);
  });

  it('traduce i fatti TTS in eventi e pulisce lo stato della frase', () => {
    const { voice, emitted, ready } = make();
    ready();
    voice.handle({ type: 'tts', ttsId: 't1', phase: 'started', synthMs: 20, firstAudioMs: 40, bargeInMs: null, playedMs: null, cause: null, error: null });
    expect(emitted.some((e) => e.type === 'voice.tts.started')).toBe(true);
    voice.handle({ type: 'tts', ttsId: 't1', phase: 'interrupted', synthMs: null, firstAudioMs: null, bargeInMs: 120, playedMs: 300, cause: 'barge-in', error: null });
    expect(emitted.find((e) => e.type === 'voice.tts.interrupted')?.payload).toMatchObject({ cause: 'barge-in', bargeInMs: 120 });
  });

  it('sintesi fallita: voice.error + tts.finished con errore, speaking azzerato, la voce resta pronta', () => {
    const { voice, emitted, ready } = make();
    ready();
    const { ttsId } = voice.speak('Ciao, sono VISIONE.');
    expect(voice.status().speaking).toBe(ttsId);
    voice.handle({ type: 'tts', ttsId, phase: 'failed', synthMs: null, firstAudioMs: null, bargeInMs: null, playedMs: null, cause: null, error: 'kokoro assente' });
    expect(emitted.find((e) => e.type === 'voice.error')?.payload).toMatchObject({ code: 'tts-failed', message: 'kokoro assente' });
    expect(emitted.find((e) => e.type === 'voice.tts.finished' && e.payload.error === 'kokoro assente')).toBeDefined();
    // Non blocca il sistema: lo stato della frase è ripulito e un nuovo parlato parte subito.
    expect(voice.status()).toMatchObject({ status: 'ready', speaking: null });
    expect(voice.speak('Di nuovo.').ttsId).toBeTruthy();
  });

  it('avvio (Fase 24): alla prima disponibilità la voce pronuncia la frase, una sola volta', () => {
    const { sent, ready } = make({ announceStartup: true, startupPhrase: 'VISIONE online.' });
    ready();
    expect(sent.filter((m) => m.type === 'speak')).toEqual([{ type: 'speak', ttsId: 'u1', text: 'VISIONE online.' }]);
    ready(); // un secondo 'ready' non ripete la frase
    expect(sent.filter((m) => m.type === 'speak')).toHaveLength(1);
  });
  it('avvio (24/10/2026): il saluto parte appena la voce è pronta, le notizie (preparate durante il caricamento) dopo il saluto', async () => {
    let asked = 0;
    let deliver: (text: string) => void = () => {};
    const news = new Promise<string>((resolve) => { deliver = resolve; });
    const { voice, sent, ready } = make({ announceStartup: true, startupBriefing: true, startupPhrase: 'Bentornato.' }, { briefing: () => { asked++; return news; } });
    voice.handle({ type: 'process', phase: 'starting', pid: 1, code: null, reason: '' });
    expect(asked).toBe(1); // la verifica dei motori parte insieme al caricamento della voce
    ready();
    expect(sent.filter((m) => m.type === 'speak')).toEqual([{ type: 'speak', ttsId: 'u1', text: 'Bentornato.' }]);
    deliver('Ho verificato i motori: sono pronti.');
    await news;
    await Promise.resolve();
    expect(sent.filter((m) => m.type === 'speak')).toHaveLength(1); // non interrompe il saluto
    voice.handle({ type: 'tts', ttsId: 'u1', phase: 'finished', synthMs: null, firstAudioMs: null, bargeInMs: null, playedMs: 900, cause: null, error: null });
    expect(sent.filter((m) => m.type === 'speak').at(-1)).toMatchObject({ text: 'Ho verificato i motori: sono pronti.' });
    expect(asked).toBe(1);
  });
});

/** Timer manuali: l'arming/timeout della wake si prova senza attese reali. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        pending.set(++seq, { fn, ms });
        return seq;
      },
      clear: (h: unknown) => pending.delete(h as number)
    },
    fire: (): number | undefined => {
      const entry = [...pending.entries()][0];
      if (!entry) return undefined;
      pending.delete(entry[0]);
      entry[1].fn();
      return entry[1].ms;
    },
    count: (): number => pending.size
  };
}

describe('createVoiceController — wake word (P-81)', () => {
  it('all\'avvio invia la configurazione della wake al processo', () => {
    const { sent, ready } = make();
    ready();
    expect(sent).toContainEqual({ type: 'wake', enabled: false, phrase: 'hey visione' });
  });

  it('wake-state aggiorna lo stato reale ed emette voice.wake.changed', () => {
    const { voice, emitted, ready } = make();
    ready();
    voice.handle({ type: 'wake-state', enabled: true, phrase: 'hey visione', available: true, reason: null });
    expect(voice.status().wake).toEqual({ enabled: true, phrase: 'hey visione', available: true, armed: false });
    expect(emitted.filter((e) => e.type === 'voice.wake.changed')).toHaveLength(1);

    voice.handle({ type: 'wake-state', enabled: true, phrase: 'hey visione', available: true, reason: null });
    expect(emitted.filter((e) => e.type === 'voice.wake.changed')).toHaveLength(1); // nessun duplicato
  });

  it('frase con comando: evento wake + enunciato eseguito subito', () => {
    const { voice, emitted, submitted, ready } = make({ announceStartup: false });
    ready();
    voice.handle({ type: 'wake-state', enabled: true, phrase: 'hey visione', available: true, reason: null });
    voice.handle({ type: 'wake', phrase: 'hey visione', text: 'Hey Visione, accendi le luci', command: 'accendi le luci', audioMs: 1_500, sttMs: 320 });

    expect(emitted.find((e) => e.type === 'voice.wake.detected')?.payload).toMatchObject({
      phrase: 'hey visione', command: 'accendi le luci', confidence: null, sttMs: 320
    });
    expect(emitted.find((e) => e.type === 'voice.stt.final')?.payload).toMatchObject({ text: 'Hey Visione, accendi le luci' });
    expect(submitted).toEqual([{ goal: 'accendi le luci', by: 'voice' }]);
    expect(voice.status()).toMatchObject({ listening: false, wake: { armed: false } });
  });

  it('sola frase: arma il push-to-talk e il timeout lo disarma senza dati finti', () => {
    const t = manualTimers();
    const { voice, clock, emitted, sent, ready } = make({ announceStartup: false }, { timers: t.timers });
    ready();
    voice.handle({ type: 'wake-state', enabled: true, phrase: 'hey visione', available: true, reason: null });
    voice.handle({ type: 'wake', phrase: 'hey visione', text: 'Hey Visione', command: '', audioMs: 900, sttMs: 250 });

    expect(emitted.find((e) => e.type === 'voice.wake.detected')?.payload).toMatchObject({ command: null });
    expect(sent).toContainEqual({ type: 'ptt', down: true, autoEnd: true });
    expect(emitted.some((e) => e.type === 'voice.ptt.pressed' && e.payload.source === 'wake')).toBe(true);
    expect(voice.status()).toMatchObject({ listening: true, wake: { armed: true } });

    clock.t += 6_000;
    expect(t.fire()).toBe(6_000);
    expect(sent).toContainEqual({ type: 'ptt', down: false, autoEnd: false });
    expect(voice.status()).toMatchObject({ listening: false, wake: { armed: false } });
    expect(emitted.filter((e) => e.type === 'voice.ptt.released').at(-1)?.payload).toMatchObject({ source: 'wake', heldMs: 6_000 });
  });

  it('17/10/2026: cominciato il parlato, il timer della wake non tronca più la frase (la chiude il silenzio)', () => {
    const t = manualTimers();
    const { voice, sent, ready } = make({ announceStartup: false }, { timers: t.timers });
    ready();
    voice.handle({ type: 'wake-state', enabled: true, phrase: 'hey visione', available: true, reason: null });
    voice.handle({ type: 'wake', phrase: 'hey visione', text: 'Hey Visione', command: '', audioMs: 900, sttMs: 250 });
    voice.handle({ type: 'vad', phase: 'start', mode: 'ptt', audioMs: 1_500 });
    sent.length = 0;
    expect(t.count()).toBe(0); // nessun timer pendente: la frase non si chiude a 6 s
    expect(sent).not.toContainEqual({ type: 'ptt', down: false, autoEnd: false });
    expect(voice.status()).toMatchObject({ listening: true, wake: { armed: true } });
  });

  it('conversazione (17/10/2026): finita una risposta resta in ascolto senza «hey visione»; nel silenzio si chiude', () => {
    const t = manualTimers();
    const { voice, emitted, sent, fire, ready, clock } = make({ announceStartup: false }, { timers: t.timers });
    ready();
    voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'ciao come stai', audioMs: 900, sttMs: 40, latencyMs: 50 });
    fire('director.summary', { rootTaskId: 'root1', outcome: 'succeeded', counts: {}, text: 'x', answer: 'Sto bene, grazie.' });
    const ttsId = (emitted.filter((e) => e.type === 'voice.tts.requested').at(-1)?.payload as { ttsId: string }).ttsId;
    sent.length = 0;
    voice.handle({ type: 'tts', phase: 'finished', ttsId, playedMs: 1_200, error: null, synthMs: null, firstAudioMs: null, bargeInMs: null, cause: null });
    expect(sent).toContainEqual({ type: 'ptt', down: true, autoEnd: true });
    expect(emitted.filter((e) => e.type === 'voice.ptt.pressed').at(-1)?.payload).toMatchObject({ source: 'conversation' });
    clock.t += 8_000;
    expect(t.fire()).toBe(8_000);
    expect(sent).toContainEqual({ type: 'ptt', down: false, autoEnd: false });
    expect(emitted.filter((e) => e.type === 'voice.ptt.released').at(-1)?.payload).toMatchObject({ source: 'conversation', heldMs: 8_000 });
  });

  it('conversazione: niente ascolto dopo un promemoria, né con followUpMs 0', () => {
    const { voice, sent, fire, ready, emitted } = make({ announceStartup: false });
    ready();
    fire('assistant.reminder.fired', { reminderId: 'r1', message: 'Bevi acqua', dueAt: 0, firedAt: 0, recurring: null });
    const reminderTts = (emitted.filter((e) => e.type === 'voice.tts.requested').at(-1)?.payload as { ttsId: string }).ttsId;
    sent.length = 0;
    voice.handle({ type: 'tts', phase: 'finished', ttsId: reminderTts, playedMs: 800, error: null, synthMs: null, firstAudioMs: null, bargeInMs: null, cause: null });
    expect(sent).not.toContainEqual({ type: 'ptt', down: true, autoEnd: true });
    const off = make({ announceStartup: false, followUpMs: 0 });
    off.ready();
    off.voice.handle({ type: 'utterance', utteranceId: 'u1', text: 'ciao', audioMs: 900, sttMs: 40, latencyMs: 50 });
    off.fire('director.summary', { rootTaskId: 'root1', outcome: 'succeeded', counts: {}, text: 'x', answer: 'Ciao!' });
    const id = (off.emitted.filter((e) => e.type === 'voice.tts.requested').at(-1)?.payload as { ttsId: string }).ttsId;
    off.sent.length = 0;
    off.voice.handle({ type: 'tts', phase: 'finished', ttsId: id, playedMs: 500, error: null, synthMs: null, firstAudioMs: null, bargeInMs: null, cause: null });
    expect(off.sent).not.toContainEqual({ type: 'ptt', down: true, autoEnd: true });
  });

  it('enunciato durante l\'arming: il push-to-talk si chiude e l\'intento usa quell\'enunciato', () => {
    const t = manualTimers();
    const { voice, clock, emitted, submitted, ready } = make({ announceStartup: false }, { timers: t.timers });
    ready();
    voice.handle({ type: 'wake-state', enabled: true, phrase: 'hey visione', available: true, reason: null });
    voice.handle({ type: 'wake', phrase: 'hey visione', text: 'Hey Visione', command: '', audioMs: 900, sttMs: 200 });
    clock.t += 800;
    voice.handle({ type: 'utterance', utteranceId: 'u9', text: 'accendi le luci', audioMs: 900, sttMs: 40, latencyMs: 50 });

    expect(emitted.filter((e) => e.type === 'voice.ptt.released').at(-1)?.payload).toMatchObject({ source: 'wake', heldMs: 800 });
    expect(t.count()).toBe(0);
    expect(submitted).toEqual([{ goal: 'accendi le luci', by: 'voice' }]);
    expect(voice.status()).toMatchObject({ listening: false, wake: { armed: false } });
  });

  it('voice.wake spegne subito l\'attesa armata; da non pronta rifiuta', () => {
    const t = manualTimers();
    const { voice, emitted, sent, ready } = make({ announceStartup: false }, { timers: t.timers });
    expect(() => voice.wake(true)).toThrow();
    ready();
    expect(voice.wake(true)).toEqual({ enabled: true, phrase: 'hey visione' });
    expect(sent).toContainEqual({ type: 'wake', enabled: true, phrase: 'hey visione' });
    voice.handle({ type: 'wake', phrase: 'hey visione', text: 'Hey Visione', command: '', audioMs: 900, sttMs: 200 });
    voice.wake(false);
    expect(voice.status()).toMatchObject({ listening: false, wake: { armed: false } });
    expect(emitted.filter((e) => e.type === 'voice.ptt.released').at(-1)?.payload).toMatchObject({ source: 'wake' });
    expect(sent.at(-1)).toEqual({ type: 'wake', enabled: false, phrase: 'hey visione' });
  });

  it('wake non disponibile: resta spenta e l\'evento lo dichiara', () => {
    const { voice, emitted, ready } = make({ announceStartup: false });
    ready();
    voice.handle({ type: 'wake-state', enabled: false, phrase: 'hey visione', available: false, reason: 'VAD dedicata assente nel processo voce' });
    expect(voice.status().wake).toMatchObject({ enabled: false, available: false });
    expect(emitted.find((e) => e.type === 'voice.wake.changed')?.payload).toMatchObject({ available: false, reason: 'VAD dedicata assente nel processo voce' });
  });
});
