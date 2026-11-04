// Hook di Claude Code (MUNDER_CLI_RUNTIME §9-10, VISIONE_AGENT_ARCHITECTURE §6): impostazioni per
// agente, mappatura degli hook in AgentEvent e risposte di controllo. Funzioni pure.
// Campi dei payload secondo la documentazione degli hook di Claude Code (session_id,
// hook_event_name, prompt, tool_name, tool_input, tool_use_id, tool_response, message).
import { isAbsolute, join } from 'node:path';
import type { AgentUsage } from '../../../shared/contracts/index.ts';
import type { ActionDescriptor, AgentEvent } from '../index.ts';
import { toolProof } from '../proof.ts';

/** Hook registrati (come Munder `hookSettings`), più la statusLine per la finestra di contesto. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop',
  'SubagentStop', 'PreCompact', 'PostCompact'
] as const;
/**
 * Lo strumento fallito (uscita diversa da zero, errore) non passa da `PostToolUse`: ha un hook suo, già nella
 * 2.1.119 (CHANGELOG). Si registra solo con la exec form (dalla 2.1.139), così una CLI più vecchia non riceve
 * un nome che non conosce.
 */
export const CLAUDE_FAILURE_HOOK = 'PostToolUseFailure';
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number] | typeof CLAUDE_FAILURE_HOOK | 'StatusLine';

const TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', CLAUDE_FAILURE_HOOK]);

/** Comando di hook: node + shim + nome dell'evento, percorsi tra virgolette con barre normali. */
export function hookCommand(nodePath: string, shimPath: string, event: ClaudeHookEvent): string {
  const q = (p: string): string => `"${p.replaceAll('\\', '/')}"`;
  return `${q(nodePath)} ${q(shimPath)} ${event}`;
}

/**
 * Prima versione con la «exec form» degli hook (`command` + `args`, lanciata senza shell): CHANGELOG di
 * Claude Code 2.1.139. Dalla 2.1.120, senza Git Bash, la forma con la shell gira in PowerShell, dove
 * `"node" "shim" Evento` è un errore di sintassi (misurato il 04/11/2026): nessun hook arriva, e la verifica
 * dice «non ha segnalato l'avvio (hook SessionStart)».
 */
const EXEC_FORM_SINCE = [2, 1, 139] as const;

/** La CLI installata accetta `args` negli hook? Versione illeggibile: no (resta la forma con la shell). */
export function supportsExecForm(version: string | null | undefined): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== EXEC_FORM_SINCE[i]) return (v[i] ?? 0) > (EXEC_FORM_SINCE[i] ?? 0);
  return true;
}

/**
 * Contenuto di `settings.json` per l'agente (passato con `--settings`, mai le impostazioni globali). Con `execForm`
 * gli hook lanciano node direttamente (vale con e senza Git Bash); la statusLine non ha `args` e resta con la shell.
 */
export function buildClaudeSettings(nodePath: string, shimPath: string, opts: { execForm?: boolean } = {}): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  const events: readonly ClaudeHookEvent[] = opts.execForm ? [...CLAUDE_HOOK_EVENTS, CLAUDE_FAILURE_HOOK] : CLAUDE_HOOK_EVENTS;
  for (const event of events) {
    const command = opts.execForm
      ? { type: 'command', command: nodePath, args: [shimPath, event] }
      : { type: 'command', command: hookCommand(nodePath, shimPath, event) };
    const entry = { hooks: [command] };
    hooks[event] = [TOOL_EVENTS.has(event) ? { matcher: '*', ...entry } : entry];
  }
  return { hooks, statusLine: { type: 'command', command: hookCommand(nodePath, shimPath, 'StatusLine') } };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
const took = (v: unknown): { durationMs?: number } => {
  const ms = int(v);
  return ms === undefined ? {} : { durationMs: ms };
};

export interface HookContext {
  readonly turnId: string | null;
  /** Generatore di id per gli strumenti senza `tool_use_id`. */
  readonly nextId: () => string;
}

