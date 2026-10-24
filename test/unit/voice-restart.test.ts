// Verifica della procedura guidata (collaudo in VM del 24/10/2026): su un PC lento la voce impiega più di un minuto a
// caricare i modelli d'ascolto e la prova diceva «il processo voce non è pronto». Ora aspetta che finisca di partire.
import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: { type: string; payload: unknown }) => void;

const stub = (status: string): { emit: (to: string) => void; listeners: () => number } => {
  const handlers = new Set<Handler>();
  vi.stubGlobal('window', {
    visione: {
      events: { subscribe: (h: Handler) => { handlers.add(h); return () => handlers.delete(h); } },
      voice: { status: async () => ({ ok: true, data: { status } }) }
    }
  });
  return {
    emit: (to) => { for (const h of [...handlers]) h({ type: 'voice.process.changed', payload: { to } }); },
    listeners: () => handlers.size
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('waitVoiceReady', () => {
  it('voce già pronta: vero subito, nessun ascolto lasciato aperto', async () => {
    const s = stub('ready');
    const { waitVoiceReady } = await import('../../src/renderer/app/voice-restart.ts');
    expect(await waitVoiceReady()).toBe(true);
    expect(s.listeners()).toBe(0);
  });

  it('voce guasta o spenta: falso subito, senza aspettare', async () => {
    const s = stub('failed');
    const { waitVoiceReady } = await import('../../src/renderer/app/voice-restart.ts');
    expect(await waitVoiceReady()).toBe(false);
    expect(s.listeners()).toBe(0);
  });

  it('voce in partenza: aspetta il «pronto»', async () => {
    const s = stub('starting');
    const { waitVoiceReady } = await import('../../src/renderer/app/voice-restart.ts');
    const p = waitVoiceReady();
    await Promise.resolve();
    s.emit('starting');
    s.emit('ready');
    expect(await p).toBe(true);
    expect(s.listeners()).toBe(0);
  });

  it('voce in partenza che non arriva: falso allo scadere', async () => {
    vi.useFakeTimers();
    const s = stub('starting');
    const { waitVoiceReady } = await import('../../src/renderer/app/voice-restart.ts');
    const p = waitVoiceReady(1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await p).toBe(false);
    expect(s.listeners()).toBe(0);
  });
});
