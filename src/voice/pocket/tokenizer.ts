// Tokenizer della voce VISIONE (P-110): SentencePiece «unigram» riscritto in TypeScript, perché la libreria
// originale non esiste per Node senza compilare. Stesse regole del modello esportato da Pocket TTS:
// normalizzatore identità, spazio → «▁», prefisso «▁», Viterbi sui punteggi in float32 (come il C++),
// carattere sconosciuto = punteggio minimo − 10, poi scomposto nei suoi byte UTF-8 (`<0xNN>`).
// Verificato contro gli id della libreria originale (`test/fixtures/pocket-tokenizer-casi.json`).

/** Il file `tokenizer.json` (esportato da `tokenizer.model` con `.backup/voce-lavoro/esporta-tokenizer.py`). */
export interface TokenizerFile {
  readonly model: 'unigram';
  readonly unkId: number;
  readonly byteFallback: boolean;
  readonly addDummyPrefix: boolean;
  /** [pezzo, punteggio, tipo]: 1 normale, 2 sconosciuto, 3 controllo, 6 byte. */
  readonly pieces: readonly (readonly [string, number, number])[];
}

export interface Tokenizer {
  encode(text: string): number[];
  decode(ids: readonly number[]): string;
}

const SPACE = '▁';
const NORMAL = 1;
const CONTROL = 3;
const BYTE = 6;
/** `kUnkPenalty` di SentencePiece. */
const UNK_PENALTY = 10;

export function createTokenizer(file: TokenizerFile): Tokenizer {
  if (file.model !== 'unigram') throw new Error(`tokenizer: modello ${String(file.model)} non gestito`);
  const ids = new Map<string, number>();
  const scores = new Float32Array(file.pieces.length);
  const bytes = new Map<number, number>();
  let maxLen = 1;
  let minScore = Infinity;
  file.pieces.forEach(([piece, score, type], id) => {
    scores[id] = score;
    if (type === NORMAL) {
      ids.set(piece, id);
      maxLen = Math.max(maxLen, [...piece].length);
      minScore = Math.min(minScore, Math.fround(score));
    } else if (type === BYTE) {
      const m = /^<0x([0-9A-F]{2})>$/.exec(piece);
      if (m) bytes.set(parseInt(m[1]!, 16), id);
    }
  });
  const unkScore = Math.fround(minScore - UNK_PENALTY);
  const byteOf = new Map([...bytes].map(([b, id]) => [id, b]));
  const types = file.pieces.map((p) => p[2]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const encode = (text: string): number[] => {
    if (text.length === 0) return [];
    const chars = [...((file.addDummyPrefix ? SPACE : '') + text.replaceAll(' ', SPACE))];
    const n = chars.length;
    // Viterbi: per ogni fine, il miglior punteggio e da dove parte l'ultimo pezzo (come EncodeOptimized).
    const best = new Float32Array(n + 1);
    const from = new Int32Array(n + 1).fill(-1);
    const piece = new Int32Array(n + 1).fill(-1);
    from[0] = 0;
    for (let start = 0; start < n; start++) {
      if (from[start] === -1) continue;
      const here = best[start]!;
      let single = false;
      let s = '';
      for (let len = 1; len <= maxLen && start + len <= n; len++) {
        s += chars[start + len - 1];
        const id = ids.get(s);
        if (id === undefined) continue;
        if (len === 1) single = true;
        const end = start + len;
        const score = Math.fround(here + scores[id]!);
        if (from[end] === -1 || score > best[end]!) {
          best[end] = score;
          from[end] = start;
          piece[end] = id;
        }
      }
      if (!single) {
        const end = start + 1;
        const score = Math.fround(here + unkScore);
        if (from[end] === -1 || score > best[end]!) {
          best[end] = score;
          from[end] = start;
          piece[end] = file.unkId;
        }
      }
    }
    const out: number[] = [];
    for (let end = n; end > 0; end = from[end]!) {
      const id = piece[end]!;
      if (id === file.unkId && file.byteFallback) {
        const span = encoder.encode(chars.slice(from[end]!, end).join(''));
        for (let i = span.length - 1; i >= 0; i--) out.push(bytes.get(span[i]!) ?? file.unkId);
      } else out.push(id);
    }
    return out.reverse();
  };

  const decode = (list: readonly number[]): string => {
    let text = '';
    let pending: number[] = [];
    const flush = (): void => {
      if (pending.length > 0) text += decoder.decode(Uint8Array.from(pending));
      pending = [];
    };
    for (const id of list) {
      const b = byteOf.get(id);
      if (b !== undefined) {
        pending.push(b);
        continue;
      }
      flush();
      if (types[id] === CONTROL) continue;
      text += id === file.unkId ? ' ⁇ ' : (file.pieces[id]?.[0] ?? '');
    }
    flush();
    text = text.replaceAll(SPACE, ' ');
    return file.addDummyPrefix && text.startsWith(' ') ? text.slice(1) : text;
  };

  return { encode, decode };
}
