// Guidata riaperta dopo averla completata (22/10/2026, VM): si parte dalla squadra applicata, non da quella consigliata.
import { describe, expect, it } from 'vitest';
import { ROLE_COMPETENCES, ROLE_ORDER, roleOf, teamFromAgents, teamPayload } from '../../src/renderer/app/setup-logic.ts';

describe('squadra esistente nella guidata', () => {
  it('il ruolo dalle competenze che la guidata stessa scrive, e il più vicino per le altre', () => {
    for (const k of ROLE_ORDER) expect(roleOf(ROLE_COMPETENCES[k])).toBe(k);
    expect(roleOf(['general', 'reasoning'])).toBe('director');
    expect(roleOf(['code', 'general'])).toBe('code');
    expect(roleOf(['planning'])).toBe('general');
  });

  it('righe dagli agenti attivi, chi comanda dal plannerAgentId; rifatte in squadra danno gli stessi agenti', () => {
    const agents = [
      { id: 'director', name: 'Director', competences: ['reasoning', 'general'], engine: { adapter: 'claude-code', model: 'sonnet' } },
      { id: 'esecutore', name: 'Esecutore', competences: ['code'], engine: { adapter: 'opencode', model: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', endpointProfile: 'nvidia' } },
      { id: 'ricercatore', name: 'Ricercatore', competences: ['research'], engine: { adapter: 'opencode', model: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', endpointProfile: 'nvidia' } }
    ];
    const { rows, commander } = teamFromAgents(agents, 'director');
    expect(rows.map((r) => [r.name, r.roleKey, r.adapter, r.model, r.endpointProfile ?? null])).toEqual([
      ['Director', 'director', 'claude-code', 'sonnet', null],
      ['Esecutore', 'code', 'opencode', 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', 'nvidia'],
      ['Ricercatore', 'research', 'opencode', 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia']
    ]);
    expect(commander).toBe(rows[0]!.key);
    // Riapplicata così com'è, la squadra torna con gli stessi identificativi e motori.
    expect(teamPayload(rows).agents.map((a) => [a.id, a.adapter, a.model])).toEqual(agents.map((a) => [a.id, a.engine.adapter, a.engine.model]));
    // Chi comanda non è fra questi: il primo.
    const other = teamFromAgents(agents, 'altro');
    expect(other.commander).toBe(other.rows[0]!.key);
    expect(teamFromAgents([], null)).toEqual({ rows: [], commander: null });
  });
});
