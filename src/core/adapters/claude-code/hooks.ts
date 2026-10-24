// Hook di Claude Code (MUNDER_CLI_RUNTIME §9-10, VISIONE_AGENT_ARCHITECTURE §6): impostazioni per
// agente, mappatura degli hook in AgentEvent e risposte di controllo. Funzioni pure.
// Campi dei payload secondo la documentazione degli hook di Claude Code (session_id,
// hook_event_name, prompt, tool_name, tool_input, tool_use_id, tool_response, message).
import { isAbsolute, join } from 'node:path';
import type { AgentUsage } from '../../../shared/contracts/index.ts';
import type { ActionDescriptor, AgentEvent } from '../index.ts';

/** Hook registrati (come Munder `hookSettings`), più la statusLine per la finestra di contesto. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop',
  'SubagentStop', 'PreCompact', 'PostCompact'
] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number] | 'StatusLine';

const TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);

/** Comando di hook: node + shim + nome dell'evento, percorsi tra virgolette con barre normali. */
export function hookCommand(nodePath: string, shimPath: string, event: ClaudeHookEvent): string {
  const q = (p: string): string => `"${p.replaceAll('\\', '/')}"`;
  return `${q(nodePath)} ${q(shimPath)} ${event}`;
}

/** Contenuto di `settings.json` per l'agente (passato con `--settings`, mai le impostazioni globali). */
export function buildClaudeSettings(nodePath: string, shimPath: string): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const entry = { hooks: [{ type: 'command', command: hookCommand(nodePath, shimPath, event) }] };
    hooks[event] = [TOOL_EVENTS.has(event) ? { matcher: '*', ...entry } : entry];
  }
  return { hooks, statusLine: { type: 'command', command: hookCommand(nodePath, shimPath, 'StatusLine') } };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

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
      return [{ kind: 'tool.finished', turnId, toolCallId: str(p.tool_use_id) ?? ctx.nextId(), tool: str(p.tool_name) ?? 'sconosciuto', ok: !failed }];
    }
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
      const git = /^\s*git\s+(.*)$/is.exec(command);
      return git ? { kind: 'git', target: (git[1] ?? '').slice(0, 1000) } : { kind: 'shell.exec', target: command.slice(0, 1000) };
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
