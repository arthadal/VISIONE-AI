// Prova di precisione dell'ascolto (24/10/2026): parole giuste sulla voce del proprietario, numeri in cifre o in lettere
// uguali, accenti e punteggiatura non contano; la frase della prova non va al Director.
import { describe, expect, it } from 'vitest';
import { accuracyPercent, comparableWords, numberWords, wordErrors } from '../../src/renderer/app/accuracy-logic.ts';

describe('precisione delle parole', () => {
  it('numeri in lettere come li dice lo STT', () => {
    expect([0, 7, 10, 21, 28, 33, 99].map((n) => numberWords(n, 'it'))).toEqual(['zero', 'sette', 'dieci', 'ventuno', 'ventotto', 'trentatre', 'novantanove']);
    expect([10, 21, 40].map((n) => numberWords(n, 'en'))).toEqual(['ten', 'twenty one', 'forty']);
  });

  it('maiuscole, accenti, punteggiatura e cifre non contano', () => {
    expect(comparableWords('Ricordami di chiamare il dentista domani alle 10.', 'it')).toEqual(comparableWords('ricordami di chiamare il dentista domani alle dieci', 'it'));
    expect(comparableWords('Spegni il computer tra mezz\'ora', 'it')).toEqual(['spegni', 'il', 'computer', 'tra', 'mezz', 'ora']);
    expect(comparableWords('Che tempo farà sabato?', 'it')).toEqual(['che', 'tempo', 'fara', 'sabato']);
  });

  it('parole sostituite, mancanti o in più; percentuale su tutte le frasi', () => {
    expect(wordErrors('annulla il promemoria delle cinque', 'Annulla il Pro Memoria delle 5.', 'it')).toEqual({ errors: 2, words: 5 });
    expect(wordErrors('chiudi tutte le finestre', 'chiudi tutte le finestre', 'it')).toEqual({ errors: 0, words: 4 });
    expect(wordErrors('leggi le notizie', '', 'it')).toEqual({ errors: 3, words: 3 });
    expect(accuracyPercent([{ errors: 2, words: 5 }, { errors: 0, words: 45 }])).toBe(96);
    expect(accuracyPercent([{ errors: 1, words: 60 }])).toBe(98.3);
    expect(accuracyPercent([])).toBe(0);
  });
});
