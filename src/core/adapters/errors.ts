// Errore strutturato di un adapter (avvio non riuscito, CLI assente, conferma richiesta…), comune a
// tutti i motori: chi li usa (Agent Manager) legge solo `error.code` del CLI Runtime.
import type { RuntimeError } from '../../shared/contracts/index.ts';

export class AdapterError extends Error {
  readonly error: RuntimeError;
  constructor(error: RuntimeError) {
    super(error.message);
    this.error = error;
  }
}
