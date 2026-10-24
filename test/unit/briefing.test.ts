// Saluto di stato all'avvio (11/10/2026): composizione dai fatti reali e uso da parte della voce.
import { describe, expect, it } from 'vitest';
import { composeBriefing, listIt, type BriefingFacts } from '../../src/core/assistant/briefing.ts';
import type { ApprovalQueue } from '../../src/core/approvals/index.ts';
import type { Director } from '../../src/core/director/index.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { createVoiceController } from '../../src/core/voice/index.ts';
import type { CoreToVoice } from '../../src/shared/contracts/index.ts';
import { DEFAULT_CONFIG } from '../../src/shared/node/config.ts';
import { memoryLogger } from '../helpers.ts';

const base: BriefingFacts = {
  greeting: 'Bentornato, signore', pc: { cpuPercent: 12.4, ramPercent: 47.6 }, engines: [{ name: 'Claude', ok: true }, { name: 'OpenCode', ok: true }],
  unclean: false, unfinished: [], approvals: 0, agentsInError: [], agenda: null
};

describe('composeBriefing', () => {
  it('tutto a posto: benvenuto, PC, motori, nessun lavoro in sospeso', () => {
    expect(composeBriefing(base)).toBe('Bentornato, signore. Il PC sta bene: processore al 12 per cento e memoria al 48 per cento. Ho verificato i motori: Claude e OpenCode sono pronti. Nessun lavoro in sospeso.');
  });

  it('problemi veri: sessione chiusa male, motore muto, agente in errore, lavori, approvazioni, agenda', () => {
    const text = composeBriefing({
      ...base, greeting: 'Bentornato, signore.', pc: { cpuPercent: 91, ramPercent: null }, unclean: true,
      engines: [{ name: 'Claude', ok: true }, { name: 'OpenCode', ok: false, detail: 'Ollama non risponde su questo PC' }, { name: 'Codex', ok: null }], agentsInError: ['Esecutore'],
      unfinished: ['Sistemare il login', 'Scrivere i test', 'Preparare il rilascio'], approvals: 2,
      agenda: 'Oggi hai un impegno: alle 15:00 il dentista.'
    });
    expect(text).toBe([
      'Bentornato, signore.',
      "L'ultima sessione si è chiusa male: ho recuperato lo stato.",
      'Il PC è sotto sforzo: processore al 91 per cento.',
      'Ho verificato il motore: Claude è pronto.',
      'Attenzione: OpenCode non è pronto: Ollama non risponde su questo PC.',
      'Non ho fatto in tempo a verificare Codex.',
      "L'agente Esecutore è in errore.",
      'Ci sono 3 lavori da terminare: «Sistemare il login», «Scrivere i test» e altri.',
      '2 approvazioni aspettano la tua decisione.',
      'Oggi hai un impegno: alle 15:00 il dentista.'
    ].join(' '));
  });

  it('in inglese: stesse regole, frasi inglesi (P-108)', () => {
    expect(composeBriefing({ ...base, greeting: 'Welcome back', engines: [{ name: 'Claude', ok: true }, { name: 'OpenCode', ok: null }], unfinished: ['Fix the login'], approvals: 1 }, 'en')).toBe(
      'Welcome back. The PC is fine: processor at 12 percent and memory at 48 percent. I checked the engine: Claude is ready. I could not finish checking OpenCode in time. There is one job to finish: “Fix the login”. One approval is waiting for your decision.'
    );
    expect(listIt(['a', 'b', 'c'], 'en')).toBe('a, b and c');
  });

  it('i fatti che mancano non si dicono (telemetria spenta, motori non verificati in tempo)', () => {
    expect(composeBriefing({ ...base, pc: null, engines: [], unfinished: ['Uno'] })).toBe("Bentornato, signore. C'è un lavoro da terminare: «Uno».");
    expect(listIt(['a', 'b', 'c'])).toBe('a, b e c');
  });
});

describe('voce: saluto di stato al primo «pronta»', () => {
  function make(briefingOn: boolean, briefing?: (g: string) => Promise<string>) {
    const sent: CoreToVoice[] = [];
    const voice = createVoiceController({
      events: { emit: () => {} } as unknown as EventEmitter,
      bus: { on: () => ({ unsubscribe: () => true, active: true, dropped: 0 }) } as never,
      approvals: { list: () => [] } as unknown as ApprovalQueue,
      director: {} as Director,
      ...(briefing ? { briefing } : {}),
      config: { ...DEFAULT_CONFIG.voice, announceStartup: true, startupPhrase: 'Bentornato, signore.', startupBriefing: briefingOn },
      log: memoryLogger().log,
      send: (m) => { sent.push(m); },
      newId: () => 'id'
    });
    voice.handle({ type: 'ready', voices: [], filters: { denoise: false, speaker: false, owner: false, ownerOnly: false, noiseGate: 0.004 }, engines: { vad: 'v', stt: 's', tts: 't' }, loadMs: 1 });
    return () => sent.flatMap((m) => (m.type === 'speak' ? [m.text] : []));
  }

  it('con il saluto di stato: il saluto subito, le notizie dopo il saluto (24/10/2026, prova in voice-core)', async () => {
    const spoken = make(true, async (g) => `${g} Il PC sta bene.`);
    await new Promise((r) => setTimeout(r, 0));
    expect(spoken()).toEqual(['Bentornato, signore.']);
  });

  it('se la raccolta fallisce resta la frase di benvenuto; spento dice solo la frase', async () => {
    const failing = make(true, async () => { throw new Error('guasto'); });
    await new Promise((r) => setTimeout(r, 0));
    expect(failing()).toEqual(['Bentornato, signore.']);
    expect(make(false, async () => 'mai')()).toEqual(['Bentornato, signore.']);
  });
});
