// Allegati (12/10/2026): come si scrivono i percorsi trascinati, scelti o incollati.
import { describe, expect, it } from 'vitest';
import { appendPaths, quotePaths, visioneDragPaths } from '../../src/renderer/app/attach-logic.ts';

describe('allegati: percorsi', () => {
  it('tra virgolette solo se servono; vuoti scartati', () => {
    expect(quotePaths(['C:\\dati\\nota.txt'])).toBe('C:\\dati\\nota.txt');
    expect(quotePaths(['C:\\Users\\Me\\Documents\\Le mie foto\\a.png', '', 'D:\\x(1).pdf'])).toBe('"C:\\Users\\Me\\Documents\\Le mie foto\\a.png" "D:\\x(1).pdf"');
    expect(quotePaths(['  ', 'C:\\a"b.txt'])).toBe('C:\\ab.txt');
  });
  it('in fondo al messaggio con gli spazi giusti', () => {
    expect(appendPaths('', ['C:\\a.txt'])).toBe('C:\\a.txt ');
    expect(appendPaths('guarda', ['C:\\a.txt'])).toBe('guarda C:\\a.txt ');
    expect(appendPaths('guarda ', ['C:\\a.txt', 'C:\\b c.txt'])).toBe('guarda C:\\a.txt "C:\\b c.txt" ');
    expect(appendPaths('testo', [])).toBe('testo');
  });
  it("trascinamento dall'Esplora di VISIONE: solo stringhe, al più 50", () => {
    expect(visioneDragPaths(JSON.stringify(['C:\\a', 3, '']))).toEqual(['C:\\a']);
    expect(visioneDragPaths('non json')).toEqual([]);
    expect(visioneDragPaths(JSON.stringify(Array.from({ length: 80 }, (_, i) => `C:\\f${i}`)))).toHaveLength(50);
  });
});
