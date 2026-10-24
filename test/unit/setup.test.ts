// Procedura guidata, parte core (P-105): requisiti dichiarati dai motori, Ollama, verifica della
// chiave NVIDIA, stato dell'accesso a Claude, variabili dell'utente e comandi `setup.*`. Nessuna
// rete e nessun registro veri: fetch, runner e salvataggio sono finti. Il punto più controllato: il
// valore di una chiave non compare mai in risultati, log, argomenti di processo o errori.
import { describe, expect, it } from 'vitest';
import { claudeSetupItems, parseAuthStatus } from '../../src/core/adapters/claude-code/setup.ts';
import { DEFAULT_ENDPOINT_PROFILES } from '../../src/core/adapters/opencode/command.ts';
import { NVIDIA_CANDIDATES, NVIDIA_KEY_CHECK_URL, NVIDIA_MODELS_URL, checkNvidiaKey, opencodeCatalog, opencodeSetupItems, readNvidiaCatalog, readOllama } from '../../src/core/adapters/opencode/setup.ts';
import { NVIDIA_CHAT_URL, forgetNvidiaProbes, probeNvidiaModel } from '../../src/core/adapters/providers/nvidia.ts';
import { derivedModelName, forgetOllamaDerived, ollamaAgentModel, ollamaIgpuFromLog } from '../../src/core/adapters/providers/ollama.ts';
import { toItem } from '../../src/core/setup/item.ts';
import type { AgentManager } from '../../src/core/agents/index.ts';
import type { AgentDefinition, AgentDefinitionInput } from '../../src/shared/contracts/index.ts';
import type { AdapterRegistry, AgentAdapter } from '../../src/core/adapters/index.ts';
import type { CommandRouter } from '../../src/core/commands/index.ts';
import { detectSetup, registerSetupCommands } from '../../src/core/setup/index.ts';
import { SYSTEM_SETUP, VC_RUNTIME_DLLS, missingVcRuntime, systemSetupItems } from '../../src/core/setup/system.ts';
import { setUserEnv, userEnvPresence, type SystemRunner } from '../../src/shared/node/user-env.ts';
import { memoryLogger } from '../helpers.ts';

