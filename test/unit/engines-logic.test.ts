// P-99 — logica pura del pannello MOTORI: righe del debug, obiettivo di riparazione, riepilogo del
// riavvio e verdetti onesti. Nessun processo, nessuna rete: solo dati reali formattati.
import { describe, expect, it } from 'vitest';
import type { EngineProbe } from '../../src/shared/contracts/index.ts';
import { agentProblemsFor, engineDebugRows, engineFixGoal, fixVerdict, restartDetail, restartSummary, withAgentProblems } from '../../src/renderer/app/engines-logic.ts';

const probe = (over: Partial<EngineProbe> = {}): EngineProbe => ({
  adapter: 'motore-a',
  available: false,
  version: null,
  path: null,
  command: null,
  problems: [],
  ...over
});

describe('P-99 — logica del pannello MOTORI', () => {
  it('debug di un motore: comando, esito, output/versione, percorso, problemi (o «—» dichiarato)', () => {
    const rows = engineDebugRows(probe({
      available: true,
      version: 'opencode v2.0.12',
      path: 'C:\\bin\\opencode.cmd',
      command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\bin\\opencode.js" --version',
      problems: []
    }));
    const of = (k: string): string => rows.find((r) => r.k === k)?.v ?? '';
    expect(of('motore')).toBe('motore-a');
    expect(of('comando')).toContain('--version');
    expect(of('esito')).toBe('DISPONIBILE');
    expect(of('output (versione)')).toBe('opencode v2.0.12');
    expect(of('percorso')).toBe('C:\\bin\\opencode.cmd');
    expect(of('problemi')).toBe('nessuno');
    // Motore senza CLI propria (pty-generic): lo dichiara, non inventa un comando.
    const generic = engineDebugRows(probe({ adapter: 'pty-generic', available: true, problems: ['versione non leggibile'] }));
    expect(generic.find((r) => r.k === 'comando')?.v).toContain('nessuna CLI propria');
    expect(generic.find((r) => r.k === 'problemi')?.v).toBe('versione non leggibile');
    expect(generic.find((r) => r.k === 'percorso')?.v).toBe('—');
  });

  it('obiettivo di riparazione: contiene la verifica reale e impone l\'esito onesto', () => {
    const goal = engineFixGoal(probe({ adapter: 'claude-code', problems: ['CLI non trovata'], command: 'claude --version' }));
    expect(goal).toContain('claude-code');
    expect(goal).toContain('claude --version');
    expect(goal).toContain('NON disponibile');
    expect(goal).toContain('CLI non trovata');
    expect(goal).toContain('errore fisso');
  });

  it('riepilogo del riavvio: conteggi reali e dettaglio per agente', () => {
    const out = {
      probes: [probe({ available: true }), probe({ adapter: 'motore-b', available: false })],
      restarted: [{ agentId: 'coder', ok: true, reason: 'sessione riavviata (idle)' }, { agentId: 'ultra', ok: false, reason: 'fiducia da approvare' }],
      failed: 1
    };
    expect(restartSummary(out)).toBe('verificati 2 motori · 1 disponibili · agenti riavviati 1/2 · falliti 1');
    expect(restartDetail(out)).toContain('coder: riavviato');
    expect(restartDetail(out)).toContain('ultra: NON riavviato — fiducia da approvare');
    expect(restartDetail({ probes: [], restarted: [], failed: 0 })).toContain('nessun agente da riavviare');
  });

  it('problemi degli agenti: un motore disponibile può essere inutilizzabile dai suoi agenti', () => {
    const agents = [
      { definition: { id: 'rotto', engine: { adapter: 'motore-a' } }, instance: { status: 'crashed', statusReason: 'processo terminato' } },
      { definition: { id: 'ok', engine: { adapter: 'motore-a' } }, instance: { status: 'idle', statusReason: null } },
      { definition: { id: 'altro', engine: { adapter: 'motore-b' } }, instance: { status: 'error', statusReason: 'avvio' } }
    ];
    expect(agentProblemsFor('motore-a', agents)).toEqual(['agente rotto: crashed (processo terminato)']);
    const full = withAgentProblems(probe({ available: true, problems: ['versione non leggibile'] }), agents);
    expect(full.problems).toEqual(['versione non leggibile', 'agente rotto: crashed (processo terminato)']);
    // Verdetto: disponibile ma con problemi residui → errore fisso, mai «riparato».
    const verdict = fixVerdict({ taskStatus: 'succeeded', probeAfter: full });
    expect(verdict).toContain('ERRORE FISSO');
    expect(verdict).toContain('agente rotto');
  });

  it('verdetto: «riparato» solo con task riuscito E verifica reale positiva', () => {
    expect(fixVerdict({ taskStatus: 'succeeded', probeAfter: probe({ adapter: 'opencode', available: true, version: 'v2' }) }))
      .toContain('riparato e verificato');
    // Task completato ma il motore non risponde: errore fisso, mai un finto risolto.
    const fixed = fixVerdict({ taskStatus: 'succeeded', probeAfter: probe({ adapter: 'opencode', available: false, problems: ['CLI non trovata'] }) });
    expect(fixed).toContain('ERRORE FISSO');
    expect(fixed).toContain('CLI non trovata');
    // Task fallito: motivo vero.
    const failed = fixVerdict({ taskStatus: 'failed', errorCode: 'policy_blocked', errorMessage: 'azione vietata', probeAfter: probe() });
    expect(failed).toContain('ERRORE FISSO');
    expect(failed).toContain('policy_blocked: azione vietata');
    // In attesa di approvazione e task ancora in corso: nessun esito dichiarato.
    expect(fixVerdict({ taskStatus: 'waiting', probeAfter: probe() })).toContain('in attesa');
    expect(fixVerdict({ taskStatus: 'running', probeAfter: probe() })).toContain('ancora in corso');
    // Verifica non eseguibile: nessun «riparato» dichiarato.
    expect(fixVerdict({ taskStatus: 'succeeded', summary: 'ok', probeAfter: null })).not.toContain('riparato e verificato');
    expect(fixVerdict({ taskStatus: 'succeeded', summary: 'ok', probeAfter: null })).toContain('nessun');
  });
});
