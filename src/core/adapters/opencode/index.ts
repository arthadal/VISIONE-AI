// Adapter `opencode` (VISIONE_AGENT_ARCHITECTURE §5, P-7, P-8): un turno = un processo
// `opencode run --standalone --format json` in pipe; sessione ripresa con `--session`; token
// reali da `opencode session export`. Opzioni e comando di esportazione si adattano a ciò che la CLI
// installata dichiara nella sua guida (la 1.x di npm non ha `--standalone` e usa `opencode export`). Nessun TUI pilotato, nessun plugin, nessun servizio
// condiviso, nessuna API proprietaria: solo la CLI già installata con il provider dell'utente.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeError, type AgentCapability, type AgentDefinition, type AgentUsage, type RuntimeError } from '../../../shared/contracts/index.ts';
import { ulid } from '../../../shared/lib/ulid.ts';
import type { ManagedProcess, ResolvedCli } from '../../runtime/index.ts';
import type { AdapterContext, AdapterModelOption, AdapterProbe, AgentAdapter, TurnInput, TurnOutcome } from '../index.ts';
import { formatProbeCommand } from '../probe-command.ts';
import {
  DEFAULT_ENDPOINT_PROFILES,
  buildConfigContent,
  buildExportArgs,
  buildTurnArgs,
  featuresFromHelp,
  featuresFromVersion,
  fileMessage,
  needsFile,
  splitModel,
  type EndpointProfile,
  type OpencodeFeatures
} from './command.ts';
import { parseRunLine, parseSessionExport, stderrReason, sumUsage } from './parser.ts';
import { NVIDIA_KEY_ENV, checkNvidiaKey, opencodeCatalog, opencodeSetupItems, readNvidiaCatalog, readOllama } from './setup.ts';
import { isNvidiaKey, nvidiaQuickText, probeNvidiaCandidates, probeNvidiaModel } from '../providers/nvidia.ts';
import { OLLAMA_IGPU_ENV, ollamaAgentModel, ollamaIgpuFromLog, readOllamaLog } from '../providers/ollama.ts';
import { userEnvPresence, type UserEnvDeps } from '../../../shared/node/user-env.ts';

export const OPENCODE_ADAPTER_ID = 'opencode';

export interface OpencodeAdapterOptions {
  /** Percorsi noti dove cercare la CLI se non è nel PATH (es. l'installatore di ai-neurale). */
  readonly candidates?: readonly string[];
  readonly endpointProfiles?: readonly EndpointProfile[];
  /** Ritentativi su `database is locked` (avvii concorrenti, misurato da ai-neurale). */
  readonly lockRetries?: number;
  readonly lockRetryDelayMs?: () => number;
  readonly startTimeoutMs?: number;
  /** Procedura guidata (P-105): rete e variabili dell'utente, finte nei test. */
  readonly setupDeps?: { readonly fetch?: typeof fetch; readonly userEnv?: UserEnvDeps; readonly ollamaLog?: () => string };
  /** Agente in modalità fiducia (P-102, chi comanda sempre): permessi pieni, letti a ogni turno. */
  readonly isTrusted?: (agentId: string) => boolean;
}

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set(['turns.headless', 'session.resume', 'events.tools', 'events.turnEnd', 'usage.tokens', 'model.select']);

export function defaultOpencodeCandidates(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Programs', 'opencode-bin', 'opencode.exe'));
  if (env.APPDATA) out.push(join(env.APPDATA, 'npm', 'opencode.cmd'));
  if (env.USERPROFILE) out.push(join(env.USERPROFILE, '.opencode', 'bin', 'opencode.exe'));
  return out;
}

