// Adapter `claude-code` (VISIONE_AGENT_ARCHITECTURE §6, P-6): la CLI Claude Code dell'utente,
// con il suo account, in PTY interattivo. Nessun Agent SDK, nessuna API: stato e controllo dagli
// hook (shim → pipe → core), sessione assegnata da VISIONE (`--session-id`) e ripresa (`--resume`).
// Mai lette o copiate le credenziali di Claude, mai modificati `~/.claude` o `~/.claude.json`.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeError, type AgentCapability, type AgentSession, type RuntimeError } from '../../../shared/contracts/index.ts';
import { ulid } from '../../../shared/lib/ulid.ts';
import { ensureHookShim, type ManagedProcess } from '../../runtime/index.ts';
import { AdapterError } from '../errors.ts';
import type { ActionGate, AdapterContext, AdapterModelOption, AdapterProbe, AgentAdapter, TurnOutcome } from '../index.ts';
import { formatProbeCommand } from '../probe-command.ts';
import { buildClaudeSettings, hookResponses, mapHook, toolAction } from './hooks.ts';
import { detectLimit, screenText, type LimitHit } from './limit.ts';
import { screenRows, selectedOption } from './screen.ts';
import { claudeSetupItems, parseAuthStatus } from './setup.ts';

export const CLAUDE_ADAPTER_ID = 'claude-code';

export { AdapterError };

export interface ClaudeAdapterOptions {
  /** Cartella dove il core scrive lo shim degli hook. */
  readonly shimDir: string;
  readonly candidates?: readonly string[];
  /** Attesa massima dell'hook SessionStart (primo segnale strutturato). */
  readonly startTimeoutMs?: number;
  /** Attesa dell'hook Stop dopo un'interruzione. */
  readonly cancelWaitMs?: number;
  /** Decisione sugli strumenti (policy di VISIONE, Fase 6); null = lascia decidere a Claude Code. */
  readonly decideTool?: (agentId: string, tool: string, input: unknown) => { decision: 'allow' | 'deny'; reason?: string } | null;
  /** Policy e approvazioni di VISIONE sulle azioni degli strumenti (P-39); null = decide Claude Code. */
  readonly decideAction?: ActionGate;
  /** Attesa del ridisegno del dialogo di fiducia prima di leggere l'opzione selezionata. */
  readonly trustSettleMs?: number;
  /** Attesa della casella di input del TUI prima di scrivere un turno. */
  readonly inputReadyMs?: number;
  /** Attesa dell'eco del testo scritto prima dell'invio. */
  readonly echoWaitMs?: number;
}

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set([
  'turns.interactive', 'session.resume', 'session.assignId', 'events.tools', 'events.turnEnd',
  'control.deny', 'control.steer', 'control.halt', 'usage.context', 'model.select'
]);

/** Variabili della sessione genitore rimosse (come Munder `buildPtyEnv`), tranne quelle dell'utente. */
const STRIP = ['CLAUDE', 'CLAUDECODE'];
const KEEP = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);
/**
 * Potenza del motore (P-83): `--effort` è reale e documentato dall'help della CLI installata
 * 2.1.289 («Effort level for the current session (low, medium, high, xhigh, max)»).
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);
/**
 * Alias di modello accettati da `--model` (help 2.1.289: «an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet')»; la tabella alias della build installata elenca anche `haiku`).
 * I modelli pieni sono `claude-*`: nessun identificativo di questo motore contiene `/`.
 */
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;
const MODEL_PATTERN = /^claude-[a-z0-9][a-z0-9.-]*$/i;
/**
 * Dialogo di fiducia della cartella (verificato su 2.1.286: "Is this a project you created or one
 * you trust? … Yes, I trust this folder"; versioni precedenti: "Do you trust the files in this
 * folder?"). Confrontato sul testo dello schermo senza sequenze ANSI né spazi.
 */
const TRUST_PROMPT = /itrustthisfolder|trustthefilesinthisfolder/;
/**
 * Prima configurazione di Claude Code non finita (VM da zero, 18/10/2026): `claude auth login` fa l'accesso
 * ma non segna l'onboarding (letto nella 2.1.299: lo segna solo il login con token), e il terminale
 * dell'agente restava sulla scelta del tema, dell'accesso o sulle note di sicurezza finché l'avvio scadeva,
 * tre volte. La prima configurazione la fa l'utente («Accedi» apre Claude Code interattivo): qui la si
 * riconosce e ci si ferma subito, senza rispondere al suo posto.
 */
