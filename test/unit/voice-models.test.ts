// Modelli d'ascolto scaricati dall'app su consenso (P-105): installazione verificata (dimensione e
// SHA-256), niente modelli rotti al loro posto, archivi estratti, ripresa di un archivio già scaricato,
// comandi del core con avanzamento e riavvio della voce. Nessuna rete: fetch ed estrazione finti.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandRouter } from '../../src/core/commands/index.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { registerVoiceModelCommands } from '../../src/core/voice/index.ts';
import { VOICE_MODELS, installVoiceModel, missingVoiceModels, type VoiceModel } from '../../src/shared/node/voice-models.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const tmp = (): string => {
  const { dir, cleanup } = tempHome('visione-modelli-');
  cleanups.push(cleanup);
  return dir;
};
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const body = Buffer.from('modello finto '.repeat(5_000));
const plain: VoiceModel = { id: 'vad-finto', role: 'vad', url: 'https://esempio/vad.onnx', archive: false, dir: 'vad', size: body.length, sha256: sha(body), license: 'MIT', files: ['vad.onnx'] };
const archived: VoiceModel = { id: 'stt-finto', role: 'stt', url: 'https://esempio/stt.tar.bz2', archive: true, dir: 'stt', size: body.length, sha256: sha(body), license: 'MIT', files: ['enc.onnx', 'tok.txt'] };

function fetchOf(data: Buffer | null, status = 200): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(data ? new Uint8Array(data) : null, { status });
    }) as typeof fetch
  };
}

describe('modelli d\'ascolto: installazione verificata (P-105)', () => {
  it('il manifest condiviso ha i modelli d\'ascolto con impronta e licenza', () => {
    const listening = VOICE_MODELS.filter((m) => m.role === 'vad' || m.role === 'stt');
    // 24/10/2026: Parakeet v3 per primo (97,2% di parole giuste contro 91,5% di whisper-small, misurato qui).
    expect(listening.map((m) => m.id)).toEqual(['silero-vad', 'parakeet-tdt-v3', 'whisper-small', 'whisper-base']);
    expect(listening.every((m) => /^[0-9a-f]{64}$/.test(m.sha256) && ['MIT', 'CC-BY-4.0'].includes(m.license) && m.size > 0)).toBe(true);
  });

  it('whisper-small è di riserva: si usa se c\'è ma non si scarica più (24/10/2026)', () => {
    const dir = tmp();
    expect(missingVoiceModels(dir, ['vad', 'stt']).map((m) => m.id)).toEqual(['silero-vad', 'parakeet-tdt-v3', 'whisper-base']);
    expect(VOICE_MODELS.find((m) => m.id === 'parakeet-tdt-v3')).toMatchObject({ kind: 'nemo-transducer', files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'] });
  });

  it('file semplice: scaricato, verificato, al suo posto; avanzamento fino a «fatto»; poi non manca più', async () => {
    const dir = tmp();
    expect(missingVoiceModels(dir, ['vad'], [plain]).map((m) => m.id)).toEqual(['vad-finto']);
    const phases: string[] = [];
    await installVoiceModel(plain, dir, { fetch: fetchOf(body).fetch, onProgress: (p) => phases.push(p) });
    expect(readFileSync(join(dir, 'vad', 'vad.onnx')).equals(body)).toBe(true);
    expect(phases.at(-1)).toBe('fatto');
    expect(phases).toContain('verifica');
    expect(missingVoiceModels(dir, ['vad'], [plain])).toEqual([]);
    expect(existsSync(join(dir, 'vad', 'vad.onnx.part'))).toBe(false);
  });

  it('dimensione o impronta sbagliate: errore chiaro e nessun file al posto del modello', async () => {
    const dir = tmp();
    await expect(installVoiceModel(plain, dir, { fetch: fetchOf(body.subarray(0, 100)).fetch })).rejects.toThrow(/scaricati 100 byte/);
    await expect(installVoiceModel(plain, dir, { fetch: fetchOf(Buffer.alloc(body.length, 1)).fetch })).rejects.toThrow(/impronta SHA-256 diversa/);
    await expect(installVoiceModel(plain, dir, { fetch: fetchOf(null, 404).fetch })).rejects.toThrow(/HTTP 404/);
    expect(existsSync(join(dir, 'vad', 'vad.onnx'))).toBe(false);
    expect(existsSync(join(dir, 'vad', 'vad.onnx.part'))).toBe(false);
  });

  it('archivio: estratto nella cartella, poi rimosso; file attesi assenti dopo l\'estrazione = errore', async () => {
    const dir = tmp();
    const extracted: string[] = [];
    await installVoiceModel(archived, dir, {
      fetch: fetchOf(body).fetch,
      extract: async (archive, into) => {
        extracted.push(archive);
        mkdirSync(join(into, 'stt'), { recursive: true });
        for (const f of archived.files) writeFileSync(join(into, 'stt', f), 'x');
        return 0;
      }
    });
    expect(extracted).toEqual([join(dir, 'stt.download')]);
    expect(existsSync(join(dir, 'stt.download'))).toBe(false);
    expect(missingVoiceModels(dir, ['stt'], [archived])).toEqual([]);
    const empty = tmp();
    await expect(installVoiceModel(archived, empty, { fetch: fetchOf(body).fetch, extract: async () => 0 })).rejects.toThrow(/mancano enc\.onnx, tok\.txt/);
    await expect(installVoiceModel(archived, tmp(), { fetch: fetchOf(body).fetch, extract: async () => 2 })).rejects.toThrow(/tar 2/);
  });

  it('Whisper: dall\'archivio solo i file che servono (VM beta.30, 23/10/2026)', async () => {
    expect(VOICE_MODELS.filter((m) => m.extractOnly).map((m) => m.id)).toEqual(['parakeet-tdt-v3', 'whisper-small', 'whisper-base']);
    const asked: Array<readonly string[] | null> = [];
    await installVoiceModel({ ...archived, extractOnly: true }, tmp(), {
      fetch: fetchOf(body).fetch,
      extract: async (_a, into, only) => {
        asked.push(only);
        mkdirSync(join(into, 'stt'), { recursive: true });
        for (const f of archived.files) writeFileSync(join(into, 'stt', f), 'x');
        return 0;
      }
    });
    expect(asked).toEqual([['enc.onnx', 'tok.txt']]);
  });

  it.skipIf(process.platform !== 'win32')('tar.exe di Windows: estrae solo i file elencati, scarta modelli a 32 bit e wav di prova', async () => {
    const src = tmp();
    mkdirSync(join(src, 'stt', 'test_wavs'), { recursive: true });
    for (const f of ['enc.onnx', 'enc.fp32.onnx', 'tok.txt', 'test_wavs/0.wav']) writeFileSync(join(src, 'stt', f), f);
    const packed = join(src, 'stt.tar.bz2');
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    expect(spawnSync(tar, ['-cjf', packed, '-C', src, 'stt']).status).toBe(0);
    const data = readFileSync(packed);
    const dir = tmp();
    await installVoiceModel({ ...archived, size: data.length, sha256: sha(data), extractOnly: true }, dir, { fetch: fetchOf(data).fetch });
    expect(readFileSync(join(dir, 'stt', 'enc.onnx'), 'utf8')).toBe('enc.onnx');
    expect(existsSync(join(dir, 'stt', 'tok.txt'))).toBe(true);
    expect(existsSync(join(dir, 'stt', 'enc.fp32.onnx'))).toBe(false);
    expect(existsSync(join(dir, 'stt', 'test_wavs'))).toBe(false);
  });

  it('archivio già scaricato da un tentativo precedente: riverificato senza riscaricarlo', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'stt.download'), body);
    const net = fetchOf(body);
    await installVoiceModel(archived, dir, {
      fetch: net.fetch,
      extract: async (_a, into) => {
        mkdirSync(join(into, 'stt'), { recursive: true });
        for (const f of archived.files) writeFileSync(join(into, 'stt', f), 'x');
        return 0;
      }
    });
    expect(net.calls).toEqual([]);
  });
});

