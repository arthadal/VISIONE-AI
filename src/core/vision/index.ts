// Volto nella webcam per il widget Umanoide (11/10/2026): il rilevatore di volti di Windows
// (Windows.Media.FaceAnalysis, già nel sistema: niente da scaricare) in un PowerShell persistente del
// core, acceso al primo fotogramma e spento dopo un minuto senza fotogrammi (webcam spenta). Il
// fotogramma arriva già ridotto e in grigio dal widget, si usa e si butta: niente disco, niente rete.
// Lo script passa in chiaro con `-Command` (come la voce di Windows, P-103): i comandi codificati
// sembrerebbero malware agli antivirus.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { CommandResult } from '../../shared/contracts/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';

/**
 * Server dei volti in PowerShell 5.1. Vincoli (template literal di TypeScript passato in riga di
 * comando): niente virgolette doppie, backtick, `${` né barre rovesciate. Righe in uscita: `{ready}`
 * una volta (o `{ready:false,error}`), poi `{id,ok,faces:[x,y,w,h,...]}` o `{id,ok:false,error}`.
 */
export const FACE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII
$out = [Console]::Out
function Send($o) { $out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); $out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.FaceAnalysis.FaceDetector, Windows.Media.FaceAnalysis, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
  if (-not [Windows.Media.FaceAnalysis.FaceDetector]::IsSupported) { throw 'rilevatore di volti non supportato da questo Windows' }
  $t = $asTask.MakeGenericMethod([Windows.Media.FaceAnalysis.FaceDetector]).Invoke($null, @([Windows.Media.FaceAnalysis.FaceDetector]::CreateAsync()))
  $null = $t.Wait(-1)
  $det = $t.Result
  $detect = $asTask.MakeGenericMethod([System.Collections.Generic.IList[Windows.Media.FaceAnalysis.DetectedFace]])
} catch {
  Send @{ ready = $false; error = [string]$_.Exception.Message }
  exit 1
}
Send @{ ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $w = [int]$req.w
    $h = [int]$req.h
    $bytes = [Convert]::FromBase64String([string]$req.gray)
    if ($bytes.Length -ne ($w * $h)) { throw 'fotogramma di dimensioni non valide' }
    $bmp = New-Object Windows.Graphics.Imaging.SoftwareBitmap ([Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8), $w, $h
    $bmp.CopyFromBuffer([System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes))
    $t = $detect.Invoke($null, @($det.DetectFacesAsync($bmp)))
    $null = $t.Wait(-1)
    $faces = @()
    foreach ($f in $t.Result) { $faces += $f.FaceBox.X, $f.FaceBox.Y, $f.FaceBox.Width, $f.FaceBox.Height }
    $bmp.Dispose()
    Send @{ id = $id; ok = $true; faces = $faces }
  } catch {
    Send @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}
`;

/** Processo a righe (il PowerShell vero o un finto nei test). */
export interface LineProcess {
  write(line: string): void;
  onLine(h: (line: string) => void): void;
  onExit(h: (reason: string) => void): void;
  kill(): void;
}

export function startFaceProcess(log?: (line: string) => void): LineProcess {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', FACE_SCRIPT.trim()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  const lineHandlers: Array<(line: string) => void> = [];
  const exitHandlers: Array<(reason: string) => void> = [];
  child.stdout.setEncoding('ascii');
  child.stdout.on('data', (data: string) => {
    buffer += data;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) for (const h of lineHandlers) h(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    const text = data.trim();
    if (text && !text.startsWith('#< CLIXML') && !text.startsWith('<Objs')) log?.(`volti Windows: ${text.slice(0, 400)}`);
  });
  let exited = false;
  const exit = (reason: string): void => {
    if (exited) return;
    exited = true;
    for (const h of exitHandlers) h(reason);
  };
  child.on('error', (err) => exit(`avvio di PowerShell fallito: ${err.message}`));
  child.on('exit', (code, signal) => exit(`PowerShell terminato (${signal ?? `codice ${code}`})`));
  child.stdin.on('error', () => undefined);
  return {
    write: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (h) => lineHandlers.push(h),
    onExit: (h) => exitHandlers.push(h),
    kill: () => {
      child.stdin.end();
      child.kill();
    }
  };
}

export type FaceResult = CommandResult<'vision.face'>;

export interface FaceService {
  detect(width: number, height: number, gray: string): Promise<FaceResult>;
  close(): void;
}

/** Riga del server → volti (gruppi di quattro numeri finiti, al più cinque volti). */
export function parseFaces(raw: unknown): FaceResult['faces'] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'number' ? [raw] : [];
  const out: FaceResult['faces'] = [];
  for (let i = 0; i + 3 < list.length && out.length < 5; i += 4) {
    const [x, y, w, h] = list.slice(i, i + 4).map(Number);
    if ([x, y, w, h].every((v) => Number.isFinite(v)) && (w as number) >= 0 && (h as number) >= 0) out.push({ x: x as number, y: y as number, w: w as number, h: h as number });
  }
  return out;
}

export interface FaceServiceOptions {
  start?: () => LineProcess;
  now?: () => number;
  /** Spegnimento del PowerShell dopo questo tempo senza fotogrammi (ms). */
  idleMs?: number;
  /** Attesa massima di una risposta (ms). */
  timeoutMs?: number;
  /** Attesa massima del «pronto» del PowerShell (ms): oltre, si chiude e si riprova al fotogramma dopo. */
  startMs?: number;
  log?: (line: string) => void;
}

export function createFaceService(opts: FaceServiceOptions = {}): FaceService {
  const start = opts.start ?? (() => startFaceProcess(opts.log));
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const startMs = opts.startMs ?? 8_000;
  let proc: LineProcess | null = null;
  let ready: Promise<void> | null = null;
  // Dopo un «non supportato» non si riprova a ogni fotogramma: il widget passa al movimento.
  let unsupported: string | null = null;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, { resolve(r: FaceResult): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; started: number }>();

  const stop = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const p = proc;
    proc = null;
    ready = null;
    p?.kill();
  };
  const failAll = (reason: string): void => {
    for (const [id, w] of pending) {
      clearTimeout(w.timer);
      pending.delete(id);
      w.reject(new CommandFailure('operation_failed', reason));
    }
  };
  const ensure = (): Promise<void> => {
    if (ready) return ready;
    const p = start();
    proc = p;
    ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      // Collaudo dell'11/10/2026: un PowerShell avviato insieme all'app è rimasto fermo prima del
      // «pronto». Senza questo limite ogni fotogramma aspetterebbe per sempre lo stesso processo.
      const startTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new CommandFailure('timeout', 'il rilevatore di volti non si è avviato in tempo'));
        if (proc === p) stop();
      }, startMs);
      (startTimer as { unref?: () => void }).unref?.();
      p.onLine((line) => {
        let msg: { ready?: boolean; error?: string; id?: number; ok?: boolean; faces?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return;
        }
        if (msg === null || typeof msg !== 'object') return;
        if (msg.ready !== undefined && !settled) {
          settled = true;
          clearTimeout(startTimer);
          if (msg.ready) resolve();
          else {
            unsupported = String(msg.error ?? 'rilevatore di volti non disponibile').slice(0, 300);
            reject(new CommandFailure('operation_failed', unsupported));
          }
          return;
        }
        const w = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
        if (!w || msg.id === undefined) return;
        clearTimeout(w.timer);
        pending.delete(msg.id);
        if (msg.ok) w.resolve({ faces: parseFaces(msg.faces), ms: Math.max(0, now() - w.started) });
        else w.reject(new CommandFailure('operation_failed', String(msg.error ?? 'rilevamento fallito').slice(0, 300)));
      });
      p.onExit((reason) => {
        if (proc === p) {
          proc = null;
          ready = null;
        }
        if (!settled) {
          settled = true;
          clearTimeout(startTimer);
          reject(new CommandFailure('operation_failed', reason));
        }
        failAll(reason);
      });
    });
    return ready;
  };

  return {
    async detect(width, height, gray) {
      if (unsupported) throw new CommandFailure('operation_failed', unsupported);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(stop, idleMs);
      (idleTimer as { unref?: () => void }).unref?.();
      await ensure();
      const p = proc;
      if (!p) throw new CommandFailure('operation_failed', 'rilevatore di volti non avviato');
      const id = nextId++;
      return new Promise<FaceResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CommandFailure('timeout', 'il rilevatore di volti non ha risposto in tempo'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, started: now() });
        p.write(JSON.stringify({ id, w: width, h: height, gray }));
      });
    },
    close: stop
  };
}

export function registerVisionCommands(router: CommandRouter, faces: FaceService): void {
  router.register('vision.face', (payload) => {
    const bytes = Math.floor((payload.gray.length * 3) / 4) - (payload.gray.endsWith('==') ? 2 : payload.gray.endsWith('=') ? 1 : 0);
    if (bytes !== payload.width * payload.height) throw new CommandFailure('invalid_payload', 'il fotogramma non corrisponde a larghezza × altezza');
    return faces.detect(payload.width, payload.height, payload.gray);
  });
}
