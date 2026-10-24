// Procedura guidata, logica dell'interfaccia (P-105): identificativi dai nomi scelti, squadra
// consigliata ricavata SOLO dai dati dei motori, controlli in italiano, esiti della verifica finale.
// 18/10/2026: ripresa dal passo in cui era dopo un riavvio del core.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VERIFY_STEP,
  approvalText,
  uniqueRequests,
  engineReady,
  missingFor,
  profilesMissing,
  resumeStep,
  slugId,
  suggestedTeam,
  teamLabel,
  usableCatalogs,
  verifyGroups,
  teamPayload,
  teamProblems,
  verifyOutcome,
  verifyStatus,
  type EngineCatalog,
  type TeamRow
} from '../../src/renderer/app/setup-logic.ts';
import type { SetupEngine } from '../../src/shared/contracts/index.ts';

const catalogs: EngineCatalog[] = [
  { adapter: 'motore-a', label: 'Motore A (account)', models: [{ model: 'alto', label: 'Alto', group: 'A', recommended: true, suggestedFor: 'director' }, { model: 'basso', label: 'Basso', group: 'A' }] },
  {
    adapter: 'motore-b',
    label: 'Motore B',
    models: [
      { model: 'g/codice', label: 'Codice', group: 'Nuvola', endpointProfile: 'nuvola', recommended: true, suggestedFor: 'code' },
      { model: 'g/revisione', label: 'Revisione', group: 'Nuvola', endpointProfile: 'nuvola', recommended: true, suggestedFor: 'review' },
      { model: 'g/ricerca', label: 'Ricerca', group: 'Nuvola', endpointProfile: 'nuvola', recommended: true, suggestedFor: 'research' },
      { model: 'locale/x', label: 'x (sul tuo PC)', group: 'Locale', endpointProfile: 'locale' }
    ]
  }
];

const row = (over: Partial<TeamRow> & { key: string }): TeamRow => ({ name: 'Agente', roleKey: 'general', adapter: 'motore-a', model: 'alto', ...over });

