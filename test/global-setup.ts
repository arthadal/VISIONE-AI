// Setup globale di vitest: le home temporanee di una corsa stanno tutte in una cartella sua dentro %TEMP%
// (visione-vitest-XXXXXX), che a fine corsa si cancella anche se un worker è caduto prima dei suoi afterAll.
// Cartella propria = conto esatto anche con altre corse in parallelo. Ciò che resta lì dentro a fine corsa
// è un difetto e si elenca; una cartella visione-* nuova direttamente in %TEMP% vuol dire che qualcosa
// crea cartelle temporanee senza `tempHome` (o che un'altra corsa senza questo setup è in parallelo): avviso.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Cartella della corsa per le home di `tempHome` (test/helpers.ts). */
    visioneTempRoot?: string;
  }
}

const RUN_PREFIX = 'visione-vitest-';
const strayCandidates = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('visione-') && !name.startsWith(RUN_PREFIX));

export default function setup(project: TestProject): () => void {
  const before = new Set(strayCandidates());
  const root = mkdtempSync(join(tmpdir(), RUN_PREFIX));
  project.provide('visioneTempRoot', root);
  return () => {
    const left = readdirSync(root);
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`[temp] ${root} non cancellabile a fine corsa: ${(err as Error).message}`);
    }
    if (left.length > 0) console.warn(`[temp] ${left.length} home non cancellate dai loro file (cancellate ora con la cartella della corsa): ${left.slice(0, 10).join(', ')}`);
    const stray = strayCandidates().filter((name) => !before.has(name));
    if (stray.length > 0) console.warn(`[temp] ${stray.length} cartelle visione-* nuove in ${tmpdir()} fuori da tempHome (o di un'altra corsa in parallelo): ${stray.slice(0, 10).join(', ')}`);
  };
}
