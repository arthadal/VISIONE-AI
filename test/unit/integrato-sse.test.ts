// Motore integrato F2 (piano MOTORE_INTEGRATO_PIANO §6): parser SSE e accumulatore dei delta chat-completions.
// Funzioni pure: i pezzi arrivano spezzati in punti qualsiasi, come dalla rete.
import { describe, expect, it } from 'vitest';
import { ChatAccumulator, SseParser, isDone, toAgentUsage, type SseEvent, type StreamDelta } from '../../src/core/adapters/integrato/sse.ts';
import { sseChunk, textPieces, toolPieces } from '../fixtures/fake-openai.ts';

/** Passa il testo al parser un pezzo alla volta, nei punti di taglio dati. */
function parseIn(text: string, cuts: number[]): SseEvent[] {
  const parser = new SseParser();
  const out: SseEvent[] = [];
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    out.push(...parser.push(text.slice(at, cut)));
    at = cut;
  }
  out.push(...parser.end());
  return out;
}

/** Gira l'intero copione del server finto attraverso parser e accumulatore. */
function run(pieces: Array<string | Uint8Array>): { deltas: StreamDelta[]; acc: ChatAccumulator } {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const acc = new ChatAccumulator();
  const deltas: StreamDelta[] = [];
  const feed = (events: SseEvent[]): void => {
    for (const e of events) deltas.push(...acc.push(e.data));
  };
  for (const p of pieces) feed(parser.push(typeof p === 'string' ? p : decoder.decode(p, { stream: true })));
  feed(parser.push(decoder.decode()));
  feed(parser.end());
  return { deltas, acc };
}

describe('SseParser', () => {
  it('righe spezzate in ogni punto possibile danno sempre gli stessi eventi', () => {
    const text = 'data: uno\n\n: commento\n\nevent: x\ndata: due\ndata: tre\nid: 7\n\ndata:quattro\n\n';
    const whole = parseIn(text, []);
    expect(whole).toEqual([
      { event: 'message', data: 'uno', id: undefined },
      { event: 'x', data: 'due\ntre', id: '7' },
      { event: 'message', data: 'quattro', id: '7' }
    ]);
    for (let i = 1; i < text.length; i++) expect(parseIn(text, [i])).toEqual(whole);
  });

  it('`\\r\\n` e `\\r` come a capo, anche con `\\r` e `\\n` in due pezzi diversi', () => {
    const text = 'data: a\r\n\r\ndata: b\r\rdata: c\n\n';
    const expected = ['a', 'b', 'c'];
    expect(parseIn(text, []).map((e) => e.data)).toEqual(expected);
    for (let i = 1; i < text.length; i++) expect(parseIn(text, [i]).map((e) => e.data)).toEqual(expected);
    // `\r` a fine pezzo seguito da `\n`: un solo a capo, non una riga vuota che chiuderebbe l'evento a metà.
    expect(parseIn('data: x\r\ndata: y\r\n\r\n', [8]).map((e) => e.data)).toEqual(['x\ny']);
  });

  it('commenti e righe senza dati non producono eventi; BOM iniziale tolto', () => {
    expect(parseIn('﻿: ping\n\n: ping\n\nretry: 10\n\ndata: ok\n\n', [])).toEqual([{ event: 'message', data: 'ok', id: undefined }]);
    expect(parseIn('data\n\n', []).map((e) => e.data)).toEqual(['']);
  });

  it('fine del flusso senza riga vuota finale: l\'ultimo evento arriva lo stesso', () => {
    expect(parseIn('data: [DONE]', []).map((e) => e.data)).toEqual(['[DONE]']);
    expect(parseIn('data: a\n', []).map((e) => e.data)).toEqual(['a']);
    expect(isDone(' [DONE] ')).toBe(true);
    expect(isDone('{"x":1}')).toBe(false);
  });
});

