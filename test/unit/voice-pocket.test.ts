// Voce VISIONE (P-110): il tokenizer e la preparazione del testo riscritti in TypeScript devono dare
// esattamente ciò che danno la libreria SentencePiece e il wrapper di Pocket TTS (casi calcolati da loro
// con `.backup/voce-lavoro/esporta-tokenizer.py`). Un id diverso = la voce dice un'altra cosa.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTokenizer, type TokenizerFile } from '../../src/voice/pocket/tokenizer.ts';
import { prepareText, splitSentences } from '../../src/voice/pocket/text.ts';
import { createJarvisEffect, jarvisRaw } from '../../src/voice/pocket/effect.ts';
import { normalizeForSpeech, numberToWords } from '../../src/voice/pocket/normalize.ts';
import { createPocketTts, type OrtModule, type OrtSession, type OrtTensor } from '../../src/voice/pocket/engine.ts';
import type { TtsChunk } from '../../src/voice/engines.ts';

const root = join(__dirname, '..', '..');
const tok = createTokenizer(JSON.parse(readFileSync(join(root, 'vendor/voce-visione/it/tokenizer.json'), 'utf8')) as TokenizerFile);
const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/pocket-tokenizer-casi.json'), 'utf8')) as {
  cases: { text: string; ids: number[]; decoded: string }[];
  prepared: { text: string; prepared: string; framesAfterEos: number }[];
  splits: { text: string; chunks: string[] }[];
};

describe('voce VISIONE: tokenizer', () => {
  it.each(fixture.cases)('stessi id di SentencePiece: $text', ({ text, ids, decoded }) => {
    expect(tok.encode(text)).toEqual(ids);
    expect(tok.decode(ids)).toBe(decoded);
  });

  it('testo vuoto: nessun token', () => {
    expect(tok.encode('')).toEqual([]);
  });
});

describe('voce VISIONE: testo', () => {
  it.each(fixture.prepared)('preparazione come Pocket TTS: $text', ({ text, prepared, framesAfterEos }) => {
    expect(prepareText(text)).toEqual({ text: prepared, framesAfterEos });
  });

  it.each(fixture.splits)('frasi come Pocket TTS: $text', ({ text, chunks }) => {
    expect(splitSentences(tok, text)).toEqual(chunks);
  });

  it('il testo vuoto è un errore dichiarato', () => {
    expect(() => prepareText('   ')).toThrow('testo vuoto');
  });
});

describe('voce VISIONE: testo da leggere (cifre, sigle, simboli, due punti)', () => {
  it.each([
    // Il saluto che la voce ha storpiato il 15/10/2026 («4 a 3», «per approcessore», parole saltate).
    ['VISIONE online. Sistemi operativi. Il PC sta bene: processore al 43 per cento e memoria al 51 per cento. Nessun lavoro in sospeso.',
      'Visione online. Sistemi operativi. Il pi ci sta bene. Processore al quarantatré per cento e memoria al cinquantuno per cento. Nessun lavoro in sospeso.'],
    ['Promemoria in ritardo, era per oggi alle 10:10: togliere la pasta.', 'Promemoria in ritardo, era per oggi alle dieci e dieci. Togliere la pasta.'],
    ['Riunione alle 15:00 e alle 9.05.', 'Riunione alle quindici e alle nove e cinque.'],
    ['Ecco: 3,14 euro; 1.250 file; 42% della CPU.', 'Ecco. Tre virgola quattordici euro. Milleduecentocinquanta file. Quarantadue per cento della ci pi u.'],
    ["L'email è stata inviata a mario.rossi@example.com.", "L'email è stata inviata a mario punto rossi chiocciola example punto com."],
    ['Oggi è il 15/10/2026, ci sono 21° e -3 gradi stanotte.', 'Oggi è il quindici ottobre duemilaventisei, ci sono ventuno gradi e meno tre gradi stanotte.'],
    ['ROMA, USB, RAM da 16 GB, PERCHÉ?', 'Roma, u esse bi, ram da sedici giga, Perché?'],
    ['Ho 1.000.000 di euro e 2001 notti, 108 e 180, 0,05 e € 20.', 'Ho un milione di euro e duemilauno notti, centotto e centottanta, zero virgola zero cinque e venti euro.'],
    ['Versione 1.1.0-beta.11 pronta.', 'Versione uno punto uno punto zero beta undici pronta.'],
    ['Apri https://example.com/pagina (subito)', 'Apri un collegamento, subito'],
    ['«Virgolette» e “altre” – trattini… 🙂', 'Virgolette e altre, trattini...'],
    ['🙂🙂', '']
  ])('%s', (input, expected) => {
    expect(normalizeForSpeech(input)).toBe(expected);
  });

  it('numeri in lettere, con le elisioni dell\'italiano', () => {
    expect([0, 1, 8, 13, 21, 23, 28, 33, 99, 100, 101, 108, 180, 999, 1000, 1001, 2026, 21000, 1_000_000, 2_500_000, 1_000_000_000].map(numberToWords)).toEqual([
      'zero', 'uno', 'otto', 'tredici', 'ventuno', 'ventitré', 'ventotto', 'trentatré', 'novantanove', 'cento', 'centouno', 'centotto', 'centottanta',
      'novecentonovantanove', 'mille', 'milleuno', 'duemilaventisei', 'ventunomila', 'un milione', 'due milioni cinquecentomila', 'un miliardo'
    ]);
  });

  it('un testo di soli simboli o emoji non fa partire la voce e non è un guasto', async () => {
    const ort: OrtModule = { Tensor: class {} as unknown as OrtModule['Tensor'], InferenceSession: { create: async () => ({ run: async () => ({}) }) } };
    const tts = createPocketTts({ dir: join(root, 'vendor/voce-visione/it'), ort, effect: false });
    const chunks: TtsChunk[] = [];
    await expect(tts.synthesize('🙂 🙂', (c) => (chunks.push(c), true))).resolves.toBeUndefined();
    expect(chunks).toEqual([]);
  });
});

