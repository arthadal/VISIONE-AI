// Grafica senza accelerazione (collaudo da PC vergine, 18/10/2026): i rasterizzatori software si riconoscono
// dal nome del renderer WebGL, le schede vere no.
import { describe, expect, it } from 'vitest';
import { softwareRenderer } from '../../src/renderer/lib/gpu.ts';

describe('renderer WebGL via software', () => {
  it('SwiftShader, driver video di base di Windows, WARP e llvmpipe: sì', () => {
    expect(softwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true);
    expect(softwareRenderer('ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true);
    expect(softwareRenderer('ANGLE (Microsoft, WARP (0x0000008C) Direct3D11)')).toBe(true);
    expect(softwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
  });

  it('schede vere e WebGL assente: no', () => {
    expect(softwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(softwareRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(softwareRenderer('ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(softwareRenderer(null)).toBe(false);
  });
});
