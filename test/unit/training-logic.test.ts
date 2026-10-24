// Addestramento (P-107k): conti della finestra; la stima dei token è identica a quella del core.
import { describe, expect, it } from 'vitest';
import { estimateTokens as coreEstimate } from '../../src/core/training/index.ts';
import { estimateTokens, filterSkills, onlineSearchUrl, parseKeywordInput, shortRoot, summarize } from '../../src/renderer/windows/panes/training-logic.ts';
import type { Skill } from '../../src/shared/contracts/index.ts';

const skill = (id: string, over: Partial<Skill> = {}): Skill => ({
  id, origin: 'catalog', category: 'code', title: id, explain: '', topics: 'errori', rule: 'x'.repeat(68), keywords: ['bug'], always: false,
  active: false, tokens: 20, uses: 0, lastUsedAt: null, suggested: 0, ...over
});

describe('finestra Addestramento', () => {
  it('stima dei token uguale al core', () => {
    for (const text of ['', 'breve', 'Rispondi con il risultato: niente premesse.', 'x'.repeat(600)]) expect(estimateTokens(text)).toBe(coreEstimate(text));
  });

  it('riepilogo: costo fisso delle «sempre» e massimo di quelle a richiesta', () => {
    const list = [skill('a', { active: true, always: true, tokens: 30 }), skill('b', { active: true, tokens: 40 }), skill('c', { active: true, tokens: 50 }), skill('d', { tokens: 99 })];
    expect(summarize(list)).toEqual({ active: 3, always: 1, alwaysTokens: 30, onDemand: 2, onDemandTokens: 90 });
    expect(filterSkills(list, 'active').map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(filterSkills([...list, skill('u', { category: 'custom', origin: 'custom' })], 'custom').map((s) => s.id)).toEqual(['u']);
  });

  it('parole chiave da virgole e punti e virgola, senza doppioni', () => {
    expect(parseKeywordInput(' preventiv, offerta; Offerta\nfattura , x ')).toEqual(['preventiv', 'offerta', 'fattura']);
  });

  it('la ricerca online è facoltativa e passa dal Browser di VISIONE', () => {
    expect(onlineSearchUrl('it')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
    expect(decodeURIComponent(onlineSearchUrl('en'))).toContain('prompt tips');
  });
});

describe('mappa del codice nella finestra', () => {
  it('delle cartelle lunghe si mostra la parte finale', () => {
    expect(shortRoot('C:\\Users\\x\\AppData\\VISIONE\\workspace\\director')).toBe('…\\workspace\\director');
    expect(shortRoot('D:\\progetti\\negozio')).toBe('D:\\progetti\\negozio');
  });
});

describe('regole consigliate', () => {
  it('spenta e utile in almeno 2 obiettivi recenti e in uno su dieci; le più utili prima', () => {
    const list = [skill('a', { suggested: 2 }), skill('b', { suggested: 6 }), skill('c', { suggested: 9, active: true }), skill('d', { suggested: 1 })];
    expect(filterSkills(list, 'suggested', 10).map((s) => s.id)).toEqual(['b', 'a']);
    // Su 50 obiettivi ne servono almeno 5.
    expect(filterSkills(list, 'suggested', 50).map((s) => s.id)).toEqual(['b']);
  });
});