export function createOpencodeAdapter(opts: OpencodeAdapterOptions = {}): AgentAdapter & { attach(runtime: AdapterContext['runtime']): void } {
  const profiles = opts.endpointProfiles ?? DEFAULT_ENDPOINT_PROFILES;
  const lockRetries = opts.lockRetries ?? 3;
  const lockDelay = opts.lockRetryDelayMs ?? (() => 2_000 + Math.floor(Math.random() * 3_000));
  const running = new Map<string, { process: ManagedProcess | null; cancel: AbortController }>();
  let runtimeRef: AdapterContext['runtime'] | null = null;

  const discover = async (refresh = false) => {
    if (!runtimeRef) return { found: false as const, name: 'opencode', problem: 'runtime non collegato' };
    return runtimeRef.discovery.discover('opencode', { candidates: opts.candidates ?? defaultOpencodeCandidates, refresh });
  };

  // Una lettura della guida per eseguibile e versione: un aggiornamento di OpenCode la fa rileggere da sola.
  // Una lettura fallita non resta in memoria: al turno dopo si riprova.
  const features = new Map<string, Promise<OpencodeFeatures>>();
  const featuresOf = (ctx: AdapterContext, cli: ResolvedCli): Promise<OpencodeFeatures> => {
    const key = `${cli.exe}|${cli.prefixArgs.join(' ')}|${cli.version ?? ''}`;
    const known = features.get(key);
    if (known) return known;
    const help = async (args: string[]): Promise<string | null> => {
      const res = await ctx.runtime.run({
        exe: cli.exe,
        args: [...cli.prefixArgs, ...args],
        cwd: ctx.workspaceDir,
        env: ctx.runtime.env(ctx.workspaceDir),
        io: 'pipes',
        kind: 'probe',
        owner: { agentId: ctx.instance.agentId, sessionId: ctx.instance.session?.id ?? null, adapter: OPENCODE_ADAPTER_ID },
        correlationId: ulid(),
        queueKey: OPENCODE_ADAPTER_ID,
        runTimeoutMs: 20_000,
        gracefulStop: 'none',
        emitOutput: false
      }, { maxChars: 200_000 });
      return res.ok ? `${res.output.stdout}\n${res.output.stderr}` : null;
    };
    const read = (async () => {
      const [runHelp, mainHelp] = await Promise.all([help(['run', '--help']), help(['--help'])]);
      const found = featuresFromHelp(runHelp, mainHelp);
      if (!found) features.delete(key);
      const out = found ?? featuresFromVersion(cli.version);
      ctx.log.info('opzioni di OpenCode', { version: cli.version, fromHelp: found !== null, ...out });
      return out;
    })();
    features.set(key, read);
    return read;
  };

  // P-93: senza `engine.endpointProfile` il profilo si sceglie dal provider del modello
  // (`deepseek/...` → profilo deepseek, `nvidia/...` → profilo nvidia): prima si usava sempre il
  // primo in elenco e un modello reale di un altro provider risultava non appartenente al profilo.
  // Il profilo esplicito nella definizione resta prioritario.
  const profileOf = (def: AgentDefinition): EndpointProfile | undefined => {
    if (def.engine.endpointProfile) return profiles.find((p) => p.id === def.engine.endpointProfile);
    const split = def.engine.model ? splitModel(def.engine.model) : null;
    if (split) return profiles.find((p) => p.provider === split.provider) ?? profiles[0];
    return profiles[0];
  };

  const adapter: AgentAdapter & { attach(runtime: AdapterContext['runtime']): void } = {
    id: OPENCODE_ADAPTER_ID,
    label: 'OpenCode (modelli NVIDIA e locali)',
    capabilities: CAPABILITIES,
    // P-102: configurazioni di OpenCode (progetto, cartella `.opencode`, globale) che possono cambiare
    // i permessi decisi da VISIONE.
    guardedPatterns: [/(^|[\\/\s"'])opencode\.jsonc?\b/i, /[\\/]\.opencode[\\/]/i, /[\\/]\.config[\\/]+opencode[\\/]/i],

    attach(runtime) {
      runtimeRef = runtime;
    },

    async probe(probeOpts = {}): Promise<AdapterProbe> {
      const found = await discover(probeOpts.refresh ?? false);
      if (!found.found) return { available: false, problems: [found.problem] };
      const problems: string[] = [];
      if (found.version === null) problems.push('versione non leggibile');
      return {
        available: true,
        path: found.path,
        command: formatProbeCommand(found.exe, found.prefixArgs, ['--version']),
        ...(found.version ? { version: found.version } : {}),
        problems
      };
    },

    async setup() {
      const found = await discover(true);
      const fetchImpl = opts.setupDeps?.fetch ?? fetch;
      const [nvidiaKey, ollama, igpuEnv] = await Promise.all([
        userEnvPresence(NVIDIA_KEY_ENV, opts.setupDeps?.userEnv),
        readOllama(fetchImpl),
        userEnvPresence(OLLAMA_IGPU_ENV, opts.setupDeps?.userEnv)
      ]);
      const igpu = ollama.running ? ollamaIgpuFromLog((opts.setupDeps?.ollamaLog ?? readOllamaLog)()) : null;
      return opencodeSetupItems({
        cli: found.found ? { found: true, version: found.version ?? null } : { found: false, problem: found.problem },
        nvidiaKey,
        ollama,
        ...(igpu ? { ollamaIgpu: { ...igpu, env: igpuEnv } } : {})
      });
    },

    async catalog() {
      const fetchImpl = opts.setupDeps?.fetch ?? fetch;
      // Con la chiave i candidati si provano davvero (21/10/2026): il catalogo pubblico elenca modelli che per
      // questo account danno 404 o non rispondono, e la squadra consigliata deve usare solo quelli vivi.
      const key = (opts.setupDeps?.userEnv?.env ?? process.env)[NVIDIA_KEY_ENV] ?? '';
      const [nvidia, ollama, probes] = await Promise.all([
        readNvidiaCatalog(fetchImpl),
        readOllama(fetchImpl),
        isNvidiaKey(key) ? probeNvidiaCandidates(key, fetchImpl) : Promise.resolve(null)
      ]);
      return opencodeCatalog(nvidia, ollama.models, probes);
    },

    async verifyKey(envName, value) {
      if (envName !== NVIDIA_KEY_ENV) return { ok: false, detail: `chiave sconosciuta per questo motore: ${envName}` };
      const key = value ?? (opts.setupDeps?.userEnv?.env ?? process.env)[envName] ?? '';
      if (!key) {
        // Salvata nel profilo Windows dopo l'apertura di VISIONE: il processo non la vede finché non riparte.
        const where = await userEnvPresence(envName, opts.setupDeps?.userEnv);
        return where === 'utente'
          ? { ok: false, detail: 'la chiave è salvata nel tuo utente Windows, ma VISIONE era già aperta: chiudi e riapri VISIONE, poi ricontrolla' }
          : { ok: false, detail: 'nessuna chiave da verificare: incollala nel campo' };
      }
      return checkNvidiaKey(key, opts.setupDeps?.fetch ?? fetch);
    },

    async health(defs) {
      const found = await discover(true);
      if (!found.found) return { ok: false, detail: found.problem };
      const fetchImpl = opts.setupDeps?.fetch ?? fetch;
      const env = opts.setupDeps?.userEnv?.env ?? process.env;
      // Una verifica per servizio usato dagli agenti, non per agente.
      const profiles = new Map<string, EndpointProfile>();
      for (const def of defs) {
        const p = profileOf(def);
        if (p) profiles.set(p.id, p);
      }
      for (const p of profiles.values()) {
        if (p.provider === 'ollama') {
          if (!(await readOllama(fetchImpl, 3_000)).running) return { ok: false, detail: 'Ollama non risponde su questo PC' };
          continue;
        }
        if (!p.apiKeyEnv) continue;
        const key = env[p.apiKeyEnv] ?? '';
        if (!key) return { ok: false, detail: `manca la chiave ${p.apiKeyEnv}` };
        if (p.provider === 'nvidia') {
          // Chiave e modelli insieme, dentro il tempo del saluto: un modello che NVIDIA ha tolto all'account
          // (404) lascia l'agente fermo anche con la chiave valida (21/10/2026, Super 120B del proprietario).
          const users = new Map<string, string[]>();
          for (const def of defs) {
            const id = profileOf(def)?.id === p.id && def.engine.model ? splitModel(def.engine.model)?.modelId : undefined;
            if (id) users.set(id, [...(users.get(id) ?? []), def.name]);
          }
          const [check, models] = await Promise.all([
            checkNvidiaKey(key, fetchImpl, 8_000),
            Promise.all([...users.keys()].map(async (id) => ({ id, probe: await probeNvidiaModel(key, id, fetchImpl, 8_000) })))
          ]);
          if (!check.ok) return check;
          const dead = models.filter((m) => !m.probe.ok);
          if (dead.length > 0) {
            return { ok: false, detail: dead.map((m) => `${users.get(m.id)!.join(', ')}: ${m.id.split('/').pop()} ${m.probe.detail}`).join('; ') };
          }
        }
      }
      return { ok: true, detail: 'programma installato e accesso verificato' };
    },

    async quickText(defs, ask, timeoutMs) {
      // Solo dove c'è un servizio rapido: NVIDIA con la chiave dell'utente. Ollama no, per ora: sul processore
      // caricare il modello e leggere il prompt costa decine di secondi e toglie il processore alla voce.
      if (!defs.some((def) => profileOf(def)?.provider === 'nvidia')) return null;
      const env = opts.setupDeps?.userEnv?.env ?? process.env;
      return nvidiaQuickText(env[NVIDIA_KEY_ENV] ?? '', ask, opts.setupDeps?.fetch ?? fetch, timeoutMs).catch(() => null);
    },

    validate(def) {
      const problems: string[] = [];
      if (def.engine.adapter !== OPENCODE_ADAPTER_ID) problems.push(`adapter ${def.engine.adapter} non è ${OPENCODE_ADAPTER_ID}`);
      if (!def.engine.model || !splitModel(def.engine.model)) problems.push('modello obbligatorio nel formato provider/modello');
      const profile = profileOf(def);
      if (!profile) problems.push(`profilo di endpoint sconosciuto: ${def.engine.endpointProfile ?? '(predefinito)'}`);
      else if (def.engine.model && splitModel(def.engine.model)?.provider !== profile.provider) {
        problems.push(`il modello ${def.engine.model} non appartiene al provider ${profile.provider} del profilo`);
      }
      return problems.length === 0 ? { ok: true } : { ok: false, problems };
    },

    /** Il modello è nel formato `provider/modello` di un provider configurato (P-83). */
    supportsModel(model) {
      const split = splitModel(model);
      return split !== null && profiles.some((p) => p.provider === split.provider);
    },

    /**
     * Elenco REALE dei modelli della CLI (`opencode models`, v2.0.12: 123 voci in ~166 ms, nessuna
     * rete necessaria). Nessun modello inventato: se il comando non riesce si restituisce [] e la UI
     * mostra solo i modelli configurati.
     */
    async listModels(def, probe) {
      if (!runtimeRef) return [];
      const cli = await discover(probe.refresh ?? false);
      if (!cli.found) return [];
      const run = await runtimeRef.run({
        exe: cli.exe,
        args: [...cli.prefixArgs, 'models'],
        cwd: probe.workspaceDir,
        env: runtimeRef.env(probe.workspaceDir),
        io: 'pipes',
        kind: 'probe',
        owner: { agentId: def.id, sessionId: null, adapter: OPENCODE_ADAPTER_ID },
        correlationId: ulid(),
        queueKey: OPENCODE_ADAPTER_ID,
        runTimeoutMs: 15_000,
        gracefulStop: 'none',
        emitOutput: false
      }, { maxChars: 2_000_000 });
      if (!run.ok || run.output.result.status !== 'exited') return [];
      const out: AdapterModelOption[] = [];
      for (const line of run.output.stdout.split(/\r?\n/)) {
        const id = line.trim();
        if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(id)) out.push({ id, detail: 'opencode models' });
      }
      return out;
    },

    async start(ctx, resume) {
      // Nessun processo fisso: la sessione del motore nasce col primo turno (sessionID nel JSON).
      runtimeRef ??= ctx.runtime;
      return resume ?? {
        id: ulid(),
        engineSessionId: '',
        adapter: OPENCODE_ADAPTER_ID,
        ...(ctx.definition.engine.model ? { model: ctx.definition.engine.model } : {}),
        startedAt: Date.now(),
        resumable: false
      };
    },

    async sendTurn(ctx, input) {
      runtimeRef ??= ctx.runtime;
      const fail = (error: RuntimeError): TurnOutcome => {
        ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome: 'failed', error });
        return { outcome: 'failed', error, engineSessionId: ctx.instance.session?.engineSessionId || null };
      };
      const valid = adapter.validate(ctx.definition);
      ctx.emit({ kind: 'turn.started', turnId: input.turnId });
      if (!valid.ok) return fail(runtimeError('invalid_spec', valid.problems.join('; ')));
      // Il turno è annullabile da subito, anche mentre si cerca la CLI (P-38).
      const cancel = new AbortController();
      const onOuterAbort = (): void => cancel.abort('annullato');
      ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
      running.set(ctx.instance.id, { process: null, cancel });
      let engineSessionId = ctx.instance.session?.engineSessionId || null;

      try {
        const cli = await discover();
        if (!cli.found) return fail(runtimeError('not_found', `OpenCode non disponibile: ${cli.problem}`));
        const profile = profileOf(ctx.definition) as EndpointProfile;
        let model = ctx.definition.engine.model as string;
        if (profile.local) {
          // Modello locale: la sua copia con il contesto adatto al prompt di OpenCode (Ollama a 4096 lo tagliava).
          const split = splitModel(model);
          const chosen = split ? await ollamaAgentModel(split.modelId, opts.setupDeps?.fetch ?? fetch) : null;
          if (split && chosen && chosen !== split.modelId) model = `${split.provider}/${chosen}`;
        }

        let file: string | undefined;
        let message = input.text;
        if (needsFile(input.text)) {
          const dir = join(ctx.agentDir, 'brief');
          mkdirSync(dir, { recursive: true });
          file = join(dir, `${input.turnId}.md`);
          writeFileSync(file, input.text, 'utf8');
          message = fileMessage(input.text);
        }
        if (cancel.signal.aborted) {
          const error = runtimeError('cancelled', String(cancel.signal.reason ?? 'annullato'));
          ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome: 'cancelled', error });
          return { outcome: 'cancelled', error, engineSessionId };
        }
        for (let attempt = 0; ; attempt++) {
          const outcome = await runOnce(ctx, input, cli, { model, profile, file, message, engineSessionId, cancel });
          if (outcome.sessionId) engineSessionId = outcome.sessionId;
          if (outcome.locked && attempt < lockRetries && !cancel.signal.aborted) {
            ctx.log.warn('database di OpenCode bloccato: nuovo tentativo', { attempt: attempt + 1 });
            await new Promise((r) => setTimeout(r, lockDelay()));
            continue;
          }
          if (engineSessionId && outcome.status !== 'cancelled') await readSessionUsage(ctx, cli, engineSessionId, input);
          ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) });
          return { outcome: outcome.status, error: outcome.error, engineSessionId };
        }
      } finally {
        ctx.signal.removeEventListener('abort', onOuterAbort);
        running.delete(ctx.instance.id);
      }
    },

    async cancelTurn(ctx, reason) {
      const r = running.get(ctx.instance.id);
      if (!r) return;
      r.cancel.abort(reason);
      if (r.process) await r.process.done;
    },

    async stop(ctx, _mode, deadlineMs) {
      // Nessun processo fisso: si annulla l'eventuale turno in corso; la sessione resta su disco.
      const r = running.get(ctx.instance.id);
      if (!r) return;
      r.cancel.abort('stop dell\'agente');
      if (r.process) await Promise.race([r.process.done, new Promise((res) => setTimeout(res, deadlineMs))]);
    },

    async readUsage(ctx) {
      const cli = await discover();
      const id = ctx.instance.session?.engineSessionId;
      if (!cli.found || !id) return null;
      return exportUsage(ctx, cli, id);
    }
  };

  async function runOnce(
    ctx: AdapterContext,
    input: TurnInput,
    cli: ResolvedCli,
    run: { model: string; profile: EndpointProfile; file: string | undefined; message: string; engineSessionId: string | null; cancel: AbortController }
  ): Promise<{ status: TurnOutcome['outcome']; error: RuntimeError | null; sessionId: string | null; locked: boolean }> {
    const cwd = ctx.workspaceDir;
    const env = ctx.runtime.env(cwd, {
      visione: { VISIONE_AGENT_ID: ctx.instance.agentId, VISIONE_AGENT_DIR: ctx.agentDir },
      adapter: { OPENCODE_CONFIG_CONTENT: buildConfigContent({ model: run.model, profile: run.profile, permissions: opts.isTrusted?.(ctx.instance.agentId) ? 'trusted' : ctx.definition.permissions }) }
    });
    const agentProfile = typeof ctx.definition.engine.options?.agent === 'string' ? ctx.definition.engine.options.agent : undefined;
    const started = ctx.runtime.start({
      exe: cli.exe,
      args: [...cli.prefixArgs, ...buildTurnArgs({
        model: run.model, engineSessionId: run.engineSessionId, message: run.message,
        ...(run.file ? { file: run.file } : {}), ...(agentProfile ? { agentProfile } : {})
      }, await featuresOf(ctx, cli))],
      cwd,
      env,
      io: 'pipes',
      kind: 'agent-turn',
      owner: { agentId: ctx.instance.agentId, sessionId: ctx.instance.session?.id ?? null, taskId: input.taskId ?? null, adapter: OPENCODE_ADAPTER_ID },
      correlationId: input.correlationId ?? input.turnId,
      queueKey: OPENCODE_ADAPTER_ID,
      runTimeoutMs: ctx.definition.limits.maxTurnMinutes * 2 * 60_000,
      ...(opts.startTimeoutMs ? { startTimeoutMs: opts.startTimeoutMs } : {}),
      gracefulStop: 'none',
      signal: run.cancel.signal
    });
    if (!started.ok) return { status: 'failed', error: started.error, sessionId: null, locked: false };
    const proc = started.process;
    const slot = running.get(ctx.instance.id);
    if (slot) slot.process = proc;

    let sessionId: string | null = null;
    let engineError: RuntimeError | null = null;
    let turnUsage: AgentUsage | null = null;
    let stderr = '';
    proc.onLine((line, stream) => {
      if (stream === 'stderr') {
        stderr = (stderr + line.text + '\n').slice(-4_000);
        return;
      }
      const parsed = parseRunLine(line.text, input.turnId);
      if (parsed.sessionId && sessionId === null) {
        sessionId = parsed.sessionId;
        // Sessione nuova (primo turno o sessione diversa): annunciata appena il motore la dichiara.
        if (sessionId !== run.engineSessionId) ctx.emit({ kind: 'session.started', engineSessionId: sessionId });
      }
      if (parsed.error && !engineError) engineError = parsed.error;
      if (parsed.stepUsage) turnUsage = sumUsage(turnUsage, parsed.stepUsage);
      for (const e of parsed.events) ctx.emit(e);
    });
    const result = await proc.done;
    if (turnUsage) ctx.emit({ kind: 'usage', usage: turnUsage, source: 'turn' });
    const errorText = `${(engineError as RuntimeError | null)?.message ?? ''}\n${stderr}`;
    const locked = /database is locked/i.test(errorText) && result.status === 'failed';
    if (result.status === 'cancelled') return { status: 'cancelled', error: result.error, sessionId, locked: false };
    if (engineError) return { status: 'failed', error: engineError, sessionId, locked };
    if (result.status === 'exited') return { status: 'completed', error: null, sessionId, locked: false };
    const failure = result.error ?? runtimeError('engine_error', `turno terminato come ${result.status}`);
    const reason = stderrReason(stderr, cli.version);
    return { status: 'failed', error: reason ? { ...failure, message: `${failure.message} — ${reason}` } : failure, sessionId, locked };
  }

  async function exportUsage(ctx: AdapterContext, cli: ResolvedCli, engineSessionId: string): Promise<AgentUsage | null> {
    const res = await ctx.runtime.run({
      exe: cli.exe,
      args: [...cli.prefixArgs, ...buildExportArgs(engineSessionId, await featuresOf(ctx, cli))],
      cwd: ctx.workspaceDir,
      env: ctx.runtime.env(ctx.workspaceDir),
      io: 'pipes',
      kind: 'probe',
      owner: { agentId: ctx.instance.agentId, sessionId: ctx.instance.session?.id ?? null, adapter: OPENCODE_ADAPTER_ID },
      correlationId: ulid(),
      queueKey: OPENCODE_ADAPTER_ID,
      runTimeoutMs: 30_000,
      gracefulStop: 'none',
      emitOutput: false
    }, { maxChars: 20_000_000 });
    if (!res.ok || res.output.result.status !== 'exited') return null;
    return parseSessionExport(res.output.stdout).usage;
  }

  async function readSessionUsage(ctx: AdapterContext, cli: ResolvedCli, engineSessionId: string, input: TurnInput): Promise<void> {
    const usage = await exportUsage(ctx, cli, engineSessionId);
    if (usage) ctx.emit({ kind: 'usage', usage, source: 'session' });
    else ctx.log.warn('uso della sessione non disponibile (UNKNOWN)', { turnId: input.turnId });
  }

  return adapter;
}

export type { EndpointProfile } from './command.ts';
export { buildConfigContent, buildTurnArgs, DEFAULT_ENDPOINT_PROFILES, PERMISSION_PROFILES } from './command.ts';
export { mapEngineError, parseRunLine, parseSessionExport } from './parser.ts';
