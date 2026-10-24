// Fase 22 (P-69) — comandi vocali di ambiente: riconoscimento nel core (regole locali, nessun
// modello) e risoluzione nel renderer col contesto REALE della UI (selezione, agenti noti, finestre
// aperte). Nessun comando inventato: se non c'è un bersaglio valido si risponde a voce, non si agisce.
import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from '../../src/core/voice/index.ts';
import { resolveVoiceCommand, type VoiceUiContext } from '../../src/renderer/voice/commands.ts';

describe('Fase 22 — comandi vocali di ambiente', () => {
  it('riconosce apri/chiudi/stato in italiano; «chiudi» da solo resta stop, il resto resta obiettivo', () => {
    expect(parseVoiceCommand('Apri il Director')).toEqual({ action: 'open-director', target: null });
    expect(parseVoiceCommand("apri l'agente coder-01")).toEqual({ action: 'open-agent', target: 'coder 01' });
    expect(parseVoiceCommand('mostra Esecutore')).toEqual({ action: 'open-agent', target: 'esecutore' });
    expect(parseVoiceCommand('apri il terminale di Esecutore')).toEqual({ action: 'open-terminal', target: 'esecutore' });
    expect(parseVoiceCommand('chiudi il terminale')).toEqual({ action: 'close-terminal', target: null });
    expect(parseVoiceCommand('chiudi la finestra')).toEqual({ action: 'close-window', target: null });
    expect(parseVoiceCommand('chi sta lavorando?')).toEqual({ action: 'status', target: null });
    expect(parseVoiceCommand('chiudi')).toBeNull();
    expect(parseVoiceCommand('scrivi una funzione di ordinamento')).toBeNull();
  });

  it('gli stessi comandi in inglese (P-108)', () => {
    expect(parseVoiceCommand('Open the Director')).toEqual({ action: 'open-director', target: null });
    expect(parseVoiceCommand('show me the coder-01 agent')).toEqual({ action: 'open-agent', target: 'coder 01' });
    expect(parseVoiceCommand("open Esecutore's terminal")).toEqual({ action: 'open-terminal', target: 'esecutore' });
    expect(parseVoiceCommand('open the terminal of Esecutore')).toEqual({ action: 'open-terminal', target: 'esecutore' });
    expect(parseVoiceCommand('close the terminal')).toEqual({ action: 'close-terminal', target: null });
    expect(parseVoiceCommand('close the window')).toEqual({ action: 'close-window', target: null });
    expect(parseVoiceCommand("who's working?")).toEqual({ action: 'status', target: null });
    expect(parseVoiceCommand('close')).toBeNull();
    expect(parseVoiceCommand('write a sorting function')).toBeNull();
  });

  const ctx: VoiceUiContext = {
    openIds: ['agent:coder-01', 'director'],
    frontKind: 'agent',
    frontRef: 'coder-01',
    agents: [
      { id: 'coder-01', name: 'Coder 01' },
      { id: 'esecutore', name: 'Esecutore' }
    ],
    status: { agentsWorking: 1, tasksActive: 2, activeGoals: 1, processesActive: 3 }
  };

  it('risolve sul contesto UI: agente pronunciato, selezione corrente, chiusura, stato reale', () => {
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'open-agent', target: 'coder 01', text: '' }, ctx)).toEqual({
      kind: 'open', windowKind: 'agent', ref: 'coder-01', title: 'Coder 01', subtitle: 'sessione reale'
    });
    // Pronome/«quello selezionato»: usa la finestra in primo piano.
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'open-terminal', target: null, text: '' }, ctx)).toEqual({
      kind: 'open', windowKind: 'agent', ref: 'coder-01', title: 'Coder 01', subtitle: 'sessione reale'
    });
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'open-agent', target: 'ignoto', text: '' }, ctx).kind).toBe('speak');
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'close-terminal', target: null, text: '' }, ctx)).toEqual({ kind: 'close', id: 'agent:coder-01' });
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'close-window', target: null, text: '' }, ctx)).toEqual({ kind: 'close', id: 'agent:coder-01' });
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'status', target: null, text: '' }, ctx)).toEqual({
      kind: 'speak', text: '1 agente al lavoro, 2 task attivi, 1 obiettivo attivo.'
    });
  });

  it('«apri le impostazioni»: il core riconosce la finestra, l\'interfaccia la apre (17/10/2026)', () => {
    expect(parseVoiceCommand('aprimi le impostazioni')).toEqual({ action: 'open-window', target: 'settings' });
    expect(parseVoiceCommand("apri l'addestramento")).toEqual({ action: 'open-window', target: 'training' });
    expect(parseVoiceCommand('open settings')).toEqual({ action: 'open-window', target: 'settings' });
    expect(parseVoiceCommand('aprimi la calcolatrice')).toEqual({ action: 'open-agent', target: 'calcolatrice' });
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'open-window', target: 'settings', text: '' }, ctx)).toEqual({
      kind: 'open', windowKind: 'settings', ref: null, title: null, subtitle: null
    });
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'open-window', target: 'reactor', text: '' }, ctx).kind).toBe('speak');
  });

  it('senza selezione né nome: parla e basta, nessuna azione inventata; stato assente = N/D', () => {
    const empty: VoiceUiContext = { openIds: [], frontKind: null, frontRef: null, agents: [], status: null };
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'open-agent', target: null, text: '' }, empty).kind).toBe('speak');
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'close-window', target: null, text: '' }, empty).kind).toBe('speak');
    expect(resolveVoiceCommand({ utteranceId: 'u', action: 'status', target: null, text: '' }, empty)).toEqual({ kind: 'speak', text: 'Stato non disponibile.' });
  });
});

