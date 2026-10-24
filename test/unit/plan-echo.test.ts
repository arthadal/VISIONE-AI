// Un passo di lavoro che risponde con un piano invece del risultato (collaudo in VM del 24/10/2026).
import { describe, expect, it } from 'vitest';
import { looksLikePlan } from '../../src/core/tasks/plan-echo.ts';

describe('looksLikePlan', () => {
  it('riconosce il piano rimandato indietro, anche in un blocco di codice', () => {
    expect(looksLikePlan('{"steps":[{"key":"s1","title":"x","spec":"y","dependsOn":[]}]}')).toBe(true);
    expect(looksLikePlan('```json\n{"steps":[]}\n```')).toBe(true);
  });
  it('un risultato vero non è un piano', () => {
    expect(looksLikePlan('La parola in maiuscolo è GIRASOLE-34.')).toBe(false);
    expect(looksLikePlan('{"risultato":"ok"}')).toBe(false);
    expect(looksLikePlan('{"steps": rotto')).toBe(false);
  });
  it('una spiegazione lunga con un esempio JSON dentro non è scartata', () => {
    const text = `Ho scritto lo script che legge i passi da un file di configurazione come questo: {"steps":[]} e poi li esegue in ordine, controllando ogni risultato.`;
    expect(looksLikePlan(text)).toBe(false);
  });
});
