// Voce Edge Read Aloud (P-84): websocket al servizio che usa Microsoft Edge (nessuna chiave, nessun
// pacchetto in più), con la voce italiana richiesta dal proprietario (default `it-IT-DiegoNeural`).
// Approccio ripreso e adattato dalla reference del vecchio JARVIS (`bridge/edge-tts.mjs`, sola
// lettura): stesso protocollo — un messaggio `speech.config`, uno SSML, frame binari con intestazione
// a lunghezza (2 byte) e audio MP3 fino a `turn.end` — con in più il client WebSocket proprio
// (`ws.ts`, nessuna dipendenza) perché il servizio rifiuta l'handshake senza header browser.
//
// Il testo passa dai server Microsoft (servizio non documentato): uso personale non commerciale
// (P-82/P-84). Se Edge non è raggiungibile, la frase passa a Kokoro (fallback locale) con un evento
// onesto (`tts-fallback`), mai in silenzio. L'audio arriva al renderer come MP3 e lì è decodificato
// con Web Audio: nessun file su disco.
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TtsChunk, TtsEngine } from './engines.ts';
import { Mp3Framer } from './mp3.ts';
import { connectWebSocket, type WsHandlers, type WsSocket } from './ws.ts';

export const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_VOICE_DEFAULT = 'it-IT-DiegoNeural';
export const EDGE_URL_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const FALLBACK_COOLDOWN_MS = 30_000;
/** Versione di presentazione se Edge non è installato nella cartella nota. */
const EDGE_VERSION_FALLBACK = '154.0.4258.53';

/**
 * Impronta richiesta dal servizio dal 2024: SHA-256 dei tick di Windows (arrotondati a 5 minuti,
 * epoca 1601) seguiti dal token pubblico di Edge. Pura e deterministica: testata con valori fissi.
 */
export function secMsGec(atMs: number, token = EDGE_TOKEN): string {
  let ticks = Math.floor(atMs / 1000) + 11644473600;
  ticks -= ticks % 300;
  return createHash('sha256').update(`${BigInt(ticks) * 10000000n}${token}`, 'ascii').digest('hex').toUpperCase();
}

/** La versione di Edge installata (quella con cui il servizio vuole essere contattato), o il fallback. */
export function detectEdgeVersion(): string {
  const env = process.env.VISIONE_EDGE_VERSION;
  if (env && /^\d+\.\d+\.\d+\.\d+$/.test(env)) return env;
  const dir = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application');
  try {
    const versions = readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
    versions.sort((a, b) => {
      const x = a.split('.').map(Number);
      const y = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
      return 0;
    });
    if (versions[0]) return versions[0];
  } catch {
    /* Edge non installato qui: si usa la versione nota */
  }
  return EDGE_VERSION_FALLBACK;
}

