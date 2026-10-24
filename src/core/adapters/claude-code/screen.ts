// Schermo virtuale minimo per leggere il dialogo di fiducia di Claude Code come lo vede l'utente.
// Il TUI non ridisegna il dialogo intero quando la selezione si sposta: riscrive solo la colonna della
// freccia nelle due righe (misurato il 10/10/2026 con 2.1.293 avviato da VISIONE installata:
// «ESC[14;2H ESC[15;2H>»). Letto come testo concatenato, la prima «> No» restava l'unica opzione
// «marcata» e VISIONE continuava a premere freccia giù, facendo oscillare la selezione fino a
// rinunciare. Qui i caratteri finiscono nella cella in cui li mette il terminale e conta lo stato finale.

/** CSI (parametri anche privati `<=>?`), OSC, ESC di due caratteri, a capo e singoli caratteri. */
const TOKEN = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\r\n\t]|[^\x1b\r\n\t]/gu;

/** Righe dello schermo dopo aver applicato posizionamenti del cursore e cancellazioni. */
export function screenRows(raw: string): string[] {
  const grid: string[][] = [];
  let r = 0;
  let c = 0;
  for (const m of raw.matchAll(TOKEN)) {
    const t = m[0];
    const final = m[2];
    if (final !== undefined) {
      const params = m[1] ?? '';
      if (/[<=>?]/.test(params)) continue; // modi privati: non muovono il cursore né scrivono
      const n = params.split(';').map(Number);
      const a = n[0] || 1;
      switch (final) {
        case 'H':
        case 'f': r = a - 1; c = (n[1] || 1) - 1; break;
        case 'A': r = Math.max(0, r - a); break;
        case 'B': r += a; break;
        case 'C': c += a; break;
        case 'D': c = Math.max(0, c - a); break;
        case 'G': c = a - 1; break;
        case 'd': r = a - 1; break;
        case 'J': {
          const row = grid[r];
          if (n[0] === 2 || n[0] === 3) grid.length = 0;
          else if (!n[0]) { grid.length = Math.min(grid.length, r + 1); if (row) row.length = Math.min(row.length, c); }
          break;
        }
        case 'K': {
          const row = grid[r];
          if (n[0] === 2) grid[r] = [];
          else if (!n[0] && row) row.length = Math.min(row.length, c);
          else if (n[0] === 1 && row) for (let i = 0; i <= c; i++) row[i] = ' ';
          break;
        }
        default: break; // colori e stili: nessun effetto sulle celle
      }
      continue;
    }
    if (t.startsWith('\x1b')) continue;
    if (t === '\r') c = 0;
    else if (t === '\n') r++;
    else if (t === '\t') c = (Math.floor(c / 8) + 1) * 8;
    else {
      const row = (grid[r] ??= []);
      row[c] = t;
      c++;
    }
  }
  return Array.from(grid, (row) => (row ? Array.from(row, (ch) => ch ?? ' ').join('') : ''));
}

/**
 * Riga d'opzione con la freccia di selezione davanti: `❯` con un terminale Unicode, `>` quando VISIONE
 * parte dall'icona, eventualmente numerata («❯ 1. Yes, proceed» nelle versioni precedenti).
 */
const MARKED_ROW = /^\s*[❯>›▸▶]\s*(?:\d+[.)]\s*)?(yes|no)\b/i;

/** Opzione evidenziata sullo schermo del dialogo di fiducia; null = nessuna freccia leggibile. */
export function selectedOption(raw: string): 'yes' | 'no' | null {
  let found: 'yes' | 'no' | null = null;
  for (const row of screenRows(raw)) {
    const m = MARKED_ROW.exec(row);
    if (m) found = (m[1] ?? '').toLowerCase() as 'yes' | 'no';
  }
  return found;
}
