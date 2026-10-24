// Widget del cruscotto (11/10/2026, richiesta del proprietario): orologio, meteo e grafici a onde
// di CPU/GPU/RAM/VRAM/rete. Qui solo logica PURA (niente DOM, niente React): serie a finestra fissa,
// tracciato dell'onda con il picco, simboli del meteo. I componenti stanno accanto.

/** Campioni tenuti per ogni grafico: con la telemetria a ~1 s sono gli ultimi due minuti. */
export const SERIES_MAX = 120;

/** Aggiunge un campione reale (i valori non finiti si scartano: mai un punto inventato). */
export function pushSample(series: readonly number[], value: number | null | undefined, max = SERIES_MAX): number[] {
  if (value === null || value === undefined || !Number.isFinite(value)) return series as number[];
  const next = series.length >= max ? series.slice(series.length - max + 1) : series.slice();
  next.push(value);
  return next;
}

export interface Wave {
  /** Tracciato SVG della linea (curva morbida fra i campioni). */
  line: string;
  /** Tracciato SVG dell'area sotto la linea (per il riempimento sfumato). */
  area: string;
  /** Picco della finestra: indice, coordinate e valore reale. */
  peak: { i: number; x: number; y: number; v: number } | null;
}

/**
 * Onda di una serie dentro un riquadro `w`×`h`. `top` è il fondo scala: per le percentuali 100, per
 * le grandezze libere (rete, VRAM) il massimo della finestra con un margine, così l'onda non piatta.
 * I campioni stanno a destra (l'ultimo sul bordo destro), come un oscilloscopio che scorre.
 */
export function wavePath(values: readonly number[], w: number, h: number, top: number | null = null, slots = SERIES_MAX): Wave {
  const n = values.length;
  if (n === 0 || w <= 0 || h <= 0) return { line: '', area: '', peak: null };
  const maxV = Math.max(...values);
  const scale = top !== null && top > 0 ? top : Math.max(maxV * 1.15, 1e-9);
  const step = w / Math.max(1, slots - 1);
  const x0 = w - (n - 1) * step;
  const pts = values.map((v, i) => [x0 + i * step, h - Math.min(1, Math.max(0, v / scale)) * (h - 2) - 1] as const);
  const r = (v: number): string => (Math.round(v * 10) / 10).toString();
  let line = `M${r(pts[0]![0])},${r(pts[0]![1])}`;
  // Catmull-Rom → Bézier cubica: l'onda passa per ogni campione reale, senza spigoli.
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(n - 1, i + 2)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = Math.min(h, Math.max(0, p1[1] + (p2[1] - p0[1]) / 6));
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = Math.min(h, Math.max(0, p2[1] - (p3[1] - p1[1]) / 6));
    line += ` C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2[0])},${r(p2[1])}`;
  }
  const area = `${line} L${r(pts[n - 1]![0])},${h} L${r(pts[0]![0])},${h} Z`;
  let pi = 0;
  for (let i = 1; i < n; i++) if (values[i]! >= values[pi]!) pi = i;
  return { line, area, peak: { i: pi, x: pts[pi]![0], y: pts[pi]![1], v: values[pi]! } };
}

/** Byte → GB con una cifra decimale (per RAM e VRAM). */
export function gb(bytes: number | null | undefined): number | null {
  return bytes === null || bytes === undefined || !Number.isFinite(bytes) ? null : bytes / 1024 ** 3;
}

/** Velocità di rete leggibile (B/s, KB/s, MB/s). */
export function rateText(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
}

// --- Meteo ---------------------------------------------------------------------------------------

/** Città scritta dal proprietario: lettere (anche accentate), spazi, apostrofi, trattini, virgole. */
export function cityValid(s: string): boolean {
  const t = s.trim();
  return t.length >= 2 && t.length <= 80 && /^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]*$/u.test(t);
}

export type WeatherKind = 'clear' | 'fair' | 'partly' | 'cloudy' | 'fog' | 'lightrain' | 'rain' | 'heavyrain' | 'sleet' | 'snow' | 'thunder' | 'unknown';

/** Simbolo di MET Norway (`partlycloudy_day`, `lightrainshowersandthunder_night`, …) → tipo di tempo. */
export function weatherKind(symbol: string | null | undefined): WeatherKind {
  const s = (symbol ?? '').replace(/_(day|night|polartwilight)$/, '');
  if (s === '') return 'unknown';
  if (s.includes('thunder')) return 'thunder';
  if (s.includes('sleet')) return 'sleet';
  if (s.includes('snow')) return 'snow';
  if (s.startsWith('heavyrain')) return 'heavyrain';
  if (s.startsWith('lightrain')) return 'lightrain';
  if (s.startsWith('rain')) return 'rain';
  if (s === 'fog') return 'fog';
  if (s === 'cloudy') return 'cloudy';
  if (s === 'partlycloudy') return 'partly';
  if (s === 'fair') return 'fair';
  if (s === 'clearsky') return 'clear';
  return 'unknown';
}

export const WEATHER_ICON: Record<WeatherKind, string> = {
  clear: '☀', fair: '🌤', partly: '⛅', cloudy: '☁', fog: '🌫', lightrain: '🌦', rain: '🌧', heavyrain: '🌧', sleet: '🌨', snow: '❄', thunder: '⛈', unknown: '·'
};

/** Il meteo si aggiorna al più ogni 30 minuti (MET Norway chiede di non interrogare più spesso). */
export const WEATHER_REFRESH_MS = 30 * 60_000;