/** Header browser dell'upgrade: senza `Origin` e `User-Agent` il servizio risponde 403 (misurato). */
export function edgeHeaders(chromium: string): Record<string, string> {
  const major = chromium.split('.')[0] ?? '154';
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent':
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`
  };
}

/** URL del websocket con token pubblico, ConnectionId e impronta GEC. */
export function buildEdgeUrl(opts: { chromium: string; connectionId: string; gec: string; endpoint?: string }): string {
  const base = opts.endpoint ?? EDGE_URL_BASE;
  return (
    `${base}?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${opts.connectionId}` +
    `&Sec-MS-GEC=${opts.gec}&Sec-MS-GEC-Version=1-${opts.chromium}`
  );
}

/** Primo messaggio: configurazione della sintesi (MP3 24 kHz, nessun confine di parola). */
export function buildConfigMessage(): string {
  return (
    `X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: OUTPUT_FORMAT
          }
        }
      }
    })
  );
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** SSML della frase, nella voce e con la prosodia configurate. */
export function buildSsml(opts: { text: string; voice: string; rate: string; pitch: string }): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='it-IT'>` +
    `<voice name='${opts.voice}'><prosody pitch='${opts.pitch}' rate='${opts.rate}' volume='+0%'>` +
    `${escapeXml(opts.text)}</prosody></voice></speak>`
  );
}

/** Messaggio `Path:ssml` con l'SSML dentro (l'intestazione è obbligatoria nel protocollo Edge). */
export function buildSsmlMessage(requestId: string, ssml: string): string {
  return (
    `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${ssml}`
  );
}

export interface EdgeAudioFrame {
  readonly path: string;
  readonly audio: Uint8Array;
}

/**
 * Frame binario del servizio: 2 byte di lunghezza intestazione (big endian), intestazione testuale,
 * poi i byte audio. Ritorna null per frame troppo corti o troncati (robustezza, mai un crash).
 */
export function parseAudioFrame(frame: Uint8Array): EdgeAudioFrame | null {
  if (frame.length < 2) return null;
  const headerLength = (frame[0]! << 8) | frame[1]!;
  if (headerLength === 0 || 2 + headerLength > frame.length) return null;
  const header = new TextDecoder().decode(frame.subarray(2, 2 + headerLength));
  const path = /\r\nPath:([^\r\n]+)/.exec(`\r\n${header}`)?.[1] ?? '';
  return { path, audio: frame.subarray(2 + headerLength) };
}

export interface EdgeTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export type EdgeConnect = (url: string, headers: Record<string, string>, handlers: WsHandlers) => WsSocket;

export interface EdgeTtsOptions {
  readonly voice: string;
  readonly rate: string;
  readonly pitch: string;
  /** Ripiego locale (Kokoro): usato SOLO se Edge fallisce prima di aver prodotto audio. */
  readonly fallback?: TtsEngine;
  /** Notifica onesta del passaggio al ripiego (una per frase fallita). */
  readonly onFallback?: (reason: string) => void;
  readonly log?: (line: string) => void;
  /** Base del websocket (solo per i test: default il servizio reale). */
  readonly endpoint?: string;
  readonly now?: () => number;
  readonly timers?: EdgeTimers;
  readonly timeoutMs?: number;
  readonly connect?: EdgeConnect;
  readonly version?: () => string;
}

const errorText = (err: unknown): string => {
  const raw = err instanceof Error ? `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}` : String(err);
  const text = raw.trim();
  return text.length > 0 ? text.slice(0, 300) : 'errore senza dettaglio';
};

/**
 * Un giro di sintesi Edge. Risolve con `delivered:false` se il servizio ha chiuso senza produrre
 * audio; lancia su errori di rete/protocollo. `onChunk` che ritorna false annulla la connessione.
 */
function speakEdge(
  text: string,
  opts: EdgeTtsOptions,
  onChunk: (chunk: TtsChunk) => boolean
): Promise<{ delivered: boolean }> {
  const now = opts.now ?? Date.now;
  const timers: EdgeTimers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const connect = opts.connect ?? connectWebSocket;
  const version = (opts.version ?? detectEdgeVersion)();
  const id = randomUUID().replace(/-/g, '');
  const url = buildEdgeUrl({ chromium: version, connectionId: id, gec: secMsGec(now()), ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });

  return new Promise<{ delivered: boolean }>((resolve, reject) => {
    let finished = false;
    let delivered = false;
    let bytes = 0;
    const framer = new Mp3Framer();
    let ws: WsSocket | null = null;

    const end = (err?: Error): void => {
      if (finished) return;
      finished = true;
      timers.clear(timer);
      const tail = framer.flush();
      if (tail !== null && tail.length > 0) {
        delivered = true;
        onChunk({ kind: 'mp3', bytes: tail });
      }
      try {
        ws?.close();
      } catch {
        /* già chiusa */
      }
      if (err) {
        (err as Error & { delivered?: boolean }).delivered ??= delivered || bytes > 0;
        reject(err);
      } else resolve({ delivered });
    };

    const timeoutMs = opts.timeoutMs ?? 15_000;
    const timer = timers.set(() => {
      try {
        ws?.terminate();
      } catch {
        /* già chiusa */
      }
      end(new Error(`nessuna risposta in ${timeoutMs} ms`));
    }, timeoutMs);

    try {
      ws = connect(url, edgeHeaders(version), {
        open: () => {
          ws?.send(buildConfigMessage());
          ws?.send(buildSsmlMessage(id, buildSsml({ text, voice: opts.voice, rate: opts.rate, pitch: opts.pitch })));
        },
        message: (data) => {
          if (typeof data === 'string') {
            if (data.includes('Path:turn.end')) end();
            return;
          }
          const frame = parseAudioFrame(data);
          if (frame === null || frame.path !== 'audio' || frame.audio.length === 0) return;
          bytes += frame.audio.length;
          for (const chunk of framer.feed(frame.audio)) {
            delivered = true;
            if (!onChunk({ kind: 'mp3', bytes: chunk })) {
              end();
              return;
            }
          }
        },
        error: (err) => end(err),
        close: () => end(bytes > 0 ? undefined : new Error('collegamento chiuso senza audio'))
      });
    } catch (err) {
      end(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export interface TtsProviderConfig {
  readonly provider: 'kokoro' | 'edge';
  readonly voice: string;
  readonly rate: string;
  readonly pitch: string;
}

export interface TtsProviderDeps {
  readonly onFallback?: (reason: string) => void;
  readonly log?: (line: string) => void;
  /** Iniezioni per i test (connessione, orologio…): in produzione non serve nessuna. */
  readonly edge?: Omit<EdgeTtsOptions, 'voice' | 'rate' | 'pitch' | 'fallback' | 'onFallback' | 'log'>;
}

/**
 * Selezione del provider TTS (P-84): con `kokoro` si usa il motore locale così com'è; con `edge` lo
 * si avvolge con il ripiego Kokoro. In entrambi i casi il riscaldamento carica il modello Kokoro.
 */
export function createTtsForProvider(
  config: TtsProviderConfig,
  kokoro: TtsEngine,
  deps: TtsProviderDeps = {}
): { tts: TtsEngine; warmup: () => Promise<void> } {
  const warmup = async (): Promise<void> => {
    await kokoro.synthesize('a', () => true);
  };
  if (config.provider !== 'edge') return { tts: kokoro, warmup };
  return {
    tts: createEdgeTts({
      ...deps.edge,
      voice: config.voice,
      rate: config.rate,
      pitch: config.pitch,
      fallback: kokoro,
      ...(deps.onFallback ? { onFallback: deps.onFallback } : {}),
      ...(deps.log ? { log: deps.log } : {})
    }),
    warmup
  };
}

/**
 * Motore TTS con Edge come voce primaria e Kokoro come ripiego locale: se Edge fallisce prima di
 * produrre audio (rete assente, 403, protocollo cambiato, nessun audio) la frase è pronunciata da
 * Kokoro e il fatto viene notificato; dopo un fallimento si evita di ritentare Edge per 30 s.
 */
export function createEdgeTts(opts: EdgeTtsOptions): TtsEngine {
  const now = opts.now ?? Date.now;
  let downUntil = 0;

  const runFallback = async (reason: string, text: string, onChunk: (chunk: TtsChunk) => boolean): Promise<void> => {
    const fallback = opts.fallback;
    if (!fallback) throw new Error(`voce Edge non disponibile: ${reason}`);
    opts.log?.(`voce Edge non disponibile (${reason}): riproduco con ${fallback.name}`);
    opts.onFallback?.(reason);
    try {
      await fallback.synthesize(text, onChunk);
    } catch (err) {
      throw new Error(`voce Edge non disponibile (${reason}) e ripiego ${fallback.name} fallito: ${errorText(err)}`);
    }
  };

  return {
    name: `edge ${opts.voice}${opts.fallback ? ' + kokoro' : ''}`,
    async synthesize(text, onChunk) {
      if (now() < downUntil) {
        await runFallback('voce Edge non raggiungibile da poco', text, onChunk);
        return;
      }
      try {
        const result = await speakEdge(text, opts, onChunk);
        if (!result.delivered) throw new Error('nessun audio ricevuto');
      } catch (err) {
        const reason = errorText(err);
        if ((err as { delivered?: boolean }).delivered === true) {
          throw new Error(`voce Edge interrotta dopo l'inizio: ${reason}`);
        }
        downUntil = now() + FALLBACK_COOLDOWN_MS;
        await runFallback(reason, text, onChunk);
      }
    }
  };
}