// Chiavi finte costruite a runtime: nel sorgente non c'è nessuna forma di segreto (check-repo).
const KEY = ['nvapi', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'].join('-');
const WRONG_KEY = ['nvapi', 'sbagliata', '000000000000000000'].join('-');

function fakeFetch(status: number | 'errore', body: unknown = {}): { fetch: typeof fetch; calls: Array<{ url: string; auth: string | null }> } {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get('authorization') });
    if (status === 'errore') throw new Error('connessione rifiutata');
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('OpenCode: requisiti per la procedura (P-105)', () => {
  it('CLI assente: guida con Node.js e npm; presente: versione', () => {
    const missing = opencodeSetupItems({ cli: { found: false, problem: 'non nel PATH' }, nvidiaKey: null, ollama: { running: false, models: [] } });
    expect(missing[0]).toMatchObject({ id: 'installato', ok: false, optional: false, commands: ['winget install OpenJS.NodeJS.LTS', 'npm.cmd install -g --no-audit --no-fund --no-update-notifier --allow-scripts=opencode-ai opencode-ai@1.19.3'] });
    expect(missing[0]!.detail).toContain('non nel PATH');
    const ok = opencodeSetupItems({ cli: { found: true, version: '2.0.12' }, nvidiaKey: null, ollama: { running: false, models: [] } });
    expect(ok[0]).toMatchObject({ ok: true, detail: 'installato, versione 2.0.12' });
    const raw = opencodeSetupItems({ cli: { found: true, version: 'opencode v2.0.12' }, nvidiaKey: null, ollama: { running: false, models: [] } });
    expect(raw[0]!.detail).toBe('installato, versione 2.0.12');
  });

  it('chiave NVIDIA: assente → passi e campo per incollarla; presente → solo presenza, mai il valore', () => {
    const none = opencodeSetupItems({ cli: { found: true, version: null }, nvidiaKey: null, ollama: { running: false, models: [] } })[1]!;
    expect(none).toMatchObject({ id: 'chiave-nvidia', ok: false, optional: true, forProfile: 'nvidia', link: 'https://build.nvidia.com', action: { kind: 'env-key', envName: 'NVIDIA_API_KEY' } });
    expect(none.steps.join(' ')).toMatch(/Get API Key/);
    for (const where of ['processo', 'utente'] as const) {
      const item = opencodeSetupItems({ cli: { found: true, version: null }, nvidiaKey: where, ollama: { running: false, models: [] } })[1]!;
      expect(item.ok).toBe(true);
      expect(item.detail).toMatch(/Verifica/);
      expect(JSON.stringify(item)).not.toMatch(/nvapi-/);
    }
  });

  it('Ollama: spento, acceso senza modelli, acceso con modelli; facoltativo', () => {
    const items = (running: boolean, models: string[]) => opencodeSetupItems({ cli: { found: true, version: null }, nvidiaKey: null, ollama: { running, models } })[2]!;
    expect(items(false, [])).toMatchObject({ ok: false, optional: true, commands: ['winget install Ollama.Ollama', 'ollama pull qwen2.5-coder:7b'] });
    expect(items(true, [])).toMatchObject({ ok: false, detail: 'acceso ma senza modelli', commands: ['ollama pull qwen2.5-coder:7b'] });
    expect(items(true, ['qwen2.5-coder:7b', 'llama3.2:3b'])).toMatchObject({ ok: true, detail: 'acceso, 2 modelli: qwen2.5-coder:7b, llama3.2:3b' });
  });

  it('profilo endpoint ollama: loopback, nessuna chiave, modello sul PC', () => {
    expect(DEFAULT_ENDPOINT_PROFILES.find((p) => p.id === 'ollama')).toEqual({ id: 'ollama', provider: 'ollama', npm: '@ai-sdk/openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: null, local: true });
  });

  it('readOllama: elenco dai /api/tags, risposta non ok = acceso senza modelli, errore = spento', async () => {
    const ok = fakeFetch(200, { models: [{ name: 'qwen2.5-coder:7b' }, { name: 42 }, {}] });
    expect(await readOllama(ok.fetch)).toEqual({ running: true, models: ['qwen2.5-coder:7b'] });
    expect(ok.calls[0]!.url).toBe('http://127.0.0.1:11434/api/tags');
    expect(await readOllama(fakeFetch(500).fetch)).toEqual({ running: true, models: [] });
    expect(await readOllama(fakeFetch('errore').fetch)).toEqual({ running: false, models: [] });
  });

  it('readOllama: dal modello più leggero, senza embedding né modelli derivati da VISIONE (21/10/2026: prendeva il 16b)', async () => {
    const tags = fakeFetch(200, { models: [
      { name: 'deepseek-coder-v2:16b', size: 8_905_126_121 },
      { name: 'visione/huihui_ai-qwen2.5-abliterate:7b-ctx16k', size: 4_683_087_074 },
      { name: 'nomic-embed-text:latest', size: 274_302_450 },
      { name: 'huihui_ai/qwen2.5-abliterate:7b', size: 4_683_087_428 },
      { name: 'senza-misura:1b' }
    ] });
    expect((await readOllama(tags.fetch)).models).toEqual(['huihui_ai/qwen2.5-abliterate:7b', 'deepseek-coder-v2:16b', 'senza-misura:1b']);
  });

  it('grafica integrata di Ollama: dal registro (righe vere del 17 e 22/10/2026) alla voce facoltativa «Attiva»', () => {
    const dropped = [
      'time=2026-10-17T17:24:53.366+02:00 level=INFO source=routes.go:2501 msg="Listening on 127.0.0.1:11434 (version 0.40.5)"',
      'time=2026-10-17T17:25:01.189+02:00 level=INFO source=runner.go:405 msg="dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1" id=0 library=Vulkan compute=0.0 name=Vulkan0 description="Intel(R) Arc(TM) Graphics" pci_id=""',
      'time=2026-10-17T17:25:01.189+02:00 level=INFO source=types.go:50 msg="inference compute" id=cpu library=cpu compute="" name=cpu description=cpu libdirs=ollama driver="" pci_id="" type="" total="15.7 GiB"'
    ].join('\n');
    const used = [
      'time=2026-10-22T00:27:01.433+02:00 level=INFO source=routes.go:2501 msg="Listening on 127.0.0.1:11435 (version 0.40.5)"',
      'time=2026-10-22T00:27:07.498+02:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=Vulkan compute=0.0 name=Vulkan0 description="Intel(R) Arc(TM) Graphics" libdirs=ollama,vulkan driver=0.0 pci_id="" type=iGPU total="9.0 GiB"'
    ].join('\n');
    expect(ollamaIgpuFromLog(dropped)).toEqual({ dropped: 'Intel(R) Arc(TM) Graphics', inUse: null });
    expect(ollamaIgpuFromLog(used)).toEqual({ dropped: null, inUse: 'Intel(R) Arc(TM) Graphics' });
    // Conta solo l'ultimo avvio nel registro.
    expect(ollamaIgpuFromLog(`${dropped}\n${used}`)).toEqual({ dropped: null, inUse: 'Intel(R) Arc(TM) Graphics' });
    expect(ollamaIgpuFromLog('')).toEqual({ dropped: null, inUse: null });

    const base = { cli: { found: true as const, version: '1.19.3' }, nvidiaKey: null, ollama: { running: true, models: ['qwen2.5-coder:7b'] } };
    const item = (igpu: { dropped: string | null; inUse: string | null; env: 'processo' | 'utente' | null } | undefined, running = true) =>
      opencodeSetupItems({ ...base, ollama: { ...base.ollama, running }, ...(igpu ? { ollamaIgpu: igpu } : {}) }).find((i) => i.id === 'ollama-grafica');
    const offer = item({ dropped: 'Intel(R) Arc(TM) Graphics', inUse: null, env: null })!;
    expect(offer).toMatchObject({ ok: false, optional: true, action: { kind: 'install', verb: 'enable', admin: false } });
    expect(offer.forProfile).toBeUndefined();
    expect(offer.detail).toContain('circa 4 volte');
    expect(offer.action?.kind === 'install' && offer.action.script).toContain("SetEnvironmentVariable('OLLAMA_IGPU_ENABLE', '1', 'User')");
    expect(toItem(offer).action).toEqual({ kind: 'install', source: 'la grafica integrata (Intel(R) Arc(TM) Graphics) per Ollama; Ollama si riavvia', admin: false, verb: 'enable' });
    expect(item({ dropped: 'Intel(R) Arc(TM) Graphics', inUse: null, env: 'utente' })!.detail).toMatch(/^attivata ma Ollama non è ripartito/);
    expect(item({ dropped: null, inUse: 'Intel(R) Arc(TM) Graphics', env: 'utente' })).toMatchObject({ ok: true, detail: 'usa Intel(R) Arc(TM) Graphics' });
    // Nessuna scheda integrata, Ollama spento o niente registro: la voce non c'è.
    expect(item({ dropped: null, inUse: null, env: null })).toBeUndefined();
    expect(item({ dropped: 'Intel(R) Arc(TM) Graphics', inUse: null, env: null }, false)).toBeUndefined();
    expect(item(undefined)).toBeUndefined();
  });

  it('ollamaAgentModel: copia con 16k di contesto creata una volta (l\'API OpenAI di Ollama ignora num_ctx, 22/10/2026)', async () => {
    const base = 'huihui_ai/qwen2.5-abliterate:7b';
    expect(derivedModelName(base)).toBe('visione/huihui_ai-qwen2.5-abliterate:7b-ctx16k');
    expect(derivedModelName('llama3')).toBe('visione/llama3:latest-ctx16k');
    const ollama = (show: unknown, create: { status: number; body: unknown } = { status: 200, body: { status: 'success' } }) => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        calls.push({ url: String(url), body });
        if (String(url).endsWith('/api/show')) return show === 'errore' ? Promise.reject(new TypeError('fetch failed')) : new Response(JSON.stringify(show), { status: 200 });
        return new Response(JSON.stringify(create.body), { status: create.status });
      }) as typeof fetch;
      return { fetch: impl, calls };
    };
    const qwen = { parameters: 'stop                           "<|im_end|>"', model_info: { 'qwen2.context_length': 32_768 } };
    forgetOllamaDerived();
    const made = ollama(qwen);
    expect(await ollamaAgentModel(base, made.fetch, 0)).toBe('visione/huihui_ai-qwen2.5-abliterate:7b-ctx16k');
    expect(made.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/api/create']);
    expect(made.calls[1]!.body).toEqual({ model: 'visione/huihui_ai-qwen2.5-abliterate:7b-ctx16k', from: base, parameters: { num_ctx: 16_384 }, stream: false });
    // Entro un minuto non si richiede niente; dopo si ricontrolla (il derivato potrebbe essere stato cancellato).
    await ollamaAgentModel(base, made.fetch, 59_000);
    expect(made.calls).toHaveLength(2);
    await ollamaAgentModel(base, made.fetch, 61_000);
    expect(made.calls).toHaveLength(4);
    // Contesto già sufficiente, modello addestrato su meno di 4096, creazione rifiutata, Ollama spento: il modello scelto.
    const cases: Array<[string, ReturnType<typeof ollama>]> = [
      ['contesto già 32k', ollama({ ...qwen, parameters: 'num_ctx                        32768' })],
      ['addestrato su 2048', ollama({ parameters: '', model_info: { 'llama.context_length': 2_048 } })],
      ['creazione rifiutata', ollama(qwen, { status: 400, body: { error: 'invalid' } })],
      ['Ollama spento', ollama('errore')]
    ];
    for (const [label, f] of cases) {
      forgetOllamaDerived();
      expect(await ollamaAgentModel(base, f.fetch, 0), label).toBe(base);
    }
    // Un modello addestrato su 8192 si allarga fino a lì, non oltre.
    forgetOllamaDerived();
    const small = ollama({ parameters: '', model_info: { 'llama.context_length': 8_192 } });
    await ollamaAgentModel('piccolo:1b', small.fetch, 0);
    expect(small.calls[1]!.body.parameters).toEqual({ num_ctx: 8_192 });
    forgetOllamaDerived();
  });

  it('checkNvidiaKey: 200 valida, 401/403 rifiutata, altro = riprova, rete assente; forma sbagliata senza chiamata', async () => {
    const good = fakeFetch(200);
    expect(await checkNvidiaKey(KEY, good.fetch)).toEqual({ ok: true, detail: 'chiave valida: NVIDIA l\'ha accettata' });
    expect(good.calls).toEqual([{ url: NVIDIA_KEY_CHECK_URL, auth: `Bearer ${KEY}` }]);
    for (const status of [401, 403]) expect((await checkNvidiaKey(KEY, fakeFetch(status).fetch)).detail).toMatch(new RegExp(`rifiutata.*HTTP ${status}`));
    expect(await checkNvidiaKey(KEY, fakeFetch(503).fetch)).toMatchObject({ ok: false, detail: expect.stringMatching(/HTTP 503: riprova/) });
    expect(await checkNvidiaKey(KEY, fakeFetch('errore').fetch)).toMatchObject({ ok: false, detail: expect.stringMatching(/non raggiungibile/) });
    const never = fakeFetch(200);
    expect((await checkNvidiaKey('sk-altro-servizio-1234567890', never.fetch)).ok).toBe(false);
    expect(never.calls).toHaveLength(0);
    for (const status of [200, 401, 503] as const) expect(JSON.stringify(await checkNvidiaKey(KEY, fakeFetch(status).fetch))).not.toContain(KEY);
  });
});

