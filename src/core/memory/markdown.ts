// Formato di `memory.md` (VISIONE_AGENT_ARCHITECTURE §8, DECISIONI P-42). Il file è scritto
// dall'agente: dati non fidati, letti come testo, mai eseguiti. Una sezione è un'intestazione `## `
// con etichette facoltative in testa, il testo prima della prima intestazione è diviso in paragrafi:
//
//   ## [decisione] [fisso] Titolo        tipo + fatto fissato (anche `📌` o `[pin]`)
//   ## [task:01J…] Titolo                memoria del task (accettata solo se il task è dell'agente)
//
// Le righe `MEMORIA: <fatto>` nel risultato di un turno sono fatti del task (P-43).
import { createHash } from 'node:crypto';
import { MEMORY_LIMITS, type MemoryKind } from '../../shared/contracts/index.ts';

export interface MemorySection {
  readonly title: string;
  readonly body: string;
  readonly kind: MemoryKind;
  readonly pinned: boolean;
  /** `[task:<id>]` dichiarato nell'intestazione. */
  readonly taskId: string | null;
  /** Testo originale (intestazione compresa): la riflessione lo riscrive tale e quale. */
  readonly raw: string;
  /** Riassunto prodotto da una riflessione precedente. */
  readonly reflection: boolean;
}

export interface ParsedMemory {
  /** Intestazioni `# ` iniziali (titolo del file), conservate dalla riflessione. */
  readonly header: string;
  readonly sections: MemorySection[];
}

const KIND_TAGS: Readonly<Record<string, MemoryKind>> = {
  fatto: 'fact', fact: 'fact', decisione: 'decision', decision: 'decision', lezione: 'lesson', lesson: 'lesson',
  riassunto: 'summary', summary: 'summary', nota: 'note', note: 'note', preferenza: 'preference', preference: 'preference'
};
const PIN_TAGS = new Set(['fisso', 'fissato', 'pin', 'pinned']);
const TAG = /^\s*(?:(📌)|\[([^\]\n]{1,80})\])\s*/u;
export const REFLECTION_TITLE = 'Riflessione del';

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function contentHash(parts: readonly (string | null)[]): string {
  return createHash('sha256').update(parts.map((p) => normalizeText(p ?? '')).join('\u0001')).digest('hex').slice(0, 32);
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`;
}

function parseHeading(line: string): { title: string; kind: MemoryKind; pinned: boolean; taskId: string | null } {
  let rest = line.replace(/^##\s+/, '');
  let kind: MemoryKind = 'note';
  let pinned = false;
  let taskId: string | null = null;
  for (let m = TAG.exec(rest); m; m = TAG.exec(rest)) {
    const tag = (m[2] ?? '').trim().toLowerCase();
    if (m[1]) pinned = true;
    else if (PIN_TAGS.has(tag)) pinned = true;
    else if (KIND_TAGS[tag]) kind = KIND_TAGS[tag];
    else if (/^task:[A-Za-z0-9_-]{1,64}$/.test(tag)) taskId = (m[2] ?? '').trim().slice(5);
    else break; // etichetta sconosciuta: fa parte del titolo
    rest = rest.slice(m[0].length);
  }
  return { title: rest.trim(), kind, pinned, taskId };
}

export function parseMemory(text: string): ParsedMemory {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header: string[] = [];
  const sections: MemorySection[] = [];
  let i = 0;
  // Titolo del file: righe `# ` (e vuote) in testa.
  while (i < lines.length && (/^#\s/.test(lines[i] as string) || (lines[i] as string).trim() === '')) {
    if ((lines[i] as string).trim() !== '') header.push(lines[i] as string);
    i++;
  }
  let fence = false;
  let current: { heading: string; body: string[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    const raw = paragraph.join('\n').trim();
    paragraph = [];
    if (raw) sections.push({ title: '', body: raw, kind: 'note', pinned: false, taskId: null, raw, reflection: false });
  };
  const flushSection = (): void => {
    if (!current) return;
    const h = parseHeading(current.heading);
    const body = current.body.join('\n').trim();
    const raw = [current.heading, ...(body ? ['', body] : [])].join('\n');
    if (h.title || body) {
      sections.push({ ...h, body, raw, reflection: h.kind === 'summary' && h.title.startsWith(REFLECTION_TITLE) });
    }
    current = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^##\s/.test(line)) {
      flushParagraph();
      flushSection();
      current = { heading: line.trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else if (line.trim() === '' && !fence) flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph();
  flushSection();
  return { header: header.join('\n'), sections };
}

/**
 * Il risultato senza le righe `MEMORIA` (16/10/2026): sono appunti per gli altri agenti, non parte della
 * risposta al proprietario. Lette ad alta voce ripetevano quanto appena detto.
 */
export function withoutFacts(text: string): string {
  return text.replace(/^[ \t]*(?:[-*][ \t]+)?MEMORIA[ \t]*(\[[^\]\n]{1,20}\])?[ \t]*:.*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Righe `MEMORIA: <fatto>` / `MEMORIA [fisso]: <fatto>` del risultato di un turno. */
export function extractFacts(text: string): Array<{ content: string; pinned: boolean }> {
  const out: Array<{ content: string; pinned: boolean }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/^[ \t]*(?:[-*][ \t]+)?MEMORIA[ \t]*(\[[^\]\n]{1,20}\])?[ \t]*:[ \t]*(.+?)[ \t]*$/gim)) {
    const content = (m[2] ?? '').trim();
    // Il segnaposto delle istruzioni ripetuto tale e quale non è un fatto.
    if (!content || /^<[^>]*>$/.test(content)) continue;
    const key = normalizeText(content).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ content: content.slice(0, MEMORY_LIMITS.factChars), pinned: PIN_TAGS.has((m[1] ?? '').slice(1, -1).trim().toLowerCase()) });
    if (out.length >= MEMORY_LIMITS.factsPerTurn) break;
  }
  return out;
}

const STOPWORDS = new Set([
  'che', 'per', 'con', 'una', 'uno', 'gli', 'dei', 'del', 'della', 'delle', 'degli', 'nel', 'nella', 'nei', 'sul', 'sulla', 'non',
  'sono', 'come', 'anche', 'più', 'tra', 'fra', 'dal', 'dalla', 'alla', 'alle', 'agli', 'allo', 'questo', 'questa', 'quello',
  'essere', 'fare', 'poi', 'cosa', 'dove', 'quando', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'you',
  'rispondi', 'compito', 'risultato', 'finale', 'solo', 'tutto', 'tutti', 'ogni'
]);

/** Query FTS5 sicura dal testo libero: parole (≥ 3 caratteri) tra virgolette in OR; null se vuota. */
export function ftsQuery(text: string, max = 16): string | null {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const w = m[0];
    if (STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    words.push(`"${w}"`);
    if (words.length >= max) break;
  }
  return words.length > 0 ? words.join(' OR ') : null;
}
