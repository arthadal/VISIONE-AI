// Addestramento (P-107k): conti e filtri della finestra, funzioni pure. La stima dei token è la stessa
// del core (`src/core/training/index.ts`, un test le confronta): il renderer non importa codice del core.
import type { Skill, SkillCategory } from '../../../shared/contracts/index.ts';
import { addressToUrl } from './browser-logic.ts';

export const estimateTokens = (text: string): number => Math.ceil((text.length + 2) / 3.5);

export type TrainingFilter = 'all' | 'suggested' | 'active' | SkillCategory;
export const TRAINING_FILTERS: readonly TrainingFilter[] = ['all', 'suggested', 'active', 'tokens', 'code', 'research', 'writing', 'safety', 'method', 'custom'];

/** Consigliata: spenta e utile in almeno 2 obiettivi recenti, e in almeno uno su dieci. */
export function isSuggested(s: Skill, recent: number): boolean {
  return !s.active && s.suggested >= Math.max(2, Math.ceil(recent * 0.1));
}

export function filterSkills(skills: readonly Skill[], filter: TrainingFilter, recent = 0): Skill[] {
  if (filter === 'all') return [...skills];
  if (filter === 'active') return skills.filter((s) => s.active);
  // Le più utili prima.
  if (filter === 'suggested') return skills.filter((s) => isSuggested(s, recent)).sort((a, b) => b.suggested - a.suggested);
  return skills.filter((s) => s.category === filter);
}

export interface TrainingSummary {
  readonly active: number;
  /** Regole attive «sempre»: costano in ogni richiesta. */
  readonly always: number;
  readonly alwaysTokens: number;
  /** Regole attive solo quando servono: il loro costo massimo in una richiesta. */
  readonly onDemand: number;
  readonly onDemandTokens: number;
}

export function summarize(skills: readonly Skill[]): TrainingSummary {
  const on = skills.filter((s) => s.active);
  const always = on.filter((s) => s.always);
  const rest = on.filter((s) => !s.always);
  const sum = (list: readonly Skill[]): number => list.reduce((n, s) => n + s.tokens, 0);
  return { active: on.length, always: always.length, alwaysTokens: sum(always), onDemand: rest.length, onDemandTokens: sum(rest) };
}

/** «preventivo, offerta; IVA» → ['preventivo', 'offerta', 'IVA']: senza doppioni, al massimo 20. */
export function parseKeywordInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\n]+/)) {
    const k = part.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (k.length < 2 || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out.slice(0, 20);
}

/** Ricerca facoltativa di altre idee, nel Browser di VISIONE. */
export function onlineSearchUrl(lang: 'it' | 'en'): string {
  return addressToUrl(lang === 'en'
    ? 'best prompt tips for AI agents save tokens'
    : 'migliori consigli prompt agenti AI risparmiare token') ?? '';
}

/** Le cartelle degli agenti iniziano tutte uguali: conta la parte finale («…\workspace\director»). */
export function shortRoot(root: string): string {
  const parts = root.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length <= 3 ? root : `…\\${parts.slice(-2).join('\\')}`;
}
