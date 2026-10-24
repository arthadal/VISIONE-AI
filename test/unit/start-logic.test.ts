// Start di VISIONE (11/10/2026): ricerca, app fissate, recenti, preferenze salvate.
import { describe, expect, it } from 'vitest';
import { addRecent, EMPTY_START_PREFS, initials, matchScore, MAX_PINS, MAX_RECENT, rankApps, rankSettings, readStartPrefs, togglePin } from '../../src/renderer/app/start-logic.ts';

const apps = [
  { id: 'a', name: 'Visual Studio Code' }, { id: 'b', name: 'Calcolatrice' }, { id: 'c', name: 'Blocco note' },
  { id: 'd', name: 'Google Chrome' }, { id: 'e', name: 'Paint' }, { id: 'f', name: 'Esplora file' }
];

describe('start-logic', () => {
  it('ricerca: inizio del nome, poi inizio di parola, poi contenuto; accenti e maiuscole non contano', () => {
    expect(matchScore('Calcolatrice', 'calc')).toBe(3);
    expect(matchScore('Google Chrome', 'chr')).toBe(2);
    expect(matchScore('Blocco note', 'occo')).toBe(1);
    expect(matchScore('Paint', 'zz')).toBe(-1);
    expect(rankApps(apps, 'co').map((a) => a.id)).toEqual(['a', 'c', 'b']); // «Code» inizio di parola, poi «Blocco», «Calcolatrice»
    expect(rankApps(apps, 'NOTE').map((a) => a.id)).toEqual(['c']);
    expect(rankApps(apps, '')).toHaveLength(6);
  });

  it('impostazioni per etichetta', () => {
    const meta = { 'voice.volume': { label: 'Volume della voce (%)', help: 'Quanto forte parla' }, 'ui.fullscreen': { label: 'Avvio a schermo intero' } };
    expect(rankSettings(meta, 'volume')).toEqual([{ path: 'voice.volume', label: 'Volume della voce (%)' }]);
    expect(rankSettings(meta, '')).toEqual([]);
  });

  it('fissate e recenti: senza doppioni e con un tetto', () => {
    let p = togglePin(EMPTY_START_PREFS, 'a');
    expect(p.pins).toEqual(['a']);
    expect(togglePin(p, 'a').pins).toEqual([]);
    for (let i = 0; i < MAX_PINS + 3; i++) p = togglePin(p, `x${i}`);
    expect(p.pins).toHaveLength(MAX_PINS);
    let r = EMPTY_START_PREFS;
    for (let i = 0; i < MAX_RECENT + 2; i++) r = addRecent(r, { path: `C:/dati/f${i}.txt`, name: `f${i}`, kind: 'file' });
    r = addRecent(r, { path: 'c:/DATI/F5.TXT', name: 'f5', kind: 'file' });
    expect(r.recent).toHaveLength(MAX_RECENT);
    expect(r.recent[0]!.name).toBe('f5');
    expect(r.recent.filter((x) => x.name === 'f5')).toHaveLength(1);
  });

  it('preferenze corrotte → vuote; iniziali delle tessere', () => {
    expect(readStartPrefs('{rotto')).toEqual(EMPTY_START_PREFS);
    expect(readStartPrefs(JSON.stringify({ pins: ['a', 3, ''], recent: [{ path: 'x', name: 'x', kind: 'file' }, { path: 1 }] }))).toEqual({ pins: ['a'], recent: [{ path: 'x', name: 'x', kind: 'file' }] });
    expect(initials('Visual Studio Code')).toBe('VS');
    expect(initials('Paint')).toBe('PA');
    expect(initials('---')).toBe('?');
  });
});
