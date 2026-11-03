// Adapter Claude Code con il runtime reale (PTY), il server degli hook reale (named pipe), lo
// shim reale e un Claude Code finto che esegue gli hook di `--settings`. Nessun account usato.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterError, buildClaudeArgs, createClaudeCodeAdapter, isClaudeModel, screenText, selectedOption } from '../../src/core/adapters/claude-code/index.ts';
import { screenRows } from '../../src/core/adapters/claude-code/screen.ts';
import { toolAction } from '../../src/core/adapters/claude-code/hooks.ts';
import type { ActionGate, AdapterContext } from '../../src/core/adapters/index.ts';
import { createHookServer, hookPipeAddress, type HookServer } from '../../src/core/runtime/index.ts';
import { adapterContext, createRuntimeHarness, definition, fakeCliEnv, writeShim } from '../adapter-harness.ts';
import { memoryLogger, tempHome } from '../helpers.ts';
import type { RuntimeHarness } from '../runtime-harness.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(opts: { cli?: boolean; deny?: boolean; trustPrompt?: boolean; onboarding?: boolean; gate?: ActionGate } = {}) {
  const bin = tempHome('visione-bin-');
  cleanups.push(bin.cleanup);
  if (opts.cli !== false) writeShim(bin.dir, 'claude', 'test/fixtures/fake-claude.mjs');
  const h: RuntimeHarness = createRuntimeHarness({
    inheritedEnv: fakeCliEnv(opts.cli === false ? null : bin.dir, {
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ...(opts.trustPrompt ? { FAKE_CLAUDE_TRUST: '1' } : {}), ...(opts.onboarding ? { FAKE_CLAUDE_ONBOARDING: '1' } : {}),
      // Come VISIONE avviata dall'icona: nessun terminale Unicode ereditato (TERM lo mette l'adapter).
      WT_SESSION: undefined, TERM: undefined
    }, { nodeDir: opts.cli !== false })
  });
  cleanups.push(() => h.cleanup());
  const hooks: HookServer = createHookServer({ address: hookPipeAddress(h.dir), log: memoryLogger('error').log });
  await hooks.start();
  cleanups.push(() => hooks.close());
  const adapter = createClaudeCodeAdapter({
    shimDir: join(h.dir, 'runtime', 'shims'),
    candidates: [],
    startTimeoutMs: 20_000,
    ...(opts.deny ? { decideTool: (_agent: string, tool: string) => (tool === 'Read' ? { decision: 'deny' as const, reason: 'lettura vietata dalla policy' } : null) } : {}),
    ...(opts.gate ? { decideAction: opts.gate } : {}),
    trustSettleMs: 100
  });
  adapter.attach(h.runtime);
  const def = definition({ engine: { adapter: 'claude-code', model: 'sonnet' } });
  const t = adapterContext(h, def, { hooks, correlationId: 'CORR-CLAUDE-01' });
  let screen = '';
  const watch = () => {
    const p = h.runtime.list({ live: true }).find((x) => x.kind === 'agent-session');
    const proc = p ? h.runtime.get(p.id) : undefined;
    proc?.onLine((c) => { screen += c.text; });
    return () => screen;
  };
  cleanups.push(() => adapter.stop(t.ctx, 'force', 3_000));
  return { h, hooks, adapter, def, ...t, watch };
}

