// Prove degli strumenti (issue #1 su GitHub, idea 6 «prima la prova, poi il fatto»): cosa consegnano i motori,
// come si accorcia l'uscita, quando un riassunto dichiara lavoro. Nessuna rete, nessuna CLI.
import { describe, expect, it } from 'vitest';
import { buildClaudeSettings, CLAUDE_FAILURE_HOOK, mapHook } from '../../src/core/adapters/claude-code/hooks.ts';
import { parseRunLine } from '../../src/core/adapters/opencode/parser.ts';
import { PROOF_LIMITS, proofInput, proofOutput } from '../../src/core/adapters/proof.ts';
import { claimsWork, isReviewTask } from '../../src/core/journal/proofs.ts';

const ctx = { turnId: 't1', nextId: () => 'id-x' };

describe('prova di uno strumento', () => {
  it('ingresso: il comando, il file o il bersaglio; altrimenti il JSON, accorciato', () => {
    expect(proofInput({ command: 'npm test', description: 'test' })).toBe('npm test');
    expect(proofInput({ file_path: 'C:\\progetto\\a.ts', content: 'x'.repeat(5_000) })).toBe('C:\\progetto\\a.ts');
    expect(proofInput({ todos: [1, 2] })).toBe('{"todos":[1,2]}');
    expect(proofInput(undefined)).toBeNull();
    expect(proofInput({ command: 'x'.repeat(1_000) })).toHaveLength(PROOF_LIMITS.input);
  });

  it('uscita: stdout e stderr; una lunga tiene l\'inizio e la fine, dove stanno esito e riepilogo', () => {
    expect(proofOutput({ stdout: 'ok\n', stderr: '', interrupted: false })).toBe('ok');
    expect(proofOutput({ stdout: '', stderr: 'errore' })).toBe('[stderr] errore');
    expect(proofOutput('')).toBeNull();
    const long = `INIZIO ${'riga\n'.repeat(2_000)}Tests 1199 passed`;
    const out = proofOutput(long) as string;
    expect(out).toHaveLength(PROOF_LIMITS.output);
    expect(out.startsWith('INIZIO')).toBe(true);
    expect(out.endsWith('Tests 1199 passed')).toBe(true);
  });

  it('il riassunto dichiara lavoro che lascia tracce? (solo allora la revisione deve avere una prova)', () => {
    for (const s of ['funzione scritta', 'Ho creato il file', 'test passati, build ok', 'Ran the tests', 'all tests pass', 'file modificati: 3']) expect(claimsWork(s), s).toBe(true);
    for (const s of ['tre idee per una cena veloce', 'idee creative per la festa', 'OK', 'la risposta è corretta', 'Ecco il riassunto']) expect(claimsWork(s), s).toBe(false);
  });

  it('revisione: competenza del passo, o un agente che fa solo revisione', () => {
    expect(isReviewTask({ competence: 'review' }, ['code'])).toBe(true);
    expect(isReviewTask({ competence: 'code' }, ['review'])).toBe(false);
    expect(isReviewTask({ competence: null }, ['review'])).toBe(true);
    expect(isReviewTask({ competence: null }, ['code', 'review'])).toBe(false);
  });
});

describe('prove dai motori', () => {
  it('Claude Code: PostToolUse porta comando, uscita e durata; PostToolUseFailure porta l\'errore', () => {
    const [ok] = mapHook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'npm test' }, tool_response: { stdout: '3 passed', stderr: '' }, duration_ms: 812 }, ctx);
    expect(ok).toMatchObject({ kind: 'tool.finished', toolCallId: 'u1', tool: 'Bash', ok: true, durationMs: 812, proof: { input: 'npm test', output: '3 passed' } });
    const [ko] = mapHook(CLAUDE_FAILURE_HOOK, { tool_name: 'Bash', tool_use_id: 'u2', tool_input: { command: 'npm test' }, error: 'Exit code 1\n2 failed' }, ctx);
    expect(ko).toMatchObject({ kind: 'tool.finished', toolCallId: 'u2', ok: false, proof: { input: 'npm test', output: 'Exit code 1\n2 failed' } });
  });

  it('Claude Code: l\'hook degli strumenti falliti si registra solo con la exec form (CLI recente)', () => {
    const modern = buildClaudeSettings('node.exe', 'shim.cjs', { execForm: true }) as { hooks: Record<string, Array<{ matcher?: string }>> };
    expect(modern.hooks[CLAUDE_FAILURE_HOOK]?.[0]?.matcher).toBe('*');
    const old = buildClaudeSettings('node.exe', 'shim.cjs') as { hooks: Record<string, unknown> };
    expect(old.hooks[CLAUDE_FAILURE_HOOK]).toBeUndefined();
    expect(old.hooks.PostToolUse).toBeDefined();
  });

  it('opencode: lo strumento completato porta ingresso e uscita, quello in errore l\'errore', () => {
    const line = (status: string, extra: Record<string, unknown>): string => JSON.stringify({
      type: 'tool_use', sessionID: 's', part: { tool: 'bash', callID: 'c1', state: { status, input: { command: 'npm test' }, time: { start: 1, end: 5 }, ...extra } }
    });
    const done = parseRunLine(line('completed', { output: '12 passed' }), 't1').events.find((e) => e.kind === 'tool.finished');
    expect(done).toMatchObject({ ok: true, durationMs: 4, proof: { input: 'npm test', output: '12 passed' } });
    const failed = parseRunLine(line('error', { error: 'comando non trovato' }), 't1').events.find((e) => e.kind === 'tool.finished');
    expect(failed).toMatchObject({ ok: false, proof: { output: 'comando non trovato' } });
  });
});
