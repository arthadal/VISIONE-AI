// Saluto di stato all'avvio (11/10/2026, richiesta del proprietario): dopo la frase di benvenuto,
// VISIONE dice come sta il PC, se i motori sono pronti, cosa resta da terminare, le approvazioni in
// attesa e gli impegni di oggi. Composizione pura dai fatti REALI raccolti dal kernel: un fatto che
// non c'è (telemetria spenta) non si dice, non si inventa.
// 12/10/2026: «i motori rispondono» era detto dopo aver solo trovato il programma. Ora il kernel fa la
// verifica vera dell'accesso (`AgentAdapter.health`) e il saluto distingue pronto, non pronto (con il
// motivo) e non verificato in tempo: mai un «tutto a posto» non controllato. Italiano e inglese (P-108).
import type { Language } from '../../shared/contracts/index.ts';

export interface BriefingEngine {
  readonly name: string;
  /** true = verificato e pronto; false = verificato e NON pronto; null = verifica non finita in tempo. */
  readonly ok: boolean | null;
  /** Il motivo, se non pronto (breve, da dire). */
  readonly detail?: string;
}

/** Meteo del luogo scelto nel widget (22/10/2026): adesso e il giorno da raccontare (oggi, o domani la sera). */
export interface BriefingWeather {
  readonly place: string;
  readonly tempC: number | null;
  /** Codice simbolo di MET Norway (es. `partlycloudy_day`). */
  readonly symbol: string | null;
  readonly day: { readonly when: 'today' | 'tomorrow'; readonly minC: number | null; readonly maxC: number | null; readonly symbol: string | null } | null;
}

export interface BriefingFacts {
  /** Frase di benvenuto scelta dal proprietario (es. «{saluto} signore, bentornato.»), già risolta. */
  readonly greeting: string;
  /** Meteo, se il proprietario ha scelto una città e il servizio ha risposto in tempo. */
  readonly weather?: BriefingWeather | null;
  /** Battuta scritta da un modello sui fatti di adesso (mai una frase fatta); null = nessun modello veloce. */
  readonly quip?: string | null;
  /** Lavori conclusi dopo l'ultimo comando del proprietario (titoli). */
  readonly meanwhile?: { readonly done: readonly string[]; readonly failed: readonly string[] } | null;
  readonly pc: { readonly cpuPercent: number | null; readonly ramPercent: number | null } | null;
  /** Motori usati dagli agenti, con l'esito della verifica; vuoto = nessun agente attivo. */
  readonly engines: readonly BriefingEngine[];
  /** L'avvio precedente non si è chiuso in modo pulito. */
  readonly unclean: boolean;
  /** Obiettivi non conclusi (titoli, il più recente prima). */
  readonly unfinished: readonly string[];
  readonly approvals: number;
  /** Agenti in errore (nomi). */
  readonly agentsInError: readonly string[];
  /** Frase dell'agenda di oggi, se ci sono impegni; null altrimenti. */
  readonly agenda: string | null;
  /**
   * Procedura guidata non ancora finita (VM, 22/10/2026): al primo avvio il tester sentiva «Attenzione: <motore> non è
   * pronto» prima di aver scelto un motore. Allora solo il benvenuto e l'invito a seguire i passi.
   */
  readonly firstRun?: boolean;
}

