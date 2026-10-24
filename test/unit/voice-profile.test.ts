// Profilo della voce (16/10/2026): la prova del PC misura la voce VISIONE e VISIONE consiglia uno dei tre
// profili (Completa, Leggera, Minima), che il proprietario può cambiare. Qui le tre parti senza audio:
// il consiglio, la risposta del processo voce e l'attesa nel core.
import { describe, expect, it } from 'vitest';
import type { CoreToVoice, VoiceToCore } from '../../src/shared/contracts/index.ts';
import { DEFAULT_CONFIG } from '../../src/shared/node/config.ts';
import type { ApprovalQueue } from '../../src/core/approvals/index.ts';
import type { EventBus } from '../../src/core/bus/index.ts';
import { CommandFailure } from '../../src/core/commands/index.ts';
import type { Director } from '../../src/core/director/index.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { createVoiceController } from '../../src/core/voice/index.ts';
import type { AdapterSetupItem } from '../../src/core/adapters/index.ts';
import { systemSetupItems } from '../../src/core/setup/system.ts';
import { FULL_MAX_RTF, LIGHT_MAX_RTF, recommendProfile } from '../../src/core/voice/profile.ts';
import { createVoiceService, type BenchmarkResult } from '../../src/voice/service.ts';
import { bestOf } from '../../src/voice/benchmark.ts';
import { profileAvailable, profileOf, profilePatch, speedTimes, VOICE_PROFILES } from '../../src/renderer/app/voice-profile.ts';
import { memoryLogger } from '../helpers.ts';

describe('recommendProfile', () => {
  it('PC veloce → Completa; al limite → Leggera; lento → Minima', () => {
    expect(recommendProfile(0.45, 'it')).toBe('full');
    expect(recommendProfile(FULL_MAX_RTF, 'it')).toBe('full');
    expect(recommendProfile(0.9, 'it')).toBe('light');
    expect(recommendProfile(LIGHT_MAX_RTF, 'it')).toBe('light');
    expect(recommendProfile(1.5, 'it')).toBe('minimal');
  });

  it('senza misura si resta prudenti (Leggera); in inglese la voce VISIONE non c\'è', () => {
    expect(recommendProfile(null, 'it')).toBe('light');
    expect(recommendProfile(0.3, 'en')).toBe('light');
    expect(recommendProfile(1.5, 'en')).toBe('minimal');
  });
});

