// Browser di VISIONE (12/10/2026): cosa può aprire e quali permessi hanno le sue pagine. La pagina web
// sta in una partizione a parte, senza preload né Node (guardie in src/main/security.ts).
import { describe, expect, it } from 'vitest';
import { BROWSER_PARTITION, contentSecurityPolicy, isAllowedBrowserPermission, isBrowsableUrl } from '../../src/main/security-policy.ts';

describe('browser di VISIONE', () => {
  it('apre solo pagine web: mai file, javascript o gli schemi di VISIONE', () => {
    expect(isBrowsableUrl('https://duckduckgo.com/?q=meteo')).toBe(true);
    expect(isBrowsableUrl('http://192.168.1.1/')).toBe(true);
    expect(isBrowsableUrl('about:blank')).toBe(true);
    for (const bad of ['file:///C:/Windows/system.ini', 'javascript:alert(1)', 'visione-file://local/C%3A%5Cx', 'chrome://settings', 'data:text/html,x', 'ms-settings:', '', 'non un url']) {
      expect(isBrowsableUrl(bad), bad).toBe(false);
    }
  });
  it('permessi minimi: schermo intero e scrittura negli appunti; niente microfono, webcam, posizione', () => {
    expect(isAllowedBrowserPermission('fullscreen')).toBe(true);
    expect(isAllowedBrowserPermission('clipboard-sanitized-write')).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal', 'hid', 'serial', 'usb']) expect(isAllowedBrowserPermission(p), p).toBe(false);
  });
  it('partizione persistente a parte; la CSP di VISIONE ammette come frame solo pagine web', () => {
    expect(BROWSER_PARTITION).toMatch(/^persist:/);
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain('frame-src https: http:');
    expect(csp).toContain("object-src 'none'");
  });
});
