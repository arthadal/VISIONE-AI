// Lingue dell'interfaccia (distribuzione mondiale, 10/10/2026): l'inglese ha tutte le chiavi
// dell'italiano con gli stessi segnaposto, i segnaposto si sostituiscono, la lingua del sistema si
// riconosce come nei contratti, le voci si scelgono nella lingua.
import { describe, expect, it } from 'vitest';
import { languageFromLocale as contractLanguage, languageSchema, LANGUAGES } from '../../src/shared/contracts/index.ts';
import { en } from '../../src/renderer/lib/i18n/en.ts';
import { effectiveLanguage, LANGUAGE_NAMES, languageFromLocale, translate } from '../../src/renderer/lib/i18n/index.ts';
import { it as itDict } from '../../src/renderer/lib/i18n/it.ts';
import { roleText, teamProblems, verifyOutcome, voiceChoices } from '../../src/renderer/app/setup-logic.ts';
import { visioneConfigSchema, DEFAULT_CONFIG } from '../../src/shared/node/config.ts';

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('lingue: dizionari e traduzione', () => {
  it('l\'inglese ha ogni chiave dell\'italiano, non vuota, con gli stessi segnaposto', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(itDict).sort());
    for (const [key, text] of Object.entries(itDict)) {
      const english = en[key as keyof typeof itDict];
      expect(english.trim(), key).not.toBe('');
      expect(placeholders(english), key).toEqual(placeholders(text));
    }
  });

  it('segnaposto sostituiti; quello senza valore resta visibile (mai un testo inventato)', () => {
    expect(translate('it', 'wiz.err.apply', { error: 'rete' })).toBe('squadra non applicata: rete');
    expect(translate('en', 'wiz.err.apply', { error: 'network' })).toBe('team not applied: network');
    expect(translate('en', 'wiz.team.agentN', { n: 3 })).toBe('Agent 3');
    expect(translate('it', 'wiz.err.apply')).toBe('squadra non applicata: {error}');
  });

  it('lingua del sistema: italiano solo per «it», il resto inglese; uguale ai contratti', () => {
    for (const locale of ['it', 'it-IT', 'it_CH', 'IT-it', 'en-US', 'en', 'de-DE', 'fr', 'itx', '', null, undefined]) {
      expect(languageFromLocale(locale), String(locale)).toBe(contractLanguage(locale));
    }
    expect(languageFromLocale('it-IT')).toBe('it');
    expect(languageFromLocale('de-DE')).toBe('en');
    expect(effectiveLanguage('en', 'it-IT')).toBe('en');
    expect(effectiveLanguage(undefined, 'it-IT')).toBe('it');
    expect(effectiveLanguage('fr', 'en-GB')).toBe('en');
    expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual([...LANGUAGES].sort());
  });

  it('configurazione: `ui.language` facoltativa, solo lingue note', () => {
    expect(DEFAULT_CONFIG.ui.language).toBeUndefined();
    expect(visioneConfigSchema.safeParse({ ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, language: 'en' } }).success).toBe(true);
    expect(visioneConfigSchema.safeParse({ ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, language: 'fr' } }).success).toBe(false);
    expect(languageSchema.options).toEqual(['it', 'en']);
  });

  it('procedura guidata in inglese: ruoli, problemi della squadra ed esito della verifica', () => {
    const t = (k: keyof typeof itDict, v?: Record<string, string | number>): string => translate('en', k, v);
    expect(roleText('code', t)).toEqual({ label: 'Coder — writes and runs code', defaultName: 'Coder', role: 'Code executor' });
    expect(teamProblems([], null, t)).toEqual(['add at least one agent', 'choose who is in charge (the Director)']);
    expect(verifyOutcome('success', 'READY', 'a', 'a', undefined, t)).toEqual({ state: 'ok', detail: 'answered: READY' });
    expect(verifyOutcome('success', 'PRONTO')).toEqual({ state: 'ok', detail: 'ha risposto: PRONTO' });
  });

  it('voci: quelle installate della lingua; altrimenti tutte; altrimenti quelle tipiche di Windows', () => {
    const installed = [{ name: 'Microsoft Cosimo', language: 'it-IT', gender: 'Male' }, { name: 'Microsoft George', language: 'en-GB', gender: 'Male' }];
    expect(voiceChoices(installed, 'en').map((v) => v.name)).toEqual(['Microsoft George']);
    expect(voiceChoices(installed, 'it').map((v) => v.name)).toEqual(['Microsoft Cosimo']);
    expect(voiceChoices([installed[0]!], 'en').map((v) => v.name)).toEqual(['Microsoft Cosimo']);
    expect(voiceChoices([], 'en').map((v) => v.name)).toEqual(['Microsoft David', 'Microsoft Zira', 'Microsoft Mark']);
  });
});

describe('ascolto avanzato (P-106): soglia del rumore dalla misura della stanza', () => {
  it('doppio del 90° percentile, tra 0,003 e 0,05; misura vuota o rotta → valore storico', async () => {
    const { noiseGateFrom } = await import('../../src/renderer/app/setup-logic.ts');
    const quiet = Array.from({ length: 30 }, (_, i) => 0.001 + i * 0.0001);
    expect(noiseGateFrom(quiet)).toBeCloseTo(0.0074, 4); // 90° percentile 0,0037 × 2
    expect(noiseGateFrom(Array(30).fill(0.0001))).toBe(0.003);
    expect(noiseGateFrom(Array(30).fill(0.2))).toBe(0.05);
    expect(noiseGateFrom([])).toBe(0.004);
    expect(noiseGateFrom([Number.NaN, -1])).toBe(0.004);
    // Un colpo isolato (tosse, porta) non alza la soglia: conta il 90° percentile, non il massimo.
    expect(noiseGateFrom([...Array(29).fill(0.002), 0.4])).toBe(0.004);
  });
});
