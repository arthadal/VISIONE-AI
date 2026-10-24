// Conversazione a voce (decisione del proprietario, 15/10/2026): quello che dice va all'agente scelto
// (o al Director) e VISIONE risponde a voce con le parole dell'agente, non con frasi fatte. Qui le due
// parti pure: «parla con …» per scegliere l'interlocutore, e la risposta resa leggibile ad alta voce.

export interface TalkCandidate {
  readonly id: string;
  readonly name: string;
}

const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const TALK_IT = /^\s*(?:ora\s+|adesso\s+)?(?:parla|parlo|fammi\s+parlare|passami|voglio\s+parlare)\s+(?:con\s+)?(?:il\s+|lo\s+|la\s+|l')?(.+?)[\s.!?]*$/;
const TALK_EN = /^\s*(?:now\s+)?(?:talk|speak|let\s+me\s+talk|put\s+me\s+through)\s+(?:to|with)\s+(?:the\s+)?(.+?)[\s.!?]*$/;
const DIRECTOR = /^(?:director|direttore|capo|regista)$/;

/**
 * «parla con Esecutore», «passami il Director», «talk to the analyst»: l'interlocutore scelto a voce.
 * `null` = non è una scelta; `{ target: null }` = il Director; un nome che non corrisponde a nessun
 * agente non è una scelta (la frase va avanti come richiesta normale).
 */
export function parseTalkTo(text: string, agents: readonly TalkCandidate[]): { target: string | null } | null {
  const t = fold(text);
  const m = TALK_IT.exec(t) ?? TALK_EN.exec(t);
  if (!m) return null;
  const who = m[1]!.trim();
  if (DIRECTOR.test(who)) return { target: null };
  const found = agents.find((a) => fold(a.name) === who || fold(a.id) === who) ?? agents.find((a) => who.length >= 3 && fold(a.name).startsWith(who));
  return found ? { target: found.id } : null;
}

/** Come chiedere all'agente una risposta da dire ad alta voce. */
export function voicePrompt(text: string, language: 'it' | 'en', now: Date = new Date()): string {
  // Breve (16/10/2026): la risposta si ascolta, e una risposta da 25 s era troppo lunga.
  // Data e ora del PC (18/10/2026): a «che ore sono?» l'agente lanciava un comando, e VISIONE diceva una
  // richiesta di approvazione invece dell'ora. Risponde sempre l'agente, ma sa già che ore sono. Nota corta:
  // oltre 1.000 caratteri il terminale dell'agente riceve un file da leggere, un giro in più prima della risposta.
  const locale = language === 'en' ? 'en-GB' : 'it-IT';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const when = `${now.toLocaleDateString(locale, { weekday: 'long' })} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}, ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const note = language === 'en'
    ? `(Said out loud to VISIONE: answer in English, two or three short sentences, no markdown: it is read aloud. If you work, say how it went. Now: ${when}.)`
    : `(Detto a voce a VISIONE: rispondi in italiano, due o tre frasi brevi, senza markdown: si legge ad alta voce. Se lavori, di' com'è andata. Ora: ${when}.)`;
  return `${text.trim()}\n\n${note}`;
}

/** Al massimo ~1.200 caratteri a voce: oltre si legge a schermo. */
const MAX_SPOKEN = 1_200;
const MEMORY_LINE = /^\s*(?:[-*]\s+)?MEMORIA\s*(?:\[[^\]\n]{1,20}\])?\s*:/i;

/** Frasi che Whisper inventa dal rumore o dal silenzio (sottotitoli dei video su cui è stato addestrato). */
const PHANTOMS = [/sottotitoli (?:creati|a cura|e revisione)/, /amara ?org/, /iscriviti al canale/, /^grazie (?:a tutti )?per la visione$/, /^thanks? for watching$/, /^(?:sottotitoli|subtitles) by/];

/**
 * Trascrizione inventata (16/10/2026: «e e e e e e…» da 4 s di parlato all'aperto): una parola sola ripetuta
 * per quasi tutta la frase, o una frase fantasma nota. Non va al Director: non è una richiesta.
 */
export function isPhantomTranscript(text: string): boolean {
  // Rumori che Whisper annota invece del parlato (24/10/2026: «[Musica» con la musica accesa diventava una richiesta
  // al Director): [Musica], (applausi), ♪ … ♪, *risate*, anche senza parentesi chiusa. Tolti, non resta niente da chiedere.
  const spoken = text.replace(/\[[^\]]*(?:\]|$)/g, ' ').replace(/\([^)]*(?:\)|$)/g, ' ').replace(/\*[^*]*(?:\*|$)/g, ' ').replace(/[♪♫]/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(spoken)) return true;
  // Solo lettere e cifre: la punteggiatura che Whisper aggiunge («Grazie per la visione.») non conta.
  const t = fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (PHANTOMS.some((re) => re.test(t))) return true;
  const words = t.split(' ').filter(Boolean);
  if (words.length < 6) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return Math.max(...counts.values()) / words.length >= 0.7;
}

/**
 * Errori ricorrenti dello STT in italiano (Parakeet v3, 24/10/2026, 100 frasi misurate qui): parole composte spezzate
 * e parole che non esistono. Solo correzioni verso una parola sicura: niente che possa trasformare una parola vera.
 */
const FIXES_IT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpro[\s-]+memori([ae])\b/giu, 'promemori$1'],
  [/\bbuonotte\b/giu, 'buonanotte'],
  [/\bturna\b/giu, 'torna'],
  [/\bchudi\b/giu, 'chiudi'],
  [/\briavia\b/giu, 'riavvia'],
  [/\blegi\b/giu, 'leggi']
];

/** La trascrizione con gli errori ricorrenti corretti; se la parola sbagliata era maiuscola, lo resta. */
export function fixTranscript(text: string, language: 'it' | 'en'): string {
  if (language !== 'it') return text;
  let out = text;
  for (const [re, word] of FIXES_IT) {
    out = out.replace(re, (found: string, end?: unknown) => {
      const fixed = word.replace('$1', typeof end === 'string' ? end.toLowerCase() : '');
      return /^\p{Lu}/u.test(found) ? fixed[0]!.toUpperCase() + fixed.slice(1) : fixed;
    });
  }
  return out;
}

/**
 * La risposta dell'agente resa leggibile: niente blocchi di codice, tabelle, titoli, grassetti, link
 * (resta il testo); gli elenchi diventano frasi; tagliata a fine frase se è lunga.
 */
export function spokenAnswer(answer: string): string {
  let t = answer.replace(/\r/g, '');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1');
  // Le righe MEMORIA sono appunti per gli altri agenti (16/10/2026: lette ad alta voce ripetevano la risposta).
  t = t.split('\n').filter((line) => !/^\s*\|.*\|\s*$/.test(line) && !/^\s*[-=*_]{3,}\s*$/.test(line) && !MEMORY_LINE.test(line)).join('\n');
  t = t.replace(/^\s{0,3}#{1,6}\s*(.*)$/gm, '$1.');
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/gm, '$1;');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2');
  t = t.replace(/\s*\n+\s*/g, ' ').replace(/;\s*(?=[A-ZÀ-Ý])/g, '. ').replace(/[.;]\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();
  if (t.endsWith(';')) t = `${t.slice(0, -1)}.`;
  if (t.length <= MAX_SPOKEN) return t;
  const cut = t.slice(0, MAX_SPOKEN);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > MAX_SPOKEN / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}