describe('voce VISIONE: motore (onnxruntime finto)', () => {
  /** onnxruntime finto: il modello «finisce la frase» dopo `eosAfter` passi; il decoder dà 1920 campioni a fotogramma. */
  function fakeOrt(eosAfter: number, clock?: { t: number; stepMs: number; decCallMs?: number; stallEvery?: number; stallMs?: number }): { ort: OrtModule; calls: { main: Record<string, OrtTensor>[]; decoder: number[] } } {
    const calls = { main: [] as Record<string, OrtTensor>[], decoder: [] as number[] };
    class Tensor implements OrtTensor {
      readonly type: string;
      readonly data: unknown;
      readonly dims: readonly number[];
      constructor(type: string, data: unknown, dims: readonly number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    }
    const bundle = JSON.parse(readFileSync(join(root, 'vendor/voce-visione/it/bundle.json'), 'utf8')) as { flow_lm_state_manifest: { output_name: string }[]; mimi_state_manifest: { output_name: string }[] };
    let steps = 0;
    let serial = 0;
    const states = (manifest: { output_name: string }[]): Record<string, OrtTensor> => Object.fromEntries(manifest.map((e) => [e.output_name, new Tensor('float32', new Float32Array([++serial]), [1])]));
    // Come onnxruntime-node: `run` lavora in un setImmediate e blocca il processo, così un decoder in coda
    // può girare mentre un passo del modello è in attesa (e il suo tempo finire nel passo).
    const job = (): Promise<void> => (clock ? new Promise((r) => setImmediate(r)) : Promise.resolve());
    const sessions: Record<string, OrtSession['run']> = {
      'text_conditioner.onnx': async (f) => ({ embeddings: new Tensor('float32', new Float32Array(f.token_ids!.dims[1]! * 1024), [1, f.token_ids!.dims[1]!, 1024]) }),
      'flow_lm_main_int8.onnx': async (f) => {
        await job();
        calls.main.push(f);
        if (f.sequence!.dims[1] === 0) steps = 0;
        else {
          steps++;
          if (clock) clock.t += clock.stepMs + (clock.stallEvery && steps % clock.stallEvery === 0 ? clock.stallMs ?? 0 : 0);
        }
        return { conditioning: new Tensor('float32', new Float32Array(1024), [1, 1024]), eos_logit: new Tensor('float32', new Float32Array([steps > eosAfter ? 0 : -10]), [1, 1]), ...states(bundle.flow_lm_state_manifest) };
      },
      'flow_lm_flow_int8.onnx': async () => ({ flow_dir: new Tensor('float32', new Float32Array(32).fill(0.1), [1, 32]) }),
      'mimi_decoder_int8.onnx': async (f) => {
        await job();
        calls.decoder.push(f.latent!.dims[1]!);
        if (clock) clock.t += (clock.decCallMs ?? 0) + 6 * f.latent!.dims[1]!;
        return { audio_frame: new Tensor('float32', new Float32Array(f.latent!.dims[1]! * 1920).fill(0.01), [1, 1, f.latent!.dims[1]! * 1920]), ...states(bundle.mimi_state_manifest) };
      }
    };
    const ort: OrtModule = { Tensor, InferenceSession: { create: async (path) => ({ run: sessions[path.split(/[\\/]/).pop()!]! }) } };
    return { ort, calls };
  }
  const dir = join(root, 'vendor/voce-visione/it');

  it('una frase: primo blocco fra il margine e un blocco intero, tutto a 24 kHz, si ferma dopo la fine più i fotogrammi di coda', async () => {
    const { ort, calls } = fakeOrt(6);
    const tts = createPocketTts({ dir, ort, effect: false, random: () => 0.5 });
    const chunks: TtsChunk[] = [];
    await tts.synthesize('Buonasera, signore. Tutti i sistemi sono operativi.', (c) => (chunks.push(c), true));
    // «Buonasera, signore. Tutti i sistemi sono operativi.»: 7 parole → 1 + 2 fotogrammi dopo la fine.
    // Il finto segnala la fine al settimo passo (indice 6): si esce all'indice 6 + 3 = 9, cioè 9 fotogrammi.
    const frames = calls.decoder.reduce((a, b) => a + b, 0);
    expect(frames).toBe(9);
    expect(calls.decoder[0]).toBeGreaterThanOrEqual(3);
    expect(calls.decoder[0]).toBeLessThanOrEqual(12);
    expect(chunks.every((c) => c.kind === 'pcm' && c.sampleRate === 24000)).toBe(true);
    expect(chunks.reduce((s, c) => s + (c.kind === 'pcm' ? c.samples.length : 0), 0)).toBe(frames * 1920);
  });

  it.each([
    ['veloce come questo PC (38 ms a fotogramma)', 38],
    ['più lento del parlato (110 ms a fotogramma: 80 ms di voce)', 110]
  ])('nessun buco nella riproduzione su un PC %s: se serve aspetta di più prima di partire', async (_name, stepMs) => {
    const clock = { t: 0, stepMs };
    const { ort, calls } = fakeOrt(140, clock);
    const tts = createPocketTts({ dir, ort, effect: false, now: () => clock.t });
    // Due passate: la prima insegna al motore quanto costa un fotogramma su questo PC.
    for (let i = 0; i < 2; i++) await tts.synthesize(fixture.splits[0]!.text, () => true);
    expect(tts.stats()).toMatchObject({ gaps: 0 });
    if (stepMs > 80) expect(calls.decoder.at(-1)).toBeGreaterThan(0);
    expect(tts.stats()!.firstMs).toBeLessThan(stepMs > 80 ? 60_000 : 600);
  });

  it('prima frase su un PC lento (avvio dell\'app): una pausa sola per riaccumulare, non decine di scatti', async () => {
    // Misurato il 16/10/2026 nel pacchetto a batteria: il saluto d'avvio partiva con la stima di un PC veloce,
    // restava indietro e decodificava un fotogramma alla volta (98 ms l'uno per il costo fisso della
    // chiamata): 125 buchi in 12,6 s. Qui: 150 ms a fotogramma e 60 ms fissi a chiamata del decoder.
    const clock = { t: 0, stepMs: 150, decCallMs: 60 };
    const { ort, calls } = fakeOrt(140, clock);
    const tts = createPocketTts({ dir, ort, effect: false, now: () => clock.t });
    await tts.synthesize(fixture.splits[0]!.text, () => true);
    expect(tts.stats()!.gaps).toBeLessThanOrEqual(1);
    expect(calls.decoder.filter((n) => n === 1).length).toBeLessThanOrEqual(2);
  });

  it('il decoder che blocca il processo non conta nel costo del fotogramma: un PC che ce la fa non si ferma', async () => {
    // Misurato il 16/10/2026 a batteria: 12 fotogrammi di decoder = 150-370 ms che bloccano il passo in
    // attesa; contati due volte, il PC sembrava più lento del parlato e la voce si fermava 2-3,5 s.
    // Qui: 50 ms a fotogramma e 150 ms fissi a chiamata del decoder, cioè ~68 ms per 80 ms di voce.
    const clock = { t: 0, stepMs: 50, decCallMs: 150 };
    const { ort } = fakeOrt(140, clock);
    const tts = createPocketTts({ dir, ort, effect: false, now: () => clock.t });
    for (let i = 0; i < 2; i++) await tts.synthesize(fixture.splits[0]!.text, () => true);
    expect(tts.stats()).toMatchObject({ gaps: 0 });
    expect(tts.stats()!.firstMs).toBeLessThan(1_500);
    // Il costo stimato del fotogramma è quello del modello (50 ms), senza il decoder che ha girato nel frattempo.
    expect(tts.stats()!.frameMs).toBeLessThan(51);
  });

  it('rallentamenti improvvisi (PC a batteria): dopo una frase con buchi la riserva cresce e le frasi dopo sono pulite', async () => {
    // Fotogramma da 50 ms (il PC ce la fa) ma ogni 60 passi un fermo di 1,2 s (oltre la riserva di partenza; in media 73 ms per 80 di voce) che nessuna stima vede.
    const clock = { t: 0, stepMs: 50, decCallMs: 40, stallEvery: 60, stallMs: 1_200 };
    const { ort } = fakeOrt(140, clock);
    const tts = createPocketTts({ dir, ort, effect: false, now: () => clock.t });
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      await tts.synthesize(fixture.splits[0]!.text, () => true);
      gaps.push(tts.stats()!.gaps);
    }
    expect(gaps[0]).toBeGreaterThan(0);
    expect(gaps.slice(2)).toEqual([0, 0]);
    expect(tts.stats()!.firstMs).toBeLessThan(3_000);
  });

  it('interrompere (onChunk → false) ferma la generazione', async () => {
    const { ort, calls } = fakeOrt(1000);
    const tts = createPocketTts({ dir, ort, effect: false });
    let got = 0;
    await tts.synthesize('Ecco una frase abbastanza lunga da generare molti fotogrammi prima della fine.', () => (got++, false));
    expect(got).toBe(1);
    // Prima del primo audio si accumula il margine (un blocco più la riserva): poi si ferma subito.
    expect(calls.main.length).toBeLessThan(30);
  });

  it('testo lungo: ogni blocco riparte dallo stato della voce, non da quello del blocco prima', async () => {
    const { ort, calls } = fakeOrt(3);
    const tts = createPocketTts({ dir, ort, effect: false });
    await tts.synthesize(fixture.splits[1]!.text, () => true);
    // L'impronta della voce entra come «testo» lungo quanto i suoi fotogrammi (voce.json): quella non è un blocco.
    const voiceFrames = (JSON.parse(readFileSync(join(dir, 'voce.json'), 'utf8')) as { shape: number[] }).shape[1];
    const textCalls = calls.main.filter((f) => f.sequence!.dims[1] === 0 && f.text_embeddings!.dims[1] !== voiceFrames);
    expect(textCalls).toHaveLength(fixture.splits[1]!.chunks.length);
    const voiceState = (f: Record<string, OrtTensor>): unknown => f.state_0!.data;
    expect(new Set(textCalls.map(voiceState)).size).toBe(1);
  });
});

