// Canali IPC renderer ↔ main. Accetta messaggi solo dalla pagina di VISIONE nella finestra principale.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import { IPC_CHANNELS, failure } from '../shared/contracts/index.ts';
import type { Logger } from '../shared/node/logging.ts';
import { parseUiCommand, type CommandRelay } from './command-relay.ts';
import { isBrowsableUrl, isTrustedRendererUrl, type RendererOrigin } from './security-policy.ts';
import type { CoreSupervisor } from './supervisor.ts';

export interface IpcDeps {
  window: () => BrowserWindow | null;
  origin: RendererOrigin;
  relay: CommandRelay;
  supervisor: CoreSupervisor;
  log: Logger;
  /** Riavvio dell'app: chiusura ordinata (core, voce) e riapertura. */
  relaunch: () => void;
  /** Chiusura dell'app; `shutdownPc` = spegnere il PC a chiusura completata. */
  quit: (shutdownPc: boolean) => void;
  /** Cartella degli allegati incollati dagli appunti (`%VISIONE%\allegati`). */
  attachmentsDir: string;
}

export function registerIpc(deps: IpcDeps): void {
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const win = deps.window();
    const frame = event.senderFrame;
    const ok = win !== null && event.sender === win.webContents && frame !== null && frame === win.webContents.mainFrame
      && isTrustedRendererUrl(frame.url, deps.origin);
    if (!ok) deps.log.warn('messaggio IPC da un mittente non attendibile rifiutato', { url: frame?.url ?? null });
    return ok;
  };

  ipcMain.handle(IPC_CHANNELS.command, (event, raw: unknown) => {
    if (!trusted(event)) return failure('unknown', 'unknown', 'forbidden', 'mittente non attendibile');
    const parsed = parseUiCommand(raw);
    if (!parsed.ok) return parsed.response;
    return deps.relay.relay(parsed.command);
  });

  ipcMain.handle(IPC_CHANNELS.supervisorGet, (event) => {
    if (!trusted(event)) throw new Error('mittente non attendibile');
    return deps.supervisor.snapshot();
  });

  // P-87: «SCHERMO INTERO» dell'apertura. È una proprietà della finestra, non del core: nessun
  // comando, nessun evento; stessa azione di F11 (`before-input-event` in `window.ts`).
  ipcMain.handle(IPC_CHANNELS.windowFullscreen, (event, raw: unknown) => {
    if (!trusted(event)) throw new Error('mittente non attendibile');
    const win = deps.window();
    if (win === null) return { fullscreen: false };
    const enabled = typeof raw === 'boolean' ? raw : !win.isFullScreen();
    win.setFullScreen(enabled);
    return { fullscreen: win.isFullScreen() };
  });

  // Riavvio chiesto dal proprietario dalla finestra di richiesta (impostazioni che valgono dal
  // riavvio). Nessun argomento: la pagina può solo chiedere il riavvio, non come farlo.
  ipcMain.handle(IPC_CHANNELS.appRelaunch, (event) => {
    if (!trusted(event)) throw new Error('mittente non attendibile');
    deps.log.info('riavvio di VISIONE chiesto dal proprietario');
    deps.relaunch();
    return { ok: true };
  });

  // Chiusura chiesta dal proprietario dallo Start (12/10/2026). L'unico argomento è un sì/no allo
  // spegnimento del PC: la pagina non sceglie né il comando né i suoi parametri.
  ipcMain.handle(IPC_CHANNELS.appQuit, (event, shutdownPc: unknown) => {
    if (!trusted(event)) throw new Error('mittente non attendibile');
    const off = shutdownPc === true;
    deps.log.info(off ? 'chiusura di VISIONE e spegnimento del PC chiesti dal proprietario' : 'chiusura di VISIONE chiesta dal proprietario');
    deps.quit(off);
    return { ok: true };
  });

  // Browser (12/10/2026): «Apri nel browser predefinito». Solo pagine web: mai file o programmi.
  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, url: unknown) => {
    if (!trusted(event)) throw new Error('mittente non attendibile');
    if (typeof url !== 'string' || url === 'about:blank' || !isBrowsableUrl(url)) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });
  // Allegati (12/10/2026): la finestra «Apri» di Windows. La pagina sceglie solo file o cartella; riceve
  // i percorsi che il proprietario ha scelto lui, nient'altro.
  ipcMain.handle(IPC_CHANNELS.attachPick, async (event, kind: unknown) => {
    if (!trusted(event)) throw new Error('mittente non attendibile');
    const properties: OpenDialogOptions['properties'] = kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
    const w = deps.window();
    const res = w ? await dialog.showOpenDialog(w, { properties }) : await dialog.showOpenDialog({ properties });
    return res.canceled ? [] : res.filePaths.slice(0, MAX_ATTACH);
  });
  // Appunti: file copiati in Esplora risorse (formato di Windows «FileNameW»: il primo), altrimenti
  // un'immagine (screenshot) salvata come PNG negli allegati di VISIONE.
  ipcMain.handle(IPC_CHANNELS.attachClipboard, async (event) => {
    if (!trusted(event)) throw new Error('mittente non attendibile');
    return clipboardAttachment(deps.attachmentsDir, deps.log);
  });
}

/** Al più tanti percorsi per scelta: un allegato è un riferimento da scrivere, non un elenco. */
const MAX_ATTACH = 50;

/** Formato grezzo di Windows con il percorso del file copiato in Esplora risorse (UTF-16, terminato da zero). */
const FILE_NAME_FORMAT = 'FileNameW';

/**
 * Allegato dagli appunti (API asincrona degli appunti di Electron): prima un file copiato in Esplora
 * risorse, poi un'immagine (screenshot) salvata come PNG negli allegati. [] se negli appunti c'è altro.
 */
async function clipboardAttachment(dir: string, log: Logger): Promise<string[]> {
  let items: Electron.ClipboardItem[] = [];
  try {
    items = await clipboard.read();
  } catch (err) {
    log.warn('appunti non leggibili', { err });
    return [];
  }
  for (const item of items) {
    const type = item.types.find((t) => t.includes(FILE_NAME_FORMAT));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      if (!(blob instanceof Blob)) continue;
      const text = Buffer.from(await blob.arrayBuffer()).toString('utf16le').replace(/\0[\s\S]*$/, '').trim();
      if (/^[A-Za-z]:\\|^\\\\/.test(text)) return [text];
    } catch {
      // formato annunciato ma illeggibile: si prova l'immagine
    }
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_CLIPBOARD_IMAGE) continue;
    mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'png';
    const name = `appunti-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
    const file = join(dir, name);
    writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    log.info('immagine degli appunti salvata come allegato', { file: name, bytes: blob.size });
    return [file];
  }
  return [];
}

/** Un'immagine negli appunti oltre questa dimensione non si salva (25 MB). */
const MAX_CLIPBOARD_IMAGE = 25 * 1024 * 1024;
