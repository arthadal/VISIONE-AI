// Riconoscimento del limite di quota di Claude Code dall'output REALE della CLI (P-83).
// Fonte verificata nelle build installate 2.1.289/2.1.290 (`bin/claude.exe`): i banner del TUI sono
//   «Usage limit reached · limit resets <ora>»            (fn gmr: Te + Cwr)
//   «Usage limit reached · continuing automatically <quando> · esc to cancel»   (pt.started)
//   «Usage limit reached again · continuing automatically <quando> · esc to cancel» (pt.rearmed)
//   «You've hit your monthly spend limit.» / «You've hit your fast limit · resets in …»
//   «You've hit your weekly limit · resets <quando>»     (misurato dal vivo il 06/10/2026, 2.1.290)
//   «Lower-priority mode ended · you have reached your weekly usage limit»
// Le fixture dei test sono queste stringhe esatte. «Context limit reached · /compact or /clear to
// continue» NON è una quota: non attiva il ripiego. La ricerca è sulla riga normalizzata e ancorata
// all'inizio (dopo caratteri non alfanumerici): una citazione dentro una frase non fa scattare il
// riconoscimento; la casella di input (`❯`) è esclusa per lo stesso motivo.
export type LimitScope = 'session' | 'weekly' | 'monthly' | 'fast' | 'unknown';

export interface LimitHit {
  readonly scope: LimitScope;
  /** Testo del banner come mostrato dalla CLI (troncato dall'evento). */
  readonly message: string;
  /** Quando il motore lo dichiara come testo («3:00pm», «shortly»…); null se non lo dice. */
  readonly resetAt: string | null;
}

/** CSI (`ESC [ … finale`), OSC (`ESC ] … BEL|ST`) e sequenze ESC di due caratteri. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Testo della riga confrontabile: senza sequenze di controllo, spazi e maiuscole. */
export function screenText(raw: string): string {
  return raw.replace(ANSI, '').replace(/\s+/g, '').toLowerCase();
}

// Sul testo per il riconoscimento cadono anche apostrofi e separatori (`you've` → `youve`).
const PATTERNS: ReadonlyArray<{ scope: LimitScope; re: RegExp }> = [
  { scope: 'monthly', re: /youvehityour(?:channels)?monthlyspendlimit/ },
  { scope: 'fast', re: /youvehityourfastlimit/ },
  // «You've hit your weekly limit · resets Oct 7 , 6pm (Europe/Rome)» (2.1.290, misurato dal vivo).
  // `compact` toglie anche punti e virgole, quindi il pattern copre «weekly (usage) limit».
  { scope: 'weekly', re: /youvehityourweekly(?:usage)?limit/ },
  { scope: 'weekly', re: /youhavereachedyourweeklyusagelimit/ },
  // Il banner generico è ancorato all'inizio (dopo simboli di cornice): una citazione dentro una
  // frase non fa scattare il ripiego.
  { scope: 'session', re: /^[^a-z0-9]*usagelimitreached/ }
];

/** Riconosce un banner di limite nella riga grezza della CLI; null = nessun limite. */
export function detectLimit(raw: string): LimitHit | null {
  // Un blocco del TUI può contenere più righe di schermo nella stessa "linea" del runtime (il
  // ridisegno usa posizionamenti del cursore, non a-capo): si valuta ogni segmento di schermo.
  for (const part of raw.split(SCREEN_BREAK)) {
    const hit = limitInSegment(part);
    if (hit) return hit;
  }
  return null;
}

/** Confini di disegno del TUI: a-capo e posizionamenti del cursore (`ESC[<riga>;<col>H|f`). */
const SCREEN_BREAK = /\r?\n|\x1b\[[0-9;]*[Hf]/;

function limitInSegment(rawLine: string): LimitHit | null {
  // La casella di input è esclusa: una citazione dell'utente non è un limite.
  if (rawLine.includes('❯')) return null;
  const text = screenText(rawLine);
  if (text.length === 0) return null;
  const compact = text.replace(/[^a-z0-9:.]+/g, '');
  const hit = PATTERNS.find((p) => (p.scope === 'session' ? p.re.test(text) : p.re.test(compact)));
  if (!hit) return null;
  const reset =
    /limitresets([a-z0-9:.]+)/.exec(text)?.[1] ??
    /resetsin([a-z0-9:.]+)/.exec(text)?.[1] ??
    // «resets Oct 7 , 6pm»: il testo normale tiene la virgola (2.1.290).
    /resets([a-z0-9:.,]+)/.exec(text)?.[1] ??
    (compact.includes('continuingautomaticallyshortly') ? 'shortly' : undefined) ??
    /continuingautomaticallyat([a-z0-9:.]+)/.exec(text)?.[1] ??
    null;
  return { scope: hit.scope, message: rawLine.trim().slice(0, 500), resetAt: reset };
}
