// ULID (https://github.com/ulid/spec): 48 bit di tempo + 80 bit casuali in base32 di Crockford.
// Monotonico nello stesso processo: nello stesso millisecondo (o con l'orologio che torna
// indietro) la parte casuale viene incrementata, così l'ordine lessicografico segue l'emissione.
// Usa solo `crypto.getRandomValues`, disponibile in Node, nel preload e nel renderer.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i] ?? 0;
    if (d < 31) {
      next[i] = d + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('ulid: spazio casuale esaurito nello stesso millisecondo');
}

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ulid: tempo non valido ${now}`);
  }
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET.charAt(d)).join('');
}

/** Millisecondi codificati in un ULID. */
export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) throw new Error(`ulid non valido: ${id}`);
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}
