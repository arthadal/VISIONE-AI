// Chi comanda è sempre in fiducia (24/10/2026, dal proprietario: «il Director deve essere sempre autorizzato»).
import { describe, expect, it } from 'vitest';
import { leadAgentOf, trustedAgentsOf, withTrust } from '../../src/renderer/app/settings-meta.ts';

describe('fiducia di chi comanda', () => {
  it('chi comanda si legge dalla configurazione; vuoto o assente = nessuno', () => {
    expect(leadAgentOf({ director: { plannerAgentId: 'director' } })).toBe('director');
    expect(leadAgentOf({ director: { plannerAgentId: '' } })).toBeNull();
    expect(leadAgentOf({})).toBeNull();
  });
  it('accenderlo per gli altri non scrive chi comanda nell\'elenco', () => {
    const config = { director: { plannerAgentId: 'director' }, policy: { trustedAgents: [] } };
    expect(withTrust(trustedAgentsOf(config), 'esecutore', true)).toEqual(['esecutore']);
  });
});
