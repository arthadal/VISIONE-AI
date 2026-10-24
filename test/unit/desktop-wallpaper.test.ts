// Test unitari della logica dello sfondo desktop (P-86): parsing dell'esito dell'helper,
// scelta 24H2/classico (dai marcatori prodotti dall'helper), misure +8 px per lo zoom 125% e
// schedulazione dei ritentativi. Nessun Electron e nessun PowerShell reale: l'helper è iniettato.
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  DESKTOP_ATTACH_DELAYS_MS,
  DESKTOP_MARGIN_PX,
  DESKTOP_REATTACH_INTERVAL_MS,
  buildAttachScript,
  buildDetachScript,
  createDesktopWallpaper,
  parseHelperOutput,
  wallpaperMetrics,
  type HelperResult
} from '../../src/main/desktop-wallpaper.ts';

describe('sfondo desktop P-86 — esito dell\'helper', () => {
  it('riconosce ok-24h2 con le informazioni di contorno', () => {
    const out = 'qualcosa\nVISIONEWP ok-24h2 parent=00010AA4 size=2400x1350\naltro\n';
    expect(parseHelperOutput(out)).toEqual({ outcome: 'ok-24h2', info: 'parent=00010AA4 size=2400x1350' });
  });

  it('riconosce ok-classico (Windows precedenti)', () => {
    expect(parseHelperOutput('VISIONEWP ok-classico workerw=00020B1C')).toEqual({ outcome: 'ok-classico', info: 'workerw=00020B1C' });
  });

  it('riconosce ok-detach del summon', () => {
    expect(parseHelperOutput('VISIONEWP ok-detach')).toEqual({ outcome: 'ok-detach', info: '' });
  });

  it('riconosce errore con il motivo', () => {
    expect(parseHelperOutput('VISIONEWP errore nessun WorkerW')).toEqual({ outcome: 'errore', info: 'nessun WorkerW' });
  });

  it('senza marcatore non inventa un esito', () => {
    const parsed = parseHelperOutput('Add-Type : errore di compilazione');
    expect(parsed.outcome).toBeNull();
    expect(parsed.info).toContain('Add-Type');
  });
});

describe('sfondo desktop P-86 — misure', () => {
  it('al 100% aggiunge +8 px per lato', () => {
    expect(wallpaperMetrics({ x: 0, y: 0, width: 1920, height: 1080 }, 1)).toEqual({ x: -8, y: -8, width: 1936, height: 1096 });
  });

  it('al 125% converte in pixel fisici e poi margina di +8 px (metodo del proprietario)', () => {
    expect(wallpaperMetrics({ x: 0, y: 0, width: 1920, height: 1080 }, 1.25)).toEqual({ x: -8, y: -8, width: 2416, height: 1366 });
  });

  it('arrotonda le misure frazionarie e rispetta un margine esplicito', () => {
    expect(wallpaperMetrics({ x: 10, y: 20, width: 1000, height: 500 }, 1.5, 4)).toEqual({ x: 11, y: 26, width: 1508, height: 758 });
    expect(DESKTOP_MARGIN_PX).toBe(8);
  });
});

