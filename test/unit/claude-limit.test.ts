// Riconoscimento del limite di quota di Claude Code (P-83): fixture = stringhe reali del TUI della
// CLI installata 2.1.289 (vedi src/core/adapters/claude-code/limit.ts), più i casi negativi che NON
// devono attivare il ripiego (citazioni dell'utente, limite di contesto, testo non ancorato).
import { describe, expect, it } from 'vitest';
import { detectLimit } from '../../src/core/adapters/claude-code/limit.ts';

describe('claude-code · riconoscimento del limite (P-83)', () => {
  it('banner «Usage limit reached · limit resets»: scope sessione e reset dichiarato', () => {
    const hit = detectLimit('Usage limit reached · limit resets 3:00 PM');
    expect(hit).toMatchObject({ scope: 'session', resetAt: '3:00pm' });
    expect(hit?.message).toContain('Usage limit reached');
  });

  it('auto-continue con reset: «continuing automatically at …»', () => {
    expect(detectLimit('Usage limit reached · continuing automatically at 4:00 PM · esc to cancel')).toMatchObject({
      scope: 'session',
      resetAt: '4:00pm'
    });
  });

  it('riarmo: «Usage limit reached again · continuing automatically shortly · esc to cancel»', () => {
    expect(detectLimit('Usage limit reached again · continuing automatically shortly · esc to cancel')).toMatchObject({
      scope: 'session',
      resetAt: 'shortly'
    });
  });

  it('limite mensile: «You\'ve hit your monthly spend limit.»', () => {
    expect(detectLimit("You've hit your monthly spend limit.")).toMatchObject({ scope: 'monthly', resetAt: null });
  });

  it('fast limit: «You\'ve hit your fast limit · resets in 8m»', () => {
    expect(detectLimit("You've hit your fast limit · resets in 8m")).toMatchObject({ scope: 'fast', resetAt: '8m' });
  });

  it('limite settimanale: «Lower-priority mode ended · you have reached your weekly usage limit»', () => {
    expect(detectLimit('Lower-priority mode ended · you have reached your weekly usage limit')).toMatchObject({ scope: 'weekly' });
  });

  it('limite settimanale reale 2.1.290: «You\'ve hit your weekly limit · resets Oct 7 , 6pm (Europe/Rome)»', () => {
    const hit = detectLimit("You've hit your weekly limit · resets Oct 7 , 6pm (Europe/Rome)");
    expect(hit).toMatchObject({ scope: 'weekly', resetAt: 'oct7,6pm' });
    expect(hit?.message).toContain('weekly limit');
  });

  it('blocco del TUI con ridisegno (banner e prompt nella stessa riga del runtime): riconosciuto', () => {
    // Forma reale 2.1.290: il ridisegno posiziona il cursore invece di usare a-capo, quindi banner e
    // casella `❯` finiscono nello stesso blocco consegnato dal runtime.
    const chunk = "\u001b[26;1H✻\u001b[38;2;255;107;128mYou've hit your weekly limit · resets Oct 7 , 6pm (Europe/Rome)\u001b[0m\u001b[29;1H❯ ";
    expect(detectLimit(chunk)).toMatchObject({ scope: 'weekly', resetAt: 'oct7,6pm' });
  });

  it('variante «You\'ve hit your weekly usage limit» riconosciuta', () => {
    expect(detectLimit("You've hit your weekly usage limit · resets in 2d")).toMatchObject({ scope: 'weekly' });
  });

  it('sequenze ANSI: il banner resta riconoscibile', () => {
    expect(detectLimit('\u001b[31mUsage limit reached\u001b[0m · limit resets 3:00 PM')).toMatchObject({ scope: 'session' });
  });

  it('la casella di input (❯) non è un limite: citazione dell\'utente ignorata', () => {
    expect(detectLimit('❯ spiega usage limit reached')).toBeNull();
  });

  it('testo non ancorato all\'inizio: nessun falso positivo da citazione', () => {
    expect(detectLimit('errore: usage limit reached segnalato dal provider')).toBeNull();
    expect(detectLimit('come risolvo il rate limit di Claude?')).toBeNull();
  });

  it('«Context limit reached» non è una quota: nessun ripiego', () => {
    expect(detectLimit('Context limit reached · /compact or /clear to continue')).toBeNull();
  });
});
