// Modalità semplice / esperto (11/10/2026): cosa vede chi usa VISIONE ogni giorno.
import { describe, expect, it } from 'vitest';
import { expertOf, lightOf, panelVisible, settingVisible, tabVisible, windowVisible } from '../../src/renderer/lib/mode.ts';
import { LEGGERO_MS, leggeroSalta } from '../../src/renderer/neural/qualita.ts';
import { HOT_PATHS } from '../../src/renderer/app/restart-logic.ts';
import { leaves } from '../../src/renderer/app/settings-meta.ts';
import { visioneConfigSchema } from '../../src/shared/node/config.ts';

describe('modalità semplice / esperto', () => {
  it('spenta di partenza; si legge da ui.expert e vale senza riavvio', () => {
    expect(expertOf({})).toBe(false);
    expect(expertOf({ ui: { expert: true } })).toBe(true);
    expect(expertOf({ ui: { expert: 'sì' } })).toBe(false);
    expect(HOT_PATHS.has('ui.expert')).toBe(true);
  });

  it('semplice: finestre di tutti i giorni, niente registro né diagnostica; esperto: tutto', () => {
    for (const k of ['director', 'apps', 'files', 'system', 'errors', 'approvals']) expect(windowVisible(k, false)).toBe(true);
    for (const k of ['telemetry', 'logs', 'terminal', 'memory']) {
      expect(windowVisible(k, false)).toBe(false);
      expect(windowVisible(k, true)).toBe(true);
    }
    expect(tabVisible('log', false)).toBe(false);
    expect(tabVisible('agents', false)).toBe(true);
    expect(panelVisible('diag', false)).toBe(false);
    expect(panelVisible('diag', true)).toBe(true);
    expect(panelVisible('engines', false)).toBe(true);
  });

  it('impostazioni in modalità semplice: solo voce e avvio, e l’interruttore non si duplica nella griglia', () => {
    expect(settingVisible('voice.volume', false)).toBe(true);
    expect(settingVisible('ui.startWithWindows', false)).toBe(true);
    expect(settingVisible('supervisor.heartbeatIntervalMs', false)).toBe(false);
    expect(settingVisible('supervisor.heartbeatIntervalMs', true)).toBe(true);
    const paths = leaves(visioneConfigSchema.parse({ version: 1 }) as unknown as Record<string, unknown>).map((l) => l.path);
    expect(paths).not.toContain('ui.expert');
    expect(paths).toContain('voice.volume');
  });
});

describe('modalità leggera (punto 7)', () => {
  it('spenta di partenza; si legge da ui.light, vale subito ed è fra le impostazioni semplici', () => {
    expect(lightOf({})).toBe(false);
    expect(lightOf({ ui: { light: true } })).toBe(true);
    expect(lightOf({ ui: { light: 1 } })).toBe(false);
    expect(visioneConfigSchema.parse({ version: 1 }).ui.light).toBe(false);
    expect(HOT_PATHS.has('ui.light')).toBe(true);
    expect(settingVisible('ui.light', false)).toBe(true);
  });

  it('la scena disegna al massimo ~30 fotogrammi al secondo: a 60 Hz uno sì e uno no', () => {
    expect(leggeroSalta(false, 16.7)).toBe(false);
    expect(leggeroSalta(true, 16.7)).toBe(true);
    expect(leggeroSalta(true, 33.4)).toBe(false);
    // Il primo fotogramma (nessun precedente) si disegna sempre.
    expect(leggeroSalta(true, 0)).toBe(false);
    expect(LEGGERO_MS).toBeLessThan(1000 / 30);
  });
});