describe('procedura guidata: logica dell\'interfaccia (P-105)', () => {
  it('slugId: nomi con accenti, spazi e numeri → identificativi validi e unici', () => {
    expect(slugId('Pippo', new Set())).toBe('pippo');
    expect(slugId('Alessia 2', new Set())).toBe('alessia-2');
    expect(slugId('Niccolò l\'Ingegnere', new Set())).toBe('niccolo-l-ingegnere');
    expect(slugId('2B', new Set())).toBe('agente-2b');
    expect(slugId('!!!', new Set())).toBe('agente');
    expect(slugId('Pippo', new Set(['pippo', 'pippo-2']))).toBe('pippo-3');
    for (const id of [slugId('Un nome davvero molto molto lungo per un agente', new Set()), slugId('Ünïcødé', new Set())]) expect(id).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
  });

  it('squadra consigliata dai dati dei motori: Director e un agente per ruolo, con il profilo del modello', () => {
    const team = suggestedTeam(catalogs);
    expect(team.map((r) => [r.name, r.roleKey, r.adapter, r.model, r.endpointProfile ?? null])).toEqual([
      ['Director', 'director', 'motore-a', 'alto', null],
      ['Esecutore', 'code', 'motore-b', 'g/codice', 'nuvola'],
      ['Revisore', 'review', 'motore-b', 'g/revisione', 'nuvola'],
      ['Ricercatore', 'research', 'motore-b', 'g/ricerca', 'nuvola']
    ]);
    expect(new Set(team.map((r) => r.key)).size).toBe(4);
    expect(teamLabel(catalogs, team)).toBe('Motore A (account) come Director + 3 agenti Nuvola');
    expect(suggestedTeam([])).toEqual([]);
    // Un motore senza consigli per il Director: il Director prende il suo modello consigliato (21/10/2026).
    expect(suggestedTeam([catalogs[1]!]).map((r) => [r.roleKey, r.model])).toEqual([['director', 'g/codice'], ['code', 'g/codice'], ['review', 'g/revisione'], ['research', 'g/ricerca']]);
  });

  it('nessun modello consigliato per la revisione (17/10/2026): il Revisore prende quello del codice', () => {
    const noReview = [catalogs[0]!, { ...catalogs[1]!, models: catalogs[1]!.models.filter((m) => m.suggestedFor !== 'review') }];
    const team = suggestedTeam(noReview);
    expect(team.map((r) => [r.roleKey, r.model])).toEqual([['director', 'alto'], ['code', 'g/codice'], ['review', 'g/codice'], ['research', 'g/ricerca']]);
  });

  it('controlli della squadra: nomi mancanti, doppi, troppo lunghi, modello mancante, chi comanda', () => {
    const ok = [row({ key: 'a', name: 'Jarvis', roleKey: 'director' }), row({ key: 'b', name: 'Pippo' })];
    expect(teamProblems(ok, 'a')).toEqual([]);
    expect(teamProblems(ok, null)).toEqual(['scegli chi comanda (il Director)']);
    expect(teamProblems(ok, 'nessuno')).toEqual(['scegli chi comanda (il Director)']);
    expect(teamProblems([row({ key: 'a', name: 'Pippo' }), row({ key: 'b', name: ' pippo ' })], 'a')).toEqual(['due agenti si chiamano «pippo»: scegli nomi diversi']);
    expect(teamProblems([row({ key: 'a', name: '  ' })], 'a')).toEqual(['dai un nome all\'agente 1']);
    expect(teamProblems([row({ key: 'a', name: 'x'.repeat(41) })], 'a')[0]).toMatch(/troppo lungo/);
    expect(teamProblems([row({ key: 'a', name: 'Pippo', model: '' })], 'a')).toEqual(['scegli il modello di «Pippo»']);
    expect(teamProblems([], null)).toEqual(['aggiungi almeno un agente', 'scegli chi comanda (il Director)']);
  });

  it('teamPayload: identificativi dai nomi, unici; ruolo e competenze dal ruolo scelto; profilo solo se c\'è', () => {
    const { agents, ids } = teamPayload([
      row({ key: 'a', name: ' Jarvis ', roleKey: 'director' }),
      row({ key: 'b', name: 'Alessia', roleKey: 'code', adapter: 'motore-b', model: 'g/codice', endpointProfile: 'nuvola' }),
      row({ key: 'c', name: 'Alessia!', roleKey: 'research' })
    ]);
    expect(agents.map((a) => a.id)).toEqual(['jarvis', 'alessia', 'alessia-2']);
    expect(ids.get('b')).toBe('alessia');
    expect(agents[0]).toEqual({ id: 'jarvis', name: 'Jarvis', role: 'Director: scompone gli obiettivi e coordina gli agenti', competences: ['reasoning', 'general'], adapter: 'motore-a', model: 'alto' });
    expect(agents[1]).toMatchObject({ competences: ['code'], endpointProfile: 'nuvola' });
  });

  it('motore pronto: solo se tutti i requisiti obbligatori sono a posto; i facoltativi non bloccano', () => {
    const engines: SetupEngine[] = [
      { adapter: 'motore-a', items: [{ id: 'installato', label: 'Installato', ok: true, optional: false, detail: '', steps: [], commands: [] }, { id: 'accesso', label: 'Accesso', ok: false, optional: false, detail: '', steps: [], commands: [] }] },
      { adapter: 'motore-b', items: [{ id: 'installato', label: 'Installato', ok: true, optional: false, detail: '', steps: [], commands: [] }, { id: 'locale', label: 'Locale', ok: false, optional: true, detail: '', steps: [], commands: [] }] }
    ];
    expect(engineReady(engines, 'motore-a')).toBe(false);
    expect(missingFor(engines, 'motore-a').map((i) => i.label)).toEqual(['Accesso']);
    expect(engineReady(engines, 'motore-b')).toBe(true);
    expect(engineReady(engines, 'sconosciuto')).toBe(false);
    expect(engineReady(null, 'motore-b')).toBe(false);
  });

  it('un motore solo (21/10/2026): solo Claude, solo NVIDIA o solo Ollama danno una squadra intera su quel motore', () => {
    const item = (id: string, ok: boolean, forProfile?: string): SetupEngine['items'][number] => ({ id, label: id, ok, optional: forProfile !== undefined, ...(forProfile ? { forProfile } : {}), detail: '', steps: [], commands: [] });
    const real: EngineCatalog[] = [
      { adapter: 'claude-code', label: 'Claude Code', models: [
        { model: 'sonnet', label: 'Sonnet', group: 'Claude', recommended: true, suggestedFor: 'director' },
        { model: 'haiku', label: 'Haiku', group: 'Claude' }
      ] },
      { adapter: 'opencode', label: 'OpenCode', models: [
        { model: 'nvidia/super', label: 'Super', group: 'NVIDIA', endpointProfile: 'nvidia', recommended: true, suggestedFor: 'code' },
        { model: 'nvidia/oss', label: 'OSS', group: 'NVIDIA', endpointProfile: 'nvidia', recommended: true, suggestedFor: 'research' },
        { model: 'ollama/qwen', label: 'qwen (sul tuo PC)', group: 'Ollama (locale)', endpointProfile: 'ollama' }
      ] }
    ];
    const engines = (claude: boolean, key: boolean, ollama: boolean): SetupEngine[] => [
      { adapter: 'claude-code', items: [item('installato', claude), item('accesso', claude)] },
      { adapter: 'opencode', items: [item('installato', key || ollama), item('chiave', key, 'nvidia'), item('ollama', ollama, 'ollama')] }
    ];
    const team = (e: SetupEngine[] | null) => suggestedTeam(usableCatalogs(real, e)).map((r) => [r.roleKey, r.adapter, r.model, r.endpointProfile ?? null]);
    expect(team(engines(true, false, false))).toEqual([
      ['director', 'claude-code', 'sonnet', null], ['code', 'claude-code', 'sonnet', null], ['review', 'claude-code', 'sonnet', null], ['research', 'claude-code', 'sonnet', null]
    ]);
    expect(team(engines(false, true, false))).toEqual([
      ['director', 'opencode', 'nvidia/super', 'nvidia'], ['code', 'opencode', 'nvidia/super', 'nvidia'], ['review', 'opencode', 'nvidia/super', 'nvidia'], ['research', 'opencode', 'nvidia/oss', 'nvidia']
    ]);
    expect(team(engines(false, false, true))).toEqual([
      ['director', 'opencode', 'ollama/qwen', 'ollama'], ['code', 'opencode', 'ollama/qwen', 'ollama'], ['review', 'opencode', 'ollama/qwen', 'ollama'], ['research', 'opencode', 'ollama/qwen', 'ollama']
    ]);
    // Tutti pronti: la squadra di sempre (Director su Claude, gli altri su NVIDIA).
    expect(team(engines(true, true, true)).map((r) => r[2])).toEqual(['sonnet', 'nvidia/super', 'nvidia/super', 'nvidia/oss']);
    // Motori non ancora rilevati o nessuno pronto: nessuna squadra inventata.
    expect(team(null)).toEqual([]);
    expect(team(engines(false, false, false))).toEqual([]);
  });

  it('verifica (21/10/2026): un turno per motore e modello, chi comanda per primo; gli altri ne prendono il risultato', () => {
    const r = (key: string, adapter: string, model: string, endpointProfile?: string): TeamRow => ({ key, name: key, roleKey: 'general', adapter, model, ...(endpointProfile ? { endpointProfile } : {}) });
    const rows = [r('a', 'oc', 'ollama/q', 'ollama'), r('b', 'oc', 'ollama/q', 'ollama'), r('c', 'cc', 'sonnet'), r('d', 'oc', 'ollama/q', 'ollama'), r('e', 'oc', 'nvidia/x', 'nvidia')];
    const ids = new Map(rows.map((x) => [x.key, `id-${x.key}`]));
    // Comanda «b»: prova lui il modello locale, «a» e «d» lo seguono; Claude e NVIDIA hanno ciascuno il suo turno.
    expect([...verifyGroups(rows, ids, 'b')]).toEqual([['id-b', ['id-a', 'id-d']], ['id-c', []], ['id-e', []]]);
    expect([...verifyGroups(rows, ids, null)]).toEqual([['id-a', ['id-b', 'id-d']], ['id-c', []], ['id-e', []]]);
    // Stesso modello ma profilo diverso: due turni.
    expect(verifyGroups([r('x', 'oc', 'm', 'p1'), r('y', 'oc', 'm', 'p2')], new Map([['x', 'X'], ['y', 'Y']]), null).size).toBe(2);
  });

  it('profili (18/10/2026): ne serve almeno uno, e la riga di un modello NVIDIA senza chiave è «non pronto»', () => {
    const item = (id: string, ok: boolean, forProfile?: string): SetupEngine['items'][number] => ({ id, label: id, ok, optional: forProfile !== undefined, ...(forProfile ? { forProfile } : {}), detail: '', steps: [], commands: [] });
    const nessuno: SetupEngine[] = [{ adapter: 'oc', items: [item('installato', true), item('chiave', false, 'nvidia'), item('locale', false, 'ollama')] }];
    expect(engineReady(nessuno, 'oc')).toBe(false);
    expect(profilesMissing(nessuno, 'oc').map((i) => i.id)).toEqual(['chiave', 'locale']);
    expect(missingFor(nessuno, 'oc').map((i) => i.id)).toEqual([]);
    expect(missingFor(nessuno, 'oc', 'nvidia').map((i) => i.id)).toEqual(['chiave']);
    const soloLocale: SetupEngine[] = [{ adapter: 'oc', items: [item('installato', true), item('chiave', false, 'nvidia'), item('locale', true, 'ollama')] }];
    expect(engineReady(soloLocale, 'oc')).toBe(true);
    expect(profilesMissing(soloLocale, 'oc')).toEqual([]);
    expect(missingFor(soloLocale, 'oc', 'nvidia').map((i) => i.id)).toEqual(['chiave']);
    expect(missingFor(soloLocale, 'oc', 'ollama')).toEqual([]);
  });

  it('esiti della verifica: riuscito con o senza PRONTO, errori, stati finali e attesa di approvazione', () => {
    expect(verifyOutcome('success', 'PRONTO')).toEqual({ state: 'ok', detail: 'ha risposto: PRONTO' });
    expect(verifyOutcome('success', 'Eccomi')).toEqual({ state: 'ok', detail: 'ha risposto: «Eccomi»' });
    expect(verifyOutcome('success', '  ')).toMatchObject({ state: 'ok', detail: expect.stringMatching(/^ha risposto, ma senza testo/) });
    expect(verifyOutcome('failure', '')).toEqual({ state: 'errore', detail: 'non ha completato (errore): nessun dettaglio' });
    // 10/10/2026: il Director non partiva e il compito è passato all'Esecutore, che ha risposto PRONTO.
    const rerouted = verifyOutcome('success', 'PRONTO', 'esecutore', 'director', new Map([['esecutore', 'Pippo']]));
    expect(rerouted.state).toBe('errore');
    expect(rerouted.detail).toMatch(/al suo posto ha risposto Pippo/);
    expect(verifyOutcome('success', 'PRONTO', 'director', 'director')).toEqual({ state: 'ok', detail: 'ha risposto: PRONTO' });
    expect(verifyStatus('timed_out', '')).toEqual({ state: 'errore', detail: 'nessuna risposta in tempo' });
    expect(verifyStatus('failed', 'chiave rifiutata')).toEqual({ state: 'errore', detail: 'il turno è fallito (chiave rifiutata)' });
    expect(verifyStatus('waiting', '')?.detail).toMatch(/Approvazioni/);
    expect(verifyStatus('running', '')).toBeNull();
    expect(verifyStatus('succeeded', '')).toBeNull();
  });

  it('permesso in parole semplici: fiducia nella cartella spiegata, altri permessi con motivo e oggetto', () => {
    const trust = approvalText({ kind: 'engine.workspace.trust', target: 'C:\dati\workspace\jarvis', reason: 'x' }, 'Jarvis');
    expect(trust.title).toBe('Jarvis chiede di potersi fidare della sua cartella di lavoro');
    expect(trust.body).toMatch(/una volta sola/);
    expect(approvalText({ kind: 'fs.write', target: 'C:\file.txt', reason: 'scrive un file' }, 'Pippo')).toEqual({ title: 'Pippo chiede un permesso: fs.write', body: 'scrive un file — C:\file.txt' });
  });

  it('richieste di permesso uguali: una scheda sola, la prima', () => {
    const a = { id: '1', agentId: 'jarvis', kind: 'engine.workspace.trust', target: 'C:/w/jarvis', reason: 'x' };
    expect(uniqueRequests([a, { ...a, id: '2' }, { ...a, id: '3', agentId: 'pippo' }, { ...a, id: '4', target: 'C:/altro' }]).map((x) => x.id)).toEqual(['1', '3', '4']);
  });
});