describe('Claude Code: requisiti per la procedura (P-105)', () => {
  it('parseAuthStatus: solo loggedIn, metodo e piano; email e organizzazione scartate', () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'persona@example.com', orgName: 'Ditta Privata', orgId: 'x' });
    const state = parseAuthStatus(out);
    expect(state).toEqual({ loggedIn: true, method: 'claude.ai', plan: 'max' });
    expect(JSON.stringify(state)).not.toMatch(/persona|Ditta/);
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false, method: null, plan: null });
    expect(parseAuthStatus('non json')).toBeNull();
    expect(parseAuthStatus('{"authMethod":"x"}')).toBeNull();
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"<script>alert(1)</script>"}')).toEqual({ loggedIn: true, method: null, plan: null });
  });

  it('non installato: installatore ufficiale e accesso in attesa; installato senza accesso: terminale di login', () => {
    const missing = claudeSetupItems({ cli: { found: false, problem: 'non trovato' }, auth: null });
    expect(missing[0]).toMatchObject({ id: 'installato', ok: false, commands: ['irm https://claude.ai/install.ps1 | iex'] });
    expect(missing[1]).toMatchObject({ id: 'accesso', ok: false, steps: [], commands: [] });
    expect(missing[1]!.detail).toMatch(/^prima installa Claude Code/);
    // Claude Code interattivo (18/10/2026): accesso e prima configurazione insieme; il comando col percorso vero.
    const noLogin = claudeSetupItems({ cli: { found: true, version: '2.1.293', exe: 'C:\\Users\\t\\.local\\bin\\claude.exe' }, auth: { loggedIn: false, method: null, plan: null } });
    expect(noLogin[1]).toMatchObject({ ok: false, action: { kind: 'login-terminal', args: [] }, commands: ['& "C:\\Users\\t\\.local\\bin\\claude.exe"'] });
    expect(noLogin[1]!.steps.join(' ')).toMatch(/tema.*note di sicurezza/s);
    const unreadable = claudeSetupItems({ cli: { found: true, version: '2.1.293' }, auth: null });
    expect(unreadable[1]!.detail).toMatch(/non leggibile/);
    const ready = claudeSetupItems({ cli: { found: true, version: '2.1.293' }, auth: { loggedIn: true, method: 'claude.ai', plan: 'max' } });
    expect(ready.map((i) => i.ok)).toEqual([true, true]);
    expect(ready[1]!.detail).toBe('accesso fatto (claude.ai, piano max)');
  });
});

