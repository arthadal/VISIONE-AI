// Riflessione su `memory.md` (VISIONE_DATA_MODEL §2, DECISIONI P-44): fatti fissati intatti, riassunto
// ricorsivo delle sezioni vecchie (il riassunto precedente rientra nel nuovo), ultime K sezioni
// intatte. Funzioni pure: lettura, backup, verifica e sostituzione atomica stanno in index.ts.
import { clip, normalizeText, parseMemory, REFLECTION_TITLE, type MemorySection } from './markdown.ts';

/** Riassunto delle sezioni vecchie entro `maxChars`. Sostituibile (es. da un agente) in futuro. */
export type Summarizer = (sections: readonly MemorySection[], maxChars: number) => string;

/** Riassunto estrattivo deterministico: una riga per sezione, le righe dei riassunti precedenti conservate. */
export const extractiveSummary: Summarizer = (sections, maxChars) => {
  const bullets: string[] = [];
  for (const s of sections) {
    if (s.reflection) {
      bullets.push(...s.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('- ')));
      continue;
    }
    const body = normalizeText(s.body);
    const first = /^(.{1,160}?[.!?])(\s|$)/.exec(body)?.[1] ?? clip(body, 160);
    const head = s.title || clip(body, 60);
    bullets.push(`- ${clip(head, 80)}${first && first !== head ? `: ${first}` : ''}`);
  }
  // Entro il tetto restano le righe più recenti (in fondo al file).
  const kept: string[] = [];
  let size = 0;
  for (let i = bullets.length - 1; i >= 0; i--) {
    const line = bullets[i] as string;
    if (size + line.length + 1 > maxChars) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  return kept.join('\n');
};

export type ReflectionPlan =
  | { ok: true; content: string; pinned: number; summarized: number; kept: number; summaryIndex: number }
  | { ok: false; reason: string };

export function planReflection(text: string, opts: { keepRecent: number; summaryMaxChars: number; date: string; summarize?: Summarizer }): ReflectionPlan {
  const parsed = parseMemory(text);
  const pinned = parsed.sections.filter((s) => s.pinned);
  const others = parsed.sections.filter((s) => !s.pinned);
  if (others.length <= opts.keepRecent) return { ok: false, reason: `niente da riassumere (${others.length} sezioni non fissate, ne restano ${opts.keepRecent})` };
  const old = others.slice(0, others.length - opts.keepRecent);
  const recent = others.slice(others.length - opts.keepRecent);
  const summary = (opts.summarize ?? extractiveSummary)(old, opts.summaryMaxChars).trim();
  const summarySection = `## [riassunto] ${REFLECTION_TITLE} ${opts.date}${summary ? `\n\n${summary}` : ''}`;
  // I paragrafi senza intestazione precedono la prima sezione: sono sempre i più vecchi, quindi
  // finiscono nel riassunto e nessun paragrafo segue un'intestazione (ne diventerebbe il corpo).
  const blocks = [...(parsed.header ? [parsed.header] : []), ...pinned.map((s) => s.raw), summarySection, ...recent.map((s) => s.raw)];
  return { ok: true, content: `${blocks.join('\n\n')}\n`, pinned: pinned.length, summarized: old.length, kept: recent.length, summaryIndex: pinned.length };
}

const sameSection = (a: MemorySection, b: MemorySection): boolean =>
  a.pinned === b.pinned && a.kind === b.kind && a.taskId === b.taskId && normalizeText(a.title) === normalizeText(b.title) && normalizeText(a.body) === normalizeText(b.body);

/** Nessun fatto fissato perso e file più piccolo; altrimenti la riflessione non si applica. */
export function verifyReflection(before: string, after: string): { ok: true } | { ok: false; reason: string } {
  const kept = parseMemory(after).sections;
  for (const p of parseMemory(before).sections.filter((s) => s.pinned)) {
    if (!kept.some((s) => sameSection(s, p))) return { ok: false, reason: `fatto fissato perso: "${clip(p.title || p.body, 80)}"` };
  }
  if (after.length >= before.length) return { ok: false, reason: `la riflessione non riduce il file (${before.length} → ${after.length} caratteri)` };
  return { ok: true };
}
