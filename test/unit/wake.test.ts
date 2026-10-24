// Wake word (P-81): matcher puro e schema di configurazione. Nessun modello, nessun audio.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, visioneConfigSchema } from '../../src/shared/node/config.ts';
import { editDistance, matchWakePhrase, normalizeWakeWord } from '../../src/voice/wake.ts';

describe('matchWakePhrase', () => {
  it('normalizza le parole (maiuscole, accenti, punteggiatura)', () => {
    expect(normalizeWakeWord('VISIONÈ,')).toBe('visione');
    expect(normalizeWakeWord("L'HA")).toBe("l'ha");
    expect(normalizeWakeWord("E'")).toBe('e');
    expect(normalizeWakeWord('...')).toBe('');
    expect(editDistance('visione', 'visone')).toBe(1);
    expect(editDistance('visione', 'visione')).toBe(0);
  });

  it('scrittura di Parakeet (24/10/2026, ora STT anche della parola d\'avvio): punteggiatura e «Ehi»', () => {
    for (const text of ['Hey, Visione.', 'Ehi, Visione!', 'Hei Visione?', 'Hey Visione.']) {
      expect(matchWakePhrase(text, 'hey visione'), text).toMatchObject({ phrase: 'hey visione', command: null });
    }
    expect(matchWakePhrase('Ehi Visione, che ore sono?', 'hey visione')).toMatchObject({ command: 'che ore sono' });
  });

  it('frase esatta con comando nella stessa utterance', () => {
    expect(matchWakePhrase('Hey Visione, apri i documenti', 'hey visione')).toEqual({
      phrase: 'hey visione',
      command: 'apri i documenti'
    });
    expect(matchWakePhrase('Hey Visione apri i documenti.', 'hey visione')).toMatchObject({ command: 'apri i documenti' });
  });

  it('tollera le varianti del saluto e gli errori di una lettera', () => {
    for (const text of ['Ehi visione', 'ei visione', 'ok visione', 'Hey visone', 'Hey visioni']) {
      expect(matchWakePhrase(text, 'hey visione'), text).toMatchObject({ command: null });
    }
    expect(matchWakePhrase('Ehi visione! apri i documenti.', 'hey visione')).toMatchObject({ command: 'apri i documenti' });
    // whisper-small scrive «È» come «E'» (18/10/2026): senza questa la trascrizione buona veniva scartata
    // e restava quella del modello rapido, «che sono» invece di «che ore sono».
    expect(matchWakePhrase("E' i visioni che ore sono.", 'hey visione')).toMatchObject({ command: 'che ore sono' });
    expect(matchWakePhrase("E' visione, che ore sono?", 'hey visione')).toMatchObject({ command: 'che ore sono' });
  });

  it('sola frase: nessun comando', () => {
    expect(matchWakePhrase('Hey Visione', 'hey visione')).toEqual({ phrase: 'hey visione', command: null });
    expect(matchWakePhrase('  Hey Visione  ', 'hey visione')).toMatchObject({ command: null });
  });

  it('casi negativi: niente wake inventate', () => {
    expect(matchWakePhrase('accendi le luci', 'hey visione')).toBeNull();
    expect(matchWakePhrase('ciao visione', 'hey visione')).toBeNull();
    expect(matchWakePhrase('hey computer', 'hey visione')).toBeNull();
    expect(matchWakePhrase('la visione è bella', 'hey visione')).toBeNull();
    expect(matchWakePhrase('allora hey visione', 'hey visione')).toBeNull();
    expect(matchWakePhrase('visione', 'hey visione')).toBeNull();
    expect(matchWakePhrase('', 'hey visione')).toBeNull();
    expect(matchWakePhrase('Hey Visione', '')).toBeNull();
  });

  it('saluto attaccato alla parola (errore reale di Whisper: «avisione»)', () => {
    expect(matchWakePhrase('avisione', 'hey visione')).toEqual({ phrase: 'hey visione', command: null });
    expect(matchWakePhrase('Avisione, apri i documenti', 'hey visione')).toMatchObject({ command: 'apri i documenti' });
    expect(matchWakePhrase('eivisione', 'hey visione')).toMatchObject({ command: null });
    // Confusioni reali b/v dello STT sulla parola attaccata.
    expect(matchWakePhrase('Abisione', 'hey visione')).toMatchObject({ command: null });
    expect(matchWakePhrase('Abysione', 'hey visione')).toMatchObject({ command: null });
    // Un attacco che non contiene la parola della frase resta negativo.
    expect(matchWakePhrase('aveva visione', 'hey visione')).toBeNull();
    expect(matchWakePhrase('avvisone', 'hey visione')).toBeNull();
    expect(matchWakePhrase('amissione', 'hey visione')).toBeNull();
  });

  it('saluto e parola spezzati (misurati con Whisper-base l\'11/10/2026: «e i visioni», «i visi o ne»)', () => {
    for (const text of ['e i visioni', 'E i visioni.', 'e i visi o ne', 'i visi o ne', 'e i visi or', 'E, i, Visione!']) {
      expect(matchWakePhrase(text, 'hey visione'), text).toEqual({ phrase: 'hey visione', command: null });
    }
    expect(matchWakePhrase('e i visioni che ore sono', 'hey visione')).toMatchObject({ command: 'che ore sono' });
    expect(matchWakePhrase('e i visi o ne accendi la musica', 'hey visione')).toMatchObject({ command: 'accendi la musica' });
    // Spezzato sì, ma non qualunque cosa: i visi delle persone, un video, una divisione restano negativi.
    for (const text of ['e i visi delle persone', 'e i video', 'e divisione', 'e i vini', 'e poi visione', 'e e e e e']) {
      expect(matchWakePhrase(text, 'hey visione'), text).toBeNull();
    }
  });

  it('funziona anche con una frase configurata diversa', () => {
    expect(matchWakePhrase('Ok Visione, spegni tutto', 'ok visione')).toMatchObject({ command: 'spegni tutto' });
    // Anche un altro saluto della stessa famiglia attiva la frase configurata…
    expect(matchWakePhrase('Hey Visione', 'ok visione')).toMatchObject({ command: null });
    // …ma una frase diversa no.
    expect(matchWakePhrase('Buongiorno visione', 'ok visione')).toBeNull();
    expect(matchWakePhrase('Ehi computer', 'ok visione')).toBeNull();
  });
});

describe('config voice.wake (P-81)', () => {
  it('default: spenta, «hey visione», soglia 0.5, timeout 6 s', () => {
    expect(DEFAULT_CONFIG.voice.wake).toEqual({ enabled: false, phrase: 'hey visione', sensitivity: 0.5, commandTimeoutMs: 6_000 });
  });

  it('accetta una wake configurata e rifiuta valori fuori scala', () => {
    const ok = visioneConfigSchema.safeParse({ version: 1, voice: { wake: { enabled: true, phrase: 'ok visione', sensitivity: 0.35, commandTimeoutMs: 4_000 } } });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.voice.wake).toEqual({ enabled: true, phrase: 'ok visione', sensitivity: 0.35, commandTimeoutMs: 4_000 });
    expect(visioneConfigSchema.safeParse({ version: 1, voice: { wake: { sensitivity: 2 } } }).success).toBe(false);
    expect(visioneConfigSchema.safeParse({ version: 1, voice: { wake: { commandTimeoutMs: 0 } } }).success).toBe(false);
    expect(visioneConfigSchema.safeParse({ version: 1, voice: { wake: { phrase: '' } } }).success).toBe(false);
  });
});
