// Anteprime dell'Esplora (11/10/2026): politica dei percorsi, URL degli schemi, tipi, richieste parziali.
import { describe, expect, it } from 'vitest';
import { FILE_SCHEME, isServablePath, mimeOf, parseRange, parseSchemeUrl, schemeUrl, THUMB_SCHEME } from '../../src/main/file-protocol.ts';
import { contentSecurityPolicy, isAllowedRendererRequest } from '../../src/main/security-policy.ts';

const policy = { home: 'C:\\Users\\tester', visionHome: 'C:\\Users\\tester\\AppData\\Roaming\\VISIONE', protectedRoots: ['C:\\Users\\tester\\munder-difflin', 'C:\\Users\\tester\\jarvis'] };

describe('file-protocol', () => {
  it('stessa politica del core: home sì, fuori no, radici protette no, percorsi relativi no', () => {
    expect(isServablePath('C:\\Users\\tester\\Pictures\\gatto.jpg', policy)).toBe(true);
    expect(isServablePath('c:\\users\\TESTER\\Desktop\\x.mp4', policy)).toBe(true);
    expect(isServablePath('C:\\Windows\\System32\\config\\SAM', policy)).toBe(false);
    expect(isServablePath('C:\\Users\\altro\\foto.jpg', policy)).toBe(false);
    expect(isServablePath('C:\\Users\\tester\\munder-difflin\\segreto.txt', policy)).toBe(false);
    expect(isServablePath('C:\\Users\\tester\\Pictures\\..\\..\\altro\\x.jpg', policy)).toBe(false);
    expect(isServablePath('Pictures\\gatto.jpg', policy)).toBe(false);
  });

  it('URL: andata e ritorno con spazi, accenti e #; schema e host controllati', () => {
    const p = 'C:\\Users\\tester\\Immagini\\Vacanze 2026\\però #1.jpg';
    expect(parseSchemeUrl(schemeUrl(FILE_SCHEME, p), FILE_SCHEME)).toEqual({ path: p, size: 256 });
    expect(parseSchemeUrl(schemeUrl(THUMB_SCHEME, p, 128), THUMB_SCHEME)).toEqual({ path: p, size: 128 });
    expect(parseSchemeUrl(schemeUrl(THUMB_SCHEME, p, 99_999), THUMB_SCHEME)?.size).toBe(1_024);
    expect(parseSchemeUrl(schemeUrl(FILE_SCHEME, p), THUMB_SCHEME)).toBeNull();
    expect(parseSchemeUrl('visione-file://altro/C%3A%5Cx.jpg', FILE_SCHEME)).toBeNull();
    expect(parseSchemeUrl('visione-file://local/relativo.jpg', FILE_SCHEME)).toBeNull();
    expect(parseSchemeUrl('non un url', FILE_SCHEME)).toBeNull();
  });

  it('tipi serviti: immagini, video, audio; il resto no (miniatura o testo)', () => {
    expect(mimeOf('a.JPG')).toBe('image/jpeg');
    expect(mimeOf('b.mp4')).toBe('video/mp4');
    expect(mimeOf('c.mp3')).toBe('audio/mpeg');
    expect(mimeOf('d.exe')).toBeNull();
    expect(mimeOf('e.pdf')).toBeNull();
  });

  it('richieste parziali per scorrere i video', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
    expect(parseRange('righe=1-2', 1000)).toBe('invalid');
  });

  it('il renderer può chiedere solo i due schemi; la CSP li ammette per immagini e media', () => {
    const origin = { rendererDir: 'C:\\app\\renderer', devServerUrl: null };
    expect(isAllowedRendererRequest('visione-thumb://local/C%3A%5Cx.jpg?s=128', origin)).toBe(true);
    expect(isAllowedRendererRequest('visione-file://local/C%3A%5Cx.mp4', origin)).toBe(true);
    expect(isAllowedRendererRequest('file:///C:/Users/tester/x.jpg', origin)).toBe(false);
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("img-src 'self' data: visione-file: visione-thumb:");
    expect(csp).toContain('media-src visione-file:');
    // 12/10/2026: solo pagine web come frame, per il <webview> del browser di VISIONE (le guardie in security.ts).
    expect(csp).toContain('frame-src https: http:');
    expect(csp).toContain("object-src 'none'");
  });
});