describe('variabili dell\'utente Windows (P-105)', () => {
  const recorder = (code: number): { run: SystemRunner; calls: Array<{ exe: string; args: readonly string[]; stdin: string | undefined }> } => {
    const calls: Array<{ exe: string; args: readonly string[]; stdin: string | undefined }> = [];
    return { run: async (exe, args, stdin) => { calls.push({ exe, args, stdin }); return code; }, calls };
  };

  it('presenza: prima l\'ambiente del processo, poi il registro dell\'utente (uscita scartata), fuori da Windows null', async () => {
    const r0 = recorder(0);
    expect(await userEnvPresence('NVIDIA_API_KEY', { env: { NVIDIA_API_KEY: 'x' }, run: r0.run, platform: 'win32' })).toBe('processo');
    expect(r0.calls).toHaveLength(0);
    expect(await userEnvPresence('NVIDIA_API_KEY', { env: {}, run: r0.run, platform: 'win32' })).toBe('utente');
    expect(r0.calls[0]!.exe).toMatch(/reg\.exe$/i);
    expect(r0.calls[0]!.args).toEqual(['query', 'HKCU\\Environment', '/v', 'NVIDIA_API_KEY']);
    expect(await userEnvPresence('NVIDIA_API_KEY', { env: {}, run: recorder(1).run, platform: 'win32' })).toBeNull();
    expect(await userEnvPresence('NVIDIA_API_KEY', { env: {}, run: r0.run, platform: 'linux' })).toBeNull();
    await expect(userEnvPresence('PATH; del', { env: {} })).rejects.toThrow(/non valido/);
  });

  it('scrittura: il valore va a PowerShell solo da stdin, mai negli argomenti; valori su più righe rifiutati', async () => {
    const r = recorder(0);
    await setUserEnv('NVIDIA_API_KEY', KEY, { run: r.run, platform: 'win32' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.exe).toMatch(/powershell\.exe$/i);
    expect(r.calls[0]!.args.join(' ')).not.toContain(KEY);
    expect(r.calls[0]!.args.join(' ')).toContain("SetEnvironmentVariable('NVIDIA_API_KEY', $v, 'User')");
    expect(r.calls[0]!.stdin).toBe(`${KEY}\n`);
    await expect(setUserEnv('NVIDIA_API_KEY', 'a\nb', { run: r.run, platform: 'win32' })).rejects.toThrow(/più righe/);
    await expect(setUserEnv('NVIDIA_API_KEY', KEY, { run: recorder(1).run, platform: 'win32' })).rejects.toThrow(/codice 1/);
    try {
      await setUserEnv('NVIDIA_API_KEY', KEY, { run: recorder(5).run, platform: 'win32' });
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
    await expect(setUserEnv('NVIDIA_API_KEY', KEY, { run: r.run, platform: 'darwin' })).rejects.toThrow(/solo su Windows/);
  });
});

const adapter = (id: string, over: Partial<AgentAdapter> = {}): AgentAdapter => ({ id, capabilities: new Set(), probe: async () => ({ available: true, problems: [] }), validate: () => ({ ok: true }), start: async () => { throw new Error('no'); }, sendTurn: async () => { throw new Error('no'); }, cancelTurn: async () => undefined, stop: async () => undefined, ...over } as AgentAdapter);
const registry = (list: AgentAdapter[]): AdapterRegistry => ({ get: (id: string) => list.find((a) => a.id === id), list: () => list } as unknown as AdapterRegistry);
const routerOf = () => {
  const handlers = new Map<string, (payload: unknown, ctx?: unknown) => Promise<unknown>>();
  const router = { register: (type: string, h: (payload: unknown, ctx?: unknown) => Promise<unknown>) => handlers.set(type, h) } as unknown as CommandRouter;
  return { router, call: (type: string, payload: unknown) => handlers.get(type)!(payload, { command: { issuedBy: 'ui', correlationId: 'c1' } }) };
};

describe('comandi setup.* del core (P-105)', () => {
  const nvidia = adapter('motore-chiavi', {
    verifyKey: async (envName, value) => (envName === 'NVIDIA_API_KEY' && value === KEY ? { ok: true, detail: 'chiave valida' } : { ok: false, detail: 'chiave rifiutata' })
  });

  it('detect: raccoglie i requisiti dei motori che li dichiarano; un rilevamento che fallisce lo dice', async () => {
    const engines = await detectSetup([
      adapter('a', { setup: async () => [{ id: 'x', label: 'X', ok: true, optional: false, detail: 'ok', steps: [], commands: [], action: { kind: 'login-terminal', args: ['auth', 'login'] } }] }),
      adapter('senza-setup'),
      adapter('rotto', { setup: async () => { throw new Error('esploso'); } })
    ]);
    expect(engines.map((e) => e.adapter)).toEqual(['a', 'rotto']);
    expect(engines[0]!.items[0]!.action).toEqual({ kind: 'login-terminal', args: ['auth', 'login'] });
    expect(engines[1]!.items[0]).toMatchObject({ ok: false, detail: 'rilevamento non riuscito: esploso' });
  });

  it('saveKey: salva solo una chiave verificata dal motore, la mette nell\'ambiente del core, mai nel log', async () => {
    const saved: Array<[string, string]> = [];
    const env: Record<string, string | undefined> = {};
    const { log, records: entries } = memoryLogger();
    const { router, call } = routerOf();
    registerSetupCommands({ router, adapters: registry([nvidia]), log, processEnv: env, saveUserEnv: async (n, v) => { saved.push([n, v]); } });
    expect(await call('setup.saveKey', { adapter: 'motore-chiavi', envName: 'NVIDIA_API_KEY', value: WRONG_KEY })).toEqual({ saved: false, check: { ok: false, detail: 'chiave rifiutata' } });
    expect(saved).toHaveLength(0);
    // Un nome che il motore non riconosce (PATH) non si salva: la UI non scrive variabili qualsiasi.
    expect(await call('setup.saveKey', { adapter: 'motore-chiavi', envName: 'PATH', value: KEY })).toMatchObject({ saved: false });
    expect(saved).toHaveLength(0);
    const ok = await call('setup.saveKey', { adapter: 'motore-chiavi', envName: 'NVIDIA_API_KEY', value: KEY });
    expect(ok).toEqual({ saved: true, check: { ok: true, detail: 'chiave valida' } });
    expect(saved).toEqual([['NVIDIA_API_KEY', KEY]]);
    expect(env.NVIDIA_API_KEY).toBe(KEY);
    expect(JSON.stringify(ok)).not.toContain(KEY);
    expect(JSON.stringify(entries)).not.toContain(KEY);
    expect(JSON.stringify(entries)).toContain('NVIDIA_API_KEY');
  });

  it('verifyKey: motore sconosciuto o senza verifica = errore; dettaglio che contiene la chiave viene scartato', async () => {
    const leaky = adapter('chiacchierone', { verifyKey: async (_n, v) => ({ ok: false, detail: `ho ricevuto ${v}` }) });
    const thrower = adapter('lanciatore', { verifyKey: async (_n, v) => { throw new Error(`errore con ${v}`); } });
    const { router, call } = routerOf();
    registerSetupCommands({ router, adapters: registry([nvidia, leaky, thrower, adapter('muto')]), log: memoryLogger().log, processEnv: {}, saveUserEnv: async () => undefined });
    await expect(call('setup.verifyKey', { adapter: 'nessuno', envName: 'NVIDIA_API_KEY' })).rejects.toThrow(/sconosciuto/);
    await expect(call('setup.verifyKey', { adapter: 'muto', envName: 'NVIDIA_API_KEY' })).rejects.toThrow(/non verifica chiavi/);
    expect(await call('setup.verifyKey', { adapter: 'chiacchierone', envName: 'NVIDIA_API_KEY', value: KEY })).toEqual({ ok: false, detail: 'verifica completata' });
    expect(JSON.stringify(await call('setup.verifyKey', { adapter: 'lanciatore', envName: 'NVIDIA_API_KEY', value: KEY }))).not.toContain(KEY);
    expect(await call('setup.verifyKey', { adapter: 'motore-chiavi', envName: 'NVIDIA_API_KEY', value: KEY })).toEqual({ ok: true, detail: 'chiave valida' });
  });

  it('saveKey: errore di salvataggio senza la chiave nel messaggio; ambiente invariato', async () => {
    const env: Record<string, string | undefined> = {};
    const { router, call } = routerOf();
    registerSetupCommands({ router, adapters: registry([nvidia]), log: memoryLogger().log, processEnv: env, saveUserEnv: async (_n, v) => { throw new Error(`registro bloccato per ${v}`); } });
    const err = await call('setup.saveKey', { adapter: 'motore-chiavi', envName: 'NVIDIA_API_KEY', value: KEY }).catch((e: Error) => e);
    expect(String(err)).toMatch(/salvataggio della chiave non riuscito/);
    expect(String(err)).not.toContain(KEY);
    expect(env.NVIDIA_API_KEY).toBeUndefined();
  });
});

describe('menu dei modelli e squadra (P-105)', () => {
  it('opencodeCatalog senza prove: candidati in cima (codice, revisione, ricerca), solo modelli di chat, poi Ollama', () => {
    const ids = NVIDIA_CANDIDATES.map((c) => c.id);
    const cat = opencodeCatalog(['nvidia/nemotron-3-embed-1b', 'nvidia/nemotron-3.5-content-safety', 'meta/llama-3.3-70b-instruct', ...ids, 'strano id con spazi'], ['qwen2.5-coder:7b']);
    const top = cat.slice(0, ids.length);
    expect(top.every((c) => c.recommended && c.group === 'NVIDIA' && c.endpointProfile === 'nvidia')).toBe(true);
    expect(top.map((c) => c.model)).toEqual(ids.map((id) => `nvidia/${id}`));
    expect(top.filter((c) => c.suggestedFor).map((c) => [c.model, c.suggestedFor])).toEqual([
      ['nvidia/nvidia/nemotron-3-super-120b-a12b', 'code'],
      ['nvidia/nvidia/nemotron-3-ultra-550b-a55b', 'review'],
      ['nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', 'research']
    ]);
    expect(cat.slice(ids.length).map((c) => c.model)).toEqual(['nvidia/meta/llama-3.3-70b-instruct', 'ollama/qwen2.5-coder:7b']);
    expect(cat.at(-1)).toEqual({ model: 'ollama/qwen2.5-coder:7b', label: 'qwen2.5-coder:7b (sul tuo PC)', group: 'Ollama (locale)', endpointProfile: 'ollama' });
    // Catalogo che non risponde: i candidati restano tutti; catalogo che non li elenca più: scendono, non consigliati.
    expect(opencodeCatalog(null, []).every((c) => c.recommended)).toBe(true);
    const gone = opencodeCatalog(['openai/gpt-oss-20b'], []);
    expect(gone[0]).toMatchObject({ model: 'nvidia/openai/gpt-oss-20b', suggestedFor: 'research', recommended: true });
    expect(gone.filter((c) => c.recommended)).toHaveLength(1);
    expect(gone.find((c) => c.model.endsWith('super-120b-a12b'))).toEqual({ model: 'nvidia/nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B — non più nel catalogo NVIDIA', group: 'NVIDIA', endpointProfile: 'nvidia' });
  });

  it('opencodeCatalog con le prove: si consiglia solo chi risponde, chi non risponde scende in fondo col motivo (misura del 21/10/2026)', () => {
    const alive = new Map([['nvidia/nemotron-3-ultra-550b-a55b', 700], ['stepfun-ai/step-5-preview', 700], ['nvidia/nemotron-3.5-lightning-30b-a3b', 3_500]]);
    const probes = new Map(NVIDIA_CANDIDATES.map((c) => [c.id, alive.has(c.id)
      ? { ok: true, ms: alive.get(c.id)!, detail: 'risponde' }
      : { ok: false, ms: 400, detail: c.id.includes('super') ? 'non disponibile per il tuo account NVIDIA (HTTP 404)' : 'nessuna risposta in 15 s' }]));
    const cat = opencodeCatalog(['meta/llama-3.3-70b-instruct'], ['qwen2.5-coder:7b'], probes);
    expect(cat.slice(0, 3)).toEqual([
      { model: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', label: 'Nemotron 3 Ultra 550B — codice, revisione e lavoro generale, risponde in 0,7 s (consigliato)', group: 'NVIDIA', endpointProfile: 'nvidia', recommended: true, suggestedFor: 'code' },
      { model: 'nvidia/stepfun-ai/step-5-preview', label: 'Step 5 Preview — codice, revisione e lavoro generale, risponde in 0,7 s (consigliato)', group: 'NVIDIA', endpointProfile: 'nvidia', recommended: true, suggestedFor: 'review' },
      { model: 'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning 30B — veloce, ricerca, risponde in 3,5 s (consigliato)', group: 'NVIDIA', endpointProfile: 'nvidia', recommended: true, suggestedFor: 'research' }
    ]);
    expect(cat[3]!.model).toBe('nvidia/meta/llama-3.3-70b-instruct');
    const failed = cat.slice(4, -1);
    expect(failed).toHaveLength(NVIDIA_CANDIDATES.length - 3);
    expect(failed.every((c) => !c.recommended && !c.suggestedFor && c.group === 'NVIDIA')).toBe(true);
    expect(failed[0]).toEqual({ model: 'nvidia/nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B — non disponibile per il tuo account NVIDIA (HTTP 404)', group: 'NVIDIA', endpointProfile: 'nvidia' });
    expect(cat.at(-1)!.model).toBe('ollama/qwen2.5-coder:7b');
    // Nessun candidato vivo: nessun modello NVIDIA consigliato, la squadra la fanno gli altri motori.
    const none = new Map(NVIDIA_CANDIDATES.map((c) => [c.id, { ok: false, ms: 0, detail: 'nessuna risposta in 15 s' }]));
    expect(opencodeCatalog(null, ['qwen2.5-coder:7b'], none).some((c) => c.recommended || c.suggestedFor)).toBe(false);
  });

  it('probeNvidiaModel: una domanda di due parole con la chiave solo nell\'intestazione; 404, 429, rete, tempo scaduto', async () => {
    forgetNvidiaProbes();
    const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const answer = (status: number | 'errore' | 'muto') => (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (status === 'errore') throw new TypeError('fetch failed');
      if (status === 'muto') {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      }
      return new Response('{}', { status });
    }) as typeof fetch;
    expect(await probeNvidiaModel(KEY, 'm/vivo', answer(200))).toMatchObject({ ok: true, detail: 'risponde' });
    expect(seen[0]).toMatchObject({ url: NVIDIA_CHAT_URL, auth: `Bearer ${KEY}`, body: { model: 'm/vivo', max_tokens: 16, stream: false } });
    expect(JSON.stringify(seen[0]!.body)).not.toContain(KEY);
    expect(await probeNvidiaModel(KEY, 'm/tolto', answer(404))).toMatchObject({ ok: false, detail: 'non disponibile per il tuo account NVIDIA (HTTP 404)' });
    expect((await probeNvidiaModel(KEY, 'm/chiave', answer(403))).detail).toBe('chiave rifiutata da NVIDIA (HTTP 403)');
    expect((await probeNvidiaModel(KEY, 'm/lento', answer('muto'), 50)).detail).toBe('nessuna risposta in 0 s');
    expect((await probeNvidiaModel(KEY, 'm/rete', answer('errore'))).detail).toContain('NVIDIA non raggiungibile');
    expect((await probeNvidiaModel(KEY, 'm/troppe', answer(429))).detail).toContain('HTTP 429');
    // Senza una chiave con la forma giusta non parte nessuna richiesta (i test e le prove usano valori fittizi).
    const before = seen.length;
    expect(await probeNvidiaModel('valore-di-prova', 'm/vivo', answer(200))).toMatchObject({ ok: false, detail: 'chiave NVIDIA assente o non valida' });
    expect(seen).toHaveLength(before);
  });

  it('probeNvidiaModel: l\'esito vale 10 minuti per chiave e modello; 429 e rete non restano in memoria', async () => {
    forgetNvidiaProbes();
    let calls = 0;
    const counting = (status: number | 'errore') => (async () => {
      calls += 1;
      if (status === 'errore') throw new TypeError('fetch failed');
      return new Response('{}', { status });
    }) as typeof fetch;
    await probeNvidiaModel(KEY, 'm/a', counting(200), 1_000, 0);
    await probeNvidiaModel(KEY, 'm/a', counting(404), 1_000, 9 * 60_000);
    expect(calls).toBe(1);
    expect((await probeNvidiaModel(KEY, 'm/a', counting(404), 1_000, 11 * 60_000)).ok).toBe(false);
    expect(calls).toBe(2);
    await probeNvidiaModel(WRONG_KEY, 'm/a', counting(200), 1_000, 11 * 60_000);
    expect(calls).toBe(3);
    await probeNvidiaModel(KEY, 'm/b', counting(429), 1_000, 0);
    await probeNvidiaModel(KEY, 'm/b', counting(429), 1_000, 1);
    await probeNvidiaModel(KEY, 'm/c', counting('errore'), 1_000, 0);
    await probeNvidiaModel(KEY, 'm/c', counting('errore'), 1_000, 1);
    expect(calls).toBe(7);
    forgetNvidiaProbes();
  });

  it('readNvidiaCatalog: id del catalogo pubblico, senza chiave; errore o risposta non ok = null', async () => {
    const ok = fakeFetch(200, { data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 7 }] });
    expect(await readNvidiaCatalog(ok.fetch)).toEqual(['meta/llama-3.3-70b-instruct']);
    expect(ok.calls[0]).toEqual({ url: NVIDIA_MODELS_URL, auth: null });
    expect(await readNvidiaCatalog(fakeFetch(500).fetch)).toBeNull();
    expect(await readNvidiaCatalog(fakeFetch('errore').fetch)).toBeNull();
  });

  const fakeManager = (initial: AgentDefinition[]) => {
    const defs = new Map(initial.map((d) => [d.id, d]));
    const calls: string[] = [];
    const manager = {
      get: (id: string) => defs.get(id) ?? null,
      active: () => [...defs.values()].sort((a, b) => a.id.localeCompare(b.id)),
      define: (input: AgentDefinitionInput) => {
        calls.push('define:' + input.id);
        const created = !defs.has(input.id);
        defs.set(input.id, { ...(input as AgentDefinition), createdBy: 'test', createdAt: 0, version: 1 });
        return { agentId: input.id, version: 1, created };
      },
      archive: async (id: string) => {
        calls.push('archive:' + id);
        defs.delete(id);
        return { alreadyArchived: false };
      }
    } as unknown as AgentManager;
    return { manager, defs, calls };
  };
  const seed = (id: string, adapterId = 'motore-a'): AgentDefinition => ({ id, name: id, role: 'ruolo ' + id, competences: ['general'], engine: { adapter: adapterId }, persona: { instructions: 'persona ' + id, language: 'it' }, workspace: { root: id, isolation: 'shared' }, permissions: 'read-only', limits: { maxTurnMinutes: 10, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }, createdBy: 'seed', createdAt: 0, version: 1 });
  const validating = (id: string) => adapter(id, { validate: (def) => (def.engine.model === 'vietato' ? { ok: false, problems: ['modello non del motore'] } : { ok: true }) });
  const member = (id: string, name: string, adapterId: string, model: string) => ({ id, name, role: '', competences: ['general'], adapter: adapterId, model });

  it('catalog: raccoglie i menu dei motori che li hanno; un catalogo che fallisce resta vuoto', async () => {
    const { router, call } = routerOf();
    registerSetupCommands({ router, adapters: registry([adapter('a', { catalog: async () => [{ model: 'm1', label: 'M1', group: 'G', recommended: true }] }), adapter('b', { label: 'Motore B', catalog: async () => { throw new Error('giù'); } }), adapter('c')]), log: memoryLogger().log, processEnv: {} });
    expect(await call('setup.catalog', {})).toEqual({ engines: [{ adapter: 'a', label: 'a', models: [{ model: 'm1', label: 'M1', group: 'G', recommended: true }] }, { adapter: 'b', label: 'Motore B', models: [] }] });
  });

  it('apply: nomi doppi rifiutati; un agente non valido = nessuna scrittura; poi definisce, conserva la persona e archivia i non scelti', async () => {
    const { manager, defs, calls } = fakeManager([seed('director'), seed('esecutore'), seed('revisore')]);
    const { router, call } = routerOf();
    registerSetupCommands({ router, adapters: registry([validating('motore-a'), validating('motore-b')]), log: memoryLogger().log, processEnv: {}, agents: () => manager });
    await expect(call('setup.apply', { agents: [member('director', 'Pippo', 'motore-a', 'sonnet'), member('esecutore', 'pippo', 'motore-b', 'x')], archiveOthers: true })).rejects.toThrow(/stesso nome/);
    await expect(call('setup.apply', { agents: [member('director', 'Jarvis', 'motore-a', 'sonnet'), member('esecutore', 'Alessia', 'motore-b', 'vietato')], archiveOthers: true })).rejects.toThrow(/«Alessia»: modello non del motore/);
    await expect(call('setup.apply', { agents: [member('nuovo', 'Nuovo', 'motore-x', 'm')], archiveOthers: true })).rejects.toThrow(/motore sconosciuto/);
    expect(calls).toEqual([]);
    const out = await call('setup.apply', { agents: [member('director', 'Jarvis', 'motore-a', 'sonnet'), { ...member('pippo', 'Pippo', 'motore-b', 'nvidia/nvidia/nemotron-3-super-120b-a12b'), endpointProfile: 'nvidia' }], archiveOthers: true });
    expect(out).toEqual({ defined: ['director', 'pippo'], archived: ['esecutore', 'revisore'] });
    expect(defs.get('director')).toMatchObject({ name: 'Jarvis', role: 'ruolo director', persona: { instructions: 'persona director' }, engine: { adapter: 'motore-a', model: 'sonnet' } });
    expect(defs.get('pippo')).toMatchObject({ name: 'Pippo', role: 'agente VISIONE', persona: { instructions: 'Rispondi in italiano.' }, workspace: { root: 'pippo' }, engine: { adapter: 'motore-b', model: 'nvidia/nvidia/nemotron-3-super-120b-a12b', endpointProfile: 'nvidia' } });
    expect([...defs.keys()].sort()).toEqual(['director', 'pippo']);
  });

  it('apply senza archiviare: gli altri agenti restano; senza agenti pronti = errore chiaro', async () => {
    const { manager, defs } = fakeManager([seed('director'), seed('revisore')]);
    const { router, call } = routerOf();
    registerSetupCommands({ router, adapters: registry([validating('motore-a')]), log: memoryLogger().log, processEnv: {}, agents: () => manager });
    expect(await call('setup.apply', { agents: [{ ...member('director', 'Capo', 'motore-a', 'sonnet'), competences: ['reasoning'] }], archiveOthers: false })).toEqual({ defined: ['director'], archived: [] });
    expect([...defs.keys()].sort()).toEqual(['director', 'revisore']);
    const empty = routerOf();
    registerSetupCommands({ router: empty.router, adapters: registry([]), log: memoryLogger().log, processEnv: {}, agents: () => null });
    await expect(empty.call('setup.apply', { agents: [member('a', 'A', 'x', 'y')], archiveOthers: true })).rejects.toThrow(/non sono ancora pronti/);
  });

  it('login: terminale con il programma di accesso del motore (non una shell); motore assente o non installato = errore chiaro', async () => {
    const opened: Array<{ exe: string; args: readonly string[]; by: string }> = [];
    const session = { processId: 'p1', kind: 'terminal', owner: { agentId: null, sessionId: null, taskId: null, adapter: null }, status: 'running', interactive: true, title: 'claude', createdAt: 1, endedAt: null } as const;
    const { router, call } = routerOf();
    registerSetupCommands({
      router,
      adapters: registry([
        adapter('con-accesso', { loginCommand: async () => ({ exe: 'C:/bin/motore.exe', args: ['auth', 'login'] }) }),
        adapter('non-installato', { loginCommand: async () => null }),
        adapter('senza-accesso')
      ]),
      log: memoryLogger().log,
      processEnv: {},
      openTerminal: async (o) => { opened.push({ exe: o.command.exe, args: o.command.args, by: o.by }); return session; }
    });
    expect(await call('setup.login', { adapter: 'con-accesso', cols: 110, rows: 26 })).toEqual({ session });
    expect(opened).toEqual([{ exe: 'C:/bin/motore.exe', args: ['auth', 'login'], by: 'owner:ui' }]);
    await expect(call('setup.login', { adapter: 'non-installato', cols: 110, rows: 26 })).rejects.toThrow(/non trovato/);
    await expect(call('setup.login', { adapter: 'senza-accesso', cols: 110, rows: 26 })).rejects.toThrow(/non ha un accesso/);
    await expect(call('setup.login', { adapter: 'nessuno', cols: 110, rows: 26 })).rejects.toThrow(/sconosciuto/);
    expect(opened).toHaveLength(1);
  });

  it('install (17/10/2026): lo script lo rilegge dal motore (la UI sceglie solo il requisito), PowerShell codificato nel terminale', async () => {
    const opened: Array<{ exe: string; args: readonly string[] }> = [];
    const session = { processId: 'p2', kind: 'terminal', owner: { agentId: null, sessionId: null, taskId: null, adapter: null }, status: 'running', interactive: true, title: 'powershell', createdAt: 1, endedAt: null } as const;
    const install = { kind: 'install', source: 'installatore ufficiale', admin: false, script: "Step 'prova' { echo 'ciao $env:USERNAME' | Out-Host }" } as const;
    let refreshed = 0;
    const { router, call } = routerOf();
    registerSetupCommands({
      router,
      adapters: registry([
        adapter('motore', { setup: async () => [
          { id: 'installato', label: 'Motore installato', ok: false, optional: false, detail: 'non trovato', steps: [], commands: [], action: install },
          { id: 'fatto', label: 'Già a posto', ok: true, optional: false, detail: 'ok', steps: [], commands: [], action: install },
          { id: 'chiave', label: 'Chiave', ok: false, optional: true, detail: 'manca', steps: [], commands: [], action: { kind: 'env-key', envName: 'X_KEY' } }
        ] })
      ]),
      log: memoryLogger().log,
      processEnv: {},
      shell: async () => ({ exe: 'C:/ps/powershell.exe', args: ['-NoLogo'] }),
      refreshPath: async () => { refreshed++; },
      openTerminal: async (o) => { opened.push({ exe: o.command.exe, args: o.command.args }); return session; }
    });
    expect(await call('setup.install', { adapter: 'motore', item: 'installato', cols: 110, rows: 26 })).toEqual({ session });
    expect(opened[0]!.exe).toBe('C:/ps/powershell.exe');
    // La PowerShell del terminale (trovata dalla discovery, consentita dalla policy), con i suoi argomenti.
    expect(opened[0]!.args.slice(0, 5)).toEqual(['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    const script = Buffer.from(opened[0]!.args[5]!, 'base64').toString('utf16le');
    expect(script).toContain(install.script); // intatto: virgolette, $ e | compresi
    expect(script.indexOf('Update-VisionePath\n')).toBeGreaterThan(-1);
    expect(script.indexOf('Update-VisionePath\n')).toBeLessThan(script.indexOf(install.script));
    await expect(call('setup.install', { adapter: 'motore', item: 'fatto', cols: 110, rows: 26 })).rejects.toThrow(/già a posto/);
    await expect(call('setup.install', { adapter: 'motore', item: 'chiave', cols: 110, rows: 26 })).rejects.toThrow(/niente da installare/);
    await expect(call('setup.install', { adapter: 'nessuno', item: 'installato', cols: 110, rows: 26 })).rejects.toThrow(/sconosciuto/);
    expect(opened).toHaveLength(1);
    // Alla UI arrivano fonte e permesso, mai lo script; prima di ogni controllo il PATH si rilegge.
    const detected = await call('setup.detect', {}) as { engines: Array<{ items: Array<{ action?: unknown }> }> };
    expect(detected.engines[0]!.items[0]!.action).toEqual({ kind: 'install', source: 'installatore ufficiale', admin: false });
    expect(refreshed).toBe(1);
  });

  it('install di un requisito di VISIONE (runtime di Visual C++, 18/10/2026): script del core, mai della UI', async () => {
    const opened: Array<readonly string[]> = [];
    const session = { processId: 'p3', kind: 'terminal', owner: { agentId: null, sessionId: null, taskId: null, adapter: null }, status: 'running', interactive: true, title: 'powershell', createdAt: 1, endedAt: null } as const;
    let missing = ['msvcp140.dll'];
    const { router, call } = routerOf();
    registerSetupCommands({
      router,
      adapters: registry([]),
      log: memoryLogger().log,
      processEnv: {},
      shell: async () => ({ exe: 'C:/ps/powershell.exe', args: [] }),
      openTerminal: async (o) => { opened.push(o.command.args); return session; },
      systemItems: () => systemSetupItems(missing)
    });
    expect(await call('setup.install', { adapter: SYSTEM_SETUP, item: 'runtime-vc', cols: 110, rows: 26 })).toEqual({ session });
    const script = Buffer.from(opened[0]![4]!, 'base64').toString('utf16le');
    expect(script).toContain('winget install --id Microsoft.VCRedist.2015+.x64 -e --source winget');
    missing = [];
    await expect(call('setup.install', { adapter: SYSTEM_SETUP, item: 'runtime-vc', cols: 110, rows: 26 })).rejects.toThrow(/niente da installare/);
    expect(opened).toHaveLength(1);
  });
});

describe('requisiti di sistema (PC vergine, 18/10/2026)', () => {
  it('runtime di Visual C++: si cercano in System32 le DLL che onnxruntime importa; fuori da Windows niente', () => {
    const present = new Set(['C:/Win/System32/vcruntime140.dll', 'C:/Win/System32/vcruntime140_1.dll']);
    const exists = (p: string): boolean => present.has(p.replaceAll('\\', '/'));
    expect(missingVcRuntime({ platform: 'win32', systemRoot: 'C:/Win', exists })).toEqual(['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll']);
    expect(missingVcRuntime({ platform: 'win32', systemRoot: 'C:/Win', exists: () => true })).toEqual([]);
    expect(missingVcRuntime({ platform: 'linux', exists: () => false })).toEqual([]);
    expect(VC_RUNTIME_DLLS).toHaveLength(5);
  });

  it('il requisito dice cosa manca, offre «Installa» col pacchetto ufficiale (con permesso) e i passi a mano', () => {
    expect(systemSetupItems([])).toEqual([]);
    const [item] = systemSetupItems(['msvcp140.dll']);
    expect(item).toMatchObject({ id: 'runtime-vc', ok: false, optional: false, action: { kind: 'install', admin: true } });
    expect(item!.detail).toContain('componente gratuito di Microsoft');
    expect(item!.detail).not.toContain('.dll'); // in parole: i nomi dei file non dicono niente a chi prova VISIONE
    expect(item!.commands).toEqual(['winget install --id Microsoft.VCRedist.2015+.x64 -e']);
  });
});

describe('«Installa» dei motori (17/10/2026)', () => {
  it('Claude Code: installatore ufficiale, senza permessi di amministratore; installato = nessuna azione', () => {
    const [missing] = claudeSetupItems({ cli: { found: false, problem: 'non trovato' }, auth: null });
    expect(missing!.action).toMatchObject({ kind: 'install', admin: false });
    expect(missing!.action?.kind === 'install' && missing!.action.script).toContain('irm https://claude.ai/install.ps1 | iex');
    const [ok] = claudeSetupItems({ cli: { found: true, version: '2.1.0' }, auth: { loggedIn: true, method: null, plan: null } });
    expect(ok!.action).toBeUndefined();
  });

  it('OpenCode: Node.js con winget solo se manca, poi npm; Ollama facoltativo con il modello consigliato', () => {
    const items = opencodeSetupItems({ cli: { found: false, problem: 'non trovato' }, nvidiaKey: null, ollama: { running: false, models: [] } });
    const cli = items.find((i) => i.id === 'installato')!;
    expect(cli.action).toMatchObject({ kind: 'install', admin: true });
    const script = cli.action?.kind === 'install' ? cli.action.script : '';
    expect(script).toMatch(/Get-Command node[\s\S]*OpenJS\.NodeJS\.LTS[\s\S]*Update-VisionePath[\s\S]*npm\.cmd install -g --no-audit --no-fund --no-update-notifier --allow-scripts=opencode-ai opencode-ai@1\.19\.3 }/);
    const ollama = items.find((i) => i.id === 'ollama')!;
    expect(ollama.action).toMatchObject({ kind: 'install', admin: true });
    expect(ollama.action?.kind === 'install' && ollama.action.script).toContain('ollama pull qwen2.5-coder:7b');
    // Ollama già acceso: solo il modello, nessun permesso da chiedere.
    const on = opencodeSetupItems({ cli: { found: true, version: '1.0.0' }, nvidiaKey: null, ollama: { running: true, models: [] } }).find((i) => i.id === 'ollama')!;
    expect(on.action).toMatchObject({ kind: 'install', admin: false });
  });
});
