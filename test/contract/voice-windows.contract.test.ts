// Contract test della voce di Windows (P-103): PowerShell e voci del sistema VERI, poi Whisper locale
// ritrascrive. Prova che la voce è italiana comprensibile, accenti compresi. Opt-in (config contract),
// non gira in `npm test`; saltato fuori da Windows o senza i modelli d'ascolto (`npm run voice:models`).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOICE_SAMPLE_RATE } from '../../src/shared/contracts/voice.ts';
import { createSherpaEngines, missingModels } from '../../src/voice/sherpa.ts';
import { createWindowsTts } from '../../src/voice/windows-tts.ts';

const modelsDir = join(process.env.VISIONE_HOME?.trim() || join(process.env.APPDATA ?? '', 'VISIONE-dev'), 'models', 'voice');
const ready = process.platform === 'win32' && existsSync(modelsDir) && missingModels(modelsDir, ['vad', 'stt']).length === 0;

describe.skipIf(!ready)('voce di Windows reale → Whisper (P-103)', () => {
  it('le voci italiane installate parlano e Whisper capisce la frase', async () => {
    const listening = await createSherpaEngines({ modelsDir, threads: 4, speaker: 'if_sara', vad: { threshold: 0.5, minSpeechMs: 120, minSilenceMs: 400 }, kokoro: false });
    const tts = createWindowsTts({ voice: 'Microsoft Cosimo', rate: '+0%' });
    try {
      const voices = await tts.voices();
      console.log('[voce windows] voci:', voices.map((v) => `${v.name} (${v.lang})`).join(', '));
      expect(voices.some((v) => v.lang.toLowerCase().startsWith('it'))).toBe(true);
      const chunks: Float32Array[] = [];
      let rate = 0;
      await tts.synthesize('Buongiorno, sono VISIONE. Il sistema è operativo e la città è già sveglia.', (c) => {
        if (c.kind !== 'pcm') return false;
        rate = c.sampleRate;
        chunks.push(c.samples);
        return true;
      });
      expect(rate).toBe(VOICE_SAMPLE_RATE);
      const samples = Float32Array.from(chunks.flatMap((c) => Array.from(c)));
      expect(samples.length).toBeGreaterThan(VOICE_SAMPLE_RATE);
      const text = (await listening.stt.transcribe(samples)).toLowerCase();
      console.log('[voce windows] Whisper:', JSON.stringify(text), 'voce', tts.name);
      expect(text).toMatch(/buongiorno/);
      expect(text).toMatch(/sistema/);
      expect(text).toMatch(/operativ/);
      expect(text).toMatch(/città|citta/);
    } finally {
      tts.close();
    }
  }, 120_000);
});