describe('procedura guidata: riavvio del core (18/10/2026)', () => {
  const source = (file: string): string => readFileSync(new URL(`../../src/renderer/app/${file}`, import.meta.url), 'utf8');

  it('App la tiene montata mentre il core riparte: con `setupOpen && ready` veniva smontata e ripartiva dal primo passo', () => {
    const app = source('App.tsx');
    const at = app.indexOf('<SetupWizard');
    expect(at).toBeGreaterThan(0);
    // La condizione che monta la procedura dipende solo dall'essere aperta, non dal core pronto.
    expect(app.slice(app.lastIndexOf('{setupOpen', at), at)).toMatch(/^\{setupOpen && \(\s*$/);
    expect(app.slice(at, app.indexOf('/>', at))).toContain('coreReady={ready}');
    // Col core che riparte si nasconde da sé (resta montata: passo e scelte non si perdono).
    expect(source('SetupWizard.tsx')).toMatch(/data-testid="setup-wizard"[^>]*hidden=\{!coreReady\}/);
  });

  it('resta sul passo in cui era se ciò che gli serve c\'è ancora', () => {
    for (let s = 0; s <= VERIFY_STEP; s++) expect(resumeStep(s, { anyReady: true, teamApplied: s >= 3 })).toBe(s);
    // Il passo Motori resta anche se nessun motore è pronto: è proprio lì che lo si sistema.
    expect(resumeStep(1, { anyReady: false, teamApplied: false })).toBe(1);
    // Voce, Offline e Verifica non dipendono dal rilevamento: con la squadra applicata restano.
    expect(resumeStep(4, { anyReady: false, teamApplied: true })).toBe(4);
  });

  it('stato incoerente: torna al passo valido più vicino, non al primo', () => {
    // La squadra applicata non c'è più nel core: si torna alla Squadra.
    expect(resumeStep(VERIFY_STEP, { anyReady: true, teamApplied: false })).toBe(2);
    expect(resumeStep(3, { anyReady: true, teamApplied: false })).toBe(2);
    // Nessun motore pronto: la Squadra non vale, si torna ai Motori.
    expect(resumeStep(2, { anyReady: false, teamApplied: false })).toBe(1);
    expect(resumeStep(VERIFY_STEP, { anyReady: false, teamApplied: false })).toBe(1);
  });

  it('rilevamento non riuscito o passo fuori misura: nessuno spostamento su un dato che manca', () => {
    expect(resumeStep(2, { anyReady: null, teamApplied: false })).toBe(2);
    expect(resumeStep(9, { anyReady: true, teamApplied: true })).toBe(VERIFY_STEP);
    expect(resumeStep(-1, { anyReady: true, teamApplied: true })).toBe(0);
    expect(resumeStep(Number.NaN, { anyReady: true, teamApplied: true })).toBe(0);
  });
});
