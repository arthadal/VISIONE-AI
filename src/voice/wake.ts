// Wake word «Hey Visione» (P-81, uso personale non commerciale): matcher PURO della trascrizione
// Whisper. Il KWS nativo di sherpa-onnx esiste ma i modelli pre-addestrati sono solo cinese/inglese
// (nessun modello per la parola italiana «visione»); qui la frase si confronta sul testo reale con
// normalizzazione e tolleranza agli errori tipici dello STT italiano. Niente dati finti: se il testo
// non contiene la frase all'inizio, non si riconosce nulla.

/** Limiti del segmento di wake (VAD → STT): sotto il minimo è rumore, sopra il tetto si chiude. */
export const WAKE_LIMITS = {
  /** Segmento minimo trascritto (ms). */
  minSegmentMs: 250,
  /** Segmento massimo (ms): oltre, la VAD viene chiusa d'ufficio. */
  maxSegmentMs: 8_000,
  /** Energia minima (RMS sul segmento): sotto, niente STT. */
  minRms: 0.004,
  /** Segmento fino a cui, se il modello rapido non ha riconosciuto la frase, riprova il modello buono (ms). */
  secondTryMs: 4_000,
  /** ...e solo se il modello rapido ha scritto al più queste parole (una frase lunga non è una parola d'avvio). */
  secondTryWords: 4
} as const;

export interface WakeMatch {
  /** Frase configurata che ha fatto match. */
  readonly phrase: string;
  /** Testo dopo la frase, già ripulito; null se il segmento era la sola frase. */
  readonly command: string | null;
}

/**
 * Normalizza una parola come il matcher: minuscole, senza accenti, solo lettere/numeri (l'apostrofo
 * resta perché compare in «l'ho»). Vuoto = la parola non esiste per il confronto.
 */
export function normalizeWakeWord(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}']+/gu, '')
    // In fondo l'apostrofo no (18/10/2026): whisper-small scrive «È» come «E'», e «E' i visioni che ore
    // sono» non era più una wake: si teneva la trascrizione del modello rapido, «che sono».
    .replace(/'+$/u, '');
}

/** varianti dello STT italiano per il saluto «hey» (solo quando la frase inizia con «hey»). */
// 24/10/2026, misurato con Parakeet v3 (voce di Windows, pulito e con rumore): «Hai visione», «Ai visione», «Eh,
// visione», «Hell visione», «É invisione».
const HEY_ALIASES: ReadonlySet<string> = new Set(['hey', 'ehi', 'ei', 'hei', 'e', 'a', 'i', 'ok', 'okay', 'okey', 'hoi', 'hai', 'ai', 'eh', 'he', 'hell', 'hel', 'ehy', 'ey']);

/** Distanza di Levenshtein fra due stringhe brevi (≤ 30 caratteri in pratica). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** Tolleranza per parola: più lunga la parola, più errori di una lettera sono accettabili. */
function tolerance(length: number): number {
  if (length >= 9) return 2;
  if (length >= 5) return 1;
  return 0;
}

interface Word {
  /** Testo originale (per ricostruire il comando senza perdere accenti/maiuscole). */
  readonly raw: string;
  /** Forma normalizzata (per il confronto). */
  readonly norm: string;
}

function words(text: string): Word[] {
  const out: Word[] = [];
  for (const raw of text.trim().split(/\s+/)) {
    const norm = normalizeWakeWord(raw);
    if (norm.length > 0) out.push({ raw, norm });
  }
  return out;
}

function wordMatches(text: string, phrase: string, first: boolean): boolean {
  if (first && HEY_ALIASES.has(phrase) && HEY_ALIASES.has(text)) return true;
  if (text === phrase) return true;
  return editDistance(text, phrase) <= tolerance(phrase.length);
}

