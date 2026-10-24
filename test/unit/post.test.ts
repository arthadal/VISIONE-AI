// P-79 — pass post-processing (aberrazione cromatica + grana + vignetta): i parametri per qualità
// sono puri e verificabili; il pass esiste solo dove c'è il composer (q1/q2) e la sua costruzione non
// richiede WebGL (solo three in Node). I valori seguono il riferimento del proprietario
// (`C:\Users\matte\jarvis`, MIT): CA 0.00035/0.0005, Noise 0.035, Vignette 0.22/0.95.
import { describe, expect, it } from 'vitest';
import { CA_OFFSET, NOISE_OPACITY, VIGNETTE_DARKNESS, VIGNETTE_OFFSET, createPost, postParams } from '../../src/renderer/neural/post.ts';

describe('post-processing G7 (P-79)', () => {
  it('a qualità 2 usa i valori del riferimento', () => {
    const p = postParams(2);
    expect([...p.ca]).toEqual([...CA_OFFSET]);
    expect(p.noise).toBe(NOISE_OPACITY);
    expect(p.vignette).toBe(1);
    expect(VIGNETTE_OFFSET).toBe(0.22);
    expect(VIGNETTE_DARKNESS).toBe(0.95);
  });

  it('qualità 1 = intensità ridotte; qualità 0 = nessun pass', () => {
    const p1 = postParams(1);
    expect(p1.ca[0]).toBeGreaterThan(0);
    expect(p1.ca[0]).toBeLessThan(CA_OFFSET[0]);
    expect(p1.noise).toBeGreaterThan(0);
    expect(p1.noise).toBeLessThan(NOISE_OPACITY);
    expect(p1.vignette).toBeGreaterThan(0);
    expect(p1.vignette).toBeLessThan(1);
    expect(postParams(0)).toEqual({ ca: [0, 0], noise: 0, vignette: 0 });
    expect(createPost(0)).toBeNull();
  });

  it('createPost: uniform del riferimento, spegnimento a caldo e aspect difensivo', () => {
    const post = createPost(2);
    expect(post).not.toBeNull();
    const u = post?.pass.uniforms as Record<string, { value: unknown }>;
    expect((u['uOffset']?.value as { x: number }).x).toBeCloseTo(0.00035, 6);
    expect((u['uOffset']?.value as { y: number }).y).toBeCloseTo(0.0005, 6);
    expect(u['uRumore']?.value).toBeCloseTo(0.035, 6);
    expect(u['uVignetta']?.value).toBe(1);
    // Spento/riacceso a caldo: il composer salta i pass disabilitati.
    expect(post?.active).toBe(true);
    post?.setActive(false);
    expect(post?.active).toBe(false);
    expect(post?.pass.enabled).toBe(false);
    post?.setActive(true);
    expect(post?.pass.enabled).toBe(true);
    // Difese: tempo/aspect non finiti non producono NaN negli uniform.
    post?.update(Number.NaN);
    expect(Number.isFinite(u['uTempo']?.value as number)).toBe(true);
    post?.setAspect(Number.NaN);
    expect(u['uAspetto']?.value).toBe(1);
    post?.setAspect(16 / 9);
    expect(u['uAspetto']?.value).toBeCloseTo(16 / 9, 6);
    post?.dispose();
  });
});
