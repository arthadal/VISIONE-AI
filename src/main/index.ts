// Electron main: supervisore leggero. Finestre, ciclo di vita, avvio e controllo del core,
// inoltro dei messaggi. Nessuna logica di dominio: quella vive nel core.
import { app, globalShortcut, screen, session, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { IPC_CHANNELS, isEvent, languageFromLocale, type VisioneEvent } from '../shared/contracts/index.ts';
import { loadConfig } from '../shared/node/config.ts';
import { createConsoleSink, createFileSink, createLogger, guardOutputStreams } from '../shared/node/logging.ts';
import { ensureDirs, pendingLegacyHome, protectedUserRoots, resolveHome, resolvePaths } from '../shared/node/paths.ts';
import { ulid } from '../shared/lib/ulid.ts';
import { createCoreLink } from './core-link.ts';
import { handleFileSchemes, registerFileSchemes } from './file-protocol-electron.ts';
import { createReminderNotifier } from './reminder-notify.ts';
import { coreEnv, createUtilityCoreFactory } from './core-process.ts';
import { createDesktopWallpaper, type DesktopWallpaperController } from './desktop-wallpaper.ts';
import { registerIpc } from './ipc.ts';
import { installAppGuards, installBrowserSession, installSessionGuards } from './security.ts';
import { BROWSER_PARTITION, type RendererOrigin } from './security-policy.ts';
import { createSpool } from './spool.ts';
import { createVoiceHost, type VoiceHost } from './voice-host.ts';
import { createMainWindow } from './window.ts';

// Primo avvio (22/10/2026, VM da «vergine»): Windows controlla un eseguibile nuovo e non firmato prima di farlo partire,
// fino a un minuto e mezzo senza nessun segno, e il tester crede che VISIONE non si apra. L'installatore lo avvia una
// volta con questa opzione mentre la sua barra è visibile (`build/installer.nsh`): il controllo avviene lì. Si esce
// prima di toccare la home, il profilo o il lock d'istanza.
if (process.argv.includes('--visione-precheck')) process.exit(0);

const packaged = app.isPackaged;
/** Edizione (P-104): l'app installata è la versione per tester (solo voce di Windows). */
const edition = packaged ? 'tester' : 'sviluppo';
const home = resolveHome(process.env, { appDataDir: app.getPath('appData'), packaged });
const paths = resolvePaths(home);
ensureDirs(paths);
// Profilo di Chromium sotto la home di VISIONE: dati deterministici e lock d'istanza per home.
app.setPath('userData', paths.chromiumDir);
app.enableSandbox();
// Notifiche di Windows (promemoria, beta.5): l'identità deve essere quella del collegamento
// creato dall'installer (appId di electron-builder.yml), altrimenti Windows non le mostra.
if (process.platform === 'win32') app.setAppUserModelId('it.matte.visione');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run(): void {
  const loaded = loadConfig(paths.configFile, { env: process.env });
  // P-97: il file sink c'è SEMPRE (anche in dev) ed è scritto per primo; il console sink è solo la
  // copia leggibile e assorbe l'EPIPE quando la console/padre non c'è più (lo scudo sui canali evita
  // il dialogo di errore Electron anche in build installata, dove il console sink non esiste).
  const fileSink = createFileSink(paths.logsDir, 'main');
  guardOutputStreams();
  const log = createLogger({
    proc: 'main',
    level: loaded.config.logging.level,
    sinks: packaged ? [fileSink] : [fileSink, createConsoleSink()]
  });
  for (const problem of loaded.problems) log.warn('configurazione: uso i default', { problem });
  log.info('avvio di VISIONE', { version: app.getVersion(), electron: process.versions.electron, home, packaged });
  const legacyHome = pendingLegacyHome(process.env, { appDataDir: app.getPath('appData'), packaged });
  if (legacyHome !== null) log.warn('migrazione home incompleta: la home storica esiste ancora (voci in uso?)', { legacyHome });
  // Avvio con Windows (Fase 24, P-71): solo build installata; reversibile dalla config. Explorer non
  // viene mai disabilitato: VISIONE convive con la shell di Windows.
  // Dall'11/10/2026 vale anche a caldo: un cambio dalle Impostazioni rilegge la configurazione.
  const applyStartWithWindows = (fresh = true): void => {
    if (!packaged) return;
    try {
      const open = fresh ? loadConfig(paths.configFile, { env: process.env }).config.ui.startWithWindows : loaded.config.ui.startWithWindows;
      app.setLoginItemSettings({ openAtLogin: open });
      log.info(open ? 'avvio con Windows attivo' : 'avvio con Windows spento');
    } catch (err) {
      log.warn('avvio con Windows non impostato', { err: String(err) });
    }
  };
  applyStartWithWindows(false);

  const origin: RendererOrigin = {
    rendererDir: packaged || !process.env.ELECTRON_RENDERER_URL ? join(__dirname, '../renderer') : null,
    devServerUrl: !packaged ? process.env.ELECTRON_RENDERER_URL ?? null : null
  };

  let win: BrowserWindow | null = null;
  // Sfondo del desktop + summon (P-86): vive finché vive la finestra; sospeso durante il summon.
  let wallpaper: DesktopWallpaperController | null = null;
  const toRenderer = (channel: string, payload: unknown): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  let voice: VoiceHost | null = null;
  // Promemoria dell'Assistente (beta.5): notifica di Windows; il clic riporta VISIONE davanti.
  const reminders = createReminderNotifier({
    onClick: () => {
      if (!win || win.isDestroyed()) return;
      if (wallpaper?.summon('promemoria')) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    warn: (msg, err) => log.warn(msg, { err })
  });
  const link = createCoreLink({
    factory: createUtilityCoreFactory({
      entry: join(__dirname, 'core.js'),
      env: coreEnv(process.env, { VISIONE_HOME: home, VISIONE_APP_VERSION: app.getVersion(), VISIONE_EDITION: edition, VISIONE_MAIN_PID: String(process.pid), VISIONE_LOCALE: app.getLocale() })
    }),
    config: loaded.config,
    appVersion: app.getVersion(),
    spool: createSpool(paths.spoolFile, log.child('spool')),
    log,
    onVoice: (msg) => {
      if (msg.type === 'control') voice?.control(msg.action);
      else voice?.send(msg);
    },
    // Il processo voce parte quando il core è pronto: prima i suoi frame andrebbero persi. A ogni
    // riavvio del core la voce riparte, così il nuovo core ne conosce di nuovo lo stato.
    onReady: () => voice?.control('restart'),
    toRenderer: {
      event: (event: VisioneEvent) => {
        // Wake word (P-81/P-86): «Hey Visione» richiama la finestra dallo sfondo del desktop.
        if (isEvent(event, 'voice.wake.detected')) wallpaper?.summon('wake word');
        if (isEvent(event, 'assistant.reminder.fired')) reminders.show(event);
        // Avvio con Windows a caldo (11/10/2026): cambiato dalle Impostazioni, vale subito.
        if (isEvent(event, 'system.config.changed') && event.payload.changed.some((p) => p === 'ui' || p.startsWith('ui.startWithWindows'))) applyStartWithWindows();
        toRenderer(IPC_CHANNELS.event, event);
      },
      state: (snapshot) => toRenderer(IPC_CHANNELS.statePush, snapshot),
      supervisor: (snapshot) => toRenderer(IPC_CHANNELS.supervisorPush, snapshot)
    }
  });
  const { supervisor: core, commands, events } = link;

  voice = createVoiceHost({
    entry: join(__dirname, 'voice.js'),
    env: coreEnv(process.env, { VISIONE_HOME: home, VISIONE_APP_VERSION: app.getVersion(), VISIONE_EDITION: edition, VISIONE_MAIN_PID: String(process.pid) }),
    config: loaded.config.voice,
    language: loaded.config.ui.language ?? languageFromLocale(app.getLocale()),
    current: () => {
      const c = loadConfig(paths.configFile, { env: process.env }).config;
      return { voice: c.voice, language: c.ui.language ?? languageFromLocale(app.getLocale()) };
    },
    edition,
    modelsDir: loaded.config.voice.modelsDir ?? join(home, 'models', 'voice'),
    // Voce VISIONE (P-110): inclusa nell'installer come risorsa; dal sorgente la si prende da `vendor/`.
    voiceDir: packaged ? join(process.resourcesPath, 'voce-visione', 'it') : join(app.getAppPath(), 'vendor', 'voce-visione', 'it'),
    profilePath: join(home, 'voice', 'owner-voice.json'),
    log: log.child('voice'),
    toCore: (msg) => link.voiceToCore(msg)
  });
  if (loaded.config.voice.enabled) log.info('voce abilitata: avvio al ready dell\'app');
  else log.info('voce disattivata nella configurazione');

  installAppGuards(log.child('security'));
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      // Una seconda istanza richiama VISIONE dallo sfondo del desktop (P-86), invece di navigare
      // silenziosamente dietro le icone.
      if (wallpaper?.summon('seconda istanza')) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let shutdownDone = false;
  let shuttingDown = false;
  let relaunching = false;
  /** Spegnere il PC quando VISIONE ha finito di chiudersi (Start → «Chiudi e spegni»). */
  let shutdownPcAfterQuit = false;
  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    wallpaper?.dispose();
    events.emit('app.shutdown', { reason: relaunching ? 'relaunch' : 'quit' });
    voice?.stop();
    globalShortcut.unregisterAll();
    void core.stop('app-quit').finally(() => {
      shutdownDone = true;
      log.info('chiusura di VISIONE completata');
      // Spegnimento chiesto insieme alla chiusura: parte solo ora, a VISIONE chiusa in ordine.
      if (shutdownPcAfterQuit) powerOffPc(log);
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());

  // Anteprime dell'Esplora (11/10/2026): schemi registrati prima di ready, gestiti sulla sessione.
  registerFileSchemes();
  void app.whenReady().then(() => {
    installSessionGuards(session.defaultSession, origin, log.child('security'));
    installBrowserSession(session.fromPartition(BROWSER_PARTITION), log.child('browser'));
    const userHome = process.env.USERPROFILE ?? app.getPath('home');
    handleFileSchemes(session.defaultSession, { home: userHome, visionHome: paths.home, protectedRoots: protectedUserRoots(userHome) }, log.child('anteprime'));
    registerIpc({
      window: () => win, origin, relay: commands, supervisor: core, log: log.child('ipc'),
      // Riavvio chiesto dal proprietario: la riapertura parte quando questa istanza ha chiuso tutto.
      relaunch: () => {
        if (relaunching) return;
        relaunching = true;
        app.relaunch();
        app.quit();
      },
      attachmentsDir: join(paths.home, 'allegati'),
      quit: (shutdownPc) => {
        if (shutdownPc) shutdownPcAfterQuit = true;
        app.quit();
      }
    });
    win = createMainWindow({
      preload: join(__dirname, '../preload/index.js'),
      origin,
      devTools: !packaged,
      fullscreen: loaded.config.ui.fullscreen,
      desktop: loaded.config.ui.desktop,
      log: log.child('window')
    });
    win.on('closed', () => {
      wallpaper?.dispose();
      wallpaper = null;
      win = null;
    });
    // La porta audio va trasferita a ogni caricamento del renderer (anche dopo un reload).
    win.webContents.on('did-finish-load', () => {
      if (win) voice?.attach(win.webContents);
    });
    // Fix Fase 24: il processo voce va avviato QUI (dopo `app ready`: utilityProcess non può
    // nascere prima). Senza questa chiamata l'host restava spento e la voce non esisteva nell'app.
    if (loaded.config.voice.enabled) voice?.start();
    // Sfondo del desktop (P-86): dal ready-to-show la finestra viene agganciata a Progman/WorkerW
    // (dietro icone e barra) e il ciclo ritenta a 3/10/30 s e poi ogni 60 s. Ctrl+Alt+V o la wake
    // word la richiamano interattiva; al blur torna a riposo. Tutto reversibile.
    if (loaded.config.ui.desktop) {
      wallpaper = createDesktopWallpaper(win, log.child('desktop'), {
        display: () => {
          const primary = screen.getPrimaryDisplay();
          return { bounds: primary.bounds, scaleFactor: primary.scaleFactor };
        }
      });
      const controller = wallpaper;
      const startWallpaper = (): void => controller.start();
      if (win.isVisible()) startWallpaper();
      else win.once('ready-to-show', startWallpaper);
      const summonShortcut = 'Control+Alt+V';
      if (!globalShortcut.register(summonShortcut, () => controller.toggle(`scorciatoia ${summonShortcut}`))) {
        log.warn('summon: scorciatoia non registrata (resta la wake word)', { shortcut: summonShortcut });
      } else {
        log.info('summon: scorciatoia registrata', { shortcut: summonShortcut });
      }
    }
    events.emit('app.started', { appVersion: app.getVersion(), electronVersion: process.versions.electron, pid: process.pid });
    if (loaded.config.voice.enabled && !globalShortcut.register(loaded.config.voice.pttShortcut, () => {
      const ts = Date.now();
      const id = ulid(ts);
      void commands.relay({ id, type: 'voice.ptt', ts, correlationId: id, issuedBy: 'ui', payload: { action: 'toggle', source: 'shortcut' } });
    })) {
      log.warn('scorciatoia del push-to-talk non registrata', { shortcut: loaded.config.voice.pttShortcut });
    }
    // La voce parte da `onReady` del core, non qui: prima i suoi frame andrebbero persi.
    core.start();
  });
}

/**
 * Spegnimento del PC a VISIONE chiusa (12/10/2026): `shutdown.exe` di Windows, staccato dal processo
 * che sta per uscire. Un errore si registra e basta: VISIONE è già chiusa, il PC resta acceso.
 */
function powerOffPc(log: { info(msg: string): void; error(msg: string, data?: Record<string, unknown>): void }): void {
  try {
    const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'shutdown.exe');
    spawn(exe, ['/s', '/t', '0'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log.info('spegnimento del PC avviato');
  } catch (err) {
    log.error('spegnimento del PC non avviato', { err });
  }
}
