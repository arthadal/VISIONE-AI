// Fase 24 (P-71) — launcher: elenco reale (Start Menu) e avvio via `shell:AppsFolder`.
// Tutti gli effetti (PowerShell e explorer) sono iniettati: nessun processo vero nei test.
import { describe, expect, it } from 'vitest';
import { createAppCatalog } from '../../src/core/system/apps.ts';

const powershellOk = (payload: unknown) => async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: JSON.stringify(payload) });

describe('Fase 24 — launcher delle applicazioni', () => {
  it('elenco: JSON di Get-StartApps filtrato (id validi, niente duplicati) e ordinato per nome', async () => {
    const catalog = createAppCatalog({
      platform: 'win32',
      exec: powershellOk([
        { Name: 'Calcolatrice', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
        { Name: 'Blocco note', AppID: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
        { Name: 'Doppione', AppID: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
        { Name: 'Percorso strano', AppID: '..\\cmd.exe' },
        { Name: '', AppID: 'app-senza-nome' }
      ])
    });
    const apps = await catalog.list();
    expect(apps.map((a) => a.name)).toEqual(['Blocco note', 'Calcolatrice']);
    expect(apps[0]!.id).toBe('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App');
  });

  it('avvio: solo id del catalogo, via explorer.exe shell:AppsFolder, senza shell', async () => {
    const started: Array<{ file: string; args: readonly string[] }> = [];
    const catalog = createAppCatalog({
      platform: 'win32',
      exec: powershellOk([{ Name: 'Calcolatrice', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }]),
      start: (file, args) => {
        started.push({ file, args });
        const handlers: Record<string, Array<() => void>> = {};
        const child = {
          once: (event: string, cb: () => void) => { (handlers[event] ??= []).push(cb); return child; },
          unref: () => undefined
        } as unknown as import('node:child_process').ChildProcess;
        queueMicrotask(() => handlers.spawn?.forEach((cb) => cb()));
        return child;
      }
    });
    await catalog.list();

    const ok = await catalog.launch('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App');
    expect(ok).toEqual({ launched: true, name: 'Calcolatrice' });
    expect(started).toEqual([{ file: 'explorer.exe', args: ['shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'] }]);

    // Id fuori catalogo o con metacaratteri: mai avviato.
    expect(await catalog.launch('qualcosa-di-ignoto')).toEqual({ launched: false, name: null });
    expect(await catalog.launch('..\\cmd.exe')).toEqual({ launched: false, name: null });
    expect(started).toHaveLength(1);
  });

  it('su piattaforme non Windows: elenco vuoto e nessun avvio (dichiarato, non finto)', async () => {
    const catalog = createAppCatalog({ platform: 'linux' });
    expect(await catalog.list()).toEqual([]);
    expect(await catalog.launch('qualsiasi-cosa')).toEqual({ launched: false, name: null });
  });
});
