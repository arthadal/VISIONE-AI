// Fase 24b (P-72) — File Manager e System Control: filesystem reale SOLO in directory temporanee
// dedicate (mai Desktop/Documenti/file personali), effetti di sistema tutti iniettati.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname as osHostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditLog } from '../../src/core/audit/index.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { createFileManager } from '../../src/core/files/index.ts';
import { createSystemControl } from '../../src/core/system/control.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

function harness() {
  const home = tempHome('visione-files-home-').dir;
  const vision = tempHome('visione-files-vh-').dir;
  // Radice protetta DENTRO la home (come i progetti esterni reali): la policy deve negarla.
  const protectedDir = join(home, 'munder-difflin');
  mkdirSync(protectedDir, { recursive: true });
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const audit: Array<Record<string, unknown>> = [];
  const events = { emit: (type: string, payload: Record<string, unknown>) => emitted.push({ type, payload }) } as unknown as EventEmitter;
  const auditLog = { record: (entry: Record<string, unknown>) => audit.push(entry) } as unknown as AuditLog;
  let started: Array<{ file: string; args: readonly string[] }> = [];
  const files = createFileManager({
    home, visionHome: vision, protectedRoots: [protectedDir],
    events, audit: auditLog, log: memoryLogger('error').log,
    run: async () => ({ code: 0, stdout: JSON.stringify({ desktop: join(home, 'Desktop'), documents: join(home, 'Documents') }) }),
    start: (file, args) => {
      started.push({ file, args });
      const handlers: Record<string, Array<() => void>> = {};
      const child = { once: (event: string, cb: () => void) => { (handlers[event] ??= []).push(cb); return child; }, unref: () => undefined } as unknown as import('node:child_process').ChildProcess;
      queueMicrotask(() => handlers.spawn?.forEach((cb) => cb()));
      return child;
    }
  });
  return { home, vision, protectedDir, files, emitted, audit, started: () => started };
}

describe('Fase 24b — File Manager (filesystem reale, radici consentite)', () => {
  it('elenco reale: cartelle prima, file con dimensione, percorso e risalita', async () => {
    const h = harness();
    mkdirSync(join(h.home, 'Documenti'));
    writeFileSync(join(h.home, 'nota.txt'), 'ciao');
    const out = h.files.list(h.home);
    expect(out.entries.map((e) => e.name)).toEqual(['Documenti', 'munder-difflin', 'nota.txt']);
    expect(out.entries[0]).toMatchObject({ kind: 'directory', size: null });
    expect(out.entries[2]).toMatchObject({ kind: 'file', size: 4 });
    expect(out.entries[2]!.modifiedAt).toBeGreaterThan(0);
    // Radici speciali: nomi e percorsi REALI dal sistema (run iniettato).
    const roots = await h.files.roots();
    expect(roots.map((r) => r.id)).toEqual(['desktop', 'documents', 'home']); // il profilo c'è sempre (Esplora)
  });

  it('mkdir, rinomina, cancella: operazione reale + evento + audit', () => {
    const h = harness();
    const created = h.files.mkdir(h.home, 'Nuova', 'owner:ui');
    expect(existsSync(created.path)).toBe(true);
    expect(h.emitted.some((e) => e.type === 'file.created')).toBe(true);
    const renamed = h.files.rename(created.path, 'Rinominata', 'owner:ui');
    expect(existsSync(renamed.to)).toBe(true);
    const removed = h.files.remove(renamed.to, false, 'owner:ui');
    expect(removed).toMatchObject({ kind: 'directory', recursive: false });
    expect(existsSync(renamed.to)).toBe(false);
    expect(h.emitted.map((e) => e.type)).toEqual(['file.created', 'file.renamed', 'file.deleted']);
    expect(h.audit.length).toBe(3);
  });

  it('errori reali e policy: inesistente, non vuota, fuori radici, protetta, nome non valido', () => {
    const h = harness();
    expect(() => h.files.list(join(h.home, 'manca'))).toThrow(/inesistente/);
    mkdirSync(join(h.home, 'piena'));
    writeFileSync(join(h.home, 'piena', 'x.txt'), 'x');
    expect(() => h.files.remove(join(h.home, 'piena'), false, 'owner:ui')).toThrow(/non vuota/);
    h.files.remove(join(h.home, 'piena'), true, 'owner:ui');
    expect(readdirSync(h.home).includes('piena')).toBe(false);
    expect(() => h.files.list('C:\\Windows')).toThrow(/radici consentite/);
    writeFileSync(join(h.protectedDir, 'segreto.txt'), 'x');
    expect(() => h.files.list(h.protectedDir)).toThrow(/protetto/);
    expect(() => h.files.mkdir(h.home, '..\\fuori', 'owner:ui')).toThrow(/nome non valido/);
  });

  it('apertura col programma predefinito: explorer.exe sul percorso, evento file.opened', async () => {
    const h = harness();
    writeFileSync(join(h.home, 'doc.pdf'), 'x');
    const out = await h.files.open(join(h.home, 'doc.pdf'), 'owner:ui');
    expect(out.opened).toBe(true);
    expect(h.started()).toEqual([{ file: 'explorer.exe', args: [join(h.home, 'doc.pdf')] }]);
    expect(h.emitted.some((e) => e.type === 'file.opened')).toBe(true);
  });

  it('ricerca di base: nome, limite, dentro le radici', () => {
    const h = harness();
    mkdirSync(join(h.home, 'docs'));
    writeFileSync(join(h.home, 'docs', 'relazione-finale.txt'), 'x');
    writeFileSync(join(h.home, 'altro.txt'), 'x');
    const out = h.files.search(h.home, 'relazione', 10);
    expect(out.results.map((r) => r.name)).toEqual(['relazione-finale.txt']);
  });

  it('ricerca per parole e senza accenti: tutte le parole devono esserci nel nome', () => {
    const h = harness();
    writeFileSync(join(h.home, 'Contratto_Affitto_2026.pdf'), 'x');
    writeFileSync(join(h.home, 'contratto-lavoro.pdf'), 'x');
    writeFileSync(join(h.home, 'attività.docx'), 'x');
    expect(h.files.search(h.home, 'contratto affitto', 10).results.map((r) => r.name)).toEqual(['Contratto_Affitto_2026.pdf']);
    expect(h.files.search(h.home, 'contratto', 10).results).toHaveLength(2);
    expect(h.files.search(h.home, 'attivita', 10).results.map((r) => r.name)).toEqual(['attività.docx']);
  });
});

