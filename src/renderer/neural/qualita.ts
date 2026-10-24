// Controllo della qualità adattiva della scena Neural (P-90; reso stabile in P-92). Da P-90 il ciclo
// di rendering gira SEMPRE mentre la vista è visibile: senza isteresi bastava una singola finestra
// lenta (o il costo di ricostruzione della scena a ogni cambio di qualità) per far scendere la
// qualità a ripetizione, e a riposo la scena restava a q0/q1 — metà risoluzione e 30–55% delle
// particelle — invece della resa piena approvata di P-89 (regressione P-90, corretta in P-92).
//
// La politica è pura e testata: si scende di qualità solo dopo `QUALITA_FINESTRE_GIU` finestre
// consecutive sotto `QUALITA_FPS_GIU`; si sale dopo `QUALITA_FINESTRE_SU` finestre sopra
// `QUALITA_FPS_SU`; dopo ogni ricostruzione la scena si assesta per `QUALITA_ASSESTAMENTO`
// fotogrammi non misurati, perché shader e buffer appena creati non sono fps di regime.

/** Fotogrammi per finestra di misura (30 ≈ mezzo secondo a 60 fps). */
export const QUALITA_FINESTRA = 30;
/** Sotto questo valore di fps una finestra è «cattiva». */
export const QUALITA_FPS_GIU = 50;
/** Da questo valore di fps una finestra conta per la promozione. */
export const QUALITA_FPS_SU = 58;
/** Finestre cattive consecutive necessarie per scendere di qualità. */
export const QUALITA_FINESTRE_GIU = 3;
/** Finestre buone consecutive necessarie per salire di qualità. */
export const QUALITA_FINESTRE_SU = 10;
/** Fotogrammi non misurati dopo una ricostruzione (compilazione shader, buffer nuovi). */
export const QUALITA_ASSESTAMENTO = 10;
/**
 * Modalità leggera (`ui.light`, punto 7 del 14/10/2026): per i PC meno potenti la scena resta alla
 * qualità minima e disegna al massimo ~30 fotogrammi al secondo. Il ciclo del browser chiama a 60 Hz
 * (o più): si disegna solo quando dall'ultimo fotogramma sono passati almeno `LEGGERO_MS`. Un po'
 * sotto i 33,3 ms, così a 60 Hz cade un fotogramma sì e uno no invece di due su tre.
 */
export const LEGGERO_MS = 29;
export const leggeroSalta = (light: boolean, sinceLast: number): boolean => light && sinceLast > 0 && sinceLast < LEGGERO_MS;

export interface QualitaStato {
  /** Finestre consecutive sopra soglia (conta per salire). */
  buone: number;
  /** Finestre consecutive sotto soglia (conta per scendere). */
  cattive: number;
}

/** Passo della politica per una finestra: `giu`, `su` o nessun cambio; stato aggiornato (puro). */
export function qualitaPasso(
  fps: number,
  quality: 0 | 1 | 2,
  stato: QualitaStato
): { passo: 'giu' | 'su' | null; stato: QualitaStato } {
  if (!Number.isFinite(fps)) return { passo: null, stato };
  if (fps < QUALITA_FPS_GIU) {
    const cattive = stato.cattive + 1;
    if (cattive >= QUALITA_FINESTRE_GIU && quality > 0) return { passo: 'giu', stato: { buone: 0, cattive: 0 } };
    return { passo: null, stato: { buone: 0, cattive } };
  }
  const buone = stato.buone + 1;
  if (fps >= QUALITA_FPS_SU && quality < 2 && buone >= QUALITA_FINESTRE_SU) {
    return { passo: 'su', stato: { buone: 0, cattive: 0 } };
  }
  return { passo: null, stato: { buone, cattive: 0 } };
}
