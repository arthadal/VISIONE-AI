// Filtri dell'ascolto (P-106): soglia del rumore, pulizia, solo la voce del proprietario, registrazione
// dell'impronta. Motori finti: il segmento del VAD ha durata e volume scelti dal test; l'«impronta» finta
// dipende dal volume del segmento (0,5 = proprietario, 0,3 = estraneo), così la regola si prova davvero.
import { describe, expect, it } from 'vitest';
import type { SpeechSegment, SttEngine, TtsEngine, VadEngine } from '../../src/voice/engines.ts';
import { centroid, cosine, enrollQuality, judgeOwner, makeProfile, OWNER_LIMITS, parseProfile, rms, speechLevel, to16k, type OwnerProfile, type SpeakerEngine } from '../../src/voice/filters.ts';
import { VoicePipeline, type PipelineFilters } from '../../src/voice/pipeline.ts';
import type { VoiceToCore } from '../../src/shared/contracts/index.ts';

class SegVad implements VadEngine {
  readonly name = 'fake-vad';
  readonly windowSize = 8;
  private speaking = false;
  private queue: SpeechSegment[] = [];
  /** Durata (campioni a 16 kHz) e volume del prossimo segmento. */
  len = 32_000;
  level = 0.5;
  /** Campioni di silenzio in coda (le pause di chi parla). */
  pause = 0;
  accept(): void {}
  set(value: boolean): void {
    if (!value && this.speaking) this.queue.push({ start: 0, samples: new Float32Array(this.len + this.pause).fill(this.level, 0, this.len) });
    this.speaking = value;
  }
  detected(): boolean { return this.speaking; }
  flush(): void { if (this.speaking) this.set(false); }
  pop(): SpeechSegment | null { return this.queue.shift() ?? null; }
  reset(): void { this.speaking = false; this.queue = []; }
}