describe('Fase 24b — System Control (metriche reali, azioni iniettate)', () => {
  const events = { emit: () => undefined } as unknown as EventEmitter;

  it('info: metriche REALI della macchina; ciò che non è ottenibile resta N/D (null)', () => {
    const control = createSystemControl({ home: tmpdir(), events });
    const info = control.info();
    expect(info.hostname).toBe(osHostname());
    expect(info.cpuCount).toBeGreaterThan(0);
    expect(info.memTotalBytes).toBeGreaterThan(0);
    expect(info.uptimeSec).toBeGreaterThan(0);
    expect(info.disk?.freeBytes).toBeGreaterThan(0);
    expect(info.loadavg === null || info.loadavg.length === 3).toBe(true); // su Windows resta [0,0,0] → null
  });

  it('exec: conferma obbligatoria per spegni/riavvia/blocca; azioni sicure senza conferma', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const control = createSystemControl({
      home: tmpdir(), events,
      run: async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: '' }; },
      start: (file, args) => {
        calls.push({ file, args });
        const handlers: Record<string, Array<() => void>> = {};
        const child = { once: (event: string, cb: () => void) => { (handlers[event] ??= []).push(cb); return child; }, unref: () => undefined } as unknown as import('node:child_process').ChildProcess;
        queueMicrotask(() => handlers.spawn?.forEach((cb) => cb()));
        return child;
      }
    });
    await expect(control.exec('shutdown', undefined, 'owner:ui')).rejects.toThrow(/conferma/);
    await expect(control.exec('restart', false, 'owner:ui')).rejects.toThrow(/conferma/);
    const vol = await control.exec('volume-up', undefined, 'owner:ui');
    expect(vol.performed).toBe(true);
    expect(calls[0]!.file).toBe('powershell.exe');
    const tm = await control.exec('task-manager', undefined, 'owner:ui');
    expect(tm.performed).toBe(true);
    const off = await control.exec('shutdown', true, 'owner:ui');
    expect(off.performed).toBe(true);
    expect(calls.at(-1)).toEqual({ file: 'shutdown.exe', args: ['/s', '/t', '0'] });
    expect(calls.some((c) => c.file === 'shutdown.exe' && c.args[0] === '/r')).toBe(false); // restart mai eseguito senza conferma
  });
});
