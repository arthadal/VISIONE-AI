import { describe, expect, it } from 'vitest';
import { REDACTED, containsSecret, redactString, redactValue } from '../../src/shared/lib/redact.ts';
import { ULID_PATTERN, ulid, ulidTime } from '../../src/shared/lib/ulid.ts';

describe('ulid', () => {
  it('produce id validi che codificano il tempo', () => {
    const id = ulid(1_700_000_000_123);
    expect(id).toMatch(ULID_PATTERN);
    expect(ulidTime(id)).toBe(1_700_000_000_123);
  });

  it('è monotonico nello stesso millisecondo e con l\'orologio che torna indietro', () => {
    const ids = [ulid(2_000_000_000_000), ulid(2_000_000_000_000), ulid(1_999_999_999_000), ulid(2_000_000_000_000)];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rifiuta tempi non validi', () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(1.5)).toThrow(RangeError);
  });
});

describe('redazione dei segreti', () => {
  it('redige le forme note di chiave e token', () => {
    const samples = [
      `nvapi-${'a'.repeat(30)}`,
      `sk-ant-${'b'.repeat(30)}`,
      `ghp_${'c'.repeat(36)}`,
      'Bearer abcdefghijklmnopqrstuvwxyz012345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl',
      // costruito a runtime: nessuna intestazione PEM letterale nel repository
      ['-----BEGIN', 'PRIVATE KEY-----\nMIIEv\n-----END', 'PRIVATE KEY-----'].join(' ')
    ];
    for (const s of samples) {
      expect(redactString(`valore: ${s} fine`)).toBe(`valore: ${REDACTED} fine`);
      expect(containsSecret(s)).toBe(true);
    }
  });

  it('nelle assegnazioni conserva il nome e toglie il valore', () => {
    expect(redactString('NVIDIA_API_KEY=supersegreto123')).toBe(`NVIDIA_API_KEY=${REDACTED}`);
    expect(redactString('password: "hunter2hunter2"')).toBe(`password: ${REDACTED}`);
  });

  it('non tocca il testo normale', () => {
    const text = 'core avviato con pid 1234, correlationId 01ABCDEF';
    expect(redactString(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it('redige oggetti in profondità senza modificarli, gestendo cicli ed Error', () => {
    const input: Record<string, unknown> = {
      apiKey: 'qualunque-valore',
      nested: { note: `token nvapi-${'x'.repeat(24)}`, count: 3, enabled: true },
      list: ['ok', 'sk-' + 'y'.repeat(24)]
    };
    input.self = input;
    const out = redactValue(input) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested).toEqual({ note: `token ${REDACTED}`, count: 3, enabled: true });
    expect(out.list).toEqual(['ok', REDACTED]);
    expect(out.self).toBe('[Circular]');
    expect(input.apiKey).toBe('qualunque-valore');
    const err = redactValue(new Error(`fallito con nvapi-${'z'.repeat(24)}`)) as { message: string };
    expect(err.message).toBe(`fallito con ${REDACTED}`);
  });
});
