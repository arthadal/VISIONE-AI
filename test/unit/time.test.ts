// Tempi leggibili (12/10/2026): sotto il minuto i secondi, poi minuti, ore, giorni; italiano e inglese.
import { describe, expect, it } from 'vitest';
import { formatAgo, formatDuration } from '../../src/renderer/lib/time.ts';

const S = 1_000;
describe('formatAgo / formatDuration', () => {
  it('«2270 s fa» diventa «37 min fa»; ore e giorni con il plurale giusto', () => {
    expect(formatAgo(15 * S)).toBe('15 s fa');
    expect(formatAgo(2270 * S)).toBe('37 min fa');
    expect(formatAgo(3600 * S)).toBe('1 ora fa');
    expect(formatAgo(5 * 3600 * S)).toBe('5 ore fa');
    expect(formatAgo(26 * 3600 * S)).toBe('1 giorno fa');
    expect(formatAgo(3 * 86_400 * S)).toBe('3 giorni fa');
    expect(formatAgo(2270 * S, 'en')).toBe('37 min ago');
    expect(formatAgo(3600 * S, 'en')).toBe('1 hour ago');
    expect(formatAgo(3 * 86_400 * S, 'en')).toBe('3 days ago');
    expect(formatAgo(-5)).toBe('0 s fa');
  });
  it('durate: «3 h 5 min», «2 g 4 h» / «2 d 4 h»', () => {
    expect(formatDuration(42 * S)).toBe('42 s');
    expect(formatDuration(2270 * S)).toBe('37 min');
    expect(formatDuration((3 * 3600 + 5 * 60) * S)).toBe('3 h 5 min');
    expect(formatDuration(2 * 3600 * S)).toBe('2 h');
    expect(formatDuration((2 * 86_400 + 4 * 3600) * S)).toBe('2 g 4 h');
    expect(formatDuration((2 * 86_400 + 4 * 3600) * S, 'en')).toBe('2 d 4 h');
  });
});