describe('ricerca dei file a voce (14/10/2026)', () => {
  it('«trovami il file del contratto»: parole da cercare senza articoli né preposizioni', () => {
    expect(parseVoiceCommand('Trovami il file del contratto')).toEqual({ action: 'find-file', target: 'contratto' });
    expect(parseVoiceCommand("cerca il documento dell'affitto di marzo")).toEqual({ action: 'find-file', target: 'affitto marzo' });
    expect(parseVoiceCommand('Dov\'è la cartella delle fatture?')).toEqual({ action: 'find-file', target: 'fatture' });
    expect(parseVoiceCommand('cercami le foto delle vacanze per favore')).toEqual({ action: 'find-file', target: 'vacanze' });
    expect(parseVoiceCommand('find the file called budget 2026')).toEqual({ action: 'find-file', target: 'budget 2026' });
    expect(parseVoiceCommand('where is my pdf about taxes')).toEqual({ action: 'find-file', target: 'taxes' });
    // Senza nome: si chiede a voce; senza «file/documento/cartella…» resta un obiettivo per il Director.
    expect(parseVoiceCommand('trova il file')).toEqual({ action: 'find-file', target: null });
    expect(parseVoiceCommand('cerca online i voli per Roma')).toBeNull();
    expect(parseVoiceCommand('cerca documentazione su React')).toBeNull();
  });

  it('nel renderer apre Esplora già sui risultati; senza parole lo chiede', () => {
    const ctx: VoiceUiContext = { openIds: [], frontKind: null, frontRef: null, agents: [], status: null };
    expect(resolveVoiceCommand({ utteranceId: 'u1', action: 'find-file', target: 'contratto affitto', text: '' }, ctx))
      .toEqual({ kind: 'open', windowKind: 'files', ref: 'find:contratto affitto', title: null, subtitle: null });
    expect(resolveVoiceCommand({ utteranceId: 'u2', action: 'find-file', target: null, text: '' }, ctx).kind).toBe('speak');
  });
});

describe('liste a voce (P-109b)', () => {
  it('«mostra la lista della spesa» non apre un agente: la frase va all\'Assistente', () => {
    expect(parseVoiceCommand('mostra la lista della spesa')).toBeNull();
    expect(parseVoiceCommand('show me my shopping list')).toBeNull();
    expect(parseVoiceCommand('mostra Esecutore')).toEqual({ action: 'open-agent', target: 'esecutore' });
  });
});
