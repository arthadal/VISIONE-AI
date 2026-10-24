// Effetti one-shot della UI (fase G6, P-78): traduzione in tipi PURA del lessico `.fx-*` del JARVIS
// del proprietario (`C:\Users\matte\jarvis\src\ui\Effects.tsx`, MIT © 2026 Aditya Dewaskar), come
// richiesto da `docs/architecture/JARVIS_REFERENCE_ANALYSIS.md` §4.6/§6.5.
//
// Regola non negoziabile: un effetto esiste SOLO se l'evento reale che lo origina è accaduto. Non c'è
// nessun effetto periodico, nessun ciclo, nessuna animazione che «sembra» attività: qui si decide solo
// la mappa evento→effetto, in modo testabile senza DOM.
import type { VisioneEvent } from '../../shared/contracts/index.ts';

export type UiEffectKind = 'flash' | 'pulse' | 'scan' | 'glitch' | 'shake';

export interface UiEffect {
  kind: UiEffectKind;
  /** Timestamp dell'evento reale: è la chiave che rimonta il nodo e fa ripartire l'animazione. */
  at: number;
  /** Tipo dell'evento che ha innescato l'effetto (diagnostica e test). */
  cause: string;
}

/** Durata in ms, allineata ai keyframe CSS di `styles.css` (come `DURATION` del riferimento). */
export const EFFECT_MS: Record<UiEffectKind, number> = { flash: 480, pulse: 900, scan: 900, glitch: 620, shake: 520 };

/** Quanto a lungo un effetto resta montato prima di smontarsi da solo. */
export const EFFECT_TTL_MS: Record<UiEffectKind, number> = {
  flash: EFFECT_MS.flash + 80,
  pulse: EFFECT_MS.pulse + 120,
  scan: EFFECT_MS.scan + 80,
  glitch: EFFECT_MS.glitch + 80,
  shake: EFFECT_MS.shake + 80
};

function str(p: Record<string, unknown>, key: string): string {
  return typeof p[key] === 'string' ? (p[key] as string) : '';
}

function fx(kind: UiEffectKind, e: VisioneEvent): UiEffect {
  return { kind, at: e.ts, cause: e.type };
}

/** Esiti di task che meritano una «punteggiatura» di errore (i cancellati volontari no). */
const TASK_GLITCH: ReadonlySet<string> = new Set(['timed_out']);
const TASK_SCAN: ReadonlySet<string> = new Set(['blocked']);

/**
 * Mappa evento reale → effetto one-shot. Solo eventi conclusivi o di errore: la transizione
 * `failed` di un task genera un `task.result.recorded` subito dopo e due glitch ravvicinati
 * sembrerebbero un guasto della UI, quindi qui si scelgono i segnali che arrivano una volta sola.
 */
export function effectOf(e: VisioneEvent): UiEffect | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    // Task: completato → onda; parziale → scansione; fallito → strappo.
    case 'task.result.recorded': {
      const outcome = str(p, 'outcome');
      if (outcome === 'success') return fx('pulse', e);
      if (outcome === 'partial') return fx('scan', e);
      return fx('glitch', e);
    }
    case 'task.status.changed': {
      const to = str(p, 'to');
      if (TASK_GLITCH.has(to)) return fx('glitch', e);
      if (TASK_SCAN.has(to)) return fx('scan', e);
      return null;
    }
    // Agenti: errore/schianto → strappo; recupero → scansione.
    case 'agent.status.changed': {
      const to = str(p, 'to');
      if (to === 'error' || to === 'crashed') return fx('glitch', e);
      if (to === 'recovering') return fx('scan', e);
      return null;
    }
    case 'agent.breaker.changed':
      return fx('scan', e);
    // Processi e sistema: un guasto vero fa tremare il frame.
    case 'process.failed':
      return fx('glitch', e);
    case 'process.crashed':
      return fx('shake', e);
    case 'system.error':
      return fx('glitch', e);
    case 'core.crashed':
      return fx('shake', e);
    // Voce: il PTT premuto accende il frame; la trascrizione e gli errori hanno i loro segni.
    case 'voice.ptt.pressed':
      return fx('flash', e);
    case 'voice.stt.final':
      return fx('scan', e);
    case 'voice.error':
      return fx('glitch', e);
    default:
      return null;
  }
}

/**
 * Eventi nuovi rispetto all'ultimo id noto (in ordine di arrivo). Se l'id non è più nella finestra
 * della UI non si indovina la storia: si restituisce vuoto, perché un effetto su eventi vecchi
 * sarebbe un'animazione senza causa presente.
 */
export function eventsAfter(events: readonly VisioneEvent[], lastId: string | null): VisioneEvent[] {
  if (lastId === null) return [];
  const at = events.findIndex((e) => e.id === lastId);
  if (at < 0) return [];
  return events.slice(at + 1);
}

/**
 * Vero se l'evento appartiene al core corrente: gli eventi caricati dal journal all'avvio (o dopo un
 * riavvio del core) non devono produrre effetti, altrimenti l'app «esploderebbe» di animazioni su
 * una storia che l'utente non ha appena vissuto.
 */
export function isFresh(e: VisioneEvent, startedAt: number | null): boolean {
  return startedAt !== null && e.ts >= startedAt;
}

/** Primo effetto tra gli eventi nuovi, con la sua causa: l'ultimo evento reale vince. */
export function latestEffect(fresh: readonly VisioneEvent[]): UiEffect | null {
  let out: UiEffect | null = null;
  for (const e of fresh) {
    const fxNow = effectOf(e);
    if (fxNow) out = fxNow;
  }
  return out;
}