/** Hook → eventi normalizzati. Un hook sconosciuto non produce eventi (mai un'eccezione). */
export function mapHook(event: string, payload: unknown, ctx: HookContext): AgentEvent[] {
  const p = obj(payload) ?? {};
  const turnId = ctx.turnId ?? 'fuori-turno';
  switch (event) {
    case 'SessionStart': {
      const id = str(p.session_id);
      return id ? [{ kind: 'session.started', engineSessionId: id }] : [];
    }
    case 'UserPromptSubmit':
      return [{ kind: 'turn.started', turnId }];
    case 'PreToolUse':
      return [{ kind: 'tool.started', turnId, toolCallId: str(p.tool_use_id) ?? ctx.nextId(), tool: str(p.tool_name) ?? 'sconosciuto', input: p.tool_input }];
    case 'PostToolUse': {
      const response = obj(p.tool_response);
      const failed = response?.is_error === true || response?.success === false || typeof response?.error === 'string';
      return [{
        kind: 'tool.finished', turnId, toolCallId: str(p.tool_use_id) ?? ctx.nextId(), tool: str(p.tool_name) ?? 'sconosciuto', ok: !failed,
        ...took(p.duration_ms), proof: toolProof(p.tool_input, p.tool_response)
      }];
    }
    case CLAUDE_FAILURE_HOOK:
      return [{
        kind: 'tool.finished', turnId, toolCallId: str(p.tool_use_id) ?? ctx.nextId(), tool: str(p.tool_name) ?? 'sconosciuto', ok: false,
        ...took(p.duration_ms), proof: toolProof(p.tool_input, p.error)
      }];
    case 'Notification': {
      const message = str(p.message) ?? '';
      const type = str(p.notification_type) ?? '';
      if (/permission/i.test(type) || /permission/i.test(message)) {
        return [{ kind: 'permission.requested', requestId: ctx.nextId(), action: { kind: 'tool-permission', target: message.slice(0, 1000) } }];
      }
      return [];
    }
    case 'Stop': {
      // Testo finale del turno, se il motore lo passa all'hook (lettura difensiva, non verificata
      // sulla CLI reale: P-38); altrimenti il risultato arriva da `results\`.
      const last = str(p.last_assistant_message);
      const text: AgentEvent[] = last ? [{ kind: 'message.text', turnId, text: last, final: true }] : [];
      return [...text, { kind: 'turn.finished', turnId, outcome: 'completed' }];
    }
    case 'StatusLine': {
      const usage = statusLineUsage(p);
      return usage ? [{ kind: 'usage', usage, source: 'session' }] : [];
    }
    default:
      return [];
  }
}

/**
 * Finestra di contesto dalla statusLine, solo se presente con nomi riconosciuti; altrimenti
 * UNKNOWN (nessun valore inventato). La forma esatta del payload non è ancora verificata su
 * questa versione: per questo la lettura è difensiva (P-34).
 */
export function statusLineUsage(p: Json): AgentUsage | null {
  const cw = obj(p.context_window);
  if (!cw) return null;
  const size = int(cw.context_window_size);
  const used = int(cw.total_input_tokens);
  const usage: Record<string, number> = {};
  if (size !== undefined) usage.contextSize = size;
  if (used !== undefined) usage.contextUsed = used;
  return Object.keys(usage).length > 0 ? (usage as AgentUsage) : null;
}

/** Strumenti che `toolAction` traduce in un'azione: senza i loro campi (comando, percorso, URL) la policy non decide. */
const GATED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'WebFetch']);

/** Lo strumento passa dalla policy di VISIONE: se `toolAction` non ne ricava l'azione, la richiesta va negata. */
export function isGatedTool(tool: string): boolean {
  return GATED_TOOLS.has(tool);
}

/**
 * Strumento del motore → azione da classificare dalla policy di VISIONE (P-39). Gli strumenti che
 * non toccano file, comandi o rete non hanno un'azione (decide il motore con i suoi permessi).
 */
export function toolAction(tool: string, input: unknown, cwd: string): ActionDescriptor | null {
  const p = obj(input) ?? {};
  const path = (v: unknown): string | null => {
    const s = str(v);
    if (!s) return null;
    return isAbsolute(s) ? s : join(cwd, s);
  };
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = str(p.command);
      if (!command) return null;
      // Il comando INTERO va alla policy: tagliato a 1000 caratteri, un inizio innocuo nascondeva la coda
      // (`echo` + 1.100 caratteri + `&& rm -rf …` passava come un `echo`). Log, eventi e approvazioni tagliano da sé.
      const git = /^\s*git\s+(.*)$/is.exec(command);
      return git ? { kind: 'git', target: git[1] ?? '' } : { kind: 'shell.exec', target: command };
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const target = path(p.file_path ?? p.notebook_path);
      return target ? { kind: 'fs.write', target } : null;
    }
    case 'Read': {
      const target = path(p.file_path);
      return target ? { kind: 'fs.read', target } : null;
    }
    case 'WebFetch': {
      const url = str(p.url);
      if (!url) return null;
      try {
        return { kind: 'net.connect', target: new URL(url).hostname };
      } catch {
        return { kind: 'net.connect', target: url.slice(0, 1000) };
      }
    }
    default:
      return null;
  }
}

/** Risposte di controllo restituite allo shim (stampate su stdout per Claude Code). */
export const hookResponses = {
  deny: (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  halt: (reason: string) => ({ continue: false, stopReason: reason }),
  context: (event: 'UserPromptSubmit' | 'PostToolUse' | 'SessionStart', text: string) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
  block: (reason: string) => ({ decision: 'block', reason })
};
