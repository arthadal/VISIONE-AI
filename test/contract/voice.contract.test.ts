// Contract test della voce REALE (Fase 18.3): carica i motori sherpa-onnx locali (Silero VAD, Whisper
// STT, Kokoro TTS) e verifica un giro TTS→STT **senza rete**. È opt-in (config contract), non gira in
// `npm test`; richiede i modelli (`npm run voice:models`). Se mancano, i test sono saltati.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOICE_SAMPLE_RATE } from '../../src/shared/contracts/voice.ts';
import { createSherpaEngines, missingModels } from '../../src/voice/sherpa.ts';

const modelsDir = join(process.env.VISIONE_HOME?.trim() || join(process.env.APPDATA ?? '', 'VISIONE-dev'), 'models', 'voice');
const ready = existsSync(modelsDir) && missingModels(modelsDir).length === 0;

/** Ricampionamento lineare (TTS Kokoro può uscire a 24 kHz; Whisper vuole 16 kHz). */
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

describe.skipIf(!ready)('voce reale (sherpa-onnx, locale, senza rete)', () => {
  it('TTS Kokoro sintetizza audio; VAD rileva il parlato; STT Whisper ritrascrive (giro completo)', async () => {
    const engines = await createSherpaEngines({ modelsDir, threads: 4, speaker: 'if_sara', vad: { threshold: 0.5, minSpeechMs: 120, minSilenceMs: 400 } });
    const chunks: Float32Array[] = [];
    let rate = 0;
    await engines.tts.synthesize('Ciao, sono Visione. Il sistema e operativo.', (chunk) => {
      if (chunk.kind !== 'pcm') return false;
      rate = chunk.sampleRate;
      chunks.push(chunk.samples);
      return true;
    });
    expect(chunks.length).toBeGreaterThan(0);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(2_000);
    console.log('[voice] TTS campioni', total, 'a', rate, 'Hz');

    // Giro completo: metti l'audio sintetizzato nel VAD e poi nello STT.
    const samples = resample(Float32Array.from(chunks.flatMap((c) => Array.from(c))), rate, VOICE_SAMPLE_RATE);
    const window = engines.vad.windowSize;
    for (let i = 0; i + window <= samples.length; i += window) engines.vad.accept(samples.subarray(i, i + window));
    engines.vad.flush();
    const segment = engines.vad.pop();
    expect(segment).not.toBeNull();
    const text = await engines.stt.transcribe(segment?.samples ?? samples);
    console.log('[voice] STT:', JSON.stringify(text));
    expect(typeof text).toBe('string');
    // La frase italiana deve contenere almeno una parola chiave riconoscibile.
    expect(text.toLowerCase()).toMatch(/visione|operativ|ciao|sono/);
  }, 180_000);
});
