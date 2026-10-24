// Finestra principale: renderer isolato, sandbox, nessun Node, nessun spellchecker remoto.
// Fase 18 / P-86: con `desktop` la finestra è preparata da wallpaper (niente cornice, fuori dalla
// taskbar, non focusable) e `desktop-wallpaper.ts` la aggancia DIETRO icone e barra; il **summon**
// (Ctrl+Alt+V o wake) la stacca e la rende interattiva.
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { Logger } from '../shared/node/logging.ts';
import type { RendererOrigin } from './security-policy.ts';

export function createMainWindow(opts: { preload: string; origin: RendererOrigin; devTools: boolean; log: Logger; fullscreen?: boolean; desktop?: boolean }): BrowserWindow {
  // In modalità desktop NON si usa il fullscreen (lo porterebbe sopra taskbar e icone): la finestra è
  // a livello desktop e dimensionata allo schermo, così resta sotto barra e icone di Windows.
  const fullscreen = opts.desktop ? false : (opts.fullscreen ?? false);
  const webPreferences: Electron.WebPreferences = {
    preload: opts.preload,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    // Browser di VISIONE (12/10/2026): il tag serve; le guardie in security.ts ammettono solo il suo.
    webviewTag: true,
    spellcheck: false,
    navigateOnDragDrop: false,
    devTools: opts.devTools
  };
  const base: Electron.BrowserWindowConstructorOptions = {
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'VISIONE',
    fullscreen,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences
  };
  const make = (extra: Electron.BrowserWindowConstructorOptions): BrowserWindow => new BrowserWindow({ ...base, ...extra });
  let win: BrowserWindow;
  // Sfondo del desktop (P-86): niente cornice, niente ombra, fuori dalla taskbar, non focusable
  // finché è a riposo (il metodo la vuole non attivabile). L'aggancio a Progman/WorkerW
  // (desktop-wallpaper.ts) la mette DIETRO icone e barra; il summon la stacca e la rende
  // focusable e cliccabile. `setIgnoreMouseEvents(true)` è la cintura in più mentre è a riposo.
  const desktopOpts: Electron.BrowserWindowConstructorOptions = { skipTaskbar: true, frame: false, resizable: false, hasShadow: false, focusable: false };
  try {
    win = make(opts.desktop ? desktopOpts : {});
  } catch (err) {
    // Un tipo di finestra non supportato non deve impedire l'avvio: si ripiega su una finestra normale.
    opts.log.warn('finestra desktop non creata, uso una finestra normale', { err: String(err) });
    win = make({});
  }

  win.once('ready-to-show', () => {
    if (opts.desktop) {
      // Sfondo del desktop (P-86): copre il display primario ma NON è fullscreen, così barra e
      // icone di Windows restano sopra. A riposo non riceve i click (un figlio di Progman/WorkerW
      // non li riceve; `setIgnoreMouseEvents(true)` lo garantisce anche a livello Chromium): i
      // click vanno SEMPRE a icone/desktop. La si richiama con Ctrl+Alt+V o con la wake word.
      try {
        win.setBounds(screen.getPrimaryDisplay().bounds);
      } catch {
        // limiti/multi-monitor: resta la dimensione predefinita
      }
      win.setSkipTaskbar(true);
      win.setAlwaysOnTop(false);
      win.setIgnoreMouseEvents(true);
      win.showInactive(); // non rubare il focus all'app in primo piano
      return;
    }
    if (fullscreen) win.setFullScreen(true);
    win.show();
  });
  // F11: entra/esce dallo schermo intero (command center immersivo).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  // Diagnostica: caricamento della pagina ed errori del renderer finiscono nel log del main.
  win.webContents.on('did-finish-load', () => opts.log.info('renderer caricato', { url: win.webContents.getURL() }));
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) opts.log.error('caricamento del renderer fallito', { code, description, url });
  });
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      // Origine inclusa (P-74): senza `sourceId`/`lineNumber` un flood di errori del renderer non è
      // diagnosticabile (è successo il 04/10 con `RangeError: Invalid array length`).
      opts.log.warn('console del renderer', {
        level: details.level,
        message: details.message.slice(0, 2_000),
        source: typeof details.sourceId === 'string' && details.sourceId !== '' ? details.sourceId.slice(0, 300) : null,
        line: Number.isFinite(details.lineNumber) ? details.lineNumber : null
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    opts.log.error('renderer terminato', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });

  if (opts.origin.devServerUrl) void win.loadURL(opts.origin.devServerUrl);
  else if (opts.origin.rendererDir) void win.loadFile(join(opts.origin.rendererDir, 'index.html'));
  return win;
}
