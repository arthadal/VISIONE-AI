// Grafica senza accelerazione (collaudo da PC vergine, 18/10/2026): in una VM senza 3D (ma anche con il desktop
// remoto o il driver video di base di Windows) WebGL gira via software, e la scena da sola teneva occupato un
// core intero (processo GPU: 59 minuti di CPU in un'ora), lasciando il core di VISIONE senza fiato fino al
// riavvio per heartbeat. Lì la scena va in modalità leggera da sola.

const SOFTWARE = /swiftshader|basic render|llvmpipe|softpipe|software|\bwarp\b/i;

/** Il renderer WebGL è un rasterizzatore software? (nome come lo dà `UNMASKED_RENDERER_WEBGL`). */
export function softwareRenderer(name: string | null): boolean {
  return name !== null && SOFTWARE.test(name);
}

let cached: string | null | undefined;

/** Nome del renderer WebGL di questo PC (null = WebGL assente): letto una volta, con un contesto che si rilascia. */
export function webglRendererName(): string | null {
  if (cached !== undefined) return cached;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return (cached = null);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    cached = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cached = null;
  }
  return cached;
}
