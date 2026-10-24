// Voce di Windows (P-103): parlato con le voci installate nel sistema (OneCore via WinRT, SAPI come
// ripiego), senza modelli da scaricare e senza componenti GPL. Un processo PowerShell persistente
// riceve una frase per riga (JSON solo ASCII) e risponde con il WAV in base64; qui il testo si spezza
// in frasi, il WAV si decodifica in PCM e si consegna a blocchi nello stesso contratto `TtsEngine`.
// Lo script passa in chiaro con `-Command` e non con `-EncodedCommand`: gli antivirus segnalano i
// comandi codificati come sospetti, e sul PC di un tester sembrerebbe un malware.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { TtsChunk, TtsEngine } from './engines.ts';

/**
 * Server di sintesi in PowerShell 5.1. Vincoli: niente virgolette doppie (passerebbero male nella
 * riga di comando), niente backtick né `${` (è un template literal di TypeScript), niente barre
 * rovesciate. Righe in uscita: `{ready,api,voices}` una volta, poi `{id,ok,voice,wav}` o `{id,ok:false,error}`.
 */
export const WINDOWS_TTS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII
$out = [Console]::Out
function Send($o) { $out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); $out.Flush() }
$winrt = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation?1' })[0].MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $winrt = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
} catch { $winrt = $null }
$sapi = $null
if (-not $winrt) { Add-Type -AssemblyName System.Speech; $sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer }
function Voices {
  if ($winrt) { return @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { @{ name = $_.DisplayName; lang = $_.Language; gender = [string]$_.Gender } }) }
  return @($sapi.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { @{ name = $_.VoiceInfo.Name; lang = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender } })
}
function Pick($want, $lang) {
  $all = Voices
  $v = $all | Where-Object { $_.name -eq $want } | Select-Object -First 1
  if (-not $v -and $lang) { $v = $all | Where-Object { $_.lang -like ($lang + '*') } | Select-Object -First 1 }
  if (-not $v) { $v = $all | Select-Object -First 1 }
  if (-not $v) { throw 'nessuna voce installata in Windows' }
  return $v
}
$api = 'sapi'
if ($winrt) { $api = 'winrt' }
Send @{ ready = $true; api = $api; voices = @(Voices) }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $v = Pick $req.voice $req.lang
    if ($winrt) {
      $winrt.Voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $v.name } | Select-Object -First 1
      $winrt.Options.SpeakingRate = [double]$req.rate
      $t = $asTask.Invoke($null, @($winrt.SynthesizeTextToStreamAsync([string]$req.text)))
      $null = $t.Wait(-1)
      $st = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($t.Result)
      $ms = New-Object System.IO.MemoryStream
      $st.CopyTo($ms); $st.Dispose()
    } else {
      $sapi.SelectVoice($v.name)
      $sapi.Rate = [int][Math]::Max(-10, [Math]::Min(10, [Math]::Round(([double]$req.rate - 1) * 10)))
      $ms = New-Object System.IO.MemoryStream
      $sapi.SetOutputToWaveStream($ms); $sapi.Speak([string]$req.text); $sapi.SetOutputToNull()
    }
    Send @{ id = $id; ok = $true; voice = $v.name; wav = [Convert]::ToBase64String($ms.ToArray()) }
    $ms.Dispose()
  } catch { Send @{ id = $id; ok = $false; error = [string]$_.Exception.Message } }
}
`;

export interface WindowsVoiceInfo {
  readonly name: string;
  readonly lang: string;
  readonly gender: string;
}

/** Il processo di sintesi visto da qui: righe in entrata e in uscita. Nei test è finto. */
export interface WindowsTtsProcess {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (reason: string) => void): void;
  kill(): void;
}

export interface WindowsTtsOptions {
  /** Nome della voce (es. «Microsoft Cosimo»); se non esiste si usa la prima voce della lingua. */
  readonly voice: string;
  /** Lingua di VISIONE (`it`, `en`): sceglie la voce di ripiego (10/10/2026, distribuzione mondiale). */
  readonly language?: string;
  /** Velocità nello stesso formato di Edge (es. `+8%`). */
  readonly rate: string;
  readonly start?: () => WindowsTtsProcess;
  readonly log?: (line: string) => void;
  /** Attesa massima dell'avvio e di ogni frase. */
  readonly timeoutMs?: number;
}

export interface WindowsTts extends TtsEngine {
  /** Avvia il processo e sintetizza una frase breve: la prima frase vera non paga l'avvio. */
  warmup(): Promise<void>;
  /** Voci installate (dopo l'avvio). */
  voices(): Promise<readonly WindowsVoiceInfo[]>;
  close(): void;
}

/** Durata della coda di silenzio dopo l'ultima frase, come Kokoro (Fase 24). */
const TAIL_MS = 220;
const MAX_SENTENCE = 400;

/** `+8%` → 1.08; `-10%` → 0.9; fuori formato → 1. Limitata a 0.5–2. */
export function rateMultiplier(rate: string): number {
  const m = /^([+-]?\d{1,3})%$/.exec(rate.trim());
  if (!m) return 1;
  return Math.min(2, Math.max(0.5, 1 + Number(m[1]) / 100));
}

/** JSON con i caratteri non ASCII scritti come `\uXXXX`: la codifica della console non li tocca. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Spezza il testo in frasi (la prima si sente prima, l'interruzione arriva tra una frase e l'altra).
 * Le frasi troppo lunghe si tagliano all'ultimo spazio prima del limite.
 */
export function splitSentences(text: string, max = MAX_SENTENCE): string[] {
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!?…;:])\s+|\n+/)) {
    let s = raw.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max);
      const at = cut > max / 2 ? cut : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (/[\p{L}\p{N}]/u.test(s)) out.push(s);
  }
  return out;
}

/** Decodifica un WAV PCM 16 bit (mono o più canali, mediati) in float32. */
export function parseWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV non valido: intestazione RIFF/WAVE assente');
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || channels < 1 || sampleRate < 8_000) {
        throw new Error(`WAV non supportato: formato ${format}, ${bits} bit, ${channels} canali, ${sampleRate} Hz`);
      }
      const end = Math.min(bytes.byteLength, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += view.getInt16(body + (i * channels + c) * 2, true);
        samples[i] = sum / channels / 32768;
      }
      return { sampleRate, samples };
    }
    at = body + size + (size % 2);
  }
  throw new Error('WAV non valido: blocco dati assente');
}

/** Il processo vero: PowerShell di sistema (percorso assoluto, non quello che capita nel PATH). */
export function startWindowsTtsProcess(log?: (line: string) => void): WindowsTtsProcess {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_TTS_SCRIPT.trim()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
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
    // PowerShell scrive l'avanzamento in CLIXML anche senza console: rumore, non errori.
    if (text && !text.startsWith('#< CLIXML') && !text.startsWith('<Objs')) log?.(`voce Windows: ${text.slice(0, 400)}`);
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

interface Pending {
  resolve(wav: Uint8Array): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createWindowsTts(opts: WindowsTtsOptions): WindowsTts {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const rate = rateMultiplier(opts.rate);
  const start = opts.start ?? (() => startWindowsTtsProcess(opts.log));
  let proc: WindowsTtsProcess | null = null;
  let ready: Promise<readonly WindowsVoiceInfo[]> | null = null;
  let resolvedVoice: string | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (reason: string): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new Error(reason));
    }
  };

  const stop = (reason: string): void => {
    const p = proc;
    proc = null;
    ready = null;
    failAll(reason);
    p?.kill();
  };

  const ensure = (): Promise<readonly WindowsVoiceInfo[]> => {
    if (ready) return ready;
    if (process.platform !== 'win32' && !opts.start) return Promise.reject(new Error('la voce di Windows esiste solo su Windows'));
    const p = start();
    proc = p;
    ready = new Promise<readonly WindowsVoiceInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`la voce di Windows non si è avviata entro ${timeoutMs} ms`));
        if (proc === p) stop('avvio scaduto');
      }, timeoutMs);
      p.onExit((reason) => {
        clearTimeout(timer);
        reject(new Error(reason));
        if (proc === p) {
          proc = null;
          ready = null;
          failAll(reason);
        }
      });
      p.onLine((line) => {
        let msg: { ready?: boolean; voices?: unknown; id?: number; ok?: boolean; voice?: string; wav?: string; error?: string };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          opts.log?.(`voce Windows: riga non valida scartata (${line.slice(0, 120)})`);
          return;
        }
        if (msg.ready) {
          clearTimeout(timer);
          const list = (Array.isArray(msg.voices) ? msg.voices : msg.voices ? [msg.voices] : []) as WindowsVoiceInfo[];
          resolve(list.filter((v) => v && typeof v.name === 'string'));
          return;
        }
        const waiting = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
        if (!waiting) return;
        pending.delete(msg.id!);
        clearTimeout(waiting.timer);
        if (msg.ok && typeof msg.wav === 'string') {
          if (msg.voice) resolvedVoice = msg.voice;
          waiting.resolve(Uint8Array.from(Buffer.from(msg.wav, 'base64')));
        } else waiting.reject(new Error(`voce Windows: ${msg.error || 'sintesi fallita senza motivo'}`));
      });
    });
    // Un avvio fallito non resta in memoria: il prossimo tentativo riparte da zero.
    ready.catch(() => undefined);
    return ready;
  };

  const request = async (text: string): Promise<Uint8Array> => {
    await ensure();
    const p = proc;
    if (!p) throw new Error('voce Windows: processo non disponibile');
    const id = nextId++;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`voce Windows: nessuna risposta entro ${timeoutMs} ms`));
        // Un processo che non risponde si butta: la prossima frase ne avvia uno nuovo.
        if (proc === p) stop('sintesi scaduta');
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      p.write(asciiJson({ id, text, voice: opts.voice, lang: opts.language ?? 'it', rate }));
    });
  };

  return {
    get name() {
      return `windows ${resolvedVoice ?? opts.voice}`;
    },
    synthesize: async (text, onChunk) => {
      const sentences = splitSentences(text);
      if (sentences.length === 0) return;
      let sampleRate = 16_000;
      // Una frase di anticipo: mentre la prima suona, la seconda è già in sintesi.
      let next: Promise<Uint8Array> | null = request(sentences[0]!);
      for (let i = 0; i < sentences.length; i++) {
        const current: Promise<Uint8Array> = next!;
        next = i + 1 < sentences.length ? request(sentences[i + 1]!) : null;
        next?.catch(() => undefined);
        const wav = parseWav(await current);
        sampleRate = wav.sampleRate;
        const chunk: TtsChunk = { kind: 'pcm', samples: wav.samples, sampleRate };
        if (!onChunk(chunk)) return;
      }
      onChunk({ kind: 'pcm', samples: new Float32Array(Math.round((sampleRate * TAIL_MS) / 1000)), sampleRate });
    },
    warmup: async () => {
      await request('Pronto.');
    },
    voices: () => ensure(),
    close: () => stop('voce Windows chiusa')
  };
}