/** Pulisce il comando dagli artefatti di punteggiatura ai bordi. */
function cleanCommand(parts: readonly string[]): string | null {
  const joined = parts.join(' ').replace(/^[\s.,!?;:»«"']+/, '').replace(/[\s.,!?;:»«"']+$/, '').trim();
  return joined.length > 0 ? joined : null;
}

/** Confusioni tipiche dello STT sulla prima consonante della parola di wake (solo nel caso attaccato). */
const FIRST_CONFUSIONS: ReadonlyArray<readonly [string, string]> = [['v', 'b'], ['s', 'z']];

/**
 * Match della parola attaccata al saluto: tolleranza piena più una se la prima consonante è una
 * confusione nota dello STT (Whisper scrive «Abisione»/«Abysione» per «avisione»).
 */
function mergedWordMatches(rest: string, phrase: string): boolean {
  if (wordMatches(rest, phrase, false)) return true;
  if (rest.length < 3 || phrase.length < 3) return false;
  const confusable = FIRST_CONFUSIONS.some(([a, b]) => (rest[0] === a && phrase[0] === b) || (rest[0] === b && phrase[0] === a));
  return confusable && editDistance(rest, phrase) <= tolerance(phrase.length) + 1;
}

/**
 * Confronta la trascrizione con la frase di wake: la frase deve stare ALL'INIZIO, parola per parola,
 * con gli alias del saluto e la tolleranza di edit distance. Whisper-base a volte attacca il saluto
 * alla parola successiva («avisione», «eivisione»): anche quel caso è riconosciuto. Restituisce il
 * comando nella stessa utterance (tutto ciò che segue), o null se il testo non è una wake.
 */
export function matchWakePhrase(text: string, phrase: string): WakeMatch | null {
  const phraseWords = words(phrase).map((w) => w.norm);
  if (phraseWords.length === 0) return null;
  const textWords = words(text);
  const matched = (i: number): boolean => wordMatches(textWords[i]!.norm, phraseWords[i]!, i === 0);
  // 1) frase dall'inizio, parola per parola.
  if (textWords.length >= phraseWords.length && phraseWords.every((_, i) => matched(i))) {
    return { phrase: phrase.trim(), command: cleanCommand(textWords.slice(phraseWords.length).map((w) => w.raw)) };
  }
  // 2) saluto attaccato alla parola successiva (errore tipico dello STT sulle frasi brevi).
  if (phraseWords.length >= 2 && HEY_ALIASES.has(phraseWords[0]!) && textWords.length >= 1) {
    const first = textWords[0]!.norm;
    for (const alias of HEY_ALIASES) {
      if (!first.startsWith(alias) || first.length <= alias.length) continue;
      const rest = first.slice(alias.length);
      if (!mergedWordMatches(rest, phraseWords[1]!)) continue;
      const tail = textWords.slice(1);
      if (!phraseWords.slice(2).every((pw, i) => tail[i] !== undefined && wordMatches(tail[i]!.norm, pw, false))) continue;
      return { phrase: phrase.trim(), command: cleanCommand(tail.slice(phraseWords.length - 2).map((w) => w.raw)) };
    }
  }
  // 3) saluto e parola SPEZZATI (misurato l'11/10/2026 con la voce di Windows e Whisper-base: «Hey
  //    Visione» pulito diventa «e i visioni», con rumore «i visi o ne», «e i visi or»).
  if (phraseWords.length >= 2 && HEY_ALIASES.has(phraseWords[0]!)) return matchSplit(textWords, phraseWords, phrase);
  return null;
}

/** Fino a 2 pezzi di saluto in testa, poi la parola di wake anche in 1–3 pezzi, poi il resto della frase. */
function matchSplit(textWords: readonly Word[], phraseWords: readonly string[], phrase: string): WakeMatch | null {
  for (let greet = 1; greet <= 2 && greet < textWords.length; greet++) {
    if (!textWords.slice(0, greet).every((w) => HEY_ALIASES.has(w.norm))) break;
    const target = phraseWords[1]!;
    // Fra le unioni accettabili vince la più vicina alla parola («visi o ne» intera, non «visio» + «ne»).
    let best: { pieces: number; distance: number } | null = null;
    for (let pieces = 1; pieces <= 3 && greet + pieces <= textWords.length; pieces++) {
      const joined = textWords.slice(greet, greet + pieces).map((w) => w.norm).join('');
      const distance = editDistance(joined, target);
      // Un pezzo in più è già la prova dello spezzamento: una lettera di tolleranza in più.
      if (distance > tolerance(target.length) + (pieces > 1 ? 1 : 0)) continue;
      if (best === null || distance <= best.distance) best = { pieces, distance };
    }
    if (best === null) continue;
    const tail = textWords.slice(greet + best.pieces);
    const restPhrase = phraseWords.slice(2);
    if (!restPhrase.every((pw, i) => tail[i] !== undefined && wordMatches(tail[i]!.norm, pw, false))) continue;
    return { phrase: phrase.trim(), command: cleanCommand(tail.slice(restPhrase.length).map((w) => w.raw)) };
  }
  return null;
}