const ONBOARDING = /choosethetextstylethatlooksbestwithyourterminal|selectloginmethod:|securitynotes:/;

export { screenText, selectedOption };

export function defaultClaudeCandidates(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
  if (env.APPDATA) out.push(join(env.APPDATA, 'npm', 'claude.cmd'));
  if (env.USERPROFILE) out.push(join(env.USERPROFILE, '.claude', 'local', 'claude.exe'), join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  return out;
}

export interface ClaudeLaunchInput {
  readonly engineSessionId: string;
  readonly resume: boolean;
  readonly settingsPath: string;
  readonly identityPath: string;
  readonly model?: string;
  readonly permissionMode?: string;
  /** Potenza dichiarata dal motore (`--effort`; P-83). */
  readonly effort?: string;
  /** Cartelle aggiuntive leggibili senza dialogo (la cartella dell'agente: brief, inbox, risultati). */
  readonly addDirs?: readonly string[];
}

/** argv di avvio (verificato su Claude Code 2.1.286: `--append-system-prompt-file` accettato). */
export function buildClaudeArgs(input: ClaudeLaunchInput): string[] {
  const args = input.resume ? ['--resume', input.engineSessionId] : ['--session-id', input.engineSessionId];
  args.push('--settings', input.settingsPath, '--append-system-prompt-file', input.identityPath);
  if (input.model) args.push('--model', input.model);
  if (input.permissionMode && PERMISSION_MODES.has(input.permissionMode)) args.push('--permission-mode', input.permissionMode);
  if (input.effort && EFFORT_SET.has(input.effort)) args.push('--effort', input.effort);
  for (const dir of input.addDirs ?? []) args.push('--add-dir', dir);
  return args;
}

/** Il motore è della famiglia Claude? I modelli di questa CLI non contengono `/` (P-83). */
export function isClaudeModel(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model) || MODEL_PATTERN.test(model);
}

interface Turn {
  readonly turnId: string;
  /** Inizio del turno: distingue un limite visto durante il turno da uno precedente. */
  readonly startedAt: number;
  resolve(outcome: TurnOutcome): void;
  cancelled: boolean;
}

interface Instance {
  readonly process: ManagedProcess;
  readonly engineSessionId: string;
  ready: boolean;
  idle: boolean;
  turn: Turn | null;
  halt: string | null;
  steer: string[];
  onReady: Array<(ok: boolean) => void>;
  onStop: Array<() => void>;
  /** Schermo confrontabile (senza ANSI né spazi), ultimi 8.000 caratteri, e totale ricevuto. */
  screen: string;
  screenTotal: number;
  /** Istante dell'ultimo blocco ricevuto dal PTY (anche solo sequenze di controllo). */
  lastOutputAt: number;
  /** Posizione dello schermo all'ultimo SessionStart o Stop: la casella di input va cercata dopo. */
  inputMark: number;
  /** Ultimo limite di quota visto (P-83) e firma già emessa nella sessione (nessun duplicato). */
  limit: (LimitHit & { at: number }) | null;
  limitNotified: string | null;
}

/** Silenzio del PTY dopo un ridisegno perché valga come eco del testo scritto (vedi `sendTurn`). */
const ECHO_QUIET_MS = 120;

/** Parte dello schermo arrivata dopo `mark` (o tutto il buffer se è più lunga). */
function screenSince(inst: Instance, mark: number): string {
  const fresh = inst.screenTotal - mark;
  return fresh >= inst.screen.length ? inst.screen : inst.screen.slice(inst.screen.length - fresh);
}

/**
 * Attende che lo schermo dopo `mark` soddisfi `test`, al più `timeoutMs`; false = scaduto. Il limite è
 * sull'orologio, non sui giri: su Windows un `setTimeout` da 50 ms dura ~62 ms e cento giri facevano
 * 6,2 s invece di 5 (misurato il 17/10/2026).
 */
async function waitScreen(inst: Instance, mark: number, test: (s: string) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test(screenSince(inst, mark))) return true;
    if (inst.process.status !== 'running') return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return test(screenSince(inst, mark));
}

