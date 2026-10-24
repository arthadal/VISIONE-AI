// Verifica locale TTS→wake (P-81, opt-in): Kokoro sintetizza «Hey Visione, apri i documenti», la
// pipeline REALE (VAD dedicata → Whisper) la trascrive e il matcher riconosce la frase e il comando.
// Nessuna rete, nessun costo. Richiede i modelli (`npm run voice:models`); altrimenti il test è saltato.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { VOICE_SAMPLE_RATE } from '../../src/shared/contracts/voice.ts';
import type { VoiceToCore } from '../../src/shared/contracts/index.ts';
import type { VoiceEngines } from '../../src/voice/engines.ts';
import { VoicePipeline } from '../../src/voice/pipeline.ts';
import { createSherpaEngines, missingModels } from '../../src/voice/sherpa.ts';

const modelsDir = join(process.env.VISIONE_HOME?.trim() || join(process.env.APPDATA ?? '', 'VISIONE-dev'), 'models', 'voice');
const ready = existsSync(modelsDir) && missingModels(modelsDir).length === 0;

/** Ricampionamento lineare (Kokoro esce a 24 kHz; la wake vive a 16 kHz). */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - t) + (input[i1] ?? 0) * t;
  }
  return out;
}

describe.skipIf(!ready)('wake reale (sherpa-onnx, locale, senza rete)', () => {
  let engines: VoiceEngines;

  beforeAll(async () => {
    engines = await createSherpaEngines({
      modelsDir, threads: 4, speaker: 'if_sara',
      vad: { threshold: 0.5, minSpeechMs: 120, minSilenceMs: 400 },
      wake: { sensitivity: 0.5 }
    });
  }, 180_000);

  /** Sintetizza `text` e la fa passare nella pipeline di wake; ritorna i fatti `wake` reali. */
  async function wakeOf(text: string): Promise<Array<Extract<VoiceToCore, { type: 'wake' }>>> {
    const chunks: Float32Array[] = [];
    let rate = 0;
    await engines.tts.synthesize(text, (chunk) => {
      if (chunk.kind !== 'pcm') return false;
      rate = chunk.sampleRate;
      chunks.push(chunk.samples);
      return true;
    });
    const audio = resample(Float32Array.from(chunks.flatMap((c) => Array.from(c))), rate, VOICE_SAMPLE_RATE);
    const core: VoiceToCore[] = [];
    const pipeline = new VoicePipeline({
      engines,
      toCore: (m) => core.push(m),
      toRenderer: () => true,
      newId: () => 'wake-contract',
      wake: { enabled: true, phrase: 'hey visione' }
    });
    // VAD dedicata pulita fra un test e l'altro (gli engine sono condivisi).
    pipeline.wake(false, 'hey visione');
    pipeline.wake(true, 'hey visione');
    for (let i = 0; i < audio.length; i += 1_600) pipeline.audio(audio.subarray(i, i + 1_600));
    // Silenzio finale: il VAD chiude il segmento (minSilence 400 ms) e la trascrizione parte.
    pipeline.audio(new Float32Array(VOICE_SAMPLE_RATE));
    await pipeline.idle();
    pipeline.close();
    return core.filter((m): m is Extract<VoiceToCore, { type: 'wake' }> => m.type === 'wake');
  }

  it('«Hey Visione, apri i documenti»: frase riconosciuta e comando nella stessa utterance', async () => {
    const facts = await wakeOf('Hey Visione, apri i documenti.');
    console.log('[wake] fatti:', JSON.stringify(facts));
    expect(facts.length).toBeGreaterThan(0);
    const fact = facts[0]!;
    expect(fact.phrase).toBe('hey visione');
    expect(fact.text.toLowerCase()).toMatch(/vision/);
    expect(fact.audioMs).toBeGreaterThan(500);
    // Il comando è il testo REALE dopo la frase: Whisper-base può scrivere «a prie» per «apri»
    // (limite del modello, documentato in P-81). Qui conta che il comando ci sia e sia completo.
    expect(fact.command.length).toBeGreaterThan(0);
    expect(fact.command.toLowerCase()).toContain('documenti');
  }, 180_000);

  it('sola frase: la wake si riconosce, il comando è vuoto', async () => {
    // «Ehi Visione» è la pronuncia italiana che Whisper-base riconosce meglio della sola «Hey»
    // importata; il matcher accetta entrambe (è la stessa frase di attivazione).
    const facts = await wakeOf('Ehi Visione');
    console.log('[wake] sola frase:', JSON.stringify(facts));
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]!.command).toBe('');
  }, 180_000);

  it('frase diversa: nessuna wake inventata', async () => {
    const facts = await wakeOf('Ciao, sono Visione e il sistema è operativo.');
    console.log('[wake] negativo:', JSON.stringify(facts));
    expect(facts).toHaveLength(0);
  }, 180_000);
});
