// Allegati (12/10/2026, richiesta del proprietario): ciò che arriva a un agente è il PERCORSO del file,
// della cartella o dello screenshot salvato; gli agenti leggono dal disco con i loro strumenti. Qui la
// parte pura: come si scrivono i percorsi in un terminale o in un messaggio. Testata.

/** Tipo del trascinamento interno di VISIONE (Esplora): l'elenco dei percorsi in JSON. */
export const VISIONE_DRAG_TYPE = 'application/x-visione-paths';

/** Percorsi pronti da scrivere: tra virgolette se contengono spazi o caratteri speciali della shell. */
export function quotePaths(paths: readonly string[]): string {
  return paths
    .map((p) => p.trim().replace(/"/g, ''))
    .filter((p) => p.length > 0)
    .map((p) => (/[\s&()^;,'`%!]/.test(p) ? `"${p}"` : p))
    .join(' ');
}

/** Aggiunge i percorsi in fondo al testo di un messaggio, con gli spazi giusti. */
export function appendPaths(text: string, paths: readonly string[]): string {
  const q = quotePaths(paths);
  if (q === '') return text;
  return text === '' || /\s$/.test(text) ? `${text}${q} ` : `${text} ${q} `;
}

/** Percorsi del trascinamento interno di VISIONE, o [] se il dato non è valido. */
export function visioneDragPaths(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 50) : [];
  } catch {
    return [];
  }
}