describe('ChatAccumulator', () => {
  it('testo semplice: ragionamento solo segnalato, `finish`, `usage`, `[DONE]`', () => {
    const { deltas, acc } = run(textPieces());
    expect(deltas.filter((d) => d.kind === 'text').map((d) => (d.kind === 'text' ? d.text : ''))).toEqual(['Ciao', ' mondo è']);
    expect(deltas.some((d) => d.kind === 'reasoning')).toBe(true);
    expect(deltas).toContainEqual({ kind: 'finish', reason: 'stop' });
    expect(deltas).toContainEqual({ kind: 'usage', usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 2 } });
    const r = acc.result();
    expect(r.text).toBe('Ciao mondo è');
    expect(r.text).not.toContain('penso');
    expect(r.reasoning).toBe(true);
    expect(r.finishReason).toBe('stop');
    expect(r.done).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.toolCalls).toEqual([]);
  });

  it('chiamata a strumento: argomenti spezzati in più blocchi ricomposti per `index`', () => {
    const { deltas, acc } = run(toolPieces());
    expect(deltas[0]).toEqual({ kind: 'tool', index: 0, id: 'call_1', name: 'read_file' });
    expect(deltas.filter((d) => d.kind === 'tool' && d.args !== undefined).map((d) => (d.kind === 'tool' ? d.args : ''))).toEqual(['{"pa', 'th":"a.txt"}']);
    const r = acc.result();
    expect(r.toolCalls).toEqual([{ index: 0, id: 'call_1', name: 'read_file', args: '{"path":"a.txt"}' }]);
    expect(JSON.parse(r.toolCalls[0]!.args)).toEqual({ path: 'a.txt' });
    expect(r.finishReason).toBe('tool_calls');
    expect(r.text).toBe('');
  });

  it('due strumenti in parallelo, nome ripetuto, `index` mancante e argomenti già oggetto', () => {
    const acc = new ChatAccumulator();
    acc.push(sseChunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'list_dir', arguments: '{"p' } }, { index: 0, id: 'a', function: { name: 'read_file', arguments: '{' } }] }).slice(6));
    acc.push(sseChunk({ tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '}' } }, { index: 1, function: { arguments: '":1}' } }] }).slice(6));
    expect(acc.result().toolCalls).toEqual([
      { index: 0, id: 'a', name: 'read_file', args: '{}' },
      { index: 1, id: 'b', name: 'list_dir', args: '{"p":1}' }
    ]);
    const loose = new ChatAccumulator();
    loose.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'x', function: { name: 'f', arguments: { a: 1 } } }] } }] }));
    loose.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'y', function: { name: 'g', arguments: '' } }] } }] }));
    expect(loose.result().toolCalls).toEqual([
      { index: 0, id: 'x', name: 'f', args: '{"a":1}' },
      { index: 1, id: 'y', name: 'g', args: '' }
    ]);
  });

  it('`reasoning` (variante senza `_content`) segnalato; altre scelte ignorate; usage con cache', () => {
    const acc = new ChatAccumulator();
    expect(acc.push(JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'hm' } }, { index: 1, delta: { content: 'altra scelta' } }] }))).toEqual([{ kind: 'reasoning' }]);
    expect(acc.result().text).toBe('');
    expect(toAgentUsage({ prompt_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } })).toEqual({ inputTokens: 3, cacheReadTokens: 2 });
    expect(toAgentUsage({ prompt_tokens: -1, completion_tokens: 1.5 })).toBeNull();
    expect(toAgentUsage(null)).toBeNull();
  });

  it('errori nel flusso: forma OpenAI, forma vLLM/NIM, blocco non JSON; redatti', () => {
    const acc = new ChatAccumulator();
    const fake = 'nv' + 'api-' + 'Z'.repeat(30);
    expect(acc.push(JSON.stringify({ error: { message: `limite superato per ${fake}`, code: 429 } }))).toEqual([{ kind: 'error', message: 'limite superato per [REDACTED]' }]);
    expect(acc.push(JSON.stringify({ object: 'error', message: 'modello non disponibile', code: 404 }))).toEqual([{ kind: 'error', message: 'modello non disponibile' }]);
    const broken = acc.push('{"choices": [');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.kind).toBe('error');
    expect(acc.result().errors).toHaveLength(3);
    expect(JSON.stringify(acc.result())).not.toContain(fake);
  });
});
