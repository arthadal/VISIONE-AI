// P-99: formattazione del comando reale di una verifica di motore. In un file a parte per non
// creare un ciclo di import tra `adapters/index.ts` (che ri-esporta il catalogo) e gli adapter.
/** Comando di verifica leggibile e reale (eseguibile risolto, shim già decodificato, argomenti). */
export function formatProbeCommand(exe: string, prefixArgs: readonly string[], args: readonly string[]): string {
  return [exe, ...prefixArgs, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
}

/** P-105: il numero di versione dentro il testo della CLI; se non c'è, il testo così com'è. */
export function versionNumber(raw: string | null): string {
  if (!raw) return '(versione non leggibile)';
  return /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(raw)?.[0] ?? raw.slice(0, 40);
}
