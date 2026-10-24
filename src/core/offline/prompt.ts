// Modalità offline (17/10/2026): istruzioni ed esempi per il modello locale, e lettura della sua risposta.
// Il modello NON agisce: riscrive la frase libera in una forma che le regole dell'Assistente già capiscono
// («ricordami tra 20 minuti di…»), oppure dice che la richiesta non si può fare offline. Misurato su 30
// frasi italiane: le regole da sole ne capiscono 13, con il modello davanti alle regole 24 (Qwen3 4B).
import type { Language } from '../../shared/contracts/index.ts';

export interface OfflinePrompt {
  readonly system: string;
  readonly shots: ReadonlyArray<readonly [string, string]>;
}

const IT: OfflinePrompt = {
  system: `Sei l'assistente offline di VISIONE. Riscrivi la richiesta dell'utente in UNA sola riga, usando SOLO una di queste forme:
ricordami <quando> di <cosa>
annota che <cosa>
cosa devo fare <oggi|domani|nei prossimi giorni>
annulla il promemoria <cosa>
annulla il timer
metti un timer di <durata> per <cosa>
aggiungi <cose> alla lista <nome>
togli <cose> dalla lista <nome>
leggimi la lista <nome>
apri <programma>
che ore sono
che giorno è
NON_OFFLINE
Usa NON_OFFLINE per tutto ciò che non è in elenco: internet, notizie, codice, testi, traduzioni, domande generali.
Non rispondere alla richiesta: riscrivila soltanto.`,
  shots: [
    ['tra 20 minuti fammi ricordare di girare la carne', 'ricordami tra 20 minuti di girare la carne'],
    ['stasera alle nove devo mandare la mail a Luca', 'ricordami stasera alle 21 di mandare la mail a Luca'],
    ['mercoledì ho la riunione alle 10', 'ricordami mercoledì alle 10 di la riunione'],
    ['ho qualcosa domani?', 'cosa devo fare domani'],
    ['quali impegni ho la settimana prossima', 'cosa devo fare nei prossimi giorni'],
    ['segnati che la password del wifi è sul frigo', 'annota che la password del wifi è sul frigo'],
    ['ricordati che a Paolo non piace il pesce', 'annota che a Paolo non piace il pesce'],
    ['fammi un conto alla rovescia di cinque minuti per le uova', 'metti un timer di 5 minuti per le uova'],
    ["mezz'ora per la torta", 'metti un timer di 30 minuti per la torta'],
    ['mettimi le mele nella spesa', 'aggiungi mele alla lista spesa'],
    ['levami lo zucchero dalla spesa', 'togli zucchero dalla lista spesa'],
    ['cosa devo comprare?', 'leggimi la lista spesa'],
    ['scordati del promemoria della palestra', 'annulla il promemoria palestra'],
    ['stoppa il conto alla rovescia', 'annulla il timer'],
    ['aprimi word', 'apri word'],
    ['mostrami le impostazioni', 'apri impostazioni'],
    ["sai dirmi l'ora?", 'che ore sono'],
    ['oggi che data è', 'che giorno è'],
    ['traducimi questo documento in inglese', 'NON_OFFLINE'],
    ['chi ha vinto la partita ieri?', 'NON_OFFLINE'],
    ['correggi il bug nel file main.js', 'NON_OFFLINE']
  ]
};

const EN: OfflinePrompt = {
  system: `You are VISIONE's offline assistant. Rewrite the user's request as ONE line, using ONLY one of these forms:
remind me <when> to <what>
note that <what>
what do I have <today|tomorrow|in the next days>
cancel the reminder <what>
cancel the timer
set a timer for <duration> for <what>
add <items> to the <name> list
remove <items> from the <name> list
read me the <name> list
open <program>
what time is it
what day is it
NOT_OFFLINE
Use NOT_OFFLINE for anything not in the list: internet, news, code, writing, translations, general questions.
Do not answer the request: only rewrite it.`,
  shots: [
    ['in 20 minutes make me remember to flip the steak', 'remind me in 20 minutes to flip the steak'],
    ['tonight at nine I must send the email to Luke', 'remind me tonight at 9pm to send the email to Luke'],
    ['wednesday I have the meeting at 10', 'remind me wednesday at 10am to go to the meeting'],
    ['anything for tomorrow?', 'what do I have tomorrow'],
    ['what are my plans next week', 'what do I have in the next days'],
    ['jot that the wifi password is on the fridge', 'note that the wifi password is on the fridge'],
    ["keep in mind that Paul doesn't like fish", "note that Paul doesn't like fish"],
    ['give me a five minute countdown for the eggs', 'set a timer for 5 minutes for the eggs'],
    ['half an hour for the cake', 'set a timer for 30 minutes for the cake'],
    ['put apples on the shopping', 'add apples to the shopping list'],
    ['take sugar off the shopping', 'remove sugar from the shopping list'],
    ['what do I need to buy?', 'read me the shopping list'],
    ['forget the gym reminder', 'cancel the reminder gym'],
    ['stop the countdown', 'cancel the timer'],
    ['launch word', 'open word'],
    ['show me the settings', 'open settings'],
    ['do you know the time?', 'what time is it'],
    ["what's the date today", 'what day is it'],
    ['translate this document into Italian', 'NOT_OFFLINE'],
    ['who won the game yesterday?', 'NOT_OFFLINE'],
    ['fix the bug in main.js', 'NOT_OFFLINE']
  ]
};

