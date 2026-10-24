// Eseguito prima di ogni file di test (`setupFiles`): a fine file le home di `tempHome` rimaste si cancellano,
// anche se un test è fallito o non ha chiamato `cleanup()`. Registrato per primo, questo afterAll gira per
// ultimo (hook a pila, il predefinito di vitest): dopo quelli del file che chiudono database e processi.
import { afterAll } from 'vitest';
import { cleanupTempHomes } from './helpers.ts';

afterAll(() => {
  const left = cleanupTempHomes();
  if (left.length > 0) throw new Error(`cartelle temporanee non cancellabili a fine file (file ancora aperti?): ${left.join(', ')}`);
});
