// Voce di Windows (P-103): funzioni pure (velocità, JSON ASCII, frasi, WAV) e motore con un processo
// PowerShell finto. Nessun processo vero: il giro reale con PowerShell si prova a mano e dal vivo.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TtsChunk } from '../../src/voice/engines.ts';
import { missingModels } from '../../src/voice/sherpa.ts';
import {
  WINDOWS_TTS_SCRIPT,
  asciiJson,
  createWindowsTts,
  parseWav,
  rateMultiplier,
  splitSentences,
  type WindowsTtsProcess
} from '../../src/voice/windows-tts.ts';
import { tempHome } from '../helpers.ts';

/** WAV PCM 16 bit costruito qui; `extra` inserisce un blocco LIST prima dei dati. */
function wav(samples: number[], opts: { rate?: number; channels?: number; bits?: number; format?: number; extra?: boolean } = {}): Uint8Array {
  const rate = opts.rate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const extra = opts.extra ? 12 : 0;
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + extra + data);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + extra + data, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(opts.format ?? 1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(bits, 34);
  let at = 36;
  if (opts.extra) {
    buf.write('LIST', at);
    buf.writeUInt32LE(4, at + 4);
    buf.write('INFO', at + 8);
    at += 12;
  }
  buf.write('data', at);
  buf.writeUInt32LE(data, at + 4);
  samples.forEach((s, i) => buf.writeInt16LE(s, at + 8 + i * 2));
  return new Uint8Array(buf);
}

/** Processo finto: registra le righe scritte e risponde con `reply` (o resta muto). */
class FakeProcess implements WindowsTtsProcess {
  readonly written: Array<{ id: number; text: string; voice: string; rate: number }> = [];
  readonly raw: string[] = [];
  killed = false;
  private lines: Array<(line: string) => void> = [];
  private exits: Array<(reason: string) => void> = [];
  private readonly reply: ((req: { id: number; text: string; voice: string }) => object | null) | null;
  constructor(reply: ((req: { id: number; text: string; voice: string }) => object | null) | null) {
    this.reply = reply;
  }
  write(line: string): void {
    this.raw.push(line);
    const req = JSON.parse(line) as { id: number; text: string; voice: string; rate: number };
    this.written.push(req);
    const out = this.reply?.(req);
    if (out) queueMicrotask(() => this.emit(out));
  }
  onLine(h: (line: string) => void): void {
    this.lines.push(h);
  }
  onExit(h: (reason: string) => void): void {
    this.exits.push(h);
  }
  kill(): void {
    this.killed = true;
  }
  emit(o: object | string): void {
    for (const h of this.lines) h(typeof o === 'string' ? o : JSON.stringify(o));
  }
  exit(reason: string): void {
    for (const h of this.exits) h(reason);
  }
  ready(): void {
    this.emit({ ready: true, api: 'winrt', voices: [{ name: 'Microsoft Cosimo', lang: 'it-IT', gender: 'Male' }, { name: 'Microsoft Elsa', lang: 'it-IT', gender: 'Female' }] });
  }
}

const okReply = (req: { id: number }): object => ({ id: req.id, ok: true, voice: 'Microsoft Cosimo', wav: Buffer.from(wav([16384, -16384, 0, 8192])).toString('base64') });