/** Il processo voce con una prova finta: si risolve a mano. */
function service(benchmark?: () => Promise<BenchmarkResult>) {
  const toCore: VoiceToCore[] = [];
  const svc = createVoiceService({
    toCore: (m) => { toCore.push(m); },
    createEngines: () => Promise.reject(new Error('non serve')),
    newId: () => 'id',
    log: () => undefined,
    exit: () => undefined,
    ...(benchmark ? { benchmark } : {})
  });
  const ask = (): void => svc.handle({ kind: 'core', msg: { type: 'benchmark' } });
  return { toCore, ask };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('prova del PC nel processo voce', () => {
  it('risponde con la misura anche senza motori avviati (la prova non usa l\'ascolto)', async () => {
    const { toCore, ask } = service(() => Promise.resolve({ rtf: 0.52, audioS: 5.4, spentMs: 2_808.4, reason: null }));
    ask();
    await flush();
    expect(toCore).toEqual([{ type: 'benchmark', rtf: 0.52, audioS: 5.4, spentMs: 2_808, reason: null }]);
  });

  it('un errore della prova diventa un motivo, non un silenzio', async () => {
    const { toCore, ask } = service(() => Promise.reject(new Error('modello rotto')));
    ask();
    await flush();
    expect(toCore).toEqual([{ type: 'benchmark', rtf: null, audioS: 0, spentMs: 0, reason: 'modello rotto' }]);
  });

  it('senza prova nel processo: risposta immediata «non disponibile»', async () => {
    const { toCore, ask } = service();
    ask();
    await flush();
    expect(toCore).toEqual([{ type: 'benchmark', rtf: null, audioS: 0, spentMs: 0, reason: 'prova non disponibile' }]);
  });

  it('una prova alla volta: due insieme si rallenterebbero e la misura sarebbe falsa', async () => {
    let finish!: (r: BenchmarkResult) => void;
    let runs = 0;
    const { toCore, ask } = service(() => { runs++; return new Promise((r) => { finish = r; }); });
    ask();
    ask();
    await flush();
    expect(runs).toBe(1);
    expect(toCore).toEqual([{ type: 'benchmark', rtf: null, audioS: 0, spentMs: 0, reason: 'prova già in corso' }]);
    finish({ rtf: 0.8, audioS: 5, spentMs: 4_000, reason: null });
    await flush();
    expect(toCore.at(-1)).toEqual({ type: 'benchmark', rtf: 0.8, audioS: 5, spentMs: 4_000, reason: null });
    ask();
    await flush();
    expect(runs).toBe(2);
  });

  it('valori fuori misura vengono riportati nei limiti del contratto', async () => {
    const { toCore, ask } = service(() => Promise.resolve({ rtf: 250, audioS: 5, spentMs: -3, reason: 'x'.repeat(400) }));
    ask();
    await flush();
    const r = toCore[0] as Extract<VoiceToCore, { type: 'benchmark' }>;
    expect(r.rtf).toBe(100);
    expect(r.spentMs).toBe(0);
    expect(r.reason).toHaveLength(300);
  });
});

/** Il controller della voce con timer a mano. */
function controller(language: 'it' | 'en' = 'it', systemItems: () => AdapterSetupItem[] = () => []) {
  const sent: CoreToVoice[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const voice = createVoiceController({
    events: { emit: () => undefined } as unknown as EventEmitter,
    bus: { on: () => ({ unsubscribe: () => undefined, active: true, dropped: 0 }) } as unknown as EventBus,
    approvals: { list: () => [] } as unknown as ApprovalQueue,
    director: {} as unknown as Director,
    config: { ...DEFAULT_CONFIG.voice, announceStartup: false },
    log: memoryLogger().log,
    send: (m) => { sent.push(m); },
    newId: () => 'u1',
    language: () => language,
    systemItems,
    timers: {
      set: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clear: (h) => { (h as { cleared: boolean }).cleared = true; }
    }
  });
  const alive = (): void => voice.handle({ type: 'process', phase: 'starting', pid: 42, code: null, reason: '' });
  return { voice, sent, timers, alive };
}

describe('prova del PC nel core (voice.benchmark)', () => {
  it('chiede la prova al processo voce e consiglia il profilo dalla misura', async () => {
    const { voice, sent, timers, alive } = controller();
    alive();
    const pending = voice.benchmark();
    expect(sent).toContainEqual({ type: 'benchmark' });
    voice.handle({ type: 'benchmark', rtf: 0.9, audioS: 5.2, spentMs: 4_680, reason: null });
    await expect(pending).resolves.toEqual({ rtf: 0.9, audioS: 5.2, spentMs: 4_680, reason: null, recommended: 'light', runtime: null });
    expect(timers[0]!.cleared).toBe(true);
  });

  it('il consiglio segue la lingua: in inglese al massimo Leggera', async () => {
    const { voice, alive } = controller('en');
    alive();
    const pending = voice.benchmark();
    voice.handle({ type: 'benchmark', rtf: 0.4, audioS: 5, spentMs: 2_000, reason: null });
    await expect(pending).resolves.toMatchObject({ recommended: 'light' });
  });

  it('runtime di Visual C++ mancante (PC vergine, 18/10/2026): il motivo è quello, con «Installa» per la guidata', async () => {
    const { voice, alive } = controller('it', () => systemSetupItems(['msvcp140.dll']));
    alive();
    const pending = voice.benchmark();
    voice.handle({ type: 'benchmark', rtf: null, audioS: 0, spentMs: 0, reason: 'onnxruntime-node non caricato' });
    const res = await pending;
    expect(res).toMatchObject({ rtf: null, recommended: 'light', runtime: { id: 'runtime-vc', action: { kind: 'install', admin: true } } });
    expect(res.reason).toContain('componente gratuito di Microsoft');
    expect(res.reason).not.toContain('.dll');
    expect(JSON.stringify(res.runtime)).not.toContain('winget install --id Microsoft.VCRedist.2015+.x64 -e --source'); // lo script resta nel core
  });

  it('chi la chiede di nuovo aspetta la stessa prova (un solo ordine al processo)', async () => {
    const { voice, sent, alive } = controller();
    alive();
    const a = voice.benchmark();
    const b = voice.benchmark();
    expect(b).toBe(a);
    expect(sent.filter((m) => m.type === 'benchmark')).toHaveLength(1);
    voice.handle({ type: 'benchmark', rtf: null, audioS: 0, spentMs: 0, reason: 'file della voce mancanti' });
    await expect(a).resolves.toMatchObject({ rtf: null, recommended: 'light', reason: 'file della voce mancanti' });
  });

  it('processo voce spento: errore subito, nessun ordine', async () => {
    const { voice, sent } = controller();
    await expect(voice.benchmark()).rejects.toThrow('il processo voce non è attivo');
    expect(sent).toHaveLength(0);
  });

  it('nessuna risposta: un motivo chiaro prima del limite del comando (90 s)', async () => {
    const { voice, timers, alive } = controller();
    alive();
    const pending = voice.benchmark();
    expect(timers[0]!.ms).toBeLessThan(90_000);
    timers[0]!.fn();
    await expect(pending).rejects.toThrow('la prova del PC non ha risposto entro 85 s');
    // Una risposta tardiva non fa danni, e la prova si può ripetere.
    voice.handle({ type: 'benchmark', rtf: 0.5, audioS: 5, spentMs: 2_500, reason: null });
    const again = voice.benchmark();
    voice.handle({ type: 'benchmark', rtf: 0.5, audioS: 5, spentMs: 2_500, reason: null });
    await expect(again).resolves.toMatchObject({ recommended: 'full' });
  });

  it('il processo voce esce durante la prova: errore, non un\'attesa di 85 s', async () => {
    const { voice, alive } = controller();
    alive();
    const pending = voice.benchmark();
    voice.handle({ type: 'process', phase: 'exited', pid: null, code: 1, reason: '' });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandFailure);
    expect((err as CommandFailure).message).toBe('il processo voce è uscito durante la prova');
  });
});

describe('profili nel renderer (corrispondenza con la configurazione)', () => {
  const cfg = (provider: string | undefined, wake: boolean | undefined): Record<string, unknown> => ({ voice: { tts: provider === undefined ? {} : { provider }, wake: wake === undefined ? {} : { enabled: wake } } });

  it('riconosce i tre profili; il resto è «personalizzato»', () => {
    expect(profileOf(cfg('visione', true))).toBe('full');
    expect(profileOf(cfg('windows', true))).toBe('light');
    expect(profileOf(cfg('windows', false))).toBe('minimal');
    expect(profileOf(cfg('visione', false))).toBe('custom');
    expect(profileOf(cfg('edge', true))).toBe('custom');
    // Valori assenti = predefiniti (voce VISIONE, «hey visione» spenta): personalizzato, non un profilo inventato.
    expect(profileOf({})).toBe('custom');
  });

  it('ogni profilo scritto si rilegge uguale', () => {
    for (const p of VOICE_PROFILES) expect(profileOf(profilePatch(p, 'Microsoft Elsa'))).toBe(p);
  });

  it('la voce di Windows si scrive solo per i profili che la usano', () => {
    expect(profilePatch('full', 'Microsoft Elsa')).toEqual({ voice: { tts: { provider: 'visione' }, wake: { enabled: true } } });
    expect(profilePatch('light', 'Microsoft Elsa')).toEqual({ voice: { tts: { provider: 'windows', voice: 'Microsoft Elsa' }, wake: { enabled: true } } });
    expect(profilePatch('minimal', null)).toEqual({ voice: { tts: { provider: 'windows' }, wake: { enabled: false } } });
  });

  it('Completa solo in italiano', () => {
    expect(profileAvailable('full', 'it')).toBe(true);
    expect(profileAvailable('full', 'en')).toBe(false);
    expect(profileAvailable('light', 'en')).toBe(true);
  });

  it('la prova in parole: «2 volte più in fretta», con la virgola in italiano; null se è lento', () => {
    expect(speedTimes(0.5, 'it')).toBe('2');
    expect(speedTimes(0.4, 'it')).toBe('2,5');
    expect(speedTimes(0.4, 'en')).toBe('2.5');
    expect(speedTimes(0.05, 'it')).toBe('20');
    expect(speedTimes(1, 'it')).toBeNull();
    expect(speedTimes(1.4, 'it')).toBeNull();
    expect(speedTimes(0, 'it')).toBeNull();
  });
});

describe('bestOf: la migliore di più misure (16/10/2026)', () => {
  const clock = (): { now: () => number; advance: (ms: number) => void } => {
    let t = 0;
    return { now: () => t, advance: (ms) => { t += ms; } };
  };

  it('tiene la misura più veloce: un disturbo all\'inizio non decide il profilo', async () => {
    // Come nella procedura guidata: la prima misura cade mentre partono gli agenti.
    const runs = [{ audioS: 5, spentMs: 7_100 }, { audioS: 5.2, spentMs: 3_300 }, { audioS: 5, spentMs: 3_000 }];
    const c = clock();
    const r = await bestOf(async () => { const x = runs.shift()!; c.advance(x.spentMs); return x; }, { runs: 3, budgetMs: 40_000, now: c.now });
    expect(r.best).toEqual({ audioS: 5, spentMs: 3_000 });
    expect(r.rtfs.map((x) => Number(x.toFixed(2)))).toEqual([1.42, 0.63, 0.6]);
    expect(recommendProfile(r.best!.spentMs / 1000 / r.best!.audioS, 'it')).toBe('full');
  });

  it('su un PC lento non comincia altre misure oltre il tempo concesso', async () => {
    const c = clock();
    let n = 0;
    const r = await bestOf(async () => { n++; c.advance(25_000); return { audioS: 5, spentMs: 25_000 }; }, { runs: 3, budgetMs: 40_000, now: c.now });
    expect(n).toBe(2);
    expect(r.rtfs).toEqual([5, 5]);
  });

  it('misure senza audio non contano; nessuna valida → null', async () => {
    const c = clock();
    const none = await bestOf(async () => null, { runs: 3, budgetMs: 40_000, now: c.now });
    expect(none).toEqual({ best: null, rtfs: [] });
    const runs = [{ audioS: 0, spentMs: 100 }, { audioS: 4, spentMs: 2_000 }];
    const some = await bestOf(async () => runs.shift() ?? null, { runs: 3, budgetMs: 40_000, now: c.now });
    expect(some.best).toEqual({ audioS: 4, spentMs: 2_000 });
  });
});
