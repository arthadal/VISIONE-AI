// Modalità sfondo del desktop (P-86, basata sulla tecnica fornita dal proprietario): VISIONE vive
// DIETRO le icone del desktop e DIETRO la barra delle applicazioni, come un wallpaper animato.
//
// Metodo:
//  1. `FindWindow("Progman")` + `SendMessageTimeout(0x052C, wParam=0xD, lParam=1)` → crea lo strato
//     WorkerW; attesa ~300 ms.
//  2. Windows 11 24H2+ (SHELLDLL_DefView/WorkerW FIGLI di Progman): stili WS_CHILD|WS_VISIBLE +
//     WS_EX_LAYERED, `SetLayeredWindowAttributes(255)`, `SetParent(win, Progman)`, `SetWindowPos`
//     con `hWndInsertAfter = SHELLDLL_DefView` (SWP_NOACTIVATE|SWP_SHOWWINDOW): la finestra resta
//     subito SOTTO le icone.
//  3. Windows precedenti: `EnumWindows` cerca la finestra con SHELLDLL_DefView, prende il WorkerW
//     SUCCESSIVO, `SetParent(win, WorkerW)` e `SetWindowPos` a 0,0 con le misure.
//  4. Esito stampato dall'helper: `ok-24h2`, `ok-classico` o `errore`.
//
// L'helper nativo è C# compilato in memoria da PowerShell (`Add-Type`): nessuna dipendenza nuova,
// nessun file, esattamente come il resto dell'app. Ogni invocazione è un processo separato e non
// lascia stato: `Attach` e `Detach` sono simmetrici e l'operazione è sempre reversibile.
//
// Un figlio di Progman/WorkerW NON riceve i click (limite di Windows, dichiarato dal metodo): per
// questo VISIONE ha il **summon** — staccare la finestra (`SetParent(win, 0)`), renderla focusable
// e portarla in primo piano; al blur si riaggancia da sola dietro le icone.
import { spawn } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import type { Logger } from '../shared/node/logging.ts';

/** Tentativi ravvicinati dopo l'avvio (ms): subito, 3 s, 10 s, 30 s. */
export const DESKTOP_ATTACH_DELAYS_MS = [0, 3_000, 10_000, 30_000] as const;
/** Ritentativo periodico (ms) una volta assestati: Explorer può riavviarsi e ricreare lo sfondo. */
export const DESKTOP_REATTACH_INTERVAL_MS = 60_000;
/** Margine (px fisici) per lato: copre i bordi con lo zoom 125% (metodo del proprietario). */
export const DESKTOP_MARGIN_PX = 8;

const POWERSHELL_TIMEOUT_MS = 20_000;

