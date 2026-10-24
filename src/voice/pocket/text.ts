// Preparazione del testo per la voce VISIONE (P-110), identica a quella di Pocket TTS: il modello è stato
// addestrato su frasi con la maiuscola e il punto finale, e regge al massimo ~50 token per volta, quindi
// il testo lungo si spezza sui confini di frase (poi su «,;:») e si reimpacchetta fino a 50 token.
import type { Tokenizer } from './tokenizer.ts';

export interface PreparedText {
  readonly text: string;
  /** Fotogrammi da generare dopo la fine rilevata: le frasi brevissime ne vogliono di più. */
  readonly framesAfterEos: number;
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export function prepareText(raw: string): PreparedText {
  let text = raw.trim();
  if (text.length === 0) throw new Error('testo vuoto');
  text = text.replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('  ', ' ');
  const framesAfterEos = (words(text) <= 4 ? 3 : 1) + 2;
  const first = String.fromCodePoint(text.codePointAt(0)!);
  text = first.toUpperCase() + text.slice(first.length);
  if (/[\p{L}\p{N}]$/u.test(text)) text += '.';
  return { text, framesAfterEos };
}

/** Indici dove inizia ogni segmento: subito dopo una serie di token di confine. */
function boundaries(tokens: readonly number[], marks: ReadonlySet<number>): number[] {
  const out = [0];
  let after = false;
  tokens.forEach((t, i) => {
    if (marks.has(t)) after = true;
    else {
      if (after) out.push(i);
      after = false;
    }
  });
  out.push(tokens.length);
  return out;
}

function segments(tok: Tokenizer, tokens: readonly number[], marks: ReadonlySet<number>): [number, string][] {
  const at = boundaries(tokens, marks);
  const out: [number, string][] = [];
  for (let i = 0; i < at.length - 1; i++) out.push([at[i + 1]! - at[i]!, tok.decode(tokens.slice(at[i], at[i + 1]))]);
  return out;
}

/** Il testo in blocchi da al massimo `maxTokens` token, tagliati dove la voce farebbe una pausa. */
export function splitSentences(tok: Tokenizer, raw: string, maxTokens = 50): string[] {
  const tokens = tok.encode(prepareText(raw).text.trim());
  const ends = new Set(tok.encode('.!...?').slice(1));
  const pauses = new Set(tok.encode(',;:').slice(1));
  const refined: [number, string][] = [];
  for (const [count, text] of segments(tok, tokens, ends)) {
    if (count <= maxTokens) {
      refined.push([count, text]);
      continue;
    }
    const sub = segments(tok, tok.encode(text.trim()), pauses);
    if (sub.length > 1) refined.push(...sub);
    else refined.push([count, text]);
  }
  const chunks: string[] = [];
  let current = '';
  let count = 0;
  for (const [n, text] of refined) {
    if (!current) {
      current = text;
      count = n;
    } else if (count + n > maxTokens) {
      chunks.push(current.trim());
      current = text;
      count = n;
    } else {
      current += ` ${text}`;
      count += n;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}