function engine(reply: ((req: { id: number; text: string; voice: string }) => object | null) | null = okReply, timeoutMs = 1_000) {
  const procs: FakeProcess[] = [];
  const tts = createWindowsTts({
    voice: 'Microsoft Cosimo',
    rate: '+8%',
    timeoutMs,
    start: () => {
      const p = new FakeProcess(reply);
      procs.push(p);
      queueMicrotask(() => p.ready());
      return p;
    }
  });
  return { tts, procs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('voce di Windows: funzioni pure (P-103)', () => {
  it('rateMultiplier: percentuale di Edge → moltiplicatore, limiti 0.5–2, formato sbagliato → 1', () => {
    expect(rateMultiplier('+8%')).toBeCloseTo(1.08);
    expect(rateMultiplier('-10%')).toBeCloseTo(0.9);
    expect(rateMultiplier('0%')).toBe(1);
    expect(rateMultiplier('+300%')).toBe(2);
    expect(rateMultiplier('-90%')).toBe(0.5);
    expect(rateMultiplier('veloce')).toBe(1);
    expect(rateMultiplier('-2Hz')).toBe(1);
  });

  it('asciiJson: solo ASCII stampabile, stesso valore dopo JSON.parse (accenti e a capo)', () => {
    const value = { text: 'Perché è così, è già\npronto — «ok» 😀', id: 3 };
    const line = asciiJson(value);
    expect(line).toMatch(/^[\x20-\x7e]*$/);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(value);
  });

  it('splitSentences: frasi per punteggiatura e a capo, niente pezzi vuoti o di sola punteggiatura', () => {
    expect(splitSentences('Ciao. Come stai? Bene!\nPoi: altro… fine')).toEqual(['Ciao.', 'Come stai?', 'Bene!', 'Poi:', 'altro…', 'fine']);
    expect(splitSentences('  ...  \n\n !! ')).toEqual([]);
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('versione 1.2.3 pronta')).toEqual(['versione 1.2.3 pronta']);
  });

  it('splitSentences: frase lunga tagliata all\'ultimo spazio prima del limite, nessuna parola persa', () => {
    const long = Array.from({ length: 60 }, (_, i) => `parola${i}`).join(' ');
    const parts = splitSentences(long, 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ')).toBe(long);
    const noSpace = 'x'.repeat(250);
    expect(splitSentences(noSpace, 100)).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });

  it('parseWav: mono 16 bit, blocchi extra saltati, stereo mediato', () => {
    const mono = parseWav(wav([16384, -32768, 0]));
    expect(mono.sampleRate).toBe(16_000);
    expect(Array.from(mono.samples)).toEqual([0.5, -1, 0]);
    expect(Array.from(parseWav(wav([16384], { extra: true, rate: 22_050 })).samples)).toEqual([0.5]);
    expect(parseWav(wav([16384], { extra: true, rate: 22_050 })).sampleRate).toBe(22_050);
    const stereo = parseWav(wav([16384, 0, -16384, -16384], { channels: 2 }));
    expect(Array.from(stereo.samples)).toEqual([0.25, -0.5]);
  });

  it('parseWav: errori onesti su intestazione, formato e dati mancanti', () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow(/RIFF/);
    expect(() => parseWav(wav([1], { bits: 8 }))).toThrow(/8 bit/);
    expect(() => parseWav(wav([1], { format: 3 }))).toThrow(/formato 3/);
    expect(() => parseWav(wav([1]).slice(0, 36))).toThrow(/dati assente/);
  });

  it('lo script PowerShell rispetta i vincoli della riga di comando (niente virgolette doppie, backtick, barre rovesciate)', () => {
    expect(WINDOWS_TTS_SCRIPT).not.toMatch(/["`\\]/);
    expect(WINDOWS_TTS_SCRIPT).toContain('SynthesizeTextToStreamAsync');
    expect(WINDOWS_TTS_SCRIPT).toContain('System.Speech');
  });

  it('missingModels per ruolo: senza Kokoro il modello TTS non è richiesto', () => {
    const { dir, cleanup } = tempHome('visione-modelli-');
    try {
      const all = missingModels(dir);
      const listening = missingModels(dir, ['vad', 'stt']);
      expect(all.some((m) => m.startsWith('kokoro'))).toBe(true);
      expect(listening.some((m) => m.startsWith('kokoro'))).toBe(false);
      expect(listening).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

describe('voce di Windows: motore con processo finto (P-103)', () => {
  it('una richiesta per frase in ordine, JSON ASCII con voce e velocità, PCM a blocchi più la coda di silenzio', async () => {
    const { tts, procs } = engine();
    const chunks: TtsChunk[] = [];
    await tts.synthesize('Buongiorno. È già pronto!', (c) => {
      chunks.push(c);
      return true;
    });
    expect(procs).toHaveLength(1);
    expect(procs[0]!.written.map((r) => r.text)).toEqual(['Buongiorno.', 'È già pronto!']);
    expect(procs[0]!.written.every((r) => r.voice === 'Microsoft Cosimo' && Math.abs(r.rate - 1.08) < 1e-9)).toBe(true);
    expect(procs[0]!.raw.every((l) => /^[\x20-\x7e]*$/.test(l))).toBe(true);
    expect(chunks).toHaveLength(3);
    const first = chunks[0]!;
    expect(first.kind).toBe('pcm');
    if (first.kind === 'pcm') {
      expect(first.sampleRate).toBe(16_000);
      expect(Array.from(first.samples)).toEqual([0.5, -0.5, 0, 0.25]);
    }
    const tail = chunks[2]!;
    expect(tail.kind === 'pcm' && tail.samples.length === Math.round((16_000 * 220) / 1000) && tail.samples.every((s) => s === 0)).toBe(true);
    expect(tts.name).toBe('windows Microsoft Cosimo');
  });

  it('interruzione: onChunk false ferma la consegna, niente coda; testo vuoto → nessuna richiesta', async () => {
    const { tts, procs } = engine();
    let n = 0;
    await tts.synthesize('Uno. Due. Tre. Quattro.', () => ++n < 2);
    expect(n).toBe(2);
    await tts.synthesize(' ... ', () => {
      throw new Error('non deve arrivare audio');
    });
    expect(procs[0]!.written.length).toBeLessThanOrEqual(3);
  });

  it('il processo resta uno solo tra più frasi; voices() restituisce le voci dichiarate all\'avvio', async () => {
    const { tts, procs } = engine();
    await tts.warmup();
    await tts.synthesize('Prima.', () => true);
    await tts.synthesize('Seconda.', () => true);
    expect(procs).toHaveLength(1);
    expect((await tts.voices()).map((v) => v.name)).toEqual(['Microsoft Cosimo', 'Microsoft Elsa']);
  });

  it('errore dichiarato da PowerShell → errore con il motivo, il processo resta per la frase dopo', async () => {
    let fail = true;
    const { tts, procs } = engine((req) => (fail ? { id: req.id, ok: false, error: 'voce non trovata' } : okReply(req)));
    await expect(tts.synthesize('Prova.', () => true)).rejects.toThrow('voce Windows: voce non trovata');
    fail = false;
    await tts.synthesize('Prova.', () => true);
    expect(procs).toHaveLength(1);
  });

  it('processo terminato durante una frase: errore, e la frase dopo avvia un processo nuovo', async () => {
    let first = true;
    const { tts, procs } = engine((req) => {
      if (first) {
        first = false;
        queueMicrotask(() => procs[0]!.exit('PowerShell terminato (codice 1)'));
        return null;
      }
      return okReply(req);
    });
    await expect(tts.synthesize('Prova.', () => true)).rejects.toThrow('PowerShell terminato (codice 1)');
    await tts.synthesize('Di nuovo.', () => true);
    expect(procs).toHaveLength(2);
  });

  it('nessuna risposta entro il limite: errore, processo ucciso e sostituito alla frase dopo', async () => {
    vi.useFakeTimers();
    let mute = true;
    const { tts, procs } = engine((req) => (mute ? null : okReply(req)), 500);
    const pending = tts.synthesize('Prova.', () => true);
    const caught = pending.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(600);
    expect(((await caught) as Error).message).toMatch(/nessuna risposta entro 500 ms/);
    expect(procs[0]!.killed).toBe(true);
    mute = false;
    const again = tts.synthesize('Di nuovo.', () => true);
    await vi.advanceTimersByTimeAsync(10);
    await again;
    expect(procs).toHaveLength(2);
  });

  it('avvio senza risposta: errore di avvio scaduto; righe non JSON scartate senza crash', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const procs: FakeProcess[] = [];
    const tts = createWindowsTts({
      voice: 'x',
      rate: '+0%',
      timeoutMs: 300,
      log: (l) => logs.push(l),
      start: () => {
        const p = new FakeProcess(null);
        procs.push(p);
        queueMicrotask(() => p.emit('rumore non json'));
        return p;
      }
    });
    const caught = tts.warmup().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(400);
    expect(((await caught) as Error).message).toMatch(/non si è avviata entro 300 ms/);
    expect(procs[0]!.killed).toBe(true);
    expect(logs.some((l) => l.includes('riga non valida'))).toBe(true);
  });

  it('close() termina il processo e rifiuta le frasi in attesa', async () => {
    const { tts, procs } = engine(() => null);
    const pending = tts.synthesize('Prova.', () => true).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 5));
    tts.close();
    expect(((await pending) as Error).message).toMatch(/chiusa/);
    expect(procs[0]!.killed).toBe(true);
  });
});
