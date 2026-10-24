// Parser dell'uscita di `opencode run --format json` (NDJSON), costruito sulle forme reali
// misurate con OpenCode v2.0.12 il 01/10/2026 (fixture in test/fixtures/opencode):
//   step_start · text {part.text, time.start/end} · tool_use {part.tool, part.id, state.status,
//   state.time.start/end} (un solo evento a strumento finito) · step_finish {part.tokens} ·
//   error {error.type, error.message, error.status?}. Ogni riga porta `sessionID`.
// La 1.19.3 (npm, misurata nella VM il 21/10/2026) cambia solo due forme: `part.callID` nel tool_use
// ed error {error.name, error.data.message, error.data.statusCode}.
// Righe non JSON o di tipo sconosciuto vengono ignorate (contate), mai un'eccezione.
import { runtimeError, type AgentUsage, type RuntimeError } from '../../../shared/contracts/index.ts';
import type { AgentEvent } from '../index.ts';

export interface ParsedLine {
  readonly events: AgentEvent[];
  readonly sessionId: string | null;
  readonly error: RuntimeError | null;
  /** Token di uno step (valori reali riportati dal motore). */
  readonly stepUsage: AgentUsage | null;
  readonly ignored: boolean;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** Errore del motore → errore strutturato di VISIONE. */
export function mapEngineError(error: unknown): RuntimeError {
  const e = obj(error) ?? {};
  const data = obj(e.data) ?? {};
  const type = str(e.type) ?? str(e.name) ?? 'unknown';
  const message = str(e.message) ?? str(data.message) ?? type;
  const status = e.status ?? data.statusCode;
  if (/session not found/i.test(message)) return runtimeError('session_not_found', `sessione inesistente: ${message}`);
  if (type.startsWith('provider.') || status === 401 || status === 403) return runtimeError('provider_unavailable', `provider non disponibile (${type}): ${message}`);
  // 404 dal fornitore (21/10/2026, NVIDIA «Function … Not found for account»): il modello non c'è più per questo
  // account. Riprovare non serve (engine_error non si ritenta): serve scegliere un altro modello.
  if (status === 404) return runtimeError('engine_error', `il modello non è disponibile per il tuo account del fornitore (HTTP 404): scegline un altro nella squadra. Dettaglio: ${message}`);
  if (type === 'aborted') return runtimeError('cancelled', `turno interrotto dal motore: ${message}`);
  if (/database is locked/i.test(message)) return runtimeError('engine_error', `database del motore bloccato: ${message}`);
  return runtimeError('engine_error', `${type}: ${message}`);
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Il motivo leggibile di un'uscita con errore, dallo stderr: l'ultima riga non vuota. Se la CLI ha
 * stampato la sua guida (argomenti non riconosciuti) lo si dice, invece di riportarne l'ultima riga.
 */
export function stderrReason(stderr: string, version: string | null): string | null {
  const clean = stderr.replace(ANSI, '');
  if (/^\s*opencode run \[message/m.test(clean) || /^Options:\s*$/m.test(clean)) {
    return `OpenCode ${version ?? '(versione sconosciuta)'} non ha riconosciuto gli argomenti e ha stampato la guida`;
  }
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? last.slice(0, 300) : null;
}

export function usageFromTokens(tokens: unknown): AgentUsage | null {
  const t = obj(tokens);
  if (!t) return null;
  const cache = obj(t.cache);
  const usage: Record<string, number> = {};
  const set = (key: keyof AgentUsage, value: number | undefined): void => {
    if (value !== undefined) usage[key] = value;
  };
  set('inputTokens', num(t.input));
  set('outputTokens', num(t.output));
  set('reasoningTokens', num(t.reasoning));
  set('cacheReadTokens', num(cache?.read));
  return Object.keys(usage).length > 0 ? (usage as AgentUsage) : null;
}

export function sumUsage(a: AgentUsage | null, b: AgentUsage | null): AgentUsage | null {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + (v ?? 0);
  return out as AgentUsage;
}

export function parseRunLine(line: string, turnId: string): ParsedLine {
  const none: ParsedLine = { events: [], sessionId: null, error: null, stepUsage: null, ignored: true };
  const trimmed = line.trim();
  if (trimmed === '' || trimmed[0] !== '{') return none;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return none;
  }
  const ev = obj(raw);
  if (!ev) return none;
  const sessionId = str(ev.sessionID);
  const part = obj(ev.part) ?? {};
  const base = { sessionId, error: null, stepUsage: null, ignored: false };
  switch (ev.type) {
    case 'step_start':
      return { ...base, events: [] };
    case 'text': {
      const text = typeof part.text === 'string' ? part.text : '';
      return { ...base, events: text === '' ? [] : [{ kind: 'message.text', turnId, text, final: obj(part.time)?.end !== undefined }] };
    }
    case 'tool_use': {
      const state = obj(part.state) ?? {};
      const time = obj(state.time) ?? {};
      const tool = str(part.tool) ?? 'sconosciuto';
      const toolCallId = str(part.callID) ?? str(part.id) ?? str(part.partID) ?? `${turnId}-tool`;
      const start = num(time.start);
      const end = num(time.end);
      const finished = state.status === 'completed' || state.status === 'error';
      const events: AgentEvent[] = [{ kind: 'tool.started', turnId, toolCallId, tool }];
      if (finished) {
        events.push({
          kind: 'tool.finished', turnId, toolCallId, tool, ok: state.status === 'completed',
          ...(start !== undefined && end !== undefined && end >= start ? { durationMs: end - start } : {})
        });
      }
      return { ...base, events };
    }
    case 'step_finish':
      return { ...base, events: [], stepUsage: usageFromTokens(part.tokens) };
    case 'error':
      return { ...base, events: [], error: mapEngineError(ev.error) };
    default:
      return { ...base, events: [], ignored: true };
  }
}

/**
 * Token totali della sessione da `opencode session export <id>` (campo `info.tokens`). La 1.x
 * (`opencode export <id>`) premette una riga «Exporting session: …»: si parte dalla prima `{` a capo.
 */
export function parseSessionExport(json: string): { usage: AgentUsage | null; sessionId: string | null } {
  try {
    const start = json.search(/^\s*\{/m);
    const doc = obj(JSON.parse(start > 0 ? json.slice(start) : json));
    const info = obj(doc?.info);
    return { usage: usageFromTokens(info?.tokens), sessionId: str(info?.id) };
  } catch {
    return { usage: null, sessionId: null };
  }
}
