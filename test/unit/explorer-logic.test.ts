// Esplora VISIONE (11/10/2026): calcolo puro della finestra.
import { describe, expect, it } from 'vitest';
import { FILE_SCHEME, parseSchemeUrl, schemeUrl, THUMB_SCHEME } from '../../src/main/file-protocol.ts';
import {
  canDrop, crumbs, displayName, extOf, fileUrl, formatSize, glyphOf, hasThumb, parentPath, previewKind, selectAt, shortCrumbs, sortEntries, thumbUrl,
  type ExplorerEntry
} from '../../src/renderer/windows/panes/explorer-logic.ts';

const e = (name: string, kind: 'file' | 'directory', size: number | null = null, modifiedAt: number | null = null): ExplorerEntry =>
  ({ name, path: `C:\\Users\\t\\Docs\\${name}`, kind, size, modifiedAt });

describe('explorer-logic', () => {
  it('tipi di anteprima e miniature', () => {
    expect(extOf('Foto.JPG')).toBe('jpg');
    expect(extOf('.gitignore')).toBe('gitignore');
    expect(extOf('senza')).toBe('');
    expect(previewKind('a.png')).toBe('image');
    expect(previewKind('b.mp4')).toBe('video');
    expect(previewKind('c.mp3')).toBe('audio');
    expect(previewKind('d.pdf')).toBe('pdf');
    expect(previewKind('e.md')).toBe('text');
    expect(previewKind('f.exe')).toBe('other');
    expect(hasThumb('d.pdf')).toBe(true);
    expect(hasThumb('c.mp3')).toBe(false);
    expect(glyphOf({ name: 'x', kind: 'directory' })).toBe('▤');
    expect(glyphOf({ name: 'x.exe', kind: 'file' })).toBe('▢');
    expect(displayName('Google Chrome.lnk')).toBe('Google Chrome');
    expect(displayName('Sito.URL')).toBe('Sito');
    expect(displayName('.lnk')).toBe('.lnk');
    expect(displayName('nota.txt')).toBe('nota.txt');
  });

  it('gli URL sono quelli che il main sa leggere', () => {
    const p = 'C:\\Users\\t\\Immagini\\però #1 & co.jpg';
    expect(fileUrl(p)).toBe(schemeUrl(FILE_SCHEME, p));
    expect(thumbUrl(p, 96)).toBe(schemeUrl(THUMB_SCHEME, p, 96));
    expect(parseSchemeUrl(thumbUrl(p, 96), THUMB_SCHEME)).toEqual({ path: p, size: 96 });
  });

  it('percorso cliccabile dalla radice più lunga, senza salire sopra', () => {
    const roots = [{ name: 'Home', path: 'C:\\Users\\t' }, { name: 'Documenti', path: 'C:\\Users\\t\\Docs' }];
    expect(crumbs('C:\\Users\\t\\Docs\\Lavoro\\2026', roots)).toEqual([
      { label: 'Documenti', path: 'C:\\Users\\t\\Docs' },
      { label: 'Lavoro', path: 'C:\\Users\\t\\Docs\\Lavoro' },
      { label: '2026', path: 'C:\\Users\\t\\Docs\\Lavoro\\2026' }
    ]);
    expect(crumbs('c:\\users\\T\\Musica', roots)[0]!.label).toBe('Home');
    expect(crumbs('D:\\Altro\\x', roots)).toEqual([{ label: 'x', path: 'D:\\Altro\\x' }]);
  });

  it('percorso lungo accorciato: radice, «…», ultime tre tappe', () => {
    const trail = ['Profilo', 'AppData', 'Local', 'Temp', 'x', 'y', 'z'].map((l, i) => ({ label: l, path: `P${i}` }));
    expect(shortCrumbs(trail.slice(0, 5))).toHaveLength(5);
    expect(shortCrumbs(trail)).toEqual([
      { label: 'Profilo', path: 'P0' }, { label: '…', path: 'P3', hidden: 'AppData › Local › Temp' },
      { label: 'x', path: 'P4' }, { label: 'y', path: 'P5' }, { label: 'z', path: 'P6' }
    ]);
  });

  it('ordinamento: cartelle prima, nome naturale, data e dimensione decrescenti', () => {
    const list = [e('file10.txt', 'file', 5, 3), e('file2.txt', 'file', 50, 1), e('Zeta', 'directory'), e('alfa', 'directory')];
    expect(sortEntries(list, 'name').map((x) => x.name)).toEqual(['alfa', 'Zeta', 'file2.txt', 'file10.txt']);
    expect(sortEntries(list, 'date').slice(2).map((x) => x.name)).toEqual(['file10.txt', 'file2.txt']);
    expect(sortEntries(list, 'size').slice(2).map((x) => x.name)).toEqual(['file2.txt', 'file10.txt']);
  });

  it('selezione: clic, Ctrl, Maiusc dall ancora', () => {
    const list = ['a', 'b', 'c', 'd'].map((n) => e(n, 'file'));
    const p = (n: string): string => `C:\\Users\\t\\Docs\\${n}`;
    const one = selectAt(new Set(), list, 1, { ctrl: false, shift: false }, null);
    expect([...one.selection]).toEqual([p('b')]);
    const add = selectAt(one.selection, list, 3, { ctrl: true, shift: false }, one.anchor);
    expect([...add.selection].sort()).toEqual([p('b'), p('d')]);
    const off = selectAt(add.selection, list, 3, { ctrl: true, shift: false }, add.anchor);
    expect([...off.selection]).toEqual([p('b')]);
    const range = selectAt(one.selection, list, 3, { ctrl: false, shift: true }, 1);
    expect([...range.selection]).toEqual([p('b'), p('c'), p('d')]);
    expect(range.anchor).toBe(1);
  });

  it('trascinamento: mai su sé stessi, dentro sé stessi o nella stessa cartella', () => {
    const a = 'C:\\Users\\t\\Docs\\A';
    expect(canDrop([a], 'C:\\Users\\t\\Docs\\B', parentPath)).toBe(true);
    expect(canDrop([a], a, parentPath)).toBe(false);
    expect(canDrop([a], `${a}\\sotto`, parentPath)).toBe(false);
    expect(canDrop([a], 'C:\\Users\\t\\Docs', parentPath)).toBe(false);
    expect(canDrop([`${a}B`], `${a}\\x`, parentPath)).toBe(true);
    expect(canDrop([], 'C:\\Users\\t', parentPath)).toBe(false);
  });

  it('formati e cartella superiore', () => {
    expect(formatSize(null)).toBe('');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1,5 KB');
    expect(formatSize(300 * 1024 * 1024)).toBe('300 MB');
    expect(parentPath('C:\\Users\\t\\Docs\\')).toBe('C:\\Users\\t');
  });
});
