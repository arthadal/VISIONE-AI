// Effetto «stile JARVIS» della voce VISIONE (P-110), scelto dal proprietario sul campione n.3: presenza
// (EQ), sdoppiamento leggero, velo metallico e un ambiente corto. È lo stesso calcolo di
// `.backup/voce-lavoro/effetto.py`, ma a flusso: lo stato (filtri e linee di ritardo) passa da un blocco
// al successivo, così la voce si effettua mentre viene generata e il risultato è identico all'intero.

export interface StreamEffect {
  process(input: Float32Array): Float32Array;
}

/** Biquad in forma diretta I (coefficienti già divisi per a0). */
function biquad(b0: number, b1: number, b2: number, a1: number, a2: number): (x: number) => number {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function highpass(sr: number, f: number, q = 0.707): (x: number) => number {
  const w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
  return biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
}

function peak(sr: number, f: number, gainDb: number, q: number): (x: number) => number {
  const A = 10 ** (gainDb / 40), w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al / A;
  return biquad((1 + al * A) / a0, (-2 * c) / a0, (1 - al * A) / a0, (-2 * c) / a0, (1 - al / A) / a0);
}

function highshelf(sr: number, f: number, gainDb: number): (x: number) => number {
  const A = 10 ** (gainDb / 40), w = (2 * Math.PI * f) / sr, c = Math.cos(w), s = Math.sin(w);
  const sa = 2 * Math.sqrt(A) * ((s / 2) * Math.SQRT2);
  const a0 = A + 1 - (A - 1) * c + sa;
  return biquad(
    (A * (A + 1 + (A - 1) * c + sa)) / a0,
    (-2 * A * (A - 1 + (A + 1) * c)) / a0,
    (A * (A + 1 + (A - 1) * c - sa)) / a0,
    (2 * (A - 1 - (A + 1) * c)) / a0,
    (A + 1 - (A - 1) * c - sa) / a0
  );
}

/** Storia circolare di un segnale: `at(k)` = il campione di k passi fa (0 = l'ultimo scritto). */
function history(size: number): { push(v: number): void; at(k: number): number } {
  const buf = new Float64Array(size);
  let n = 0;
  return {
    push: (v) => { buf[n % size] = v; n++; },
    at: (k) => (k < n && k < size ? buf[(n - 1 - k) % size]! : 0)
  };
}

/** Ritardo modulato con interpolazione lineare; prima dell'inizio del segnale vale 0. */
function delayMod(sr: number, baseMs: number, depthMs: number, rateHz: number): (x: number, n: number) => number {
  const h = history(Math.ceil(((baseMs + depthMs) * sr) / 1000) + 4);
  return (x, n) => {
    h.push(x);
    const idx = n - ((baseMs + depthMs * Math.sin((2 * Math.PI * rateHz * n) / sr)) * sr) / 1000;
    if (idx < 0) return 0;
    const i0 = Math.floor(idx), fr = idx - i0;
    return h.at(n - i0) * (1 - fr) + h.at(n - i0 - 1) * fr;
  };
}

/** Pettine con retroazione: y[i] = x[i] + fb·y[i−d]. */
function comb(sr: number, ms: number, fb: number): (x: number) => number {
  const d = Math.trunc((sr * ms) / 1000);
  const h = history(d);
  return (x) => {
    const y = x + fb * h.at(d - 1);
    h.push(y);
    return y;
  };
}

/** Passa-tutto di Schroeder: y[i] = −g·x[i] + x[i−d] + g·y[i−d]. */
function allpass(sr: number, ms: number, g: number): (x: number) => number {
  const d = Math.trunc((sr * ms) / 1000);
  const hx = history(d), hy = history(d);
  return (x) => {
    const y = -g * x + hx.at(d - 1) + g * hy.at(d - 1);
    hx.push(x);
    hy.push(y);
    return y;
  };
}

/** Effetto grezzo (senza guadagno finale), campione per campione: è ciò che il test confronta con Python. */
export function jarvisRaw(sr: number): (x: number) => number {
  const hp = highpass(sr, 110), pk = peak(sr, 2800, 3.5, 0.9), hs = highshelf(sr, 7500, 2.5);
  const d1 = delayMod(sr, 11, 1.2, 0.6), d2 = delayMod(sr, 17, 1.6, 0.9);
  const metal = comb(sr, 2.4, 0.35);
  const room = [29.7, 37.1, 41.1, 43.7].map((ms) => comb(sr, ms, 0.62));
  const ap1 = allpass(sr, 5.0, 0.7), ap2 = allpass(sr, 1.7, 0.7);
  let n = 0;
  return (input) => {
    const x = hs(pk(hp(input)));
    const dbl = 0.32 * d1(x, n) + 0.22 * d2(x, n);
    const y = x + dbl + 0.18 * (metal(x) - x);
    let wet = 0;
    for (const c of room) wet += c(y * 0.25);
    n++;
    return y + 0.14 * ap2(ap1(wet));
  };
}

/**
 * L'effetto a flusso con un guadagno fisso (l'originale normalizzava l'intero file, cosa impossibile
 * mentre si parla) e un limitatore morbido sopra `knee` che tende a 0,98: un picco non satura mai.
 */
export function createJarvisEffect(sr: number, gain: number, knee = 0.9): StreamEffect {
  const fx = jarvisRaw(sr);
  const room = 0.98 - knee; // asintoto sotto 1: anche in float32 non si arriva mai al fondo scala
  return {
    process: (input) => {
      const out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const v = fx(input[i]!) * gain;
        const a = Math.abs(v);
        out[i] = a <= knee ? v : Math.sign(v) * (knee + room * Math.tanh((a - knee) / room));
      }
      return out;
    }
  };
}