describe('voce VISIONE: effetto «stile JARVIS»', () => {
  const ref = JSON.parse(readFileSync(join(root, 'test/fixtures/jarvis-effetto-casi.json'), 'utf8')) as {
    sampleRate: number; length: number; step: number; samples: number[]; sumAbs: number;
  };
  const signal = Float64Array.from({ length: ref.length }, (_, n) =>
    n >= 3000 && n < 3400 ? 0 : 0.5 * Math.sin((2 * Math.PI * 220 * n) / ref.sampleRate) + 0.3 * Math.sin((2 * Math.PI * 3100 * n) / ref.sampleRate) * (n % 7 === 0 ? 1 : 0.5)
  );

  it('campione per campione è il calcolo di effetto.py', () => {
    const fx = jarvisRaw(ref.sampleRate);
    const out = Array.from(signal, (v) => fx(v));
    ref.samples.forEach((v, i) => expect(out[i * ref.step]).toBeCloseTo(v, 7));
    expect(out.reduce((s, v) => s + Math.abs(v), 0)).toBeCloseTo(ref.sumAbs, 4);
  });

  it('a blocchi dà lo stesso risultato che tutto insieme (lo stato passa da un blocco all\'altro)', () => {
    const input = Float32Array.from(signal);
    const whole = createJarvisEffect(ref.sampleRate, 0.5).process(input);
    const fx = createJarvisEffect(ref.sampleRate, 0.5);
    const parts = [0, 1, 1920, 1921, 3840, ref.length];
    const chunked = new Float32Array(ref.length);
    for (let i = 0; i < parts.length - 1; i++) chunked.set(fx.process(input.subarray(parts[i], parts[i + 1])), parts[i]);
    expect(chunked).toEqual(whole);
  });

  it('il limitatore non supera mai 1, anche con un guadagno esagerato', () => {
    const out = createJarvisEffect(ref.sampleRate, 20).process(Float32Array.from(signal));
    expect(Math.max(...Array.from(out, Math.abs))).toBeLessThan(1);
  });
});
