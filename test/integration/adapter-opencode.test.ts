// Adapter OpenCode con il runtime reale e un OpenCode finto che riproduce le uscite reali
// registrate (fixture). Verifica argv, config senza segreti, eventi, sessione, uso, errori.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpencodeAdapter } from '../../src/core/adapters/opencode/index.ts';
import { buildConfigContent, DEFAULT_ENDPOINT_PROFILES } from '../../src/core/adapters/opencode/command.ts';
import { NVIDIA_KEY_CHECK_URL, forgetNvidiaProbes } from '../../src/core/adapters/providers/nvidia.ts';
import { forgetOllamaDerived } from '../../src/core/adapters/providers/ollama.ts';
import type { AgentSession } from '../../src/shared/contracts/index.ts';
import { adapterContext, createRuntimeHarness, definition, fakeCliEnv, writeShim } from '../adapter-harness.ts';
import type { RuntimeHarness } from '../runtime-harness.ts';
import { tempHome } from '../helpers.ts';

const harnesses: RuntimeHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

const MODEL = 'nvidia/nvidia/nemotron-3-super-120b-a12b';
const SESSION = 'ses_f073921f8ffe7VX3YEExPwe92O';

const binDirs: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  for (const b of binDirs.splice(0)) b.cleanup();
});

function setup(opts: { cli?: boolean; key?: boolean; version?: string; nohelp?: boolean; trusted?: boolean } = {}) {
  const bin = tempHome('visione-bin-');
  binDirs.push(bin);
  if (opts.cli !== false) writeShim(bin.dir, 'opencode', 'test/fixtures/fake-opencode.mjs');
  const extra = { NVIDIA_API_KEY: opts.key === false ? undefined : 'valore-di-prova', FAKE_OPENCODE_VERSION: opts.version, FAKE_OPENCODE_NOHELP: opts.nohelp ? '1' : undefined };
  const h = createRuntimeHarness({
    inheritedEnv: fakeCliEnv(opts.cli === false ? null : bin.dir, extra, { nodeDir: opts.cli !== false })
  });
  harnesses.push(h);
  const adapter = createOpencodeAdapter({ candidates: [], lockRetryDelayMs: () => 10, ...(opts.trusted ? { isTrusted: () => true } : {}) });
  adapter.attach(h.runtime);
  const def = definition({ engine: { adapter: 'opencode', model: MODEL } });
  const t = adapterContext(h, def, { correlationId: 'CORR-TURNO-01' });
  return { h, adapter, def, ...t, last: () => JSON.parse(readFileSync(join(h.workspace, 'fake-oc-last.json'), 'utf8')) };
}