export function offlinePrompt(lang: Language): OfflinePrompt {
  return lang === 'en' ? EN : IT;
}

const NO_THINK = '<think>\n\n</think>\n\n';

/** Formato di chat Qwen (ChatML), senza ragionamento: istruzioni ed esempi, uguali per ogni richiesta. */
export function chatPrefix(lang: Language): string {
  const p = offlinePrompt(lang);
  let out = `<|im_start|>system\n${p.system}<|im_end|>\n`;
  for (const [user, assistant] of p.shots) out += `<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n${assistant}<|im_end|>\n`;
  return out + '<|im_start|>user\n';
}

/** La coda: la frase dell'utente e l'inizio della risposta (dopo `chatPrefix`). */
export function chatTurn(text: string): string {
  return `${cleanUserText(text)}<|im_end|>\n<|im_start|>assistant\n${NO_THINK}`;
}

/** Una frase sola, senza marcatori di chat: chi scrive «<|im_end|>» non riscrive le istruzioni. */
export function cleanUserText(text: string): string {
  return text.replace(/<\|/g, '<').replace(/\|>/g, '>').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export type ModelLine = { readonly kind: 'refuse' } | { readonly kind: 'time' } | { readonly kind: 'date' } | { readonly kind: 'other'; readonly text: string };

const TIME_Q = /^(?:che\s+ore\s+sono|che\s+ora\s+[eè]|sai\s+dirmi\s+l'ora|what\s+time\s+is\s+it|what'?s\s+the\s+time)\b/i;
const DATE_Q = /^(?:che\s+giorno\s+[eè]|che\s+data\s+[eè]|oggi\s+che\s+giorno|quanti\s+ne\s+abbiamo|what\s+day\s+is\s+it|what'?s\s+the\s+date|what\s+is\s+the\s+date|what\s+day\s+is\s+today)/i;

/** La prima riga utile della risposta del modello, letta come VISIONE la userebbe. */
export function readModelLine(raw: string): ModelLine {
  const first = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0] ?? '';
  const line = first.trim().replace(/^["'«“]+|["'»”.!]+$/g, '').trim();
  if (/^(?:NON_OFFLINE|NOT_OFFLINE)\b/i.test(line)) return { kind: 'refuse' };
  if (TIME_Q.test(line)) return { kind: 'time' };
  if (DATE_Q.test(line)) return { kind: 'date' };
  return { kind: 'other', text: line };
}

/** Domande su ora e data riconosciute dalla frase stessa, senza modello. */
export function timeOrDateQuestion(text: string): 'time' | 'date' | null {
  const t = text.trim().replace(/^(?:(?:ehi|hey|ok)\s+)?(?:visione[\s,]+)?/i, '').replace(/[?!.\s]+$/, '');
  if (TIME_Q.test(t)) return 'time';
  if (DATE_Q.test(t)) return 'date';
  return null;
}

/** Risposta a «che ore sono» / «che giorno è» con l'orologio del PC. */
export function answerTimeOrDate(kind: 'time' | 'date', now: number, lang: Language): string {
  const d = new Date(now);
  if (lang === 'en') {
    return kind === 'time'
      ? `It's ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
      : `Today is ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`;
  }
  if (kind === 'time') {
    const hh = d.getHours();
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh === 1 ? `È l'una${mm === '00' ? '' : ` e ${Number(mm)}`}.` : `Sono le ${hh}:${mm}.`;
  }
  return `Oggi è ${d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;
}
