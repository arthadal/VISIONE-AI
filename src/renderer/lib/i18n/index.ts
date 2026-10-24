// Lingue dell'interfaccia (distribuzione mondiale, 10/10/2026): dizionari it/en, segnaposto {nome},
// contesto React con la lingua in uso. L'italiano è la lingua di partenza; l'inglese deve avere tutte
// le chiavi (lo controlla il compilatore). Nessuna libreria: poche righe, nessun caricamento a parte.
import { createContext, useCallback, useContext } from 'react';
import type { Language } from '../../../shared/contracts/index.ts';
import { en } from './en.ts';
import { it } from './it.ts';

export type MessageKey = keyof typeof it;
export type Vars = Readonly<Record<string, string | number>>;

const DICTIONARIES: Readonly<Record<Language, Readonly<Record<MessageKey, string>>>> = { it, en };

/** Lingue offerte, con il nome nella loro lingua (il menu non si traduce). */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { it: 'Italiano', en: 'English' };

/**
 * Specchio di `languageFromLocale` dei contratti (il renderer importa solo tipi da lì): «it-IT» → it,
 * ogni altra lingua → inglese. Un test tiene allineate le due.
 */
export function languageFromLocale(locale: string | null | undefined): Language {
  return /^it(?:[-_]|$)/i.test(locale ?? '') ? 'it' : 'en';
}

/** Lingua effettiva: quella scelta (`ui.language`) o, se manca, quella del sistema. */
export function effectiveLanguage(configured: unknown, systemLocale: string | null | undefined): Language {
  return configured === 'it' || configured === 'en' ? configured : languageFromLocale(systemLocale);
}

/** Testo della chiave nella lingua, con i segnaposto sostituiti (un segnaposto senza valore resta com'è). */
export function translate(lang: Language, key: MessageKey, vars?: Vars): string {
  const text = DICTIONARIES[lang][key] ?? it[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
}

export type Translate = (key: MessageKey, vars?: Vars) => string;

export const LanguageContext = createContext<Language>('it');

export function useLanguage(): Language {
  return useContext(LanguageContext);
}

/** `t('chiave', { nome })` nella lingua in uso. */
export function useT(): Translate {
  const lang = useContext(LanguageContext);
  return useCallback((key: MessageKey, vars?: Vars) => translate(lang, key, vars), [lang]);
}
