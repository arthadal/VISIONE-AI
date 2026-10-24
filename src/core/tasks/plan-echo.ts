// Collaudo in VM del 24/10/2026 (squadra solo Ollama, qwen2.5 7B): il Director, eseguendo il proprio passo, ha
// risposto con un altro piano JSON e VISIONE l'ha portato al proprietario come risposta. Un passo di lavoro che
// risponde con un piano non ha fatto il lavoro: il tentativo non vale e il successivo lo dice all'agente.

/** Vero se il testo è (o contiene come unico oggetto) un piano `{"steps":[…]}` invece di un risultato. */
export function looksLikePlan(text: string): boolean {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  // Testo vero attorno all'oggetto (una spiegazione con un esempio JSON) non è un piano rimandato indietro.
  if (text.slice(0, start).trim().length > 40 || text.slice(end + 1).trim().length > 40) return false;
  try {
    const raw: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof raw === 'object' && raw !== null && Array.isArray((raw as { steps?: unknown }).steps);
  } catch {
    return false;
  }
}

export const PLAN_ECHO_ERROR = 'ha risposto con un piano JSON invece del risultato del passo';
export const PLAN_ECHO_HINT = 'Il tentativo precedente ha risposto con un piano JSON: il piano c\'è già. NON pianificare: esegui tu il passo e rispondi con il risultato, in testo normale.';
