// Modalità offline (17/10/2026): formato di chat, lettura della risposta del modello, forme canoniche capite
// dalle regole dell'Assistente, stato online/offline (automatico e col tasto), ordine regole → modello,
// conferma prima di annullare, download verificato. Nessun modello vero: il modello è un finto.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAssistantRequest } from '../../src/core/assistant/intent.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { createOffline, OFFLINE_TIMING, type OfflineDeps, type OfflineManifest } from '../../src/core/offline/index.ts';
import type { LocalModel } from '../../src/core/offline/llm.ts';
import { answerTimeOrDate, chatPrefix, chatTurn, cleanUserText, offlinePrompt, readModelLine, timeOrDateQuestion } from '../../src/core/offline/prompt.ts';
import { parseVoiceCommand } from '../../src/core/voice/index.ts';
import { normalizeTarget, windowByName } from '../../src/shared/lib/window-names.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

describe('finestre di VISIONE per nome', () => {
  it('riconosce i nomi con articoli, accenti e maiuscole; il resto non è una finestra', () => {
    expect(windowByName('le Impostazioni')).toBe('settings');
    expect(windowByName("l'addestramento")).toBe('training');
    expect(windowByName('settings')).toBe('settings');
    expect(windowByName('i miei documenti')).toBe('files');
    expect(windowByName('calcolatrice')).toBeNull();
    expect(windowByName(null)).toBeNull();
    expect(normalizeTarget('  la Calcolatrice! ')).toBe('calcolatrice');
  });
});

