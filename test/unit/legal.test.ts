// Privacy e licenza (11/10/2026): l'informativa deve dire il vero. Ogni servizio esterno che il codice
// contatta deve comparirvi, in italiano e in inglese; i testi devono avere entrambe le lingue.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGLISH_MARK, legalSection } from '../../src/renderer/app/legal.ts';

const LEGAL = join(import.meta.dirname, '../../src/renderer/legal');
const privacy = readFileSync(join(LEGAL, 'PRIVACY.txt'), 'utf8');
const license = readFileSync(join(LEGAL, 'LICENZA_BETA_TESTER.txt'), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|json)$/.test(n) ? [p] : [];
  });
}

describe('privacy e licenza', () => {
  it('due lingue, BOM per l’installer, sezione giusta per lingua', () => {
    for (const text of [privacy, license]) {
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text).toContain(ENGLISH_MARK);
    }
    expect(legalSection(privacy, 'it')).toMatch(/^VISIONE - INFORMATIVA SULLA PRIVACY/);
    expect(legalSection(privacy, 'en')).toMatch(/^VISIONE - PRIVACY NOTICE/);
    expect(legalSection('solo italiano', 'en')).toBe('solo italiano');
  });

  it('ogni servizio esterno contattato dal codice (non dai motori) è dichiarato nell’informativa', () => {
    const SRC = join(import.meta.dirname, '../../src');
    const hosts = new Set<string>();
    for (const file of sources(SRC)) {
      if (file.includes(`${join('core', 'adapters')}`)) continue; // i motori: dichiarati come «servizio del motore»
      for (const m of readFileSync(file, 'utf8').matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1]!.toLowerCase());
    }
    // Solo commenti e documentazione, mai contattati: non sono connessioni.
    for (const doc of ['github.com/ulid', 'opencode.ai']) hosts.delete(doc);
    const declared = (lang: 'it' | 'en'): string => legalSection(privacy, lang).toLowerCase();
    for (const host of hosts) {
      const short = host.replace(/^www\./, '');
      expect(declared('it'), `manca ${short} nell'informativa italiana`).toContain(short);
      expect(declared('en'), `missing ${short} in the English notice`).toContain(short);
    }
  });

  it('la licenza dice dove finiscono le chiavi (variabili d’ambiente), in entrambe le lingue', () => {
    expect(legalSection(license, 'it')).toContain("variabili d'ambiente");
    expect(legalSection(license, 'en')).toContain('environment variables');
  });
});
