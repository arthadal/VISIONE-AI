// Esplora VISIONE (11/10/2026): Cestino, copia, sposta, anteprima di testo, Start di Windows.
// Filesystem reale SOLO in cartelle temporanee; il Cestino di Windows e PowerShell sono finti.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditLog } from '../../src/core/audit/index.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { createFileManager, freeName, isSystemClutter, PREVIEW_TEXT_BYTES } from '../../src/core/files/index.ts';
import { createSystemControl } from '../../src/core/system/control.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

function harness(recycleWorks = true) {
  const home = tempHome('visione-explorer-home-').dir;
  const vision = tempHome('visione-explorer-vh-').dir;
  const protectedDir = join(home, 'munder-difflin');
  mkdirSync(protectedDir, { recursive: true });
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const audit: Array<Record<string, unknown>> = [];
  const recycled: string[][] = [];
  const files = createFileManager({
    home, visionHome: vision, protectedRoots: [protectedDir],
    events: { emit: (type: string, payload: Record<string, unknown>) => emitted.push({ type, payload }) } as unknown as EventEmitter,
    audit: { record: (entry: Record<string, unknown>) => audit.push(entry) } as unknown as AuditLog,
    log: memoryLogger('error').log,
    run: async () => ({ code: 0, stdout: '{}' }),
    // Cestino finto: «sposta» davvero via (così l'esito si misura come col Cestino vero).
    recycle: async (paths) => { recycled.push([...paths]); if (recycleWorks) for (const p of paths) rmSync(p, { recursive: true, force: true }); return recycleWorks; }
  });
  return { home, protectedDir, files, emitted, audit, recycled };
}

