// Privacy e licenza dentro l'app (11/10/2026, prima dell'uscita): una sola fonte, i file di `src/renderer/legal/`
// che mostra anche l'installer. Ogni file ha l'italiano e poi, dopo `=== ENGLISH ===`, l'inglese.
/// <reference path="../assets.d.ts" />
import type { Language } from '../../shared/contracts/index.ts';
import licenseText from '../legal/LICENZA_BETA_TESTER.txt?raw';
import privacyText from '../legal/PRIVACY.txt?raw';

export const ENGLISH_MARK = '=== ENGLISH ===';

/** La parte nella lingua chiesta (senza BOM e spazi ai bordi); senza inglese, l'italiano. */
export function legalSection(text: string, lang: Language): string {
  const clean = text.replace(/^\uFEFF/, '');
  const at = clean.indexOf(ENGLISH_MARK);
  if (at < 0) return clean.trim();
  return (lang === 'en' ? clean.slice(at + ENGLISH_MARK.length) : clean.slice(0, at)).trim();
}

export const LEGAL_TEXTS = { privacy: privacyText, license: licenseText } as const;
export type LegalDoc = keyof typeof LEGAL_TEXTS;
