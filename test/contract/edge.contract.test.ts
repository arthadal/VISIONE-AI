// Contract reale della voce Edge (P-84, opt-in con `npm run test:contract`): usa il servizio Read
// Aloud di Microsoft Edge con la voce italiana del proprietario. Costo zero e nessuna chiave; il
// testo passa dai server Microsoft (uso personale non commerciale, P-82/P-84). Se la rete non è
// disponibile il test è SALTATO con un messaggio esplicito (mai un finto verde).
import { describe, expect, it } from 'vitest';
import { createEdgeTts } from '../../src/voice/edge.ts';

describe('voce Edge reale (Read Aloud, rete, costo zero)', () => {
  it('sintetizza una frase breve: byte MP3 non vuoti e latenza del primo audio misurata', async (ctx) => {
    const chunks: Uint8Array[] = [];
    let firstMs: number | null = null;
    const t0 = Date.now();
    const engine = createEdgeTts({ voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz', timeoutMs: 20_000 });
    try {
      await engine.synthesize('VISIONE è operativa. Sistemi pronti.', (chunk) => {
        if (chunk.kind !== 'mp3') return false;
        firstMs ??= Date.now() - t0;
        chunks.push(chunk.bytes);
        return true;
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[edge] rete non disponibile o servizio non raggiungibile: ${reason}`);
      ctx.skip();
      return;
    }

    const total = chunks.reduce((n, c) => n + c.length, 0);
    console.log(`[edge] ${chunks.length} blocchi, ${total} byte, primo audio ${firstMs} ms, totale ${Date.now() - t0} ms, voce it-IT-DiegoNeural`);
    expect(chunks.length).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(2_000);
    expect(firstMs).not.toBeNull();
    expect(firstMs!).toBeGreaterThan(0);
    // Il primo blocco è MP3 allineato (sync word), non testo o silenzio.
    expect(chunks[0]![0]).toBe(0xff);
    expect(chunks[0]![1]! & 0xe0).toBe(0xe0);
  }, 60_000);
});
