// Guida al primo avvio (11/10/2026, prima dell'uscita): le cose più utili di VISIONE, in ordine, una
// tappa alla volta, ognuna illuminata sull'elemento vero dell'interfaccia con cosa è e come si usa.
// Compare una volta dopo la procedura guidata (`ui.guideSeen`) e si riapre dallo Start o da Ctrl+K.
// Qui il calcolo puro e testato; la resa è in `Guide.tsx`.
import type { MessageKey } from '../lib/i18n/index.ts';

export interface GuideStep {
  readonly id: string;
  /** Elemento da illuminare; `null` = scheda al centro dello schermo. */
  readonly target: string | null;
  readonly title: MessageKey;
  readonly body: MessageKey;
}

/** Dalle cose più utili alle altre: parlare, chiedere, Start ed Esplora, promemoria, il resto. */
export const GUIDE_STEPS: readonly GuideStep[] = [
  { id: 'welcome', target: null, title: 'guide.welcome.title', body: 'guide.welcome.body' },
  { id: 'voice', target: '[data-testid="voice-button"]', title: 'guide.voice.title', body: 'guide.voice.body' },
  { id: 'goal', target: '[data-testid="goal-input"]', title: 'guide.goal.title', body: 'guide.goal.body' },
  { id: 'scene', target: '.neural-label.k-director', title: 'guide.scene.title', body: 'guide.scene.body' },
  { id: 'start', target: '[data-testid="start-button"]', title: 'guide.start.title', body: 'guide.start.body' },
  { id: 'windows', target: '[data-testid="windows-menu"]', title: 'guide.windows.title', body: 'guide.windows.body' },
  { id: 'widgets', target: '[data-testid="widgets-menu"]', title: 'guide.widgets.title', body: 'guide.widgets.body' },
  { id: 'tabs', target: '[data-testid="side-tabs"]', title: 'guide.tabs.title', body: 'guide.tabs.body' },
  { id: 'palette', target: '[data-testid="open-palette"]', title: 'guide.palette.title', body: 'guide.palette.body' },
  { id: 'settings', target: '[data-testid="open-settings"]', title: 'guide.settings.title', body: 'guide.settings.body' },
  { id: 'done', target: null, title: 'guide.done.title', body: 'guide.done.body' }
];

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Margine dal bordo e distanza tra elemento e scheda. */
const EDGE = 16;
const GAP = 14;

/**
 * Dove mettere la scheda: sopra l'elemento se sta nella metà bassa dello schermo, altrimenti sotto;
 * di lato se né sopra né sotto c'è posto (linguette sul bordo destro); centrata sull'elemento e
 * sempre dentro lo schermo. Senza elemento: al centro.
 */
export function cardPosition(target: Rect | null, view: { w: number; h: number }, card: { w: number; h: number }): { x: number; y: number } {
  const clampX = (x: number): number => Math.min(Math.max(EDGE, x), Math.max(EDGE, view.w - card.w - EDGE));
  const clampY = (y: number): number => Math.min(Math.max(EDGE, y), Math.max(EDGE, view.h - card.h - EDGE));
  if (!target) return { x: clampX((view.w - card.w) / 2), y: clampY((view.h - card.h) / 2) };
  const centerX = target.x + target.w / 2 - card.w / 2;
  const above = target.y - GAP - card.h;
  const below = target.y + target.h + GAP;
  const lowerHalf = target.y + target.h / 2 > view.h / 2;
  if (lowerHalf && above >= EDGE) return { x: clampX(centerX), y: above };
  if (!lowerHalf && below + card.h <= view.h - EDGE) return { x: clampX(centerX), y: below };
  // Elemento alto quasi quanto lo schermo: di fianco, dal lato con più spazio.
  const left = target.x - GAP - card.w;
  const x = left >= EDGE ? left : target.x + target.w + GAP;
  return { x: clampX(x), y: clampY(target.y + target.h / 2 - card.h / 2) };
}

/** La guida si mostra da sola una volta, a procedura guidata fatta, intro finita e nulla davanti. */
export function shouldAutoShow(s: { ready: boolean; setupComplete: boolean; setupOpen: boolean; introOn: boolean; guideSeen: boolean | null }): boolean {
  return s.ready && s.setupComplete && !s.setupOpen && !s.introOn && s.guideSeen === false;
}

export function guideSeenOf(config: Record<string, unknown>): boolean {
  return (config.ui as { guideSeen?: unknown } | undefined)?.guideSeen === true;
}