describe('adapter claude-code', () => {
  it('avvio: settings con gli hook, identity, --session-id, SessionStart dalla pipe → sessione riprendibile', async () => {
    const s = await setup();
    const session = await s.adapter.start(s.ctx);
    expect(session).toMatchObject({ adapter: 'claude-code', resumable: true, model: 'sonnet' });
    expect(session.engineSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.events[0]).toEqual({ kind: 'session.started', engineSessionId: session.engineSessionId });
    // P-102: impostazioni accanto allo shim (cartella custodita), non nella cartella dell'agente.
    expect(existsSync(join(s.ctx.agentDir, 'settings.json'))).toBe(false);
    const settings = JSON.parse(readFileSync(join(s.h.dir, 'runtime', 'shims', `settings-${s.ctx.instance.agentId}.json`), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>; statusLine: { command: string } };
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PostCompact', 'PostToolUse', 'PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('*');
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toMatch(/^"[^"]+node(\.exe)?" "[^"]+visione-hook\.cjs" Stop$/);
    expect(settings.statusLine.command).toMatch(/ StatusLine$/);
    expect(readFileSync(join(s.ctx.agentDir, 'identity.md'), 'utf8')).toContain('Rispondi in italiano.');
    // Il processo è in PTY, di lunga durata, con agente/sessione/adapter distinti.
    const proc = s.h.runtime.list({ live: true })[0];
    expect(proc).toMatchObject({ kind: 'agent-session', io: 'pty', owner: { agentId: 'director', sessionId: session.id, adapter: 'claude-code' } });
  }, 40_000);

  it('turno: testo nel PTY, hook → turn.started, tool.started/finished, uso del contesto, turn.finished', async () => {
    const s = await setup();
    await s.adapter.start(s.ctx);
    const screen = s.watch();
    const t0 = Date.now();
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'turno-1', text: 'ciao VISIONE' });
    expect(out.outcome).toBe('completed');
    // Casella `❯` riconosciuta subito (TERM dall'adapter): niente attesa di 15 s a ogni turno.
    expect(screen()).toContain('❯');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(screen()).toContain('risposta: ciao VISIONE');
    expect(s.events.map((e) => e.kind)).toEqual(['session.started', 'turn.started', 'turn.started', 'tool.started', 'tool.finished', 'usage', 'message.text', 'turn.finished']);
    // Testo finale dall'hook Stop (`last_assistant_message`, lettura difensiva: P-38).
    expect(s.events.find((e) => e.kind === 'message.text')).toEqual({ kind: 'message.text', turnId: 'turno-1', text: 'risposta: ciao VISIONE', final: true });
    expect(s.events.find((e) => e.kind === 'tool.finished')).toMatchObject({ toolCallId: 'toolu_01', tool: 'Read', ok: true, turnId: 'turno-1' });
    expect(s.events.find((e) => e.kind === 'usage')).toEqual({ kind: 'usage', source: 'session', usage: { contextSize: 200_000, contextUsed: 1_234 } });
    await s.h.idle();
    expect(s.h.events.filter((e) => e.type === 'tool.call.finished')).toHaveLength(1);
    expect(s.h.journal.read({ limit: 100, correlationId: 'CORR-CLAUDE-01' }).map((e) => e.type)).toEqual(expect.arrayContaining(['agent.session.started', 'agent.turn.finished']));
  }, 40_000);

  it('testo da 900 caratteri: il TUI lo mostra come «[Pasted text]», vale come eco e non si aspetta 5 s', async () => {
    const s = await setup();
    await s.adapter.start(s.ctx);
    const text = `RISPOSTA: ricevuto. ${'testo di riempimento '.repeat(60)}`.slice(0, 900);
    const t0 = Date.now();
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'turno-lungo', text });
    expect(out.outcome).toBe('completed');
    expect(s.events.find((e) => e.kind === 'message.text')).toMatchObject({ text: 'ricevuto' });
    expect(Date.now() - t0).toBeLessThan(4_000);
  }, 40_000);

  it('17/10/2026: inizio del testo non ridisegnato (ConPTY) → vale il ridisegno visibile, nessuna attesa di secondi', async () => {
    const s = await setup();
    await s.adapter.start(s.ctx);
    const t0 = Date.now();
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'turno-voce', text: 'Compito: come stai oggi? Rispondi breve.' });
    expect(out.outcome).toBe('completed');
    expect(Date.now() - t0).toBeLessThan(1_800);
    expect(s.events.find((e) => e.kind === 'message.text')).toMatchObject({ text: 'risposta: Compito: come stai oggi? Rispondi breve.' });
  }, 40_000);

  it('controllo dagli hook: strumento negato dalla policy (deny), contesto aggiunto (steer)', async () => {
    const s = await setup({ deny: true });
    await s.adapter.start(s.ctx);
    const screen = s.watch();
    await s.adapter.steer?.(s.ctx, 'ricorda: rispondi breve');
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't2', text: 'leggi la nota' });
    expect(out.outcome).toBe('completed');
    await vi.waitFor(() => expect(screen()).toContain('NEGATO: lettura vietata dalla policy'));
    expect(screen()).toContain('contesto: ricorda: rispondi breve');
  }, 40_000);

  it('annullamento: Esc nel TUI e continue:false dagli hook → turno cancelled', async () => {
    const s = await setup();
    await s.adapter.start(s.ctx);
    const screen = s.watch();
    const pending = s.adapter.sendTurn(s.ctx, { turnId: 't3', text: 'compito lento' });
    await vi.waitFor(() => expect(s.events.some((e) => e.kind === 'tool.finished')).toBe(true), { timeout: 10_000 });
    await s.adapter.cancelTurn(s.ctx, 'cambio di programma');
    expect(await pending).toMatchObject({ outcome: 'cancelled', error: { code: 'cancelled' } });
    expect(screen()).toContain('interrotto');
    // La sessione resta viva e accetta un nuovo turno.
    expect((await s.adapter.sendTurn(s.ctx, { turnId: 't4', text: 'di nuovo' })).outcome).toBe('completed');
  }, 40_000);

  it('caduta della CLI durante il turno → turno failed, process.exited, sessione non più avviata', async () => {
    const s = await setup();
    await s.adapter.start(s.ctx);
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't5', text: 'crash' });
    expect(out).toMatchObject({ outcome: 'failed', error: { code: 'exit_nonzero' } });
    await vi.waitFor(() => expect(s.events.some((e) => e.kind === 'process.exited')).toBe(true));
    expect(await s.adapter.sendTurn(s.ctx, { turnId: 't6', text: 'ancora' })).toMatchObject({ outcome: 'failed', error: { code: 'not_running' } });
  }, 40_000);

  it('ripresa con --resume e stop gentile: processo stopped, token dell\'agente revocato', async () => {
    const s = await setup();
    const first = await s.adapter.start(s.ctx);
    await s.adapter.stop(s.ctx, 'graceful', 5_000);
    await vi.waitFor(() => expect(s.h.runtime.list({ live: true })).toEqual([]));
    expect(s.h.runtime.list().find((p) => p.kind === 'agent-session')?.status).toBe('stopped');
    s.setSession(first);
    const again = await s.adapter.start(s.ctx, first);
    expect(again).toMatchObject({ id: first.id, engineSessionId: first.engineSessionId });
    const screen = s.watch();
    await s.adapter.sendTurn(s.ctx, { turnId: 't7', text: 'dopo la ripresa' });
    expect(screen()).toContain('risposta: dopo la ripresa');
    expect(s.h.runtime.list().filter((p) => p.kind === 'agent-session')).toHaveLength(2);
  }, 60_000);

  it('senza CLI installata → AdapterError not_found; probe non disponibile', async () => {
    const s = await setup({ cli: false });
    expect((await s.adapter.probe()).available).toBe(false);
    await expect(s.adapter.start(s.ctx)).rejects.toBeInstanceOf(AdapterError);
    await expect(s.adapter.start(s.ctx)).rejects.toMatchObject({ error: { code: 'not_found' } });
  });

  it('dialogo di fiducia della cartella: trust_required subito, processo fermato, nessuna risposta al posto del proprietario', async () => {
    const s = await setup({ trustPrompt: true });
    const started = Date.now();
    await expect(s.adapter.start(s.ctx)).rejects.toMatchObject({ error: { code: 'trust_required', retryable: false } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(s.events.filter((e) => e.kind === 'session.started')).toEqual([]);
    const proc = s.h.runtime.list().find((p) => p.kind === 'agent-session');
    expect(proc?.status).toBe('stopped');
    expect(s.h.runtime.list({ live: true })).toEqual([]);
    expect(existsSync(join(s.h.workspace, 'fake-claude-trust-answered'))).toBe(false);
  }, 40_000);

  it('prima configurazione di Claude Code non finita (18/10/2026): errore chiaro subito, non ritentato, nessun tasto al suo posto', async () => {
    const s = await setup({ onboarding: true });
    const started = Date.now();
    const err = await s.adapter.start(s.ctx).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ error: { code: 'engine_error', retryable: false } });
    expect((err as { error: { message: string } }).error.message).toMatch(/prima configurazione/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(s.events.filter((e) => e.kind === 'session.started')).toEqual([]);
    expect(s.h.runtime.list({ live: true })).toEqual([]);
    expect(existsSync(join(s.h.workspace, 'fake-claude-onboarding-keys'))).toBe(false);
  }, 40_000);

  it('fiducia approvata dal proprietario: legge l\'opzione selezionata, freccia fino a "sì", Invio, poi SessionStart', async () => {
    const s = await setup({ trustPrompt: true });
    const approved = Object.create(s.ctx, { trustApproved: { value: true } }) as AdapterContext;
    const session = await s.adapter.start(approved);
    expect(session.resumable).toBe(true);
    expect(s.events.filter((e) => e.kind === 'session.started')).toHaveLength(1);
    // Il finto parte su "No": una freccia giù, poi Invio solo quando "Yes" è selezionato.
    const keys = readFileSync(join(s.h.workspace, 'fake-claude-trust-answered'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    expect(keys).toEqual(['\x1b[B', '\r']);
    const out = await s.adapter.sendTurn(approved, { turnId: 'turno-fiducia', text: 'dopo la fiducia' });
    expect(out.outcome).toBe('completed');
  }, 40_000);

  it('opzione selezionata nel dialogo: dallo schermo ricostruito, non dal testo concatenato', () => {
    const word = (s: string): string => s.split(' ').join('\u001b[1C');
    const dialog = (arrow: string): string => `\u001b[2J\u001b[3;2H${word('Quick safety check')}\u001b[14;2H${arrow}\u001b[1C${word('No, exit')}\u001b[15;4H${word('Yes, I trust this folder')}\u001b[17;2H${word('Enter to confirm')}\u001b[>0q\u001b[?u\u001b[m`;
    expect(selectedOption(dialog('❯'))).toBe('no');
    expect(selectedOption(dialog('>'))).toBe('no');
    expect(selectedOption('nessuna selezione')).toBeNull();
    expect(selectedOption('\u001b[1;1H❯\u001b[1C1.\u001b[1CYes,\u001b[1Cproceed\u001b[2;3H2.\u001b[1CNo,\u001b[1Cexit')).toBe('yes');
    // Schermo reale (10/10/2026, Claude Code 2.1.293 avviato da VISIONE installata): dopo la freccia giù
    // il TUI riscrive SOLO la colonna 2 delle due righe. Prima si leggeva il testo concatenato e vinceva
    // sempre il vecchio «> No»: VISIONE premeva ancora giù, la selezione oscillava e il Director falliva.
    const real = dialog('>');
    const down = '\u001b[14;2H \u001b[15;2H>';
    const up = '\u001b[14;2H>\u001b[15;2H ';
    expect(selectedOption(real + down)).toBe('yes');
    expect(selectedOption(real + down + up)).toBe('no');
    expect(selectedOption(real + down + up + down)).toBe('yes');
    // Un `>` dentro una sequenza di controllo non è una freccia.
    expect(selectedOption('\u001b[>0q\u001b[1;1Hnessuna opzione')).toBeNull();
    expect(screenRows(real + down)[14]).toMatch(/^ > Yes, I trust this folder/);
  });

  it('policy di VISIONE negli hook: strumento → azione → gate; negato con il motivo sullo schermo', async () => {
    const asked: Array<{ agentId: string; kind: string; target: string }> = [];
    const gate: ActionGate = (agentId, action) => {
      asked.push({ agentId, kind: action.kind, target: action.target });
      return { decision: 'deny', reason: 'bloccato dalla policy di prova' };
    };
    const s = await setup({ gate });
    await s.adapter.start(s.ctx);
    const screen = s.watch();
    await s.adapter.sendTurn(s.ctx, { turnId: 'turno-gate', text: 'leggi' });
    expect(asked).toEqual([{ agentId: 'director', kind: 'fs.read', target: join(s.h.workspace, 'nota.txt') }]);
    expect(screen()).toContain('NEGATO: bloccato dalla policy di prova');
    expect(toolAction('Bash', { command: 'git push origin main' }, 'C:\\w')).toEqual({ kind: 'git', target: 'push origin main' });
    expect(toolAction('Write', { file_path: 'a\\b.txt' }, 'C:\\w')).toEqual({ kind: 'fs.write', target: 'C:\\w\\a\\b.txt' });
    expect(toolAction('WebFetch', { url: 'https://example.invalid/x' }, 'C:\\w')).toEqual({ kind: 'net.connect', target: 'example.invalid' });
    expect(toolAction('TodoWrite', {}, 'C:\\w')).toBeNull();
  }, 40_000);

  it('toolAction: il comando arriva intero alla policy, anche oltre 1000 caratteri', () => {
    const lungo = `echo ${'a'.repeat(1_100)} && rm -rf ~/Documenti`;
    expect(toolAction('Bash', { command: lungo }, 'C:\\w')).toEqual({ kind: 'shell.exec', target: lungo });
    expect(toolAction('Bash', { command: `git log ${'a'.repeat(1_100)} & calc.exe` }, 'C:\\w')?.target).toHaveLength(1_100 + 15);
  });

  it('testo dello schermo: sequenze ANSI, OSC e spazi rimossi', () => {
    const raw = '\x1b]0;claude\x07\x1b[14;2H❯\x1b[1CNo,\x1b[1Cexit\x1b[m\x1b[15;4HYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\x1b[38;2;153;153;153m';
    expect(screenText(raw)).toBe('❯no,exityes,itrustthisfolder');
  });

  it('limite di quota: banner reale nel PTY → turno failed `limit_reached` e evento `agent.limit.reached`', async () => {
    const s = await setup();
    await s.adapter.start(s.ctx);
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't-limite', text: 'compito con LIMITE' });
    expect(out).toMatchObject({ outcome: 'failed', error: { code: 'limit_reached' } });
    expect(s.events.find((e) => e.kind === 'limit.reached')).toMatchObject({ scope: 'session', resetAt: '3:00pm' });
    await s.h.idle();
    const emitted = s.h.events.filter((e) => e.type === 'agent.limit.reached');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({ agentId: 'director', adapter: 'claude-code', scope: 'session', turnId: 't-limite' });
    // Un turno successivo (senza banner) riparte: la sessione non resta bloccata.
    expect((await s.adapter.sendTurn(s.ctx, { turnId: 't-dopo-limite', text: 'di nuovo' })).outcome).toBe('completed');
  }, 40_000);

  it('modello e potenza: `--effort` nell\'argv; `validate` rifiuta modelli di altri motori', () => {
    const args = buildClaudeArgs({
      engineSessionId: '00000000-0000-0000-0000-000000000001', resume: false, settingsPath: 's.json', identityPath: 'i.md',
      model: 'sonnet', effort: 'high'
    });
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high']));
    expect(isClaudeModel('sonnet')).toBe(true);
    expect(isClaudeModel('claude-opus-4-5')).toBe(true);
    expect(isClaudeModel('nvidia/nvidia/nemotron-3-super-120b-a12b')).toBe(false);
    const adapter = createClaudeCodeAdapter({ shimDir: 'x' });
    expect(adapter.validate(definition({ engine: { adapter: 'claude-code', model: 'nvidia/nvidia/x' } }))).toMatchObject({ ok: false });
    expect(adapter.validate(definition({ engine: { adapter: 'claude-code', model: 'sonnet', options: { effort: 'turbo' } } }))).toMatchObject({ ok: false });
    expect(adapter.validate(definition({ engine: { adapter: 'claude-code', model: 'sonnet', options: { effort: 'xhigh' } } }))).toEqual({ ok: true });
    expect(adapter.tuning?.(definition({ engine: { adapter: 'claude-code', options: { effort: 'low' } } }))).toEqual({ effort: { options: ['low', 'medium', 'high', 'xhigh', 'max'], current: 'low' } });
  });

  it('le variabili della sessione Claude genitore non arrivano all\'agente; lo shim esiste', async () => {
    const s = await setup();
    const env = s.h.runtime.env(s.h.workspace, { strip: ['CLAUDE', 'CLAUDECODE'], keep: ['CLAUDE_CONFIG_DIR'] });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    await s.adapter.start(s.ctx);
    expect(existsSync(join(s.h.dir, 'runtime', 'shims', 'visione-hook.cjs'))).toBe(true);
  }, 40_000);
});
