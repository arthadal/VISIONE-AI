// «@nome …» nella chat con VISIONE va a quell'agente, senza piano (24/10/2026).
import { describe, expect, it } from 'vitest';
import { addressedAgent } from '../../src/core/director/index.ts';

const agents = [{ id: 'esecutore', name: 'Esecutore' }, { id: 'ricercatore', name: 'Ricercatore Web' }];

describe('richiesta a un agente con @nome', () => {
  it('per id o per nome, maiuscole e spazi non contano', () => {
    expect(addressedAgent('@esecutore crea il file', agents)).toEqual({ agentId: 'esecutore', text: 'crea il file' });
    expect(addressedAgent('@RicercatoreWeb: cerca tre alternative', agents)).toEqual({ agentId: 'ricercatore', text: 'cerca tre alternative' });
  });
  it('agente sconosciuto, @ in mezzo o niente da dire: resta una richiesta al Director', () => {
    expect(addressedAgent('@nessuno fai qualcosa', agents)).toBeNull();
    expect(addressedAgent('scrivi a @esecutore', agents)).toBeNull();
    expect(addressedAgent('@esecutore', agents)).toBeNull();
  });
});