export function createClaudeCodeAdapter(opts: ClaudeAdapterOptions): AgentAdapter & { attach(runtime: AdapterContext['runtime']): void } {
  const instances = new Map<string, Instance>();
  let runtimeRef: AdapterContext['runtime'] | null = null;

  const discover = async (refresh = false) => {
    if (!runtimeRef) return { found: false as const, name: 'claude', problem: 'runtime non collegato' };
    return runtimeRef.discovery.discover('claude', { candidates: opts.candidates ?? defaultClaudeCandidates, refresh });
  };

  const finishTurn = (inst: Instance, ctx: AdapterContext, outcome: TurnOutcome['outcome'], error: RuntimeError | null): void => {
    const turn = inst.turn;
    if (!turn) return;
    inst.turn = null;
    inst.idle = true;
    inst.halt = null;
    ctx.emit({ kind: 'turn.finished', turnId: turn.turnId, outcome, ...(error ? { error } : {}) });
    turn.resolve({ outcome, error, engineSessionId: inst.engineSessionId });
  };

  const adapter: AgentAdapter & { attach(runtime: AdapterContext['runtime']): void } = {
    id: CLAUDE_ADAPTER_ID,
    label: 'Claude (con il tuo account Claude)',
    capabilities: CAPABILITIES,
    // P-102: impostazioni di Claude Code (utente e progetto) che possono aggiungere o spegnere hook.
    guardedPatterns: [/\.claude[\\/]+settings(\.local)?\.json/i, /\.claude\.json/i],

    attach(runtime) {
      runtimeRef = runtime;
    },

    async loginCommand() {
      const found = await discover(true);
      // Claude Code interattivo, non `auth login` (18/10/2026): così l'utente fa anche la prima configurazione
      // (tema, note di sicurezza), che `auth login` non segna e che altrimenti fermerebbe ogni agente.
      return found.found ? { exe: found.exe, args: [...found.prefixArgs] } : null;
    },

    async catalog() {
      // P-105: gli alias del motore, che Claude Code risolve all'ultima versione del modello.
      return [
        { model: 'sonnet', label: 'Claude Sonnet — equilibrato (consigliato per il Director)', group: 'Claude', recommended: true, suggestedFor: 'director' as const },
        { model: 'opus', label: 'Claude Opus — il più capace, più lento', group: 'Claude' },
        { model: 'haiku', label: 'Claude Haiku — il più veloce', group: 'Claude' },
        { model: 'fable', label: 'Claude Fable', group: 'Claude' }
      ].filter((m) => (MODEL_ALIASES as readonly string[]).includes(m.model));
    },

    async setup() {
      const found = await discover(true);
      if (!found.found || !runtimeRef) return claudeSetupItems({ cli: found.found ? { found: true, version: found.version ?? null, exe: found.exe } : { found: false, problem: found.problem }, auth: null });
      // Stato dell'accesso: solo `loggedIn`, metodo e piano (P-105). Nessuna sessione, nessun turno.
      // In un'installazione nuova la cartella degli shim nasce solo al primo agente: senza, `cwd_missing`.
      mkdirSync(opts.shimDir, { recursive: true });
      const run = await runtimeRef.run({
        exe: found.exe,
        args: [...found.prefixArgs, 'auth', 'status', '--json'],
        cwd: opts.shimDir,
        env: runtimeRef.env(opts.shimDir),
        io: 'pipes',
        kind: 'probe',
        owner: { agentId: null, sessionId: null, adapter: CLAUDE_ADAPTER_ID },
        correlationId: ulid(),
        queueKey: CLAUDE_ADAPTER_ID,
        runTimeoutMs: 20_000,
        gracefulStop: 'none',
        emitOutput: false
      }, { maxChars: 20_000 });
      // Da scollegato esce con codice 1 ma scrive lo stesso il JSON (`loggedIn: false`, misurato).
      const auth = run.ok ? parseAuthStatus(run.output.stdout) : null;
      return claudeSetupItems({ cli: { found: true, version: found.version ?? null, exe: found.exe }, auth });
    },

    async health() {
      // Programma trovato E accesso fatto (`auth status`): gli stessi requisiti della procedura guidata.
      const missing = (await adapter.setup!()).find((item) => !item.optional && !item.ok);
      return missing ? { ok: false, detail: missing.detail } : { ok: true, detail: 'programma installato e accesso fatto' };
    },

    async probe(probeOpts = {}): Promise<AdapterProbe> {
      const found = await discover(probeOpts.refresh ?? false);
      if (!found.found) return { available: false, problems: [found.problem] };
      return {
        available: true,
        path: found.path,
        command: formatProbeCommand(found.exe, found.prefixArgs, ['--version']),
        ...(found.version ? { version: found.version } : {}),
        problems: found.version ? [] : ['versione non leggibile']
      };
    },

    validate(def) {
      const problems: string[] = [];
      if (def.engine.adapter !== CLAUDE_ADAPTER_ID) problems.push(`adapter ${def.engine.adapter} non è ${CLAUDE_ADAPTER_ID}`);
      const mode = def.engine.options?.permissionMode;
      if (mode !== undefined && (typeof mode !== 'string' || !PERMISSION_MODES.has(mode))) {
        problems.push(`permissionMode non consentito: ${String(mode)} (ammessi: ${[...PERMISSION_MODES].join(', ')})`);
      }
      if (def.engine.model !== undefined && !isClaudeModel(def.engine.model)) {
        problems.push(`modello non del motore: ${def.engine.model} (alias ammessi: ${MODEL_ALIASES.join(', ')}; oppure un id claude-*)`);
      }
      const effort = def.engine.options?.effort;
      if (effort !== undefined && (typeof effort !== 'string' || !EFFORT_SET.has(effort))) {
        problems.push(`effort non consentito: ${String(effort)} (ammessi: ${EFFORT_LEVELS.join(', ')})`);
      }
      return problems.length === 0 ? { ok: true } : { ok: false, problems };
    },

    supportsModel(model) {
      return isClaudeModel(model);
    },

    listModels() {
      // Alias reali della CLI installata (help 2.1.289 + tabella alias della build): nessun modello
      // inventato; l'elenco pieno dei modelli dell'account non è enumerabile dalla CLI.
      return Promise.resolve(MODEL_ALIASES.map((id): AdapterModelOption => ({ id, detail: 'alias della CLI' })));
    },

    tuning(def) {
      const effort = def.engine.options?.effort;
      return { effort: { options: [...EFFORT_LEVELS], current: typeof effort === 'string' && EFFORT_SET.has(effort) ? effort : null } };
    },

    async start(ctx, resume) {
      runtimeRef ??= ctx.runtime;
      const valid = adapter.validate(ctx.definition);
      if (!valid.ok) throw new AdapterError(runtimeError('invalid_spec', valid.problems.join('; ')));
      if (!ctx.hooks) throw new AdapterError(runtimeError('invalid_spec', 'canale degli hook non disponibile'));
      if (instances.has(ctx.instance.id)) throw new AdapterError(runtimeError('invalid_spec', 'istanza già avviata'));
      const cli = await discover();
      if (!cli.found) throw new AdapterError(runtimeError('not_found', `Claude Code non disponibile: ${cli.problem}`));
      // Node per lo shim: quello dell'utente se c'è, altrimenti l'eseguibile del core in modalità node.
      const node = await ctx.runtime.discovery.discover('node');
      const nodePath = node.found ? node.exe : process.execPath;
      const shim = ensureHookShim(opts.shimDir);

      mkdirSync(ctx.agentDir, { recursive: true });
      const identityPath = join(ctx.agentDir, 'identity.md');
      // P-102: le impostazioni con gli hook vivono accanto allo shim (cartella custodita dalla policy),
      // non nella cartella dell'agente: l'agente non può riscriverle durante la sessione.
      const settingsPath = join(opts.shimDir, `settings-${ctx.instance.agentId}.json`);
      const def = ctx.definition;
      writeFileSync(identityPath, `# ${def.name}\n\nRuolo: ${def.role}\n\n${def.persona.instructions}\n`, 'utf8');
      writeFileSync(settingsPath, JSON.stringify(buildClaudeSettings(nodePath, shim), null, 2), 'utf8');

      const engineSessionId = resume?.engineSessionId || randomUUID();
      const sessionId = resume?.id ?? ulid();
      let inst: Instance | null = null;
      const toolIds = (): string => ulid();
      const token = ctx.hooks.register(ctx.instance.agentId, (req) => {
        const current = inst;
        if (!current) return null;
        const events = mapHook(req.event, req.payload, { turnId: current.turn?.turnId ?? null, nextId: toolIds });
        for (const e of events) {
          if (e.kind === 'turn.finished') continue; // gestito sotto con l'esito reale
          ctx.emit(e);
        }
        switch (req.event) {
          case 'SessionStart':
            current.ready = true;
            current.idle = true;
            current.inputMark = current.screenTotal;
            for (const cb of current.onReady.splice(0)) cb(true);
            return null;
          case 'UserPromptSubmit':
            current.idle = false;
            if (current.halt) return hookResponses.halt(current.halt);
            return current.steer.length > 0 ? hookResponses.context('UserPromptSubmit', current.steer.splice(0).join('\n')) : null;
          case 'PreToolUse': {
            if (current.halt) return hookResponses.halt(current.halt);
            const p = (req.payload ?? {}) as { tool_name?: unknown; tool_input?: unknown };
            const decision = opts.decideTool?.(ctx.instance.agentId, String(p.tool_name ?? ''), p.tool_input) ?? null;
            if (decision?.decision === 'deny') return hookResponses.deny(decision.reason ?? 'negato dalla policy di VISIONE');
            const action = opts.decideAction ? toolAction(String(p.tool_name ?? ''), p.tool_input, ctx.workspaceDir) : null;
            const gate = action ? opts.decideAction?.(ctx.instance.agentId, action) ?? null : null;
            return gate?.decision === 'deny' ? hookResponses.deny(gate.reason) : null;
          }
          case 'PostToolUse':
            if (current.halt) return hookResponses.halt(current.halt);
            return current.steer.length > 0 ? hookResponses.context('PostToolUse', current.steer.splice(0).join('\n')) : null;
          case 'Stop': {
            current.inputMark = current.screenTotal;
            const cancelled = current.turn?.cancelled === true;
            const limited = current.turn !== null && current.limit !== null && current.limit.at >= current.turn.startedAt;
            if (limited) {
              finishTurn(current, ctx, 'failed', runtimeError('limit_reached', current.limit!.message));
            } else {
              if (!cancelled) {
                // Turno riuscito: il limite eventualmente visto prima è superato.
                current.limit = null;
                current.limitNotified = null;
              }
              finishTurn(current, ctx, cancelled ? 'cancelled' : 'completed', cancelled ? runtimeError('cancelled', current.halt ?? 'annullato') : null);
            }
            for (const cb of current.onStop.splice(0)) cb();
            return null;
          }
          default:
            return null;
        }
      });

      const env = ctx.runtime.env(ctx.workspaceDir, {
        strip: STRIP,
        keep: KEEP,
        visione: {
          VISIONE_AGENT_ID: ctx.instance.agentId,
          VISIONE_AGENT_DIR: ctx.agentDir,
          VISIONE_AGENT_TOKEN: token,
          VISIONE_HOOK_PIPE: ctx.hooks.address
        },
        // TERM: su Windows node-pty ignora `name`, e senza un terminale Unicode riconosciuto (VISIONE
        // avviata dall'icona) il TUI disegna la casella con `>` invece di `❯`: ogni turno aspettava
        // 15 s una casella mai vista (misurato con 2.1.299 il 16/10/2026). Se lo shim gira con
        // l'eseguibile di Electron serve la modalità node.
        adapter: { TERM: 'xterm-256color', ...(node.found ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }
      });
      ctx.runtime.policy.allowExecutable(cli.exe);
      const permissionMode = typeof def.engine.options?.permissionMode === 'string' ? def.engine.options.permissionMode : undefined;
      const effort = typeof def.engine.options?.effort === 'string' && EFFORT_SET.has(def.engine.options.effort) ? def.engine.options.effort : undefined;
      const started = ctx.runtime.start({
        exe: cli.exe,
        args: [...cli.prefixArgs, ...buildClaudeArgs({
          engineSessionId, resume: Boolean(resume?.engineSessionId), settingsPath, identityPath, addDirs: [ctx.agentDir],
          ...(def.engine.model ? { model: def.engine.model } : {}), ...(permissionMode ? { permissionMode } : {}), ...(effort ? { effort } : {})
        })],
        cwd: ctx.workspaceDir,
        env,
        io: 'pty',
        pty: { cols: 120, rows: 32 },
        kind: 'agent-session',
        owner: { agentId: ctx.instance.agentId, sessionId, adapter: CLAUDE_ADAPTER_ID },
        correlationId: ulid(),
        gracefulStop: 'ctrl-c',
        signal: ctx.signal
      });
      if (!started.ok) {
        ctx.hooks.unregister(ctx.instance.agentId);
        throw new AdapterError(started.error);
      }
      const proc = started.process;
      inst = { process: proc, engineSessionId, ready: false, idle: false, turn: null, halt: null, steer: [], onReady: [], onStop: [], screen: '', screenTotal: 0, lastOutputAt: 0, inputMark: 0, limit: null, limitNotified: null };
      // Schermo tenuto per tutta la vita della sessione: serve a sapere quando il TUI accetta input.
      const tracked = inst;
      proc.onLine((line) => {
        const text = screenText(line.text);
        tracked.screen = (tracked.screen + text).slice(-8_000);
        tracked.screenTotal += text.length;
        tracked.lastOutputAt = Date.now();
        // Limite di quota (P-83): banner reale della CLI. Durante un turno lo chiude subito come
        // `limit_reached` (senza attendere un reset che può essere lontano); l'evento è emesso una
        // volta per firma finché nessun turno riesce.
        const hit = detectLimit(line.text);
        if (!hit) return;
        tracked.limit = { ...hit, at: Date.now() };
        const signature = `${hit.scope}|${hit.message}`;
        if (tracked.limitNotified !== signature) {
          tracked.limitNotified = signature;
          ctx.emit({ kind: 'limit.reached', turnId: tracked.turn?.turnId ?? null, scope: hit.scope, message: hit.message, resetAt: hit.resetAt });
        }
        if (tracked.turn) finishTurn(tracked, ctx, 'failed', runtimeError('limit_reached', hit.message));
      });
      instances.set(ctx.instance.id, inst);
      const current = inst;
      void proc.done.then((r) => {
        ctx.hooks?.unregister(ctx.instance.agentId);
        instances.delete(ctx.instance.id);
        for (const cb of current.onReady.splice(0)) cb(false);
        const error = r.error ?? runtimeError('crashed', `sessione terminata (${r.status})`);
        finishTurn(current, ctx, current.turn?.cancelled ? 'cancelled' : 'failed', error);
        ctx.emit({ kind: 'process.exited', exit: r.status === 'exited' ? 'clean' : r.status === 'crashed' ? 'crashed' : r.status === 'stopped' || r.status === 'cancelled' ? 'killed' : 'error', ...(r.exitCode === null ? {} : { code: r.exitCode }), tail: r.tail });
      });

      // Il dialogo di fiducia è una decisione del proprietario: VISIONE non risponde mai al suo
      // posto (né modifica la configurazione di Claude). Senza approvazione lo riconosce e si
      // ferma subito; con l'approvazione registrata (P-39) sceglie "sì, mi fido" solo dopo aver
      // letto sullo schermo che è l'opzione selezionata (frecce per arrivarci, al più 4 tentativi).
      let trustPrompt = false;
      let onboarding = false;
      let confirmed = false;
      let moves = 0;
      let settle: ReturnType<typeof setTimeout> | null = null;
      let screen = '';
      // Flusso grezzo del PTY (con le sequenze del cursore): la freccia si legge sullo schermo ricostruito.
      let raw = '';
      const confirmTrust = (): void => {
        settle = null;
        if (current.ready || confirmed) return;
        const selected = selectedOption(raw);
        if (selected === 'yes') {
          confirmed = true;
          ctx.log.info('fiducia nella cartella confermata come approvato dal proprietario', { workspace: ctx.workspaceDir });
          proc.write('\r');
        } else if (selected === 'no' && moves < 4) {
          moves++;
          proc.write('\x1b[B');
        } else if (selected !== null) {
          for (const cb of current.onReady.splice(0)) cb(false);
        }
      };
      const offScreen = proc.onLine((line) => {
        if (current.ready || confirmed || onboarding || (trustPrompt && !ctx.trustApproved)) return;
        screen = (screen + screenText(line.text)).slice(-4_000);
        raw = (raw + line.text).slice(-64_000);
        if (ONBOARDING.test(screen)) {
          onboarding = true;
          for (const cb of current.onReady.splice(0)) cb(false);
          return;
        }
        if (!TRUST_PROMPT.test(screen)) return;
        trustPrompt = true;
        if (!ctx.trustApproved) {
          for (const cb of current.onReady.splice(0)) cb(false);
          return;
        }
        if (settle !== null) clearTimeout(settle);
        settle = setTimeout(confirmTrust, opts.trustSettleMs ?? 300);
      });
      const ready = await new Promise<boolean>((resolve) => {
        if (current.ready) return resolve(true);
        const t = setTimeout(() => resolve(false), opts.startTimeoutMs ?? 60_000);
        current.onReady.push((ok) => {
          clearTimeout(t);
          resolve(ok);
        });
      });
      offScreen();
      if (settle !== null) clearTimeout(settle);
      // Avvio non riuscito: istanza e hook liberati subito, così un nuovo avvio non trova residui.
      const abandon = async (reason: string): Promise<void> => {
        await proc.stop({ mode: 'force', reason });
        instances.delete(ctx.instance.id);
        ctx.hooks?.unregister(ctx.instance.agentId);
      };
      if (!ready && onboarding) {
        await abandon('prima configurazione di Claude Code da fare');
        throw new AdapterError(runtimeError('engine_error', 'Claude Code non ha finito la prima configurazione (tema, accesso, note di sicurezza): aprilo una volta e completala, dalla procedura guidata (passo Motori, «Accedi») o da un terminale'));
      }
      if (!ready && trustPrompt && !ctx.trustApproved) {
        await abandon('fiducia nella cartella da confermare');
        throw new AdapterError(runtimeError('trust_required', `Claude Code chiede di confermare la fiducia nella cartella di lavoro ${ctx.workspaceDir}: decisione del proprietario`));
      }
      if (!ready && trustPrompt) {
        await abandon('conferma della fiducia non riuscita');
        throw new AdapterError(runtimeError('engine_error', `fiducia approvata ma l'opzione "sì" non è stata riconosciuta sullo schermo di Claude Code (${ctx.workspaceDir})`));
      }
      if (!ready) {
        // La coda come la mostrava lo schermo, non i codici del terminale (VM, 18/10/2026: «Coda: ␛[38;2;248;…»).
        const shown = screenRows(proc.tail()).map((r) => r.trim()).filter(Boolean).join(' · ');
        await abandon('nessun SessionStart entro il tempo di avvio');
        throw new AdapterError(runtimeError('timeout', `Claude Code non ha segnalato l'avvio della sessione (hook SessionStart). Schermo: ${shown.slice(-300) || '(vuoto)'}`));
      }
      const session: AgentSession = {
        id: sessionId,
        engineSessionId,
        adapter: CLAUDE_ADAPTER_ID,
        ...(def.engine.model ? { model: def.engine.model } : {}),
        startedAt: Date.now(),
        resumable: true
      };
      return session;
    },

    async sendTurn(ctx, input) {
      const inst = instances.get(ctx.instance.id);
      if (!inst || inst.process.status !== 'running') {
        const error = runtimeError('not_running', 'sessione Claude Code non avviata');
        ctx.emit({ kind: 'turn.started', turnId: input.turnId });
        ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome: 'failed', error });
        return { outcome: 'failed', error, engineSessionId: inst?.engineSessionId ?? null };
      }
      if (!inst.idle || inst.turn) {
        return { outcome: 'failed', error: runtimeError('engine_error', 'turno già in corso: un turno alla volta'), engineSessionId: inst.engineSessionId };
      }
      // Testo breve: una riga sola (gli a-capo del brief diventano spazi). Testo lungo: file nella
      // cartella dell'agente, leggibile senza dialoghi grazie a `--add-dir` (contract test, P-38).
      let text = input.text.replace(/\s*\r?\n\s*/g, ' ').trim();
      // Un primo carattere speciale cambierebbe modalità nel TUI (comandi, shell, memoria, menzioni).
      if (/^[/!#@&]/.test(text)) text = `Richiesta: ${text}`;
      if (input.text.length > 1_000) {
        const dir = join(ctx.agentDir, 'brief');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${input.turnId}.md`);
        writeFileSync(file, input.text, 'utf8');
        text = `Leggi ed esegui le istruzioni nel file ${file.replaceAll('\\', '/')}`;
      }
      const outcome = new Promise<TurnOutcome>((resolve) => {
        inst.turn = { turnId: input.turnId, startedAt: Date.now(), resolve, cancelled: false };
      });
      inst.idle = false;
      ctx.emit({ kind: 'turn.started', turnId: input.turnId });
      // L'hook SessionStart (o Stop) arriva prima che il TUI disegni la casella di input: il testo
      // scritto prima andrebbe perso (contract test reale, P-38). Si attende la casella (`❯`), si
      // scrive, si controlla l'eco sullo schermo e solo allora si invia. Testo e invio separati: il
      // TUI tratta un incolla con a-capo come testo, non come invio.
      const ready = await waitScreen(inst, inst.inputMark, (s) => s.includes('❯'), opts.inputReadyMs ?? 15_000);
      if (!ready) ctx.log.warn('casella di input del TUI non vista: scrivo comunque', { turnId: input.turnId });
      const typedAt = inst.screenTotal;
      inst.process.write(text);
      const probe = screenText(text).slice(0, 16);
      // Un testo lungo (fra 700 e 900 caratteri in su) il TUI lo raccoglie come «[Pasted text #1]» invece di
      // mostrarlo: è arrivato anche così. Senza questo ogni turno lungo aspettava 5 s (misurato il 16/10/2026).
      // Su Windows ConPTY manda solo le celle cambiate: i caratteri già presenti in quella posizione dello
      // schermo (il «Compito:» del turno prima, il piè di pagina uguale di ogni brief) diventano spostamenti
      // del cursore e il campione può non arrivare mai: ogni turno a voce aspettava 6,2 s (misurato il
      // 17/10/2026 su una copia della sessione del Director). Fermo dopo la scrittura, il TUI disegna solo
      // per ciò che ha letto: un ridisegno visibile, finito da ECHO_QUIET_MS, vale come eco.
      const echoed = await waitScreen(inst, typedAt, (s) =>
        s.includes(probe) || s.includes('[pastedtext') || (s.length > 0 && Date.now() - inst.lastOutputAt >= ECHO_QUIET_MS), opts.echoWaitMs ?? 2_000);
      if (!echoed) ctx.log.warn('eco del testo non vista sullo schermo: invio comunque', { turnId: input.turnId });
      await new Promise((r) => setTimeout(r, 100));
      inst.process.write('\r');
      const hardMs = ctx.definition.limits.maxTurnMinutes * 2 * 60_000;
      const timer = setTimeout(() => void adapter.cancelTurn(ctx, 'durata massima del turno superata'), hardMs);
      try {
        return await outcome;
      } finally {
        clearTimeout(timer);
      }
    },

    async cancelTurn(ctx, reason) {
      const inst = instances.get(ctx.instance.id);
      if (!inst?.turn) return;
      inst.turn.cancelled = true;
      inst.halt = reason;
      // Esc interrompe il turno nel TUI; il prossimo hook risponde `continue:false`.
      inst.process.write('\x1b');
      const stopped = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), opts.cancelWaitMs ?? 5_000);
        inst.onStop.push(() => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (!stopped) finishTurn(inst, ctx, 'cancelled', runtimeError('cancelled', reason));
    },

    async steer(ctx, note) {
      instances.get(ctx.instance.id)?.steer.push(note.slice(0, 4_000));
    },

    async stop(ctx, mode, deadlineMs) {
      const inst = instances.get(ctx.instance.id);
      if (!inst) return;
      if (inst.turn) await adapter.cancelTurn(ctx, 'stop dell\'agente');
      if (mode === 'graceful' && inst.process.status === 'running') {
        // Due Ctrl+C: il primo svuota l'input, il secondo chiude il TUI (stop gentile).
        inst.process.write('\x03');
        await new Promise((r) => setTimeout(r, 200));
      }
      await inst.process.stop({ mode, reason: 'stop dell\'agente', graceMs: Math.max(0, deadlineMs - 1_000) });
      ctx.hooks?.unregister(ctx.instance.agentId);
    }
  };
  return adapter;
}
