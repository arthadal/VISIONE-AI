// Server-Sent Events e delta chat-completions compatibili OpenAI (piano MOTORE_INTEGRATO_PIANO §5-6, P-107w).
// Funzioni pure, senza rete né timer: il trasporto passa i pezzi di testo così come arrivano dalla rete, qui si
// ricompongono righe e blocchi (`SseParser`) e ogni blocco `data:` diventa una lista di delta tipizzati
// (`ChatAccumulator`), che intanto accumula il risultato del turno.
import type { AgentUsage } from '../../../shared/contracts/index.ts';
import { redactString } from '../../../shared/lib/redact.ts';

/** Un evento SSE completo: `event` vale «message» se il server non lo dichiara. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | undefined;
}

/** Riga più lunga accettata senza a capo: oltre, il flusso è guasto (o ostile) e non si continua ad accumulare. */
export const SSE_MAX_LINE = 4_000_000;

/**
 * Parser SSE incrementale (specifica WHATWG, «event stream interpretation»). Robusto ai pezzi spezzati in punti
 * qualsiasi: una riga, un `\r\n` o un carattere possono arrivare a metà fra due `push`. Righe terminate da
 * `\r\n`, `\n` o `\r`; `:` all'inizio è un commento (i keepalive dei server); più righe `data:` dello stesso
 * evento si uniscono con `\n`. Unica deroga voluta alla specifica: `end()` consegna anche l'ultimo evento senza
 * la riga vuota finale, perché alcuni server chiudono subito dopo `data: [DONE]`.
 */
export class SseParser {
  private buffer = '';
  private pendingCR = false;
  private started = false;
  private dataLines: string[] = [];
  private eventName = '';
  private lastId: string | undefined = undefined;