/** «A», «A e B», «A, B e C» (in inglese «A, B and C»). */
export function listIt(items: readonly string[], lang: Language = 'it'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'e'} ${items[items.length - 1]}`;
}

const pct = (n: number, lang: Language): string => `${Math.round(n)} ${lang === 'en' ? 'percent' : 'per cento'}`;
const quote = (t: string, lang: Language): string => {
  const s = t.length > 60 ? `${t.slice(0, 57)}…` : t;
  return lang === 'en' ? `“${s}”` : `«${s}»`;
};
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * `{saluto}` nella frase di benvenuto (22/10/2026, «buongiorno signore, bentornato»): il saluto dell'ora.
 * Dalle 5 alle 13 buongiorno, fino alle 18 buon pomeriggio, poi buonasera; maiuscola solo a inizio frase.
 */
export function resolveGreeting(phrase: string, hour: number, lang: Language = 'it'): string {
  if (!phrase.includes('{saluto}')) return phrase;
  const word = lang === 'en'
    ? (hour >= 5 && hour < 12 ? 'good morning' : hour >= 12 && hour < 18 ? 'good afternoon' : 'good evening')
    : (hour >= 5 && hour < 13 ? 'buongiorno' : hour >= 13 && hour < 18 ? 'buon pomeriggio' : 'buonasera');
  return phrase.replace(/\{saluto\}/g, (_m, at: number) =>
    /^\s*$|[.!?]\s+$/.test(phrase.slice(0, at)) ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word);
}

/** Il simbolo di MET Norway in parole: prima i fenomeni (temporale, neve…), poi il cielo. */
export function weatherWords(symbol: string | null, lang: Language = 'it'): string | null {
  if (!symbol) return null;
  const s = symbol.replace(/_(day|night|polartwilight)$/, '');
  const en = lang === 'en';
  if (s.includes('thunder')) return en ? 'thunderstorms' : 'temporale';
  if (s.includes('sleet')) return en ? 'sleet' : 'nevischio';
  if (s.includes('snow')) return en ? 'snow' : 'neve';
  if (s.includes('rainshowers')) return en ? 'showers' : 'rovesci';
  if (s.includes('rain')) return s.startsWith('light') ? (en ? 'light rain' : 'pioggia leggera') : s.startsWith('heavy') ? (en ? 'heavy rain' : 'pioggia forte') : (en ? 'rain' : 'pioggia');
  if (s === 'fog') return en ? 'fog' : 'nebbia';
  if (s === 'cloudy') return en ? 'overcast skies' : 'cielo coperto';
  if (s === 'partlycloudy') return en ? 'partly cloudy skies' : 'cielo parzialmente nuvoloso';
  if (s === 'fair') return en ? 'mostly clear skies' : 'cielo poco nuvoloso';
  if (s === 'clearsky') return en ? 'clear skies' : 'cielo sereno';
  return null;
}

const degrees = (c: number, lang: Language): string => {
  const n = Math.round(c);
  return n < 0 ? `${lang === 'en' ? 'minus' : 'meno'} ${-n}` : String(n);
};

/** «A Cassolnovo ci sono 14 gradi e cielo sereno. Oggi fra 9 e 17 gradi.» Solo i pezzi che ci sono. */
export function weatherSentence(w: BriefingWeather, lang: Language = 'it'): string | null {
  const en = lang === 'en';
  const out: string[] = [];
  const words = weatherWords(w.symbol, lang);
  if (w.tempC !== null) {
    const t = degrees(w.tempC, lang);
    const unit = Math.abs(Math.round(w.tempC)) === 1 ? (en ? 'degree' : 'grado') : (en ? 'degrees' : 'gradi');
    out.push(en
      ? `In ${w.place} it is ${t} ${unit}${words ? ` with ${words}` : ''}.`
      : `A ${w.place} ${Math.abs(Math.round(w.tempC)) === 1 ? "c'è" : 'ci sono'} ${t} ${unit}${words ? ` e ${words}` : ''}.`);
  } else if (words) out.push(en ? `In ${w.place}: ${words}.` : `A ${w.place}: ${words}.`);
  const d = w.day;
  if (d && d.minC !== null && d.maxC !== null) {
    const dayWords = d.when === 'tomorrow' ? weatherWords(d.symbol, lang) : null;
    const head = d.when === 'tomorrow' ? (en ? 'Tomorrow' : 'Domani') : (en ? 'Today' : 'Oggi');
    const range = en ? `between ${degrees(d.minC, lang)} and ${degrees(d.maxC, lang)} degrees` : `fra ${degrees(d.minC, lang)} e ${degrees(d.maxC, lang)} gradi`;
    out.push(`${head}${dayWords ? ` ${dayWords},` : ''} ${range}.`);
  }
  return out.length > 0 ? out.join(' ') : null;
}

/**
 * Fatti per la battuta: solo ciò che VISIONE sa davvero, perché il modello non inventi. Niente numeri del PC
 * (prova del 22/10/2026: la battuta citava il processore allo «0,24%» e il saluto, subito dopo, al 17%), niente meteo
 * (22/10/2026: «non battute sul meteo»: il meteo lo dice già il saluto).
 */
export interface QuipFacts {
  readonly hour: number;
  readonly weekday: number;
  readonly pending: number;
  /** Cose dette o chieste da lui di recente (le sue richieste): l'ispirazione della frase. */
  readonly sayings?: readonly { readonly text: string; readonly ago: string }[];
  /** Battute che gli sono piaciute / non gli sono piaciute («bella», «questa no»): il tono da seguire e da evitare. */
  readonly liked?: readonly string[];
  readonly disliked?: readonly string[];
}

/**
 * Richiesta della battuta. 22/10/2026, proprietario: non battute sul meteo ma «frasi motivazionali messe sul ridere,
 * di business o di vita», ispirate a ciò che lui scrive o dice, che autoapprendono. Le scrive un modello ogni volta:
 * niente frasi fatte (regola del proprietario, 15/10/2026). L'esempio di tono è suo.
 */
export function quipPrompt(f: QuipFacts, lang: Language = 'it'): { system: string; user: string } {
  const en = lang === 'en';
  const days = en
    ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    : ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  const block = (head: string, items: readonly string[] | undefined): string | null =>
    items && items.length > 0 ? `${head}:\n${items.map((x) => `- ${x}`).join('\n')}` : null;
  const facts = [
    `${en ? 'Time' : 'Ora'}: ${f.hour}:00, ${days[f.weekday] ?? ''}`,
    `${en ? 'Unfinished jobs' : 'Lavori in sospeso'}: ${f.pending}`,
    block(en ? 'Things the owner said or asked recently' : 'Cose dette o chieste da lui di recente', f.sayings?.map((s) => `(${s.ago}) ${s.text}`)),
    block(en ? 'Quips the owner liked (follow this tone)' : 'Battute che gli sono piaciute (segui questo tono)', f.liked),
    block(en ? 'Quips the owner did not like (avoid this tone, never repeat them)' : 'Battute che non gli sono piaciute (evita questo tono, non ripeterle)', f.disliked)
  ].filter((x): x is string => x !== null).join('\n');
  if (en) {
    return {
      system: 'You are VISIONE, the personal assistant of your owner, with the dry wit of a British butler. Write ONE ' +
        'sentence (at most 25 words) to say aloud as your owner arrives: a motivational line with a laugh, about business ' +
        'or life, inspired if you can by one of the things the owner said or asked recently (below). The tone the owner ' +
        'likes: "if today goes badly, think what the dead would have to say". Light dark humour is fine, but never about ' +
        'real people, specific deaths, illnesses or real tragedies; never vulgar, no stale puns, no greeting-card wisdom, ' +
        'no weather. Do not greet (the greeting is already said), no numbers, no emoji, no quotes, no lists, do not ' +
        'invent facts about the owner. Reply with the sentence only.',
      user: facts
    };
  }
  return {
    system: "Sei VISIONE, l'assistente personale del proprietario, con l'ironia asciutta di un maggiordomo inglese. Scrivi UNA " +
      'sola frase (al massimo 25 parole) da dirgli a voce appena arriva: una frase motivazionale messa sul ridere, di ' +
      'business o di vita, ispirata se puoi a una delle cose che ha detto o chiesto di recente (qui sotto). Il tono che ' +
      'gli piace: «se oggi non va bene, pensa a chi è morto cosa dovrebbe dire». Umorismo nero leggero sì, ma mai su ' +
      'persone reali, lutti precisi, malattie o tragedie vere; mai volgare, niente giochi di parole scontati, niente frasi ' +
      "da cioccolatino, niente meteo. Non salutare (il saluto c'è già), niente numeri, emoji, virgolette o elenchi, non " +
      'inventare fatti su di lui. Rispondi solo con la frase.',
    user: facts
  };
}

/** Un saluto in testa alla battuta (il modello lo aggiunge anche se gli si dice di no: prova del 22/10/2026). */
const LEADING_GREETING = /^(buon\s?giorno|buon\s?pomeriggio|buona\s?sera|buonanotte|salve|ciao|bentornato|good (morning|afternoon|evening)|welcome back|hello)\b[^.!?]*[.!?]\s*/i;

/**
 * La battuta come la dice VISIONE: una frase sola (la prima, se il modello ne scrive di più), senza saluto in testa,
 * virgolette o markup, al più 30 parole; altrimenti null.
 */
export function cleanQuip(text: string | null): string | null {
  if (!text) return null;
  if (/<\/?think/i.test(text)) return null;
  const line = text.replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().replace(/^["«“']+|["»”']+$/g, '').trim().replace(LEADING_GREETING, '');
  const first = (line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line).replace(/^["«“']+|["»”']+$/g, '').trim();
  const words = first.split(/\s+/).filter(Boolean).length;
  if (first.length < 8 || words > 30) return null;
  return sentence(first);
}

export function composeBriefing(f: BriefingFacts, lang: Language = 'it'): string {
  const en = lang === 'en';
  const out: string[] = [];
  const greeting = f.greeting.trim();
  if (greeting) out.push(sentence(greeting));
  if (f.firstRun) {
    out.push(en ? "Welcome: let's set up VISIONE together, follow the steps on the screen." : 'Benvenuto: prepariamo VISIONE insieme, segui i passi sullo schermo.');
    return out.join(' ');
  }
  // L'ordine chiesto dal proprietario (22/10/2026): saluto, meteo, battuta, poi PC, sistemi e cosa è successo.
  const weather = f.weather ? weatherSentence(f.weather, lang) : null;
  if (weather) out.push(weather);
  if (f.quip) out.push(f.quip);

  if (f.unclean) out.push(en ? 'The last session did not close properly: I recovered its state.' : "L'ultima sessione si è chiusa male: ho recuperato lo stato.");

  if (f.pc && (f.pc.cpuPercent !== null || f.pc.ramPercent !== null)) {
    const bits: string[] = [];
    if (f.pc.cpuPercent !== null) bits.push(en ? `processor at ${pct(f.pc.cpuPercent, lang)}` : `processore al ${pct(f.pc.cpuPercent, lang)}`);
    if (f.pc.ramPercent !== null) bits.push(en ? `memory at ${pct(f.pc.ramPercent, lang)}` : `memoria al ${pct(f.pc.ramPercent, lang)}`);
    const busy = (f.pc.cpuPercent ?? 0) >= 85 || (f.pc.ramPercent ?? 0) >= 90;
    const head = en ? (busy ? 'The PC is under strain' : 'The PC is fine') : (busy ? 'Il PC è sotto sforzo' : 'Il PC sta bene');
    out.push(`${head}: ${listIt(bits, lang)}.`);
  }

  if (f.engines.length > 0) {
    const ready = f.engines.filter((e) => e.ok === true).map((e) => e.name);
    const bad = f.engines.filter((e) => e.ok === false);
    const late = f.engines.filter((e) => e.ok === null).map((e) => e.name);
    if (ready.length > 0) {
      const one = ready.length === 1;
      out.push(en
        ? `I checked ${one ? 'the engine' : 'the engines'}: ${listIt(ready, lang)} ${one ? 'is' : 'are'} ready.`
        : `Ho verificato ${one ? 'il motore' : 'i motori'}: ${listIt(ready, lang)} ${one ? 'è pronto' : 'sono pronti'}.`);
    }
    for (const e of bad) {
      const why = e.detail?.trim().replace(/[.!]+$/, '');
      out.push(en ? `Warning: ${e.name} is not ready${why ? `: ${why}` : ''}.` : `Attenzione: ${e.name} non è pronto${why ? `: ${why}` : ''}.`);
    }
    if (late.length > 0) out.push(en ? `I could not finish checking ${listIt(late, lang)} in time.` : `Non ho fatto in tempo a verificare ${listIt(late, lang)}.`);
  }

  if (f.agentsInError.length > 0) {
    const one = f.agentsInError.length === 1;
    const names = listIt(f.agentsInError, lang);
    out.push(en ? `${one ? 'The agent' : 'The agents'} ${names} ${one ? 'is' : 'are'} in error.` : `${one ? "L'agente" : 'Gli agenti'} ${names} ${one ? 'è' : 'sono'} in errore.`);
  }

  // «Se ha fatto qualcosa mentre non c'ero» (22/10/2026): solo se c'è, e misurato dal suo ultimo comando,
  // perché VISIONE non sa quando si è alzato dal PC.
  // Titoli uguali si dicono una volta col numero (prova del 22/10/2026: «Verifica…» e «Verifica…»).
  const counted = (titles: readonly string[]): string[] => {
    const n = new Map<string, number>();
    for (const t of titles) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].map(([t, k]) => `${quote(t, lang)}${k > 1 ? (en ? ` ${k} times` : ` ${k} volte`) : ''}`);
  };
  const named = (titles: readonly string[]): string => {
    const items = counted(titles);
    return items.length > 2 ? `${items.slice(0, 2).join(', ')} ${en ? `and ${items.length - 2} more` : `e altri ${items.length - 2}`}` : listIt(items, lang);
  };
  const done = f.meanwhile?.done ?? [];
  const failed = f.meanwhile?.failed ?? [];
  if (done.length > 0) out.push(en ? `Since your last command I finished ${named(done)}.` : `Dal tuo ultimo comando ho concluso ${named(done)}.`);
  if (failed.length > 0) {
    out.push(en ? `${named(failed)} did not succeed.` : `Non ${failed.length === 1 ? 'è andato' : 'sono andati'} a buon fine ${named(failed)}.`);
  }

  const n = f.unfinished.length;
  if (n === 0) out.push(en ? 'No unfinished work.' : 'Nessun lavoro in sospeso.');
  else {
    const titles = f.unfinished.slice(0, 2).map((t) => quote(t, lang));
    const list = n > 2 ? `${titles.join(', ')} ${en ? 'and others' : 'e altri'}` : listIt(titles, lang);
    out.push(en
      ? `${n === 1 ? 'There is one job to finish' : `There are ${n} jobs to finish`}: ${list}.`
      : `${n === 1 ? "C'è un lavoro da terminare" : `Ci sono ${n} lavori da terminare`}: ${list}.`);
  }

  if (f.approvals > 0) {
    out.push(en
      ? `${f.approvals === 1 ? 'One approval is' : `${f.approvals} approvals are`} waiting for your decision.`
      : `${f.approvals === 1 ? "Un'approvazione aspetta" : `${f.approvals} approvazioni aspettano`} la tua decisione.`);
  }
  if (f.agenda) out.push(f.agenda);
  return out.join(' ');
}
