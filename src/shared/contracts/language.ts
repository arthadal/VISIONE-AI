// Lingue di VISIONE (requisito del proprietario del 10/10/2026: distribuzione mondiale, almeno
// italiano e inglese). La lingua scelta vive in `ui.language`; assente = quella di Windows.
import { z } from 'zod';

export const LANGUAGES = ['it', 'en'] as const;
export const languageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof languageSchema>;

/** Lingua da un tag del sistema (BCP 47): «it-IT» → it; ogni altra lingua → inglese. */
export function languageFromLocale(locale: string | null | undefined): Language {
  return /^it(?:[-_]|$)/i.test(locale ?? '') ? 'it' : 'en';
}

/** Persona predefinita di un agente nuovo (P-108): risponde nella lingua di VISIONE. */
export function defaultPersona(lang: Language): { instructions: string; language: Language } {
  return lang === 'en' ? { instructions: 'Reply in English.', language: 'en' } : { instructions: 'Rispondi in italiano.', language: 'it' };
}

/** Nomi e ruoli degli agenti predefiniti in inglese (gli id restano quelli). */
export const DEFAULT_AGENT_NAMES_EN: Readonly<Record<string, { name: string; role: string }>> = {
  esecutore: { name: 'Executor', role: 'Code executor' },
  revisore: { name: 'Reviewer', role: 'Results review' },
  ricercatore: { name: 'Researcher', role: 'Research and gathering' }
};