describe('adapter opencode', () => {
  it('saluto di stato: un modello NVIDIA tolto all\'account ferma i suoi agenti anche con la chiave valida (21/10/2026)', async () => {
    forgetNvidiaProbes();
    const { h } = setup();
    // Chiave finta costruita a runtime (check-repo): passa solo al fetch finto.
    const key = ['nvapi', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'].join('-');
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === NVIDIA_KEY_CHECK_URL) return new Response('{}', { status: 200 });
      const model = String((JSON.parse(String(init?.body)) as { model: string }).model);
      asked.push(model);
      return new Response('{}', { status: model.includes('super') ? 404 : 200 });
    }) as typeof fetch;
    const adapter = createOpencodeAdapter({ candidates: [], lockRetryDelayMs: () => 10, setupDeps: { fetch: fetchImpl, userEnv: { env: { NVIDIA_API_KEY: key } } } });
    adapter.attach(h.runtime);
    const nvidia = (id: string, name: string, model: string) => definition({ id, name, engine: { adapter: 'opencode', model, endpointProfile: 'nvidia' } });
    const esecutore = nvidia('esecutore', 'Esecutore', 'nvidia/nvidia/nemotron-3-super-120b-a12b');
    const ricercatore = nvidia('ricercatore', 'Ricercatore', 'nvidia/nvidia/nemotron-3-super-120b-a12b');
    const revisore = nvidia('revisore', 'Revisore', 'nvidia/nvidia/nemotron-3-ultra-550b-a55b');
    expect(await adapter.health!([esecutore, ricercatore, revisore])).toEqual({ ok: false, detail: 'Esecutore, Ricercatore: nemotron-3-super-120b-a12b non disponibile per il tuo account NVIDIA (HTTP 404)' });
    // Una prova per modello, non per agente.
    expect(asked.sort()).toEqual(['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b']);
    expect(await adapter.health!([revisore])).toEqual({ ok: true, detail: 'programma installato e accesso verificato' });
    forgetNvidiaProbes();
  });

  it('battuta del saluto: testo breve da NVIDIA con la chiave dell\'utente; agenti solo locali: niente (22/10/2026)', async () => {
    const key = ['nvapi', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'].join('-');
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Una battuta.' } }] }), { status: 200 });
    }) as typeof fetch;
    const adapter = createOpencodeAdapter({ candidates: [], lockRetryDelayMs: () => 10, setupDeps: { fetch: fetchImpl, userEnv: { env: { NVIDIA_API_KEY: key } } } });
    const ask = { system: 's', user: 'u', maxTokens: 80 };
    const remoto = definition({ id: 'revisore', engine: { adapter: 'opencode', model: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', endpointProfile: 'nvidia' } });
    const locale = definition({ id: 'esecutore', engine: { adapter: 'opencode', model: 'ollama/qwen2.5-coder:7b', endpointProfile: 'ollama' } });
    expect(await adapter.quickText!([remoto, locale], ask, 2_000)).toBe('Una battuta.');
    expect(await adapter.quickText!([locale], ask, 2_000)).toBeNull();
    expect(calls).toBe(1);
  });

  it('probe: CLI trovata tramite lo shim npm decodificato (mai cmd.exe) e versione letta', async () => {
    const s = setup();
    const probe = await s.adapter.probe();
    expect(probe).toMatchObject({ available: true, version: 'opencode v2.0.12-fake', problems: [] });
    expect(probe.path).toMatch(/opencode\.cmd$/);
    expect(s.adapter.capabilities.has('turns.headless')).toBe(true);
  });

  it('turno con un modello locale: copia con il contesto adatto e configurazione leggera (22/10/2026)', async () => {
    forgetOllamaDerived();
    const { h } = setup();
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url));
      if (String(url).endsWith('/api/show')) return new Response(JSON.stringify({ parameters: '', model_info: { 'qwen2.context_length': 32_768 } }), { status: 200 });
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    }) as typeof fetch;
    const adapter = createOpencodeAdapter({ candidates: [], lockRetryDelayMs: () => 10, setupDeps: { fetch: fetchImpl } });
    adapter.attach(h.runtime);
    const def = definition({ engine: { adapter: 'opencode', model: 'ollama/qwen2.5-coder:7b', endpointProfile: 'ollama' } });
    const t = adapterContext(h, def, { correlationId: 'CORR-LOCALE-01' });
    await adapter.start(t.ctx);
    const out = await adapter.sendTurn(t.ctx, { turnId: 'locale-1', text: 'Rispondi soltanto con OK.' });
    expect(out.outcome).toBe('completed');
    const last = JSON.parse(readFileSync(join(h.workspace, 'fake-oc-last.json'), 'utf8')) as { argv: string[]; config: Record<string, unknown> & { tools: Record<string, boolean> } };
    expect(last.argv).toContain('ollama/visione/qwen2.5-coder:7b-ctx16k');
    expect(last.config).toMatchObject({ model: 'ollama/visione/qwen2.5-coder:7b-ctx16k', agent: { title: { disable: true } } });
    expect(last.config.tools.webfetch).toBe(false);
    expect(asked).toEqual(['http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/api/create']);
    forgetOllamaDerived();
  });

  it('agente in fiducia: OpenCode può scrivere file e lanciare comandi (24/10/2026, «gli agenti dicono di non poter scrivere»)', async () => {
    for (const trusted of [false, true]) {
      const s = setup({ trusted });
      await s.adapter.start(s.ctx);
      const out = await s.adapter.sendTurn(s.ctx, { turnId: 'fiducia-1', text: 'Rispondi soltanto con OK.' });
      expect(out.outcome).toBe('completed');
      const permission = (s.last() as { config: { permission: Record<string, string> } }).config.permission;
      if (trusted) expect(permission).toMatchObject({ edit: 'allow', bash: 'allow', external_directory: 'allow' });
      else expect(permission.bash).toBe('deny');
    }
  });

  it('turno completo: argv, config senza segreti, PWD, eventi normalizzati, sessione, token reali dall\'export', async () => {
    const s = setup();
    const session = await s.adapter.start(s.ctx);
    expect(session).toMatchObject({ engineSessionId: '', adapter: 'opencode', resumable: false });
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'turno-1', taskId: 'task-1', text: 'Rispondi soltanto con OK.' });
    expect(out).toEqual({ outcome: 'completed', error: null, engineSessionId: SESSION });

    const last = s.last();
    expect(last.argv).toEqual(['run', '--standalone', '--format', 'json', '--model', MODEL, 'Rispondi soltanto con OK.']);
    expect(last.pwd).toBe(s.h.workspace);
    expect(last.config).toMatchObject({ enabled_providers: ['nvidia'], share: 'disabled', autoupdate: false, model: MODEL });
    expect(last.config.provider.nvidia.options).toEqual({ baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: '{env:NVIDIA_API_KEY}' });
    expect(JSON.stringify(last.config)).not.toContain('valore-di-prova');
    expect(last.config.permission).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' });

    expect(s.events.map((e) => e.kind)).toEqual(['turn.started', 'session.started', 'message.text', 'usage', 'turn.finished']);
    expect(s.events.find((e) => e.kind === 'message.text')).toMatchObject({ text: 'OK', final: true, turnId: 'turno-1' });
    expect(s.events.find((e) => e.kind === 'usage')).toEqual({ kind: 'usage', source: 'session', usage: { inputTokens: 8838, outputTokens: 4, reasoningTokens: 141, cacheReadTokens: 0 } });

    // Processo del turno: proprietario con agente, task e adapter distinti; coda del motore.
    await s.h.idle();
    const created = s.h.events.filter((e) => e.type === 'process.created').map((e) => e.payload as { kind: string; owner: Record<string, unknown> });
    expect(created.find((c) => c.kind === 'agent-turn')).toMatchObject({ owner: { agentId: 'director', taskId: 'task-1', adapter: 'opencode' } });
    // versione della CLI (senza proprietario), le due guide (opzioni conosciute) ed export della sessione (dell'agente)
    expect(created.filter((c) => c.kind === 'probe').map((c) => c.owner.agentId)).toEqual([null, 'director', 'director', 'director']);
    expect(readFileSync(join(s.h.workspace, 'fake-oc-help.log'), 'utf8').trim().split(/\r?\n/).sort()).toEqual(['--help', 'run --help']);
    // Ponte verso il bus: eventi agent.* con la correlazione del turno.
    const agent = s.h.events.filter((e) => e.type.startsWith('agent.'));
    expect(agent.map((e) => e.type)).toEqual(['agent.turn.started', 'agent.session.started', 'agent.message.text', 'agent.usage.updated', 'agent.turn.finished']);
    expect(agent.every((e) => e.correlationId === 'CORR-TURNO-01' && e.source.kind === 'agent')).toBe(true);
    expect(s.h.journal.read({ limit: 50, correlationId: 'CORR-TURNO-01' }).map((e) => e.type)).toContain('agent.usage.updated');
  });

  it('turno con strumenti: tool.started/finished con esito e durata, token per step sommati', async () => {
    const s = setup();
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't2', text: 'usa uno strumento' });
    expect(out.outcome).toBe('completed');
    const finished = s.events.filter((e) => e.kind === 'tool.finished');
    expect(finished.map((e) => e.kind === 'tool.finished' && [e.tool, e.ok])).toEqual([['read', false], ['glob', true], ['read', true]]);
    expect(finished.every((e) => e.kind === 'tool.finished' && typeof e.durationMs === 'number')).toBe(true);
    expect(s.events.filter((e) => e.kind === 'tool.started')).toHaveLength(3);
    expect(s.events.find((e) => e.kind === 'usage' && e.source === 'turn')).toMatchObject({ usage: { inputTokens: 18_273, outputTokens: 86, reasoningTokens: 62, cacheReadTokens: 8_672 } });
    await s.h.idle();
    expect(s.h.events.filter((e) => e.type === 'tool.call.finished')).toHaveLength(3);
  });

  it('ripresa della sessione con --session; testo lungo o multi-riga passato via file, mai in argv', async () => {
    const s = setup();
    const resume: AgentSession = { id: 'ses-visione', engineSessionId: SESSION, adapter: 'opencode', startedAt: 0, resumable: true };
    s.setSession(resume);
    const text = `prima riga\nseconda riga ${'x'.repeat(2_000)}`;
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't3', text });
    expect(out.outcome).toBe('completed');
    const last = s.last();
    expect(last.argv.slice(0, 6)).toEqual(['run', '--standalone', '--format', 'json', '--session', SESSION]);
    expect(last.argv).toContain('--file');
    expect(last.argv.join(' ')).not.toContain('seconda riga');
    expect(last.fileText).toBe(text);
    expect(existsSync(join(s.ctx.agentDir, 'brief', 't3.md'))).toBe(true);
    expect(s.events.some((e) => e.kind === 'session.started')).toBe(false); // stessa sessione
  });

  it('sessione inesistente → failed con session_not_found', async () => {
    const s = setup();
    s.setSession({ id: 'x', engineSessionId: 'ses_inesistente000000000000', adapter: 'opencode', startedAt: 0, resumable: true });
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't4', text: 'ciao' });
    expect(out).toMatchObject({ outcome: 'failed', error: { code: 'session_not_found' } });
    expect(s.events.at(-1)).toMatchObject({ kind: 'turn.finished', outcome: 'failed', error: { code: 'session_not_found' } });
  });

  it('senza provider disponibile (nessuna chiave nell\'ambiente) → provider_unavailable, nessun dato inventato', async () => {
    const s = setup({ key: false });
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't5', text: 'ciao' });
    expect(out).toMatchObject({ outcome: 'failed', error: { code: 'provider_unavailable', retryable: true } });
    expect(s.events.some((e) => e.kind === 'message.text')).toBe(false);
  });

  it('senza CLI installata → probe non disponibile e turno failed con not_found', async () => {
    const s = setup({ cli: false });
    const probe = await s.adapter.probe();
    expect(probe.available).toBe(false);
    expect(probe.problems[0]).toMatch(/non trovato/);
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't6', text: 'ciao' });
    expect(out).toMatchObject({ outcome: 'failed', error: { code: 'not_found' } });
  });

  it('permesso "ask" in run: rifiutato dal motore → turno failed, strumento non eseguito', async () => {
    const s = setup();
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't7', text: 'prova ask' });
    expect(out.outcome).toBe('failed');
    expect(s.events.find((e) => e.kind === 'tool.finished')).toMatchObject({ tool: 'shell', ok: false });
  });

  it('annullamento del turno: processo terminato (cancelled), turno cancelled, nessun export', async () => {
    const s = setup();
    const pending = s.adapter.sendTurn(s.ctx, { turnId: 't8', text: 'turno lento' });
    await new Promise((r) => setTimeout(r, 1_500));
    await s.adapter.cancelTurn(s.ctx, 'basta così');
    const out = await pending;
    expect(out).toMatchObject({ outcome: 'cancelled', error: { code: 'cancelled' } });
    await s.h.idle();
    expect(s.h.events.some((e) => e.type === 'process.cancelled')).toBe(true);
    const exports = s.h.events.filter((e) => e.type === 'process.created' && (e.payload as { kind: string; owner: { agentId: string | null } }).owner.agentId !== null
      && (e.payload as { kind: string }).kind === 'probe');
    // Solo le due letture della guida, prima del turno: nessun export.
    expect(exports).toHaveLength(2);
    expect(readFileSync(join(s.h.workspace, 'fake-oc-help.log'), 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
  });

  it('database del motore bloccato: ritenta (al massimo 3 volte) e poi riesce', async () => {
    const s = setup();
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 't9', text: 'database bloccato' });
    expect(out.outcome).toBe('completed');
    await s.h.idle();
    const turns = s.h.events.filter((e) => e.type === 'process.created' && (e.payload as { kind: string }).kind === 'agent-turn');
    expect(turns).toHaveLength(3);
  });

  // OpenCode 1.19.3, l'ultima su npm e quella che la guidata installa ai tester (21/10/2026): con
  // `--standalone` ogni turno usciva con codice 1 e tutti gli agenti OpenCode fallivano la verifica.
  it('OpenCode 1.x (npm): niente --standalone, eventi con callID, token da `opencode export`', async () => {
    const s = setup({ version: '1.19.3' });
    expect((await s.adapter.probe()).version).toBe('1.19.3');
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'v1-1', text: 'Leggi e scrivi.' });
    expect(out).toEqual({ outcome: 'completed', error: null, engineSessionId: 'ses_ea065a498ffeij3LJzHO25lr5f' });
    expect(s.last().argv).toEqual(['run', '--format', 'json', '--model', MODEL, 'Leggi e scrivi.']);
    const tools = s.events.filter((e) => e.kind === 'tool.finished');
    expect(tools).toMatchObject([
      { tool: 'read', ok: true, toolCallId: 'call-34317dbd-34c7-441c-8722-5c4f6ba3cefa' },
      { tool: 'write', ok: true, toolCallId: 'call-538eeddc-e984-47bb-9857-ccd27d17caea' }
    ]);
    expect(s.events.some((e) => e.kind === 'message.text')).toBe(true);
    expect(s.events.filter((e) => e.kind === 'usage').map((e) => (e as { source: string }).source)).toEqual(['turn', 'session']);
  });

  it('OpenCode 1.x, testo lungo via file: il messaggio prima di `--file` (array nella 1.x), il file arriva intero', async () => {
    const s = setup({ version: '1.19.3' });
    const text = `Brief della verifica\nseconda riga\n${'x'.repeat(1_200)}`;
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'v1-lungo', text });
    expect(out).toMatchObject({ outcome: 'completed' });
    const last = s.last();
    expect(last.argv.slice(0, 6)).toEqual(['run', '--format', 'json', '--model', MODEL, 'Esegui le istruzioni contenute nel file allegato.']);
    expect(last.argv[6]).toBe('--file');
    expect(last.fileText).toBe(text);
  });

  it('OpenCode 1.x senza chiave valida: errore del provider letto dalla forma {name, data}', async () => {
    const s = setup({ version: '1.19.3', key: false });
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'v1-2', text: 'ciao' });
    expect(out).toMatchObject({ outcome: 'failed', error: { code: 'provider_unavailable' } });
    expect(out.error?.message).toMatch(/APIError.*Authorization failed/);
  });

  it('le opzioni si leggono dalla guida, non dal numero: una 1.x con la versione illeggibile funziona lo stesso', async () => {
    const s = setup({ version: '1-muta' });
    expect((await s.adapter.probe()).version).toBe('opencode');
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'v1-3', text: 'ciao' });
    expect(out).toMatchObject({ outcome: 'completed' });
    expect(s.last().argv.slice(0, 3)).toEqual(['run', '--format', 'json']);
    // Secondo turno: la guida non si rilegge (una lettura per eseguibile e versione).
    const helps = () => readFileSync(join(s.h.workspace, 'fake-oc-help.log'), 'utf8').trim().split(/\r?\n/);
    expect(helps().sort()).toEqual(['--help', 'run --help']);
    await s.adapter.sendTurn(s.ctx, { turnId: 'v1-4', text: 'ciao' });
    expect(helps()).toHaveLength(2);
  });

  it('guida e versione illeggibili e argomenti rifiutati: il motivo arriva nel messaggio, non solo «codice 1»', async () => {
    const s = setup({ version: '1-muta', nohelp: true });
    const out = await s.adapter.sendTurn(s.ctx, { turnId: 'v1-5', text: 'ciao' });
    expect(out).toMatchObject({ outcome: 'failed' });
    expect(out.error?.message).toMatch(/non ha riconosciuto gli argomenti/);
  });

  it('validazione: modello obbligatorio provider/modello e profilo coerente', () => {
    const s = setup();
    expect(s.adapter.validate(definition({ engine: { adapter: 'opencode' } }))).toMatchObject({ ok: false });
    expect(s.adapter.validate(definition({ engine: { adapter: 'opencode', model: 'senzaprovider' } }))).toMatchObject({ ok: false });
    expect(s.adapter.validate(definition({ engine: { adapter: 'opencode', model: 'altro/modello' } }))).toMatchObject({ ok: false });
    expect(s.adapter.validate(definition({ engine: { adapter: 'opencode', model: MODEL, endpointProfile: 'nvidia-proxy-locale' } }))).toEqual({ ok: true });
  });

  it('P-93: DeepSeek è un profilo endpoint reale e la config non contiene chiavi (auth memorizzata)', () => {
    const s = setup();
    expect(s.adapter.supportsModel?.('deepseek/deepseek-flash')).toBe(true);
    expect(s.adapter.validate(definition({ engine: { adapter: 'opencode', model: 'deepseek/deepseek-flash' } }))).toEqual({ ok: true });
    // Il modello DeepSeek appartiene al provider `deepseek`: abbinarlo a `nvidia` viene rifiutato.
    expect(s.adapter.validate(definition({ engine: { adapter: 'opencode', model: 'deepseek/deepseek-flash', endpointProfile: 'nvidia' } }))).toMatchObject({ ok: false });
    const deepseek = DEFAULT_ENDPOINT_PROFILES.find((p) => p.id === 'deepseek');
    expect(deepseek).toMatchObject({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKeyEnv: null });
    const content = buildConfigContent({ model: 'deepseek/deepseek-flash', profile: deepseek as NonNullable<typeof deepseek>, permissions: 'workspace-write' });
    // Nessuna chiave in chiaro né riferimento a variabili d'ambiente: usa l'autenticazione della CLI.
    expect(content).not.toContain('apiKey');
    expect(content).not.toContain('{env:');
    expect(JSON.parse(content)).toMatchObject({ model: 'deepseek/deepseek-flash', enabled_providers: ['deepseek'], permission: { edit: 'allow', bash: 'deny', webfetch: 'deny' } });
  });
});