describe('sfondo desktop P-86 — script dell\'helper', () => {
  it('lo script di aggancio usa il protocollo concordato (Progman, 0x052C, wParam 0xD, lParam 1)', () => {
    const script = buildAttachScript('-12345', { x: -8, y: -8, width: 1936, height: 1096 });
    expect(script).toContain('FindWindow("Progman"');
    expect(script).toContain('SendMessageTimeout(progman, 0x052C, (IntPtr)0xD, (IntPtr)1, 0, 2000, out res)');
    expect(script).toContain('Thread.Sleep(300)');
    expect(script).toContain('$h=[IntPtr]::new([long]-12345)');
    expect(script).toContain('Attach($h, -8, -8, 1936, 1096)');
    expect(script).toContain('VISIONEWP');
  });

  it('contiene ENTRAMBI i percorsi: 24H2 (DefView figlio di Progman, layered) e classico (WorkerW)', () => {
    const script = buildAttachScript('7', { x: 0, y: 0, width: 100, height: 100 });
    // 24H2: stile child + layered, sotto SHELLDLL_DefView.
    expect(script).toContain('"SHELLDLL_DefView"');
    expect(script).toContain('SetLayeredWindowAttributes');
    expect(script).toContain('SetWindowPos(hwnd, defView');
    expect(script).toContain('return "ok-24h2"');
    // Classico: EnumWindows → WorkerW successivo → SetParent → SetWindowPos.
    expect(script).toContain('EnumWindows');
    expect(script).toContain('FindWindowEx(IntPtr.Zero, owner, "WorkerW"');
    expect(script).toContain('return "ok-classico"');
    expect(script).toContain('return "errore');
    expect(script).toContain('SetParent');
  });

  it('lo script di distacco è reversibile (SetParent a 0, niente WS_EX_LAYERED)', () => {
    const script = buildDetachScript('99');
    expect(script).toContain('Detach($h)');
    expect(script).toContain('SetParent(hwnd, IntPtr.Zero)');
    expect(script).toContain('ok-detach');
  });

  it('la schedulazione è quella del metodo: subito, 3, 10, 30 s, poi ogni 60 s', () => {
    expect([...DESKTOP_ATTACH_DELAYS_MS]).toEqual([0, 3_000, 10_000, 30_000]);
    expect(DESKTOP_REATTACH_INTERVAL_MS).toBe(60_000);
  });
});

describe('sfondo desktop P-86 — ciclo attach/summon/rest', () => {
  function fakeWindow(): { win: BrowserWindow; handlers: Map<string, () => void> } {
    const handlers = new Map<string, () => void>();
    const win = {
      getNativeWindowHandle: () => {
        const buf = Buffer.alloc(8);
        buf.writeBigInt64LE(0x1234n);
        return buf;
      },
      isDestroyed: () => false,
      isFocused: () => false,
      isVisible: () => true,
      on: (name: string, fn: () => void) => {
        handlers.set(name, fn);
      },
      setFocusable: vi.fn(),
      setSkipTaskbar: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setBounds: vi.fn(),
      show: vi.fn(),
      showInactive: vi.fn(),
      focus: vi.fn()
    } as unknown as BrowserWindow;
    return { win, handlers };
  }

  it('aggancia subito e poi solo dopo i ritardi previsti; l\'esito resta nel log', async () => {
    vi.useFakeTimers();
    try {
      const { win } = fakeWindow();
      const scripts: string[] = [];
      const run = vi.fn(async (script: string): Promise<HelperResult> => {
        scripts.push(script);
        return { outcome: 'ok-24h2', info: `giro ${scripts.length}` };
      });
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as never;
      const controller = createDesktopWallpaper(win, log, { display: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), run });
      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(scripts[0] ?? '').toContain('Attach($h, -8, -8, 1936, 1096)');
      await vi.advanceTimersByTimeAsync(2_999);
      expect(run).toHaveBeenCalledTimes(1); // il secondo giro è a 3 s dal primo
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000 + 30_000);
      expect(run).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(5); // da qui: ogni 60 s
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('il summon stacca e rende interattiva; il rest riaggancia; il blur riporta a riposo', async () => {
    vi.useFakeTimers();
    try {
      const { win, handlers } = fakeWindow();
      const scripts: string[] = [];
      const run = vi.fn(async (script: string): Promise<HelperResult> => {
        scripts.push(script);
        return { outcome: script.includes('Detach') ? 'ok-detach' : 'ok-24h2', info: '' };
      });
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as never;
      const controller = createDesktopWallpaper(win, log, { display: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), run });
      controller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.summoned).toBe(false);

      expect(controller.toggle('test')).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.summoned).toBe(true);
      expect(scripts.some((s) => s.includes('Detach'))).toBe(true);
      expect(win.setFocusable).toHaveBeenCalledWith(true);
      expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
      expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
      expect(win.show).toHaveBeenCalled();
      expect(win.focus).toHaveBeenCalled();

      // Blur → riaggancio (il fake non è focused).
      handlers.get('blur')?.();
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.summoned).toBe(false);
      expect(win.setFocusable).toHaveBeenCalledWith(false);
      expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
      expect(scripts.filter((s) => s.includes('Attach')).length).toBeGreaterThanOrEqual(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