describe('Esplora — operazioni sui file nel core', () => {
  it('nomi liberi: mai sovrascrivere', () => {
    const taken = new Set(['a.txt', 'a (2).txt', 'cartella', '.gitignore']);
    const exists = (n: string): boolean => taken.has(n);
    expect(freeName(exists, 'b.txt')).toBe('b.txt');
    expect(freeName(exists, 'a.txt')).toBe('a (3).txt');
    expect(freeName(exists, 'cartella')).toBe('cartella (2)');
    expect(freeName(exists, '.gitignore')).toBe('.gitignore (2)');
  });

  it('Cestino: più file insieme, esito misurato, evento e audit; fuori radici rifiutato', async () => {
    const h = harness();
    const a = join(h.home, 'a.txt');
    const d = join(h.home, 'cartella');
    writeFileSync(a, 'x');
    mkdirSync(d);
    writeFileSync(join(d, 'dentro.txt'), 'y');
    const out = await h.files.trash([a, d], 'owner:ui');
    expect(out).toEqual({ trashed: [a, d], failed: [] });
    expect(h.emitted.filter((e) => e.type === 'file.trashed').map((e) => e.payload.kind)).toEqual(['file', 'directory']);
    expect(h.audit.map((x) => x.action)).toEqual(['file.trash', 'file.trash']);
    await expect(h.files.trash([join(h.protectedDir, 'x')], 'owner:ui')).rejects.toThrow(/protetto/);
    await expect(h.files.trash(['C:\\Windows\\System32\\x.dll'], 'owner:ui')).rejects.toThrow(/fuori dalle radici/);
  });

  it('Cestino non riuscito: errore vero, niente evento', async () => {
    const h = harness(false);
    const a = join(h.home, 'a.txt');
    writeFileSync(a, 'x');
    await expect(h.files.trash([a], 'owner:ui')).rejects.toThrow(/Cestino/);
    expect(existsSync(a)).toBe(true);
    expect(h.emitted.some((e) => e.type === 'file.trashed')).toBe(false);
  });

  it('copia e sposta: nome «(2)» se esiste, sposta nella stessa cartella = niente, mai una cartella dentro sé stessa', () => {
    const h = harness();
    const src = join(h.home, 'src');
    const dst = join(h.home, 'dst');
    mkdirSync(src);
    mkdirSync(dst);
    writeFileSync(join(src, 'nota.txt'), 'ciao');
    writeFileSync(join(dst, 'nota.txt'), 'già qui');
    const copied = h.files.copy([join(src, 'nota.txt')], dst, 'owner:ui');
    expect(copied.done[0]!.to).toBe(join(dst, 'nota (2).txt'));
    expect(readFileSync(join(dst, 'nota (2).txt'), 'utf8')).toBe('ciao');
    expect(readFileSync(join(dst, 'nota.txt'), 'utf8')).toBe('già qui');
    const moved = h.files.move([join(src, 'nota.txt')], dst, 'owner:ui');
    expect(moved.done[0]!.to).toBe(join(dst, 'nota (3).txt'));
    expect(existsSync(join(src, 'nota.txt'))).toBe(false);
    expect(h.files.move([join(dst, 'nota.txt')], dst, 'owner:ui').done).toEqual([]);
    expect(() => h.files.move([src], src, 'owner:ui')).toThrow(/dentro sé stessa/);
    mkdirSync(join(src, 'figlia'));
    expect(() => h.files.copy([src], join(src, 'figlia'), 'owner:ui')).toThrow(/dentro sé stessa/);
    expect(() => h.files.copy([join(dst, 'nota.txt')], h.protectedDir, 'owner:ui')).toThrow(/protetto/);
    expect(h.emitted.filter((e) => e.type === 'file.created' || e.type === 'file.renamed').length).toBeGreaterThanOrEqual(2);
  });

  it('anteprima di testo: al più 256 KiB, binari rifiutati', () => {
    const h = harness();
    const t = join(h.home, 'testo.md');
    writeFileSync(t, '# Titolo\nciao');
    expect(h.files.read(t)).toEqual({ path: t, text: '# Titolo\nciao', truncated: false, size: 13 });
    const big = join(h.home, 'grande.txt');
    writeFileSync(big, 'a'.repeat(PREVIEW_TEXT_BYTES + 10));
    expect(h.files.read(big)).toMatchObject({ truncated: true, size: PREVIEW_TEXT_BYTES + 10 });
    const bin = join(h.home, 'x.bin');
    writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
    expect(() => h.files.read(bin)).toThrow(/binario/);
    expect(() => h.files.read(h.home)).toThrow(/non è un file/);
  });

  it('elenco come Esplora risorse: niente file di sistema né collegamenti rotti; «nascosti» li mostra', () => {
    const h = harness();
    const dir = join(h.home, 'Documenti');
    mkdirSync(join(dir, 'Lavoro'), { recursive: true });
    for (const n of ['desktop.ini', 'Thumbs.db', '~$offerta.docx', 'NTUSER.DAT', 'nota.txt']) writeFileSync(join(dir, n), 'x');
    symlinkSync(join(dir, 'Lavoro'), join(dir, 'Scorciatoia'), 'junction');
    const gone = join(h.home, 'sparita');
    mkdirSync(gone);
    symlinkSync(gone, join(dir, 'Rotta'), 'junction');
    rmSync(gone, { recursive: true });
    const names = (hidden?: boolean): string[] => h.files.list(dir, hidden).entries.map((e) => e.name).sort();
    expect(names()).toEqual(['Lavoro', 'nota.txt', 'Scorciatoia'].sort());
    expect(h.files.list(dir).entries.find((e) => e.name === 'Scorciatoia')?.kind).toBe('directory');
    expect(names(true)).toEqual(['desktop.ini', 'Lavoro', 'nota.txt', 'NTUSER.DAT', 'Scorciatoia', 'Thumbs.db', '~$offerta.docx'].sort());
    expect(isSystemClutter('AppData')).toBe(true);
    expect(isSystemClutter('appunti.txt')).toBe(false);
  });
});

describe('Start di Windows dal tasto Start di VISIONE', () => {
  it('start-menu: Ctrl+Esc via SendKeys, senza conferma', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const control = createSystemControl({
      home: tmpdir(), events: { emit: () => undefined } as unknown as EventEmitter,
      run: async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: '' }; }
    });
    expect(await control.exec('start-menu', undefined, 'owner:ui')).toMatchObject({ action: 'start-menu', performed: true });
    expect(calls[0]!.file).toBe('powershell.exe');
    expect(calls[0]!.args.at(-1)).toContain("SendWait('^{ESC}')");
  });
});
