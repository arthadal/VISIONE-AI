// Guida al primo avvio (11/10/2026): ordine delle tappe, posizione della scheda, apertura automatica.
import { describe, expect, it } from 'vitest';
import { cardPosition, GUIDE_STEPS, guideSeenOf, shouldAutoShow } from '../../src/renderer/app/guide-logic.ts';
import { en } from '../../src/renderer/lib/i18n/en.ts';
import { it as itDict } from '../../src/renderer/lib/i18n/it.ts';

const view = { w: 1536, h: 864 };
const card = { w: 380, h: 220 };

describe('guida al primo avvio', () => {
  it('si apre con il benvenuto, chiude con «tutto pronto»; prima le cose più utili; testi in due lingue', () => {
    expect(GUIDE_STEPS[0]!.id).toBe('welcome');
    expect(GUIDE_STEPS.at(-1)!.id).toBe('done');
    expect(GUIDE_STEPS.slice(1, 3).map((s) => s.id)).toEqual(['voice', 'goal']);
    for (const s of GUIDE_STEPS) {
      for (const key of [s.title, s.body]) {
        expect(itDict[key].length).toBeGreaterThan(3);
        expect(en[key].length).toBeGreaterThan(3);
        expect(en[key]).not.toBe(itDict[key]);
      }
    }
  });

  it('scheda: sopra un elemento in basso, sotto uno in alto, di fianco a uno altissimo, sempre dentro lo schermo', () => {
    const bottom = cardPosition({ x: 600, y: 820, w: 200, h: 30 }, view, card);
    expect(bottom.y + card.h).toBeLessThanOrEqual(820);
    const top = cardPosition({ x: 700, y: 20, w: 100, h: 24 }, view, card);
    expect(top.y).toBeGreaterThanOrEqual(44);
    const corner = cardPosition({ x: 10, y: 820, w: 60, h: 40 }, view, card);
    expect(corner.x).toBeGreaterThanOrEqual(16);
    const tall = cardPosition({ x: 1500, y: 100, w: 30, h: 740 }, view, card);
    expect(tall.x + card.w).toBeLessThanOrEqual(1500);
    expect(cardPosition(null, view, card)).toEqual({ x: (1536 - 380) / 2, y: (864 - 220) / 2 });
  });

  it('parte da sola una volta: pronto, procedura fatta, niente davanti, non ancora vista', () => {
    const base = { ready: true, setupComplete: true, setupOpen: false, introOn: false, guideSeen: false as boolean | null };
    expect(shouldAutoShow(base)).toBe(true);
    expect(shouldAutoShow({ ...base, guideSeen: true })).toBe(false);
    expect(shouldAutoShow({ ...base, guideSeen: null })).toBe(false);
    expect(shouldAutoShow({ ...base, setupOpen: true })).toBe(false);
    expect(shouldAutoShow({ ...base, introOn: true })).toBe(false);
    expect(shouldAutoShow({ ...base, setupComplete: false })).toBe(false);
    expect(guideSeenOf({ ui: { guideSeen: true } })).toBe(true);
    expect(guideSeenOf({})).toBe(false);
  });
});
