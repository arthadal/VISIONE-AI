// Prova del PC per il profilo della voce (16/10/2026): la migliore di più misure. Una frase sola, misurata
// subito dopo che la procedura guidata aveva avviato la squadra, dava RTF 1,42 su un PC che ne fa 0,5 (gli
// agenti che partono si prendono la CPU per qualche secondo) e consigliava la Minima a torto. Il minimo è la
// stima meno disturbata da ciò che gira insieme: un disturbo può solo rallentare, mai accelerare.

export interface BenchRun {
  /** Secondi di audio prodotti. */
  readonly audioS: number;
  /** Millisecondi di calcolo. */
  readonly spentMs: number;
}

export interface BestOf {
  /** La misura più veloce (null = nessuna misura valida). */
  readonly best: BenchRun | null;
  /** L'RTF di ogni misura, nell'ordine: per il registro. */
  readonly rtfs: readonly number[];
}

/**
 * Ripete `run` fino a `runs` volte e tiene la più veloce. Oltre `budgetMs` dall'inizio non ne comincia altre
 * (su un PC lento una misura dura di più: si resta sotto il limite del comando). Una misura senza audio non conta.
 */
export async function bestOf(run: () => Promise<BenchRun | null>, opts: { runs: number; budgetMs: number; now: () => number }): Promise<BestOf> {
  const start = opts.now();
  const rtfs: number[] = [];
  let best: BenchRun | null = null;
  for (let i = 0; i < opts.runs; i++) {
    if (i > 0 && opts.now() - start >= opts.budgetMs) break;
    const r = await run();
    if (!r || !(r.audioS > 0)) continue;
    const rtf = r.spentMs / 1000 / r.audioS;
    rtfs.push(rtf);
    if (!best || rtf < best.spentMs / 1000 / best.audioS) best = r;
  }
  return { best, rtfs };
}