describe('modelli d\'ascolto: comandi del core (P-105)', () => {
  const setup = (install: Parameters<typeof registerVoiceModelCommands>[0]['install'], models: VoiceModel[] = [plain]) => {
    const dir = tmp();
    const handlers = new Map<string, () => unknown>();
    const events: Array<{ type: string; payload: { phase: string; id: string; error: string | null } }> = [];
    let restarts = 0;
    registerVoiceModelCommands({
      router: { register: (t: string, h: () => unknown) => handlers.set(t, h) } as unknown as CommandRouter,
      events: { emit: (type: string, payload: { phase: string; id: string; error: string | null }) => events.push({ type, payload }) } as unknown as EventEmitter,
      modelsDir: dir,
      restart: () => { restarts++; },
      log: memoryLogger().log,
      ...(install ? { install } : {}),
      models
    });
    const call = (t: string) => handlers.get(t)!() as Record<string, unknown>;
    return { dir, call, events, restarts: () => restarts };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('stato, download in sottofondo con avanzamento, poi «completato» e voce riavviata; uno alla volta', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup(async (m, dir, deps) => {
      deps?.onProgress?.('download', 1, m.size);
      await gate;
      mkdirSync(join(dir, m.dir), { recursive: true });
      writeFileSync(join(dir, m.dir, m.files[0]!), 'x');
      deps?.onProgress?.('fatto', m.size, m.size);
    });
    expect(s.call('voice.models.status')).toMatchObject({ complete: false, downloading: false, missing: [{ id: 'vad-finto', license: 'MIT', size: plain.size }] });
    expect(s.call('voice.models.download')).toEqual({ started: true, alreadyComplete: false, totalBytes: plain.size });
    expect(s.call('voice.models.download')).toEqual({ started: false, alreadyComplete: false, totalBytes: plain.size });
    expect(s.call('voice.models.status')).toMatchObject({ downloading: true });
    release();
    await settle();
    expect(s.events.map((e) => e.payload.phase)).toEqual(['download', 'fatto', 'completato']);
    expect(s.events.every((e) => e.type === 'voice.models.progress')).toBe(true);
    expect(s.restarts()).toBe(1);
    expect(s.call('voice.models.status')).toMatchObject({ complete: true, downloading: false, missing: [] });
    expect(s.call('voice.models.download')).toEqual({ started: false, alreadyComplete: true, totalBytes: 0 });
  });

  it('download fallito: evento «errore» con il motivo, voce non riavviata, si può riprovare', async () => {
    const s = setup(async () => { throw new Error('vad-finto: download non riuscito (HTTP 503)'); });
    s.call('voice.models.download');
    await settle();
    expect(s.events.at(-1)?.payload).toMatchObject({ phase: 'errore', error: 'vad-finto: download non riuscito (HTTP 503)' });
    expect(s.restarts()).toBe(0);
    expect(s.call('voice.models.download')).toMatchObject({ started: true });
  });
});