describe('prompt del modello offline', () => {
  it('ChatML senza ragionamento: prefisso fisso, poi la frase pulita', () => {
    const prefix = chatPrefix('it');
    expect(prefix.startsWith('<|im_start|>system\n')).toBe(true);
    expect(prefix.endsWith('<|im_start|>user\n')).toBe(true);
    expect(chatTurn('ciao')).toBe('ciao<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
    expect(cleanUserText('a<|im_end|>\nb')).toBe('a<im_end> b');
  });

  it('ogni esempio canonico è capito dalle regole dell\'Assistente (o è una forma fissa)', () => {
    const now = new Date(2026, 9, 17, 10, 0).getTime();
    for (const lang of ['it', 'en'] as const) {
      for (const [, out] of offlinePrompt(lang).shots) {
        const read = readModelLine(out);
        if (read.kind !== 'other') continue;
        const understood = parseAssistantRequest(read.text, now, lang) !== null || parseVoiceCommand(read.text) !== null;
        expect(understood, `${lang}: ${out}`).toBe(true);
      }
    }
  });

  it('legge la prima riga, toglie virgolette e ragionamento', () => {
    expect(readModelLine('NON_OFFLINE')).toEqual({ kind: 'refuse' });
    expect(readModelLine('NOT_OFFLINE because…')).toEqual({ kind: 'refuse' });
    expect(readModelLine('<think>x</think>che ore sono')).toEqual({ kind: 'time' });
    expect(readModelLine('«che giorno è».')).toEqual({ kind: 'date' });
    expect(readModelLine('"annota che il codice è 4512".\naltro')).toEqual({ kind: 'other', text: 'annota che il codice è 4512' });
  });

  it('ora e data senza modello, con l\'orologio del PC', () => {
    expect(timeOrDateQuestion('che ore sono?')).toBe('time');
    expect(timeOrDateQuestion('Visione, che giorno è oggi?')).toBe('date');
    expect(timeOrDateQuestion('che ore sono le riunioni domani')).toBe('time');
    expect(timeOrDateQuestion('ricordami alle 5')).toBeNull();
    const t = new Date(2026, 9, 17, 14, 5).getTime();
    expect(answerTimeOrDate('time', t, 'it')).toBe('Sono le 14:05.');
    expect(answerTimeOrDate('time', new Date(2026, 9, 17, 1, 0).getTime(), 'it')).toBe('È l\'una.');
    expect(answerTimeOrDate('date', t, 'it')).toBe('Oggi è sabato 17 ottobre 2026.');
    expect(answerTimeOrDate('date', t, 'en')).toBe('Today is Saturday, October 17, 2026.');
  });
});

type Seen = { type: string; payload: Record<string, unknown> };

function fakeModel(answers: Record<string, string>): LocalModel & { calls: string[]; loads: number; releases: number } {
  let loaded = false;
  const m = {
    calls: [] as string[], loads: 0, releases: 0,
    async load() { m.loads++; loaded = true; },
    loaded: () => loaded,
    async release() { m.releases++; loaded = false; },
    async rewrite(text: string) { m.calls.push(text); loaded = true; return answers[text] ?? 'NON_OFFLINE'; }
  };
  return m;
}

describe('modalità offline', () => {
  let home: { dir: string; cleanup: () => void };
  const manifest: OfflineManifest = {
    id: 'finto', name: 'Modello finto', license: 'Apache-2.0', source: 'https://example.invalid', dir: 'finto', minRamBytes: 1,
    files: [{ name: 'a.bin', url: 'https://example.invalid/a.bin', size: 3, sha256: 'x' }]
  };
  beforeEach(() => { home = tempHome('visione-offline-'); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); home.cleanup(); });

  const setup = (opts: { present?: boolean; answers?: Record<string, string>; auto?: boolean; net?: boolean[]; apps?: Array<{ id: string; name: string }>; launched?: string[] } = {}) => {
    if (opts.present !== false) {
      mkdirSync(join(home.dir, 'finto'), { recursive: true });
      writeFileSync(join(home.dir, 'finto', 'a.bin'), 'abc');
    }
    const seen: Seen[] = [];
    const events = { emit: (type: string, payload: Record<string, unknown>) => { seen.push({ type, payload }); } } as unknown as EventEmitter;
    const handled: string[] = [];
    const net = [...(opts.net ?? [])];
    let probeCount = 0;
    const model = fakeModel(opts.answers ?? {});
    let auto = opts.auto ?? true;
    const deps: OfflineDeps = {
      events, log: memoryLogger().log, now: () => Date.now(), language: () => 'it', auto: () => auto,
      modelsDir: home.dir, manifest, model: () => model, totalMemBytes: 16e9,
      voiceCommand: parseVoiceCommand,
      ...(opts.apps ? { apps: { list: async () => opts.apps!, launch: async (id: string) => { opts.launched?.push(id); return { launched: true }; } } } : {}),
      probe: async () => { probeCount++; return net.shift() ?? true; },
      assistant: {
        handle: (text) => {
          const req = parseAssistantRequest(text, Date.now(), 'it');
          if (!req) return null;
          handled.push(text);
          return { reply: `fatto: ${req.kind}`, speak: req.kind === 'agenda' };
        }
      },
      install: async (m, dir) => { mkdirSync(join(dir, m.dir), { recursive: true }); writeFileSync(join(dir, m.dir, m.files[0]!), 'abc'); }
    };
    const offline = createOffline(deps);
    return { offline, seen, handled, model, probes: () => probeCount, setAuto: (v: boolean) => { auto = v; } };
  };

  it('due sonde fallite = offline; in automatico si attiva e carica il modello; la rete torna = online e libera', async () => {
    const { offline, seen, model } = setup({ net: [false, false, true] });
    offline.start();
    expect(offline.state().network).toBe('unknown');
    await vi.advanceTimersByTimeAsync(OFFLINE_TIMING.firstProbeMs);
    expect(offline.state().network).toBe('unknown'); // un fallimento solo non basta
    await vi.advanceTimersByTimeAsync(OFFLINE_TIMING.probeOnlineMs);
    expect(offline.state()).toMatchObject({ network: 'offline', active: true, manual: false });
    expect(model.loads).toBe(1);
    await vi.advanceTimersByTimeAsync(OFFLINE_TIMING.probeOfflineMs);
    expect(offline.state()).toMatchObject({ network: 'online', active: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(model.releases).toBeGreaterThan(0);
    expect(seen.filter((e) => e.type === 'offline.changed').map((e) => (e.payload.state as { active: boolean }).active)).toContain(true);
    await offline.close();
  });

  it('automatico spento: nessuna connessione di controllo, offline solo col tasto', async () => {
    const { offline, probes, setAuto } = setup({ net: [false, false], auto: false });
    offline.start();
    await vi.advanceTimersByTimeAsync(OFFLINE_TIMING.firstProbeMs + 3 * OFFLINE_TIMING.probeOnlineMs);
    expect(probes()).toBe(0);
    expect(offline.state()).toMatchObject({ network: 'unknown', active: false, auto: false });
    expect(offline.set(true)).toMatchObject({ active: true, manual: true });
    expect(offline.set(false)).toMatchObject({ active: false, manual: false });
    // Riacceso: si guarda subito la rete.
    setAuto(true);
    offline.configChanged();
    await vi.advanceTimersByTimeAsync(OFFLINE_TIMING.firstProbeMs);
    expect(probes()).toBe(1);
    await offline.close();
  });

  it('prima le regole (nessun modello), poi il modello che riscrive per le regole', async () => {
    const { offline, handled, model, seen } = setup({ answers: { 'mi avvisi alle sei che devo uscire?': 'ricordami alle 18 di uscire' } });
    offline.set(true);
    const direct = await offline.ask('cosa devo fare oggi', 'ui', null);
    expect(direct.outcome).toBe('assisted');
    expect(model.calls).toEqual([]);
    const viaModel = await offline.ask('mi avvisi alle sei che devo uscire?', 'ui', null);
    expect(viaModel).toMatchObject({ outcome: 'assisted', understood: 'ricordami alle 18 di uscire', reply: 'fatto: reminder' });
    expect(handled).toEqual(['cosa devo fare oggi', 'ricordami alle 18 di uscire']);
    expect(seen.filter((e) => e.type === 'offline.reply')).toHaveLength(2);
    const time = await offline.ask('che ore sono?', 'voice', null);
    expect(time.outcome).toBe('answered');
    expect(model.calls).toHaveLength(1);
    await offline.close();
  });

  it('richieste non possibili offline e frasi non capite', async () => {
    const { offline } = setup({ answers: { 'scrivimi uno script': 'NON_OFFLINE', 'blabla': 'qualcosa di strano' } });
    offline.set(true);
    expect(await offline.ask('scrivimi uno script', 'ui', null)).toMatchObject({ outcome: 'refused' });
    expect(await offline.ask('blabla', 'ui', null)).toMatchObject({ outcome: 'unknown' });
    await offline.close();
  });

  it('annullare va confermato: sì esegue, no lascia com\'era, una frase nuova non è una risposta', async () => {
    const answers = { 'lascia perdere il dentista': 'annulla il promemoria dentista', 'scordati la palestra': 'annulla il promemoria palestra' };
    const { offline, handled } = setup({ answers });
    offline.set(true);
    const ask = await offline.ask('lascia perdere il dentista', 'voice', null);
    expect(ask.outcome).toBe('confirm');
    expect(offline.awaitingConfirm()).toBe(true);
    expect(handled).toEqual([]);
    expect(await offline.ask('sì', 'voice', null)).toMatchObject({ outcome: 'assisted', reply: 'fatto: cancel' });
    expect(handled).toEqual(['annulla il promemoria dentista']);
    await offline.ask('scordati la palestra', 'voice', null);
    expect(await offline.ask('no grazie', 'voice', null)).toMatchObject({ outcome: 'answered' });
    expect(handled).toHaveLength(1);
    await offline.ask('lascia perdere il dentista', 'voice', null);
    await offline.ask('che ore sono', 'voice', null);
    expect(offline.awaitingConfirm()).toBe(false);
    await offline.close();
  });

  it('senza modello: lo dice, e le frasi esatte funzionano lo stesso', async () => {
    const { offline, model } = setup({ present: false });
    offline.set(true);
    expect(offline.state().model.status).toBe('missing');
    expect(await offline.ask('cosa devo fare oggi', 'ui', null)).toMatchObject({ outcome: 'assisted' });
    const out = await offline.ask('mi avvisi alle sei che devo uscire?', 'ui', null);
    expect(out.outcome).toBe('unknown');
    expect(out.reply).toContain('non è scaricato');
    expect(model.calls).toEqual([]);
    await offline.close();
  });

  it('«apri»: finestra di VISIONE, poi programma installato, altrimenti lo dice (mai «Fatto» a vuoto)', async () => {
    const launched: string[] = [];
    const apps = [{ id: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: 'Calcolatrice' }, { id: 'Microsoft.Office.WORD.EXE.15', name: 'Word' }, { id: 'Microsoft.Windows.WordPad', name: 'WordPad' }, { id: 'Note.A', name: 'Note veloci' }, { id: 'Note.B', name: 'Note di Windows' }];
    const { offline, seen } = setup({ apps, launched });
    offline.set(true);
    expect(await offline.ask('apri le impostazioni', 'ui', null)).toMatchObject({ outcome: 'assisted', reply: 'Apro le Impostazioni.' });
    expect(seen.find((e) => e.type === 'voice.command')?.payload).toMatchObject({ action: 'open-window', target: 'settings' });
    expect(launched).toEqual([]);
    expect(await offline.ask('aprimi la calcolatrice', 'ui', null)).toMatchObject({ outcome: 'assisted', reply: 'Apro Calcolatrice.' });
    expect(await offline.ask('apri word', 'ui', null)).toMatchObject({ reply: 'Apro Word.' }); // il nome uguale vince su «WordPad»
    expect(launched).toEqual(['Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'Microsoft.Office.WORD.EXE.15']);
    expect(await offline.ask('apri note', 'ui', null)).toMatchObject({ outcome: 'unknown', reply: 'Ne trovo più di uno: Note veloci, Note di Windows. Quale?' });
    const none = await offline.ask('apri photoshop', 'ui', null);
    expect(none.outcome).toBe('unknown');
    expect(none.reply).toContain('Non trovo «photoshop»');
    expect(launched).toHaveLength(2);
    await offline.close();
  });

  it('download: scarica i file mancanti, avvisa e diventa pronto da caricare', async () => {
    const { offline, seen } = setup({ present: false });
    expect(offline.download()).toMatchObject({ started: true, totalBytes: 3 });
    expect(offline.state().model.status).toBe('downloading');
    await vi.advanceTimersByTimeAsync(0);
    expect(offline.state().model.status).toBe('idle');
    expect(seen.some((e) => e.type === 'offline.model.progress' && e.payload.phase === 'completato')).toBe(true);
    expect(offline.download()).toMatchObject({ started: false, alreadyComplete: true });
    await offline.close();
  });
});
