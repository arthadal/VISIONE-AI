// Browser di VISIONE (12/10/2026): barra degli indirizzi; partizione uguale a quella ammessa dal main.
import { describe, expect, it } from 'vitest';
import { BROWSER_PARTITION as MAIN_PARTITION } from '../../src/main/security-policy.ts';
import { addressToUrl, BROWSER_PARTITION } from '../../src/renderer/windows/panes/browser-logic.ts';

describe('barra degli indirizzi', () => {
  it('indirizzi restano indirizzi; il resto è una ricerca', () => {
    expect(addressToUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(addressToUrl('repubblica.it')).toBe('https://repubblica.it');
    expect(addressToUrl('www.comune.roma.it/servizi')).toBe('https://www.comune.roma.it/servizi');
    expect(addressToUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(addressToUrl('192.168.1.1')).toBe('http://192.168.1.1');
    expect(addressToUrl('meteo roma domani')).toBe('https://duckduckgo.com/?q=meteo%20roma%20domani');
    expect(addressToUrl('file:///C:/Windows')).toBe('https://duckduckgo.com/?q=file%3A%2F%2F%2FC%3A%2FWindows');
    expect(addressToUrl('   ')).toBeNull();
  });
  it('la partizione del renderer è quella che il main ammette', () => {
    expect(BROWSER_PARTITION).toBe(MAIN_PARTITION);
  });
});