  push(chunk: string): SseEvent[] {
    if (chunk.length === 0) return [];
    let text = chunk;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    // Il pezzo precedente finiva con `\r`: se questo comincia con `\n`, è lo stesso a capo `\r\n`.
    if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
    this.pendingCR = false;
    const buffer = this.buffer + text;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const line = buffer.slice(start, i);
      if (c === 13) {
        if (i + 1 < buffer.length) {
          if (buffer.charCodeAt(i + 1) === 10) i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      this.line(line, out);
    }
    this.buffer = buffer.slice(start);
    if (this.buffer.length > SSE_MAX_LINE) throw new Error(`riga SSE oltre ${SSE_MAX_LINE} caratteri senza a capo`);
    return out;
  }

  /** Fine del flusso: l'ultima riga senza a capo e l'ultimo evento senza riga vuota vengono consegnati. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buffer.length > 0) this.line(this.buffer, out);
    this.buffer = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.dataLines.length > 0) out.push({ event: this.eventName || 'message', data: this.dataLines.join('\n'), id: this.lastId });
      this.dataLines = [];
      this.eventName = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    else if (field === 'id' && !value.includes('\u0000')) this.lastId = value;
    // `retry` e campi sconosciuti: ignorati (la riconnessione la decide il trasporto, non il server).
  }
}

/** Il marcatore di fine flusso di chat-completions. */
export function isDone(data: string): boolean {
  return data.trim() === '[DONE]';
}

/** Un pezzo di risposta, nell'ordine in cui arriva (tipo del piano §6). */
export type StreamDelta =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning' }
  | { kind: 'tool'; index: number; id?: string; name?: string; args?: string }
  | { kind: 'finish'; reason: string }
  | { kind: 'usage'; usage: AgentUsage }
  | { kind: 'error'; message: string };

/** Una chiamata a strumento ricomposta: gli argomenti sono il JSON grezzo, da validare a parte. */
export interface ToolCallDraft {
  readonly index: number;
  id: string | undefined;
  name: string | undefined;
  args: string;
}

/** Il turno ricomposto dall'accumulatore. */
export interface ChatOutcome {
  readonly text: string;
  /** Il modello ha ragionato: segnalato, mai accumulato nel testo. */
  readonly reasoning: boolean;
  readonly toolCalls: ToolCallDraft[];
  readonly finishReason: string | null;
  readonly usage: AgentUsage | null;
  /** Errori arrivati DENTRO il flusso (HTTP 200 e poi un blocco `error`), già redatti. */
  readonly errors: string[];
  /** È arrivato `[DONE]`. */
  readonly done: boolean;
}

const MAX_ERROR = 500;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/** `usage` di chat-completions → `AgentUsage` (solo valori reali, mai stime); null se non c'è niente di utile. */
export function toAgentUsage(raw: unknown): AgentUsage | null {
  if (!isObject(raw)) return null;
  const prompt = isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const completion = isObject(raw.completion_tokens_details) ? raw.completion_tokens_details : {};
  const usage: AgentUsage = {};
  const input = count(raw.prompt_tokens);
  const output = count(raw.completion_tokens);
  const reasoning = count(completion.reasoning_tokens);
  const cached = count(prompt.cached_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (cached !== undefined) usage.cacheReadTokens = cached;
  return Object.keys(usage).length > 0 ? usage : null;
}

/** Errore dentro un blocco: forma OpenAI (`{error:{message}}`) o vLLM/NIM (`{object:"error", message}`). */
function streamError(chunk: Json): string | null {
  const e = chunk.error;
  if (typeof e === 'string' && e.length > 0) return e;
  if (isObject(e)) return typeof e.message === 'string' && e.message.length > 0 ? e.message : JSON.stringify(e);
  if (chunk.object === 'error') return typeof chunk.message === 'string' && chunk.message.length > 0 ? chunk.message : 'errore del server nel flusso';
  return null;
}

/**
 * Accumulatore dei delta di chat-completions in streaming (`stream: true`, `stream_options.include_usage`).
 * `push` riceve il campo `data` di un evento SSE e restituisce i delta in ordine; `result()` dà il turno
 * ricomposto. Considera solo la scelta 0 (si chiede sempre `n = 1`). Gli argomenti di uno strumento arrivano
 * spezzati in più blocchi con lo stesso `index` e si concatenano; `id` e `name` valgono la prima volta che
 * arrivano (alcuni server li ripetono in ogni blocco). Gli errori sono redatti prima di uscire da qui.
 */
export class ChatAccumulator {
  private text = '';
  private reasoning = false;
  private readonly tools = new Map<number, ToolCallDraft>();
  private finishReason: string | null = null;
  private usage: AgentUsage | null = null;
  private readonly errors: string[] = [];
  private done = false;
  private lastToolIndex = -1;

  push(data: string): StreamDelta[] {
    if (isDone(data)) {
      this.done = true;
      return [];
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return [this.fail(`blocco del flusso non leggibile (non è JSON): ${data.slice(0, 160)}`)];
    }
    if (!isObject(chunk)) return [this.fail('blocco del flusso non leggibile (non è un oggetto JSON)')];
    const error = streamError(chunk);
    if (error !== null) return [this.fail(error)];

    const out: StreamDelta[] = [];
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices.find((c): c is Json => isObject(c) && (c.index === undefined || c.index === 0));
    if (choice) {
      const delta = isObject(choice.delta) ? choice.delta : null;
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          this.reasoning = true;
          out.push({ kind: 'reasoning' });
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          this.text += delta.content;
          out.push({ kind: 'text', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const d = this.tool(call);
            if (d) out.push(d);
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        this.finishReason = choice.finish_reason;
        out.push({ kind: 'finish', reason: choice.finish_reason });
      }
    }
    const usage = toAgentUsage(chunk.usage);
    if (usage) {
      this.usage = usage;
      out.push({ kind: 'usage', usage });
    }
    return out;
  }

  result(): ChatOutcome {
    return {
      text: this.text,
      reasoning: this.reasoning,
      toolCalls: [...this.tools.values()].sort((a, b) => a.index - b.index).map((t) => ({ ...t })),
      finishReason: this.finishReason,
      usage: this.usage,
      errors: [...this.errors],
      done: this.done
    };
  }

  private tool(call: unknown): StreamDelta | null {
    if (!isObject(call)) return null;
    const fn = isObject(call.function) ? call.function : {};
    const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
    let index: number;
    if (typeof call.index === 'number' && Number.isInteger(call.index) && call.index >= 0) {
      index = call.index;
    } else if (id !== undefined) {
      // Server senza `index`: si riconosce la chiamata dal suo id, altrimenti è una nuova.
      const known = [...this.tools.values()].find((t) => t.id === id);
      index = known ? known.index : this.tools.size;
    } else {
      index = Math.max(this.lastToolIndex, 0);
    }
    this.lastToolIndex = index;
    const name = typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : undefined;
    const rawArgs = fn.arguments;
    const args = typeof rawArgs === 'string' ? (rawArgs.length > 0 ? rawArgs : undefined) : isObject(rawArgs) ? JSON.stringify(rawArgs) : undefined;

    let draft = this.tools.get(index);
    if (!draft) {
      draft = { index, id: undefined, name: undefined, args: '' };
      this.tools.set(index, draft);
    }
    if (id !== undefined && draft.id === undefined) draft.id = id;
    if (name !== undefined && draft.name === undefined) draft.name = name;
    if (args !== undefined) draft.args += args;
    return {
      kind: 'tool',
      index,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(args !== undefined ? { args } : {})
    };
  }

  private fail(message: string): StreamDelta {
    const clean = redactString(message).slice(0, MAX_ERROR);
    this.errors.push(clean);
    return { kind: 'error', message: clean };
  }
}
