// Il tasto della modalità offline (17/10/2026, dal collaudo): premuto mentre il core parte (o si riavvia)
// riceveva `core_unavailable` e il clic veniva ignorato in silenzio. Ora riprova e, se non basta, lo dice.
import { afterEach, describe, expect, it, vi } from 'vitest';

type Res = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } };

const stubSet = (answers: Res[]): { calls: boolean[] } => {
  const calls: boolean[] = [];
  vi.stubGlobal('window', {
    visione: { offline: { set: async (active: boolean): Promise<Res> => { calls.push(active); return answers.length > 1 ? answers.shift()! : answers[0]!; } } }
  });
  return { calls };
};
const down: Res = { ok: false, error: { code: 'core_unavailable', message: 'core non disponibile', retryable: true } };
const state = { network: 'online', active: true, manual: true, auto: true, model: { status: 'idle', name: 'x', license: 'x', sizeBytes: 1, received: 0, error: null }, ramOk: true, since: 1 };

afterEach(() => vi.unstubAllGlobals());

describe('tasto offline', () => {
  it('core non ancora pronto: riprova e poi entra (lo stato si aggiorna)', async () => {
    const { calls } = stubSet([down, down, { ok: true, data: state }]);
    const { setOffline, offlineState } = await import('../../src/renderer/app/offline-store.ts');
    expect(await setOffline(true, async () => {})).toBeNull();
    expect(calls).toEqual([true, true, true]);
    expect(offlineState()?.active).toBe(true);
  });

  it('core giù troppo a lungo, o un altro errore: restituisce l\'errore invece di tacere', async () => {
    const { setOffline } = await import('../../src/renderer/app/offline-store.ts');
    const a = stubSet([down]);
    expect((await setOffline(true, async () => {}))?.code).toBe('core_unavailable');
    expect(a.calls.length).toBe(17);
    const b = stubSet([{ ok: false, error: { code: 'invalid_input', message: 'no', retryable: false } }]);
    expect((await setOffline(false, async () => {}))?.code).toBe('invalid_input');
    expect(b.calls).toEqual([false]);
  });
});