const OWNER = new Float32Array([1, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const STRANGER = new Float32Array([0, 0, 1, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** Impronta finta: dal volume del segmento (0,5 proprietario, 0,3 estraneo, altro = rumore). */
const fakeSpeaker = (): SpeakerEngine & { calls: number } => {
  const s = { name: 'impronta finta', calls: 0, embed: (x: Float32Array): Float32Array => {
    s.calls++;
    const v = x[0] ?? 0;
    if (Math.abs(v - 0.5) < 0.01) return OWNER.map((n, i) => n + (i === 3 ? 0.05 * (s.calls % 3) : 0));
    if (Math.abs(v - 0.3) < 0.01) return STRANGER;
    return new Float32Array(16).fill(0.25);
  } };
  return s;
};
const stt = (): SttEngine & { calls: number } => { const s = { name: 'stt', calls: 0, transcribe: async (): Promise<string> => { s.calls++; return 'hey visione apri il terminale'; } }; return s; };
const tts: TtsEngine = { name: 'tts', synthesize: async () => undefined };

function setup(filters: PipelineFilters, wake = false) {
  const vad = new SegVad();
  const s = stt();
  const core: VoiceToCore[] = [];
  const pipeline = new VoicePipeline({
    engines: { vad, stt: s, tts, wakeVad: vad },
    toCore: (m) => core.push(m), toRenderer: () => true, newId: () => 'u', now: () => 1_000,
    timers: { set: () => ({}), clear: () => undefined }, wake: { enabled: wake, phrase: 'hey visione' }, filters
  });
  const say = async (level: number, ms: number, pauseMs = 0): Promise<void> => {
    vad.level = level;
    vad.len = Math.round((ms / 1000) * 16_000);
    vad.pause = Math.round((pauseMs / 1000) * 16_000);
    pipeline.ptt(true, false);
    vad.set(true);
    pipeline.audio(new Float32Array(8));
    vad.set(false);
    pipeline.audio(new Float32Array(8));
    pipeline.ptt(false, false);
    await pipeline.idle();
  };
  return { vad, stt: s, core, pipeline, say, of: <T extends VoiceToCore['type']>(t: T) => core.filter((m) => m.type === t) as Extract<VoiceToCore, { type: T }>[] };
}

const profile = (): OwnerProfile => makeProfile('fake', [OWNER, OWNER], 0);
const ownerFilters = (over: Partial<PipelineFilters> = {}): PipelineFilters => ({ noiseGate: 0.004, speaker: fakeSpeaker(), speakerModel: 'fake', owner: { enabled: true, minScore: 0.4, margin: 0.05, profile: profile(), cohort: [STRANGER] }, ...over });

describe('filtri: logica pura', () => {
  it('regola del proprietario: somiglianza minima E margine sulla voce di riferimento più simile', () => {
    expect(judgeOwner(OWNER, OWNER, [STRANGER], 0.4, 0.05).outcome).toBe('owner');
    expect(judgeOwner(STRANGER, OWNER, [STRANGER], 0.4, 0.05).outcome).toBe('stranger');
    // Simile al proprietario ma ancora più simile a una voce di riferimento: estraneo.
    const mid = new Float32Array([0.6, 0.1, 0.7, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cosine(mid, OWNER)).toBeGreaterThan(0.4);
    expect(judgeOwner(mid, OWNER, [STRANGER], 0.4, 0.05).outcome).toBe('stranger');
    expect(judgeOwner(mid, OWNER, [], 0.4, 0.05)).toMatchObject({ outcome: 'owner', margin: null });
  });

  it('impronta media, qualità della registrazione, profilo letto solo se integro e dello stesso modello', () => {
    expect(cosine(centroid([OWNER, OWNER.map((x) => x * 10)]), OWNER)).toBeCloseTo(1, 5);
    expect(enrollQuality([OWNER, OWNER, OWNER]).min).toBeCloseTo(1, 5);
    expect(enrollQuality([OWNER, STRANGER, OWNER]).min).toBeLessThan(0.5);
    const p = makeProfile('eres2net-sv-en', [OWNER, OWNER, OWNER], 42);
    expect(parseProfile(JSON.parse(JSON.stringify(p)), 'eres2net-sv-en')).toEqual(p);
    expect(parseProfile(p, 'altro-modello')).toBeNull();
    expect(parseProfile({ ...p, centroid: [1, 2] }, 'eres2net-sv-en')).toBeNull();
    expect(parseProfile('rotto', 'eres2net-sv-en')).toBeNull();
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 6);
    expect(to16k(new Float32Array(48_000), 48_000)).toHaveLength(16_000);
  });
});

describe('filtri nella pipeline (P-106)', () => {
  it('soglia del rumore: un parlato debole non arriva allo STT', async () => {
    const t = setup({ noiseGate: 0.05 });
    await t.say(0.01, 2_000);
    expect(t.stt.calls).toBe(0);
    expect(t.of('heard')).toEqual([{ type: 'heard', mode: 'ptt', outcome: 'quiet', score: null, audioMs: 2_000 }]);
    expect(t.of('utterance')[0]).toMatchObject({ text: '' });
  });

  it('soglia del rumore: conta il livello dei tratti parlati, non la media con le pause', async () => {
    // 1 s di voce a 0,08 e 3 s di pausa: media 0,04 (sotto 0,05), ma si sta parlando sopra la soglia.
    const audio = new Float32Array(64_000).fill(0.08, 0, 16_000);
    expect(rms(audio)).toBeLessThan(0.05);
    expect(speechLevel(audio)).toBeCloseTo(0.08, 5);
    expect(speechLevel(new Float32Array(1_000).fill(0.02))).toBeCloseTo(0.02, 5);
    const t = setup({ noiseGate: 0.05 });
    await t.say(0.08, 1_000, 3_000);
    expect(t.stt.calls).toBe(1);
    expect(t.of('heard').filter((h) => h.outcome === 'quiet')).toEqual([]);
  });

  it('solo il proprietario: l\'estraneo non arriva allo STT, il proprietario sì; corto = non giudicato', async () => {
    const t = setup(ownerFilters());
    await t.say(0.3, 2_000);
    expect(t.stt.calls).toBe(0);
    expect(t.of('heard').at(-1)).toMatchObject({ outcome: 'stranger' });
    expect(t.of('utterance').at(-1)).toMatchObject({ text: '' });
    await t.say(0.5, 2_000);
    expect(t.stt.calls).toBe(1);
    expect(t.of('heard').at(-1)).toMatchObject({ outcome: 'owner' });
    expect(t.of('utterance').at(-1)?.text).toBe('hey visione apri il terminale');
    await t.say(0.3, 600);
    expect(t.of('heard').at(-1)).toMatchObject({ outcome: 'unverified', score: null });
    expect(t.stt.calls).toBe(2);
  });

  it('filtro spento o senza impronta: nessun giudizio, tutto come prima', async () => {
    const off = setup(ownerFilters({ owner: { enabled: false, minScore: 0.4, margin: 0.05, profile: profile(), cohort: [] } }));
    await off.say(0.3, 2_000);
    expect(off.stt.calls).toBe(1);
    expect(off.of('heard')).toHaveLength(0);
    const none = setup(ownerFilters({ owner: { enabled: true, minScore: 0.4, margin: 0.05, profile: null, cohort: [] } }));
    await none.say(0.3, 2_000);
    expect(none.stt.calls).toBe(1);
  });

  it('wake: la frase di un estraneo non sveglia VISIONE (niente STT)', async () => {
    const t = setup(ownerFilters(), true);
    t.vad.level = 0.3;
    t.vad.len = 24_000;
    t.vad.set(true);
    t.pipeline.audio(new Float32Array(8));
    t.vad.set(false);
    t.pipeline.audio(new Float32Array(8));
    await t.pipeline.idle();
    expect(t.stt.calls).toBe(0);
    expect(t.of('heard').at(-1)).toMatchObject({ mode: 'wake', outcome: 'stranger' });
    expect(t.of('wake')).toHaveLength(0);
  });

  it('registrazione: 3 frasi → impronta salvata, il filtro la usa subito; niente STT durante la registrazione', async () => {
    const saved: Array<OwnerProfile | null> = [];
    const f = ownerFilters({ owner: { enabled: true, minScore: 0.4, margin: 0.05, profile: null, cohort: [STRANGER] }, saveProfile: (p) => saved.push(p) });
    const t = setup(f);
    t.pipeline.enroll('save');
    expect(t.of('enroll').at(-1)).toMatchObject({ phase: 'error', reason: 'not-started' });
    t.pipeline.enroll('start');
    await t.say(0.5, 800);
    expect(t.of('enroll').at(-1)).toMatchObject({ phase: 'error', reason: 'short' });
    await t.say(0.5, 2_000);
    await t.say(0.5, 2_000);
    t.pipeline.enroll('save');
    expect(t.of('enroll').at(-1)).toMatchObject({ phase: 'error', reason: 'few', count: 2 });
    await t.say(0.5, 2_000);
    expect(t.of('enroll').at(-1)).toMatchObject({ phase: 'sample', count: 3, audioMs: 2_000 });
    t.pipeline.enroll('save');
    expect(t.of('enroll').at(-1)).toMatchObject({ phase: 'saved', count: 3, reason: null });
    expect(t.stt.calls).toBe(0);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ version: 1, model: 'fake', samples: 3 });
    // Ora il filtro è attivo con l'impronta nuova.
    await t.say(0.3, 2_000);
    expect(t.of('heard').at(-1)).toMatchObject({ outcome: 'stranger' });
    await t.say(0.5, 2_000);
    expect(t.of('heard').at(-1)).toMatchObject({ outcome: 'owner' });
    // Cancellare l'impronta spegne il giudizio.
    t.pipeline.enroll('clear');
    expect(saved.at(-1)).toBeNull();
    expect(t.of('enroll').at(-1)).toMatchObject({ phase: 'cleared' });
    const judged = t.of('heard').length;
    const transcribed = t.stt.calls;
    await t.say(0.3, 2_000);
    expect(t.of('heard')).toHaveLength(judged);
    expect(t.stt.calls).toBe(transcribed + 1);
  });

  it('prova della procedura: giudica la frase anche col filtro spento, non la trascrive (nessun obiettivo)', async () => {
    const t = setup(ownerFilters({ owner: { enabled: false, minScore: 0.4, margin: 0.05, profile: profile(), cohort: [STRANGER] } }));
    t.pipeline.enroll('probe');
    await t.say(0.5, 2_000);
    expect(t.of('heard').at(-1)).toMatchObject({ outcome: 'owner' });
    t.pipeline.enroll('probe');
    await t.say(0.3, 2_000);
    expect(t.of('heard').at(-1)).toMatchObject({ outcome: 'stranger' });
    expect(t.stt.calls).toBe(0);
    expect(t.of('utterance')).toHaveLength(0);
    // Finita la prova si torna al normale: la frase dopo si trascrive.
    await t.say(0.3, 2_000);
    expect(t.stt.calls).toBe(1);
    // Senza impronta la prova dice «non giudicato», sempre senza STT.
    const none = setup(ownerFilters({ owner: { enabled: false, minScore: 0.4, margin: 0.05, profile: null, cohort: [] } }));
    none.pipeline.enroll('probe');
    await none.say(0.5, 2_000);
    expect(none.of('heard').at(-1)).toMatchObject({ outcome: 'unverified' });
    expect(none.stt.calls).toBe(0);
  });

  it('registrazione con frasi incoerenti (voci diverse): rifiutata, si ricomincia; senza modello: errore chiaro', async () => {
    const t = setup(ownerFilters({ owner: { enabled: true, minScore: 0.4, margin: 0.05, profile: null, cohort: [] } }));
    t.pipeline.enroll('start');
    await t.say(0.5, 2_000);
    await t.say(0.3, 2_000);
    await t.say(0.3, 2_000);
    t.pipeline.enroll('save');
    const last = t.of('enroll').at(-1);
    expect(last).toMatchObject({ phase: 'error', reason: 'quality' });
    expect(last?.quality ?? 1).toBeLessThan(OWNER_LIMITS.enrollMinQuality);
    const nomodel = setup({ noiseGate: 0.004 });
    nomodel.pipeline.enroll('start');
    expect(nomodel.of('enroll').at(-1)).toMatchObject({ phase: 'error', reason: 'no-model' });
  });
});