// C# dell'helper. Compilato in memoria da PowerShell: niente csc.exe esterno, niente file.
const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class VisioneWallpaper {
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll", SetLastError=true)] static extern int SetWindowLong(IntPtr hWnd, int index, int value);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  const int GWL_STYLE = -16;
  const int GWL_EXSTYLE = -20;
  const int WS_CHILD = 0x40000000;
  const int WS_VISIBLE = 0x10000000;
  const int WS_POPUP = unchecked((int)0x80000000);
  const int WS_CAPTION = 0x00C00000;
  const int WS_EX_LAYERED = 0x00080000;
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOZORDER = 0x0004;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_FRAMECHANGED = 0x0020;
  const uint SWP_SHOWWINDOW = 0x0040;
  const uint LWA_ALPHA = 0x00000001;

  static string Err(string stage) { return "errore " + stage + " (last=" + Marshal.GetLastWin32Error() + ")"; }

  // Aggancia: 0x052C a Progman, poi 24H2 (figlio di Progman, sotto DefView) o classico (WorkerW).
  public static string Attach(IntPtr hwnd, int x, int y, int cx, int cy) {
    if (!IsWindow(hwnd)) return "errore finestra non valida";
    IntPtr progman = FindWindow("Progman", null);
    if (progman == IntPtr.Zero) return "errore Progman non trovato";
    IntPtr res;
    SendMessageTimeout(progman, 0x052C, (IntPtr)0xD, (IntPtr)1, 0, 2000, out res);
    Thread.Sleep(300);

    // Windows 11 24H2+: SHELLDLL_DefView (o il WorkerW che lo contiene) e' FIGLIO di Progman.
    IntPtr defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (defView == IntPtr.Zero) {
      IntPtr childWorker = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
      if (childWorker != IntPtr.Zero) defView = FindWindowEx(childWorker, IntPtr.Zero, "SHELLDLL_DefView", null);
    }
    if (defView != IntPtr.Zero) {
      SetParent(hwnd, progman);
      int style = GetWindowLong(hwnd, GWL_STYLE);
      SetWindowLong(hwnd, GWL_STYLE, ((style & ~WS_CAPTION) | WS_CHILD | WS_VISIBLE) & 0x7FFFFFFF);
      int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
      SetWindowLong(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
      SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
      // hWndInsertAfter = DefView: la finestra entra SUBITO SOTTO le icone (sopra il wallpaper).
      if (!SetWindowPos(hwnd, defView, x, y, cx, cy, SWP_NOACTIVATE | SWP_SHOWWINDOW)) return Err("SetWindowPos 24H2");
      return "ok-24h2";
    }

    // Windows precedenti: il WorkerW top-level SUCCESSIVO alla finestra che possiede SHELLDLL_DefView.
    IntPtr owner = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { owner = h; return false; }
      return true;
    }, IntPtr.Zero);
    IntPtr workerw = IntPtr.Zero;
    if (owner != IntPtr.Zero) workerw = FindWindowEx(IntPtr.Zero, owner, "WorkerW", null);
    if (workerw == IntPtr.Zero) workerw = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "WorkerW", null);
    if (workerw == IntPtr.Zero) return "errore nessun WorkerW";
    SetParent(hwnd, workerw);
    int style2 = GetWindowLong(hwnd, GWL_STYLE);
    SetWindowLong(hwnd, GWL_STYLE, ((style2 & ~WS_CAPTION) | WS_CHILD | WS_VISIBLE) & 0x7FFFFFFF);
    if (!SetWindowPos(hwnd, IntPtr.Zero, x, y, cx, cy, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)) return Err("SetWindowPos classico");
    return "ok-classico";
  }

  // Stacca per il summon: di nuovo top-level, focusable e cliccabile. Reversibile con Attach.
  public static string Detach(IntPtr hwnd) {
    if (!IsWindow(hwnd)) return "errore finestra non valida";
    SetParent(hwnd, IntPtr.Zero);
    int style = GetWindowLong(hwnd, GWL_STYLE);
    SetWindowLong(hwnd, GWL_STYLE, (style & ~WS_CHILD & ~WS_CAPTION) | WS_POPUP | WS_VISIBLE);
    int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
    SetWindowLong(hwnd, GWL_EXSTYLE, ex & ~WS_EX_LAYERED);
    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    return "ok-detach";
  }
}
`;

/** Esito stampato dall'helper. `null` = nessuna riga riconosciuta (processo fallito, timeout…). */
export type HelperOutcome = 'ok-24h2' | 'ok-classico' | 'ok-detach' | 'errore';

export interface HelperResult {
  outcome: HelperOutcome | null;
  info: string;
  stderr?: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Misure per il helper in PIXEL FISICI: `SetWindowPos` non conosce i DIP di Electron, quindi le
 * bounds del display (DIP) vanno moltiplicate per lo `scaleFactor`. Il margine di +8 px per lato
 * (metodo del proprietario, zoom 125%) copre i bordi e gli arrotondamenti.
 */
export function wallpaperMetrics(bounds: Bounds, scaleFactor: number, margin = DESKTOP_MARGIN_PX): Bounds {
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return {
    x: Math.round(bounds.x * sf) - margin,
    y: Math.round(bounds.y * sf) - margin,
    width: Math.round(bounds.width * sf) + margin * 2,
    height: Math.round(bounds.height * sf) + margin * 2
  };
}

/** Estrae l'esito dell'helper dallo stdout (`VISIONEWP ok-24h2 …`), ignorando ogni altra riga. */
export function parseHelperOutput(stdout: string): HelperResult {
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('VISIONEWP');
    if (at === -1) continue;
    const rest = line.slice(at + 'VISIONEWP'.length).trim();
    const space = rest.search(/\s/);
    const word = space === -1 ? rest : rest.slice(0, space);
    const info = space === -1 ? '' : rest.slice(space + 1).trim();
    if (word === 'ok-24h2' || word === 'ok-classico' || word === 'ok-detach' || word === 'errore') return { outcome: word, info };
  }
  return { outcome: null, info: stdout.trim().slice(0, 300) };
}

function psPrelude(): string {
  return ["$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'", "Add-Type -TypeDefinition @'", CSHARP, "'@"].join('\n');
}

/** Script PowerShell di aggancio (24H2 o classico: decide l'helper, non il chiamante). */
export function buildAttachScript(hwnd: string, metrics: Bounds): string {
  return [
    psPrelude(),
    `$h=[IntPtr]::new([long]${hwnd})`,
    `'VISIONEWP ' + [VisioneWallpaper]::Attach($h, ${metrics.x}, ${metrics.y}, ${metrics.width}, ${metrics.height})`,
    ''
  ].join('\n');
}

/** Script PowerShell di distacco per il summon (sempre reversibile). */
export function buildDetachScript(hwnd: string): string {
  return [psPrelude(), `$h=[IntPtr]::new([long]${hwnd})`, `'VISIONEWP ' + [VisioneWallpaper]::Detach($h)`, ''].join('\n');
}

/** HWND della finestra come intero (8 byte su x64, 4 su x86). */
export function nativeHandle(win: BrowserWindow): string | null {
  try {
    const buf = win.getNativeWindowHandle();
    const value = buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0));
    return value.toString();
  } catch {
    return null;
  }
}

/** Esegue uno script PowerShell codificato e interpreta l'esito. Non lancia mai. */
export function runPowerShell(script: string): Promise<HelperResult> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result: HelperResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ outcome: null, info: `avvio PowerShell fallito: ${String(e)}` });
      return;
    }
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* già uscito */
      }
      finish({ outcome: null, info: `timeout dopo ${POWERSHELL_TIMEOUT_MS} ms`, stderr: err.trim().slice(0, 300) });
    }, POWERSHELL_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      finish({ outcome: null, info: `errore del processo: ${String(e)}` });
    });
    child.on('exit', () => {
      clearTimeout(killer);
      const parsed = parseHelperOutput(out);
      finish({ ...parsed, stderr: err.trim().slice(0, 300) });
    });
  });
}

export interface DesktopWallpaperController {
  /** Avvia il ciclo: subito, 3 s, 10 s, 30 s, poi ogni 60 s (finché non è richiamata). */
  start(): void;
  /** Stacca dal desktop e porta la finestra in primo piano, interattiva. `false` se già richiamata. */
  summon(reason: string): boolean;
  /** Riaggancia dietro le icone e riprende il ciclo. `false` se già a riposo. */
  rest(reason: string): boolean;
  toggle(reason: string): boolean;
  readonly summoned: boolean;
  dispose(): void;
}

export interface DesktopWallpaperDeps {
  /** Display primario corrente (DIP + fattore di scala): ricalcolato a ogni tentativo. */
  display: () => { bounds: Bounds; scaleFactor: number };
  /** Esecutore dell'helper (test); default: PowerShell con Add-Type. */
  run?: (script: string) => Promise<HelperResult>;
}

/**
 * Ciclo di vita dell'aggancio desktop: ritenta all'avvio (Explorer può creare lo sfondo con
 * ritardo), poi ogni minuto (Explorer si riavvia; ripetere è innocuo), sospeso durante il summon.
 * Tutte le operazioni sono reversibili; ogni esito finisce nel log del main (`<home>\logs\main.jsonl`).
 */
export function createDesktopWallpaper(win: BrowserWindow, log: Logger, deps: DesktopWallpaperDeps): DesktopWallpaperController {
  const run = deps.run ?? runPowerShell;
  let disposed = false;
  let summoned = false;
  let attached = false;
  let busy = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  let lastOutcome: HelperOutcome | null = null;

  function scheduleNext(): void {
    if (disposed || summoned || timer !== null) return;
    const delay = attempt < DESKTOP_ATTACH_DELAYS_MS.length ? (DESKTOP_ATTACH_DELAYS_MS[attempt] ?? DESKTOP_REATTACH_INTERVAL_MS) : DESKTOP_REATTACH_INTERVAL_MS;
    timer = setTimeout(() => {
      timer = null;
      void attachOnce();
    }, delay);
  }

  function logResult(result: HelperResult): void {
    const ok = result.outcome === 'ok-24h2' || result.outcome === 'ok-classico';
    const info = { attempt, outcome: result.outcome ?? 'nessun esito', info: result.info, ...(result.stderr ? { stderr: result.stderr } : {}) };
    if (ok) {
      const changed = result.outcome !== lastOutcome;
      lastOutcome = result.outcome;
      // Info per i primi tentativi del metodo (verifica del ciclo 0/3/10/30/60 s), poi solo ai
      // cambi e una volta ogni 10 (10 min): il log resta leggibile per anni.
      if (changed || attempt <= DESKTOP_ATTACH_DELAYS_MS.length + 1 || attempt % 10 === 0) log.info('sfondo desktop: finestra agganciata dietro icone e barra', { ...info, path: result.outcome });
      else log.debug('sfondo desktop: riagganciata', info);
    } else {
      lastOutcome = result.outcome;
      log.warn('sfondo desktop: agganciamento non riuscito', info);
    }
  }

  async function attachOnce(): Promise<void> {
    if (disposed || summoned || busy || win.isDestroyed()) {
      scheduleNext();
      return;
    }
    const hwnd = nativeHandle(win);
    if (hwnd === null) {
      attempt += 1;
      log.warn('sfondo desktop: handle della finestra non disponibile');
      scheduleNext();
      return;
    }
    busy = true;
    attempt += 1;
    const { bounds, scaleFactor } = deps.display();
    const result = await run(buildAttachScript(hwnd, wallpaperMetrics(bounds, scaleFactor)));
    busy = false;
    attached = result.outcome === 'ok-24h2' || result.outcome === 'ok-classico';
    logResult(result);
    scheduleNext();
  }

  function clearTimers(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (restTimer !== null) {
      clearTimeout(restTimer);
      restTimer = null;
    }
  }

  async function summonAsync(reason: string): Promise<void> {
    const hwnd = nativeHandle(win);
    if (attached && hwnd !== null) {
      const result = await run(buildDetachScript(hwnd));
      if (result.outcome === 'ok-detach') {
        attached = false;
        log.info('summon: finestra staccata dal desktop', { reason, info: result.info });
      } else {
        // Onesto: il distacco può fallire (finestra ricreata da Chromium); il foreground si tenta comunque.
        log.warn('summon: distacco dal desktop non riuscito', { reason, outcome: result.outcome ?? 'nessun esito', info: result.info, ...(result.stderr ? { stderr: result.stderr } : {}) });
      }
    }
    if (disposed || win.isDestroyed()) return;
    try {
      const { bounds } = deps.display();
      win.setFocusable(true);
      win.setSkipTaskbar(false);
      win.setIgnoreMouseEvents(false);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setBounds(bounds);
      win.show();
      win.focus();
      log.info('summon: finestra interattiva in primo piano (Ctrl+Alt+V per rimetterla a riposo)', { reason });
    } catch (e) {
      log.warn('summon: primo piano non riuscito', { reason, err: String(e) });
    }
  }

  function summon(reason: string): boolean {
    if (disposed || summoned || win.isDestroyed()) return false;
    summoned = true;
    clearTimers();
    void summonAsync(reason);
    return true;
  }

  async function restAsync(reason: string): Promise<void> {
    try {
      const { bounds } = deps.display();
      win.setAlwaysOnTop(false);
      win.setFocusable(false);
      win.setIgnoreMouseEvents(true);
      win.setSkipTaskbar(true);
      win.setBounds(bounds);
      win.showInactive();
    } catch (e) {
      log.warn('summon: ritorno a riposo non applicato', { reason, err: String(e) });
    }
    // Riaggancio immediato: da qui il ciclo periodico riprende a proteggere lo sfondo anche se
    // Explorer si riavvia (ogni 60 s).
    await attachOnce();
    log.info('summon: ritorno a riposo dietro icone e barra', { reason, agganciata: attached });
  }

  function rest(reason: string): boolean {
    if (disposed || !summoned || win.isDestroyed()) return false;
    summoned = false;
    clearTimers();
    void restAsync(reason);
    return true;
  }

  try {
    // Al blur (l'utente passa a un'altra app) la finestra torna dietro le icone. Piccolo debounce:
    // i passaggi di focus del summon non devono farla rientrare da sola.
    win.on('blur', () => {
      if (!summoned || disposed) return;
      if (restTimer !== null) clearTimeout(restTimer);
      restTimer = setTimeout(() => {
        restTimer = null;
        if (!disposed && summoned && !win.isFocused()) rest('blur');
      }, 300);
    });
  } catch {
    /* finestra non valida: il summon resta l'unica via */
  }

  return {
    start() {
      scheduleNext();
    },
    summon,
    rest,
    toggle(reason) {
      return summoned ? rest(reason) : summon(reason);
    },
    get summoned() {
      return summoned;
    },
    dispose() {
      disposed = true;
      clearTimers();
    }
  };
}
