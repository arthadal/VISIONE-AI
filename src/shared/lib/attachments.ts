// Allegati della chat (24/10/2026, richiesta del proprietario: «allegati come su WhatsApp»). Nel testo di un messaggio
// ogni allegato è una riga «📎 <percorso assoluto>»: la chat li mostra come etichette da aprire, il core ne dà una copia
// agli agenti. Parte pura, usata da renderer e core.

export const ATTACH_MARK = '📎';
export const ATTACH_LIMITS = { files: 10, bytes: 50 * 1024 * 1024 } as const;

export interface AttachedFile {
  readonly path: string;
  readonly name: string;
}

const LINE = /^\s*📎\s+(.+?)\s*$/u;
const isAbsolutePath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');

/** Il nome del file, senza cartelle. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Il testo con una riga «📎 percorso» per allegato (al più `ATTACH_LIMITS.files`, senza doppioni). */
export function withAttachments(text: string, paths: readonly string[]): string {
  const clean = [...new Set(paths.map((p) => p.trim()).filter((p) => isAbsolutePath(p) && !/[\r\n]/.test(p)))].slice(0, ATTACH_LIMITS.files);
  return [text.trim(), ...clean.map((p) => `${ATTACH_MARK} ${p}`)].filter((l) => l.length > 0).join('\n');
}

/** Il testo senza le righe degli allegati, e gli allegati. */
export function splitAttachments(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = [];
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    const path = m?.[1];
    if (path && isAbsolutePath(path)) {
      if (files.length < ATTACH_LIMITS.files && !files.some((f) => f.path === path)) files.push({ path, name: fileName(path) });
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join('\n').trim(), files };
}

/** Il testo per chi lo legge in una riga sola: gli allegati diventano «[allegati: a.pdf, b.png]». */
export function describeAttachments(text: string, language: 'it' | 'en'): string {
  const { text: body, files } = splitAttachments(text);
  if (files.length === 0) return body;
  const list = `[${language === 'en' ? 'attachments' : 'allegati'}: ${files.map((f) => f.name).join(', ')}]`;
  return body.length > 0 ? `${body} ${list}` : list;
}
