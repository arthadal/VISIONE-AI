// Trasporto del motore integrato (piano MOTORE_INTEGRATO_PIANO §5, P-107w): una richiesta chat-completions in
// streaming verso un profilo compatibile OpenAI, con tempi, ritentativi e annullamento. Restituisce il campo
// `data` di ogni evento SSE (fino a `[DONE]`, escluso); i delta li ricompone `sse.ts`.
//
// Remoto (`keepalive: 'h2-ping'`): `node:http2`, una sessione per origine condivisa fra le richieste, PING ogni
// 15 s SOLO finché c'è almeno una richiesta aperta (su questa macchina una connessione muta per ~38 s viene
// tagliata), chiusura dopo 60 s senza richieste. Se il server non negozia h2 (ALPN), ripiego su `node:https` con
// `setKeepAlive`. Locale (`keepalive: 'none'`, Ollama su 127.0.0.1): `fetch` nativo.
//
// Il codice gira DENTRO il core: un evento `error` senza ascoltatore lo farebbe cadere. Ogni sessione, socket,
// stream e richiesta ha il suo ascoltatore `error` (e `goaway` sulle sessioni).
//
// La chiave: la chiede `getKey()` al momento della richiesta, va SOLO nell'intestazione `authorization` e solo
// verso l'host del profilo (mai seguendo un reindirizzamento); messaggi d'errore e righe di log passano da
// `scrubSecret` (valore esatto + forme note di segreto).
import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { connect as http2Connect, constants as H2, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { RuntimeErrorCode } from '../../../shared/contracts/index.ts';
import { REDACTED, redactString } from '../../../shared/lib/redact.ts';
import { AdapterError } from '../errors.ts';
import { SseParser, isDone } from './sse.ts';

/** Un fornitore compatibile OpenAI. Il piano diceva `apiKeyEnv`: con P-107w la chiave non viene dall'ambiente. */
export interface ProviderProfile {
  id: string;
  /** Es. `https://integrate.api.nvidia.com/v1`, `http://127.0.0.1:11434/v1`. */
  baseURL: string;
  /** Il profilo richiede una chiave: senza, la richiesta non parte. */
  needsKey: boolean;
  keepalive: 'h2-ping' | 'none';
  maxRpm?: number;
}

export interface ChatStreamRequest {
  profile: ProviderProfile;
  /** Corpo chat-completions (con `stream: true`); serializzato una volta sola. */
  body: unknown;
  signal: AbortSignal;
  /** Silenzio massimo dall'invio al primo byte del corpo. */
  firstByteMs: number;
  /** Silenzio massimo fra due blocchi, dopo il primo. */
  idleMs: number;
  /** Chiesta al momento della richiesta, mai prima e mai conservata. */
  getKey?: () => string | null;
  /** Percorso relativo al `baseURL` (predefinito `/chat/completions`). */
  path?: string;
}

export interface ChatTransport {
  stream(req: ChatStreamRequest): AsyncIterable<string>;
  /** Chiude subito sessioni e connessioni tenute aperte. */
  close(): void;
}

export const CONNECT_TIMEOUT_MS = 10_000;
export const FIRST_BYTE_TIMEOUT_MS = 120_000;
export const IDLE_TIMEOUT_MS = 90_000;
export const PING_INTERVAL_MS = 15_000;
export const SESSION_IDLE_MS = 60_000;
export const RESET_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];
export const MAX_STATUS_RETRIES = 3;
/** Oltre questa attesa chiesta dal server (`Retry-After`) non si aspetta: si riporta l'errore. */
export const MAX_RETRY_AFTER_MS = 60_000;
const H1_KEEPALIVE_MS = 10_000;
const RETRY_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const ERROR_BODY_MAX = 4_096;
const DEFAULT_PATH = '/chat/completions';

type H1Request = (url: URL, options: RequestOptions) => ClientRequest;

export interface TransportOptions {
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  sessionIdleMs?: number;
  resetRetryDelaysMs?: readonly number[];
  maxStatusRetries?: number;
  maxRetryAfterMs?: number;
  /** Attesa fra i tentativi; rifiuta se `signal` viene annullato. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Diagnostica: righe già redatte. */
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Apre la sessione h2 dell'origine, o dice che il server parla solo HTTP/1.1 (prove: h2c in chiaro). */
  connectH2?: (url: URL, timeoutMs: number) => Promise<ClientHttp2Session | 'http/1.1'>;
  /** Richiesta HTTP/1.1 del ripiego (prove: `node:http` verso il server finto). */
  h1Request?: H1Request;
}

/** Errore del trasporto: `error.code` come ogni adapter, più lo stato HTTP e se il flusso era già partito. */
export class TransportError extends AdapterError {
  readonly status: number | null;
  /** Qualcosa era già stato consegnato al chiamante: ripetere la richiesta tocca a lui (il ciclo, F3). */
  readonly afterFirstByte: boolean;
  constructor(code: RuntimeErrorCode, message: string, details: { retryable: boolean; status?: number | null; afterFirstByte?: boolean }) {
    super({ code, message: message.slice(0, 500), retryable: details.retryable });
    this.name = 'TransportError';
    this.status = details.status ?? null;
    this.afterFirstByte = details.afterFirstByte ?? false;
  }
}

/** Stato HTTP da ritentare: interno, non esce mai dal trasporto. */
class RetryableStatus extends Error {
  readonly status: number;
  readonly waitMs: number | null;
  constructor(status: number, waitMs: number | null, detail: string) {
    super(detail);
    this.status = status;
    this.waitMs = waitMs;
  }
}

/** Toglie il valore esatto della chiave e le forme note di segreto. */
export function scrubSecret(text: string, key: string | null): string {
  const exact = key !== null && key.length >= 4 ? text.split(key).join(REDACTED) : text;
  return redactString(exact);
}

export function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** `Retry-After` in secondi o come data HTTP → millisecondi; null se assente o illeggibile. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1_000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** URL della richiesta: il percorso si aggiunge al `baseURL` (che finisce spesso con `/v1`). */
export function chatUrl(profile: ProviderProfile, path = DEFAULT_PATH): URL {
  try {
    const base = new URL(profile.baseURL);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('protocollo');
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return new URL(path);
    return new URL(`${profile.baseURL.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`);
  } catch {
    throw new TransportError('engine_error', `${profile.id}: indirizzo del profilo non valido`, { retryable: false });
  }
}

/** La chiave va solo all'host (e al protocollo) del profilo, e in chiaro solo verso la macchina stessa. */
export function assertKeyDestination(profile: ProviderProfile, url: URL): void {
  const base = new URL(profile.baseURL);
  if (url.host !== base.host || url.protocol !== base.protocol) {
    throw new TransportError('policy_denied', `${profile.id}: la chiave va solo a ${base.host}, non a ${url.host}`, { retryable: false });
  }
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new TransportError('policy_denied', `${profile.id}: la chiave non viaggia in chiaro verso ${url.host}`, { retryable: false });
  }
}

const cancelled = (): TransportError => new TransportError('cancelled', 'richiesta annullata', { retryable: false });

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && !err.message.includes(code) ? `${code} ${err.message}` : err.message;
  }
  return String(err);
}

const firstValue = (v: string | string[] | number | undefined): string | undefined => (Array.isArray(v) ? v[0] : v === undefined ? undefined : String(v));

/** Coda asincrona dei pezzi del corpo, alimentata dagli eventi del socket. */
class Channel<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private closed = false;
  private failure: { error: unknown } | null = null;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = { error };
    for (const w of this.waiters.splice(0)) w.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.failure) return Promise.reject(this.failure.error);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

/** Una risposta aperta, qualunque sia la via (h2, HTTP/1.1, fetch). */
interface Wire {
  readonly status: number;
  header(name: string): string | undefined;
  readonly body: Channel<Uint8Array>;
  /** Chiude subito lo stream; idempotente. */
  close(): void;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

/** Apertura predefinita: TLS con ALPN (h2 o ripiego), oppure h2c in chiaro per i server sulla macchina stessa. */
function defaultConnectH2(url: URL, timeoutMs: number): Promise<ClientHttp2Session | 'http/1.1'> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Gli ascoltatori `error` qui sotto restano attaccati anche dopo: un errore tardivo non resta mai senza.
    if (url.protocol === 'http:') {
      if (!isLoopback(url.hostname)) {
        reject(new Error(`HTTP/2 in chiaro solo verso la macchina stessa, non ${url.host}`));
        return;
      }
      const session = http2Connect(url.origin);
      session.on('error', (err) => settle(() => reject(err)));
      timer = setTimeout(() => settle(() => {
        session.destroy();
        reject(new Error(`connessione oltre ${timeoutMs} ms`));
      }), timeoutMs);
      session.once('connect', () => settle(() => resolve(session)));
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const socket = tlsConnect({ host, port: Number(url.port || 443), servername: isIP(host) === 0 ? host : undefined, ALPNProtocols: ['h2', 'http/1.1'] });
    socket.on('error', (err) => settle(() => reject(err)));
    timer = setTimeout(() => settle(() => {
      socket.destroy();
      reject(new Error(`connessione oltre ${timeoutMs} ms`));
    }), timeoutMs);
    socket.once('secureConnect', () => settle(() => {
      if (socket.alpnProtocol !== 'h2') {
        socket.destroy();
        resolve('http/1.1');
        return;
      }
      const session = http2Connect(url.origin, { createConnection: () => socket });
      session.on('error', () => undefined); // il pool attacca il suo subito dopo; questo copre l'intervallo
      resolve(session);
    }));
  });
}

interface H2Entry {
  readonly origin: string;
  readonly session: ClientHttp2Session;
  open: number;
  ping: ReturnType<typeof setInterval> | null;
  idle: ReturnType<typeof setTimeout> | null;
  pooled: boolean;
}

/** Una sessione h2 per origine; PING solo a richiesta aperta; chiusura dopo l'inattività. */
class H2Pool {
  private readonly entries = new Map<string, H2Entry>();
  private readonly connecting = new Map<string, Promise<H2Entry | 'http/1.1'>>();
  private readonly h1Origins = new Set<string>();
  private readonly connect: (url: URL, timeoutMs: number) => Promise<ClientHttp2Session | 'http/1.1'>;
  private readonly connectTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly sessionIdleMs: number;
  private readonly log: (line: string) => void;

  constructor(o: { connect: (url: URL, timeoutMs: number) => Promise<ClientHttp2Session | 'http/1.1'>; connectTimeoutMs: number; pingIntervalMs: number; sessionIdleMs: number; log: (line: string) => void }) {
    this.connect = o.connect;
    this.connectTimeoutMs = o.connectTimeoutMs;
    this.pingIntervalMs = o.pingIntervalMs;
    this.sessionIdleMs = o.sessionIdleMs;
    this.log = o.log;
  }

  get(url: URL): Promise<H2Entry | 'http/1.1'> {
    const origin = url.origin;
    if (this.h1Origins.has(origin)) return Promise.resolve('http/1.1');
    const live = this.entries.get(origin);
    if (live && !live.session.closed && !live.session.destroyed) return Promise.resolve(live);
    const pending = this.connecting.get(origin);
    if (pending) return pending;
    const p = this.open(url).finally(() => this.connecting.delete(origin));
    this.connecting.set(origin, p);
    return p;
  }

  acquire(entry: H2Entry): void {
    entry.open++;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = null;
    if (entry.ping === null && this.pingIntervalMs > 0) {
      entry.ping = setInterval(() => {
        try {
          entry.session.ping((err) => {
            if (err) this.log(`PING su ${entry.origin} non riuscito: ${redactString(describe(err))}`);
          });
        } catch (err) {
          this.log(`PING su ${entry.origin} non inviato: ${redactString(describe(err))}`);
        }
      }, this.pingIntervalMs);
    }
  }

  release(entry: H2Entry): void {
    entry.open = Math.max(0, entry.open - 1);
    if (entry.open > 0) return;
    if (entry.ping) clearInterval(entry.ping);
    entry.ping = null;
    if (!entry.pooled) {
      // Sessione già tolta (GOAWAY): finite le sue richieste, si chiude.
      if (!entry.session.closed) entry.session.close();
      return;
    }
    this.armIdle(entry);
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.drop(entry);
      if (!entry.session.destroyed) entry.session.destroy();
    }
  }

  private armIdle(entry: H2Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      entry.idle = null;
      if (entry.open > 0) return;
      this.drop(entry);
      if (!entry.session.closed) entry.session.close();
    }, this.sessionIdleMs);
    entry.idle.unref();
  }

  private drop(entry: H2Entry): void {
    if (this.entries.get(entry.origin) === entry) this.entries.delete(entry.origin);
    entry.pooled = false;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = null;
    if (entry.open === 0 && entry.ping) {
      clearInterval(entry.ping);
      entry.ping = null;
    }
  }

  private async open(url: URL): Promise<H2Entry | 'http/1.1'> {
    const result = await this.connect(url, this.connectTimeoutMs);
    if (result === 'http/1.1') {
      this.h1Origins.add(url.origin);
      this.log(`${url.host} non negozia HTTP/2: ripiego su HTTP/1.1 con keepalive`);
      return 'http/1.1';
    }
    const entry: H2Entry = { origin: url.origin, session: result, open: 0, ping: null, idle: null, pooled: true };
    result.on('error', (err) => {
      this.log(`sessione HTTP/2 con ${url.host} in errore: ${redactString(describe(err))}`);
      this.drop(entry);
    });
    result.on('goaway', (code) => {
      // Le richieste già partite finiscono sulla sessione vecchia; le nuove ne aprono un'altra.
      this.log(`GOAWAY da ${url.host} (codice ${code})`);
      this.drop(entry);
    });
    result.on('close', () => {
      this.drop(entry);
      if (entry.ping) clearInterval(entry.ping);
      entry.ping = null;
    });
    this.entries.set(url.origin, entry);
    this.armIdle(entry);
    return entry;
  }
}

/** Trasporto HTTP per i profili compatibili OpenAI (h2 con PING, ripiego HTTP/1.1, fetch in locale). */
export class HttpChatTransport implements ChatTransport {
  private readonly pool: H2Pool;
  private readonly delays: readonly number[];
  private readonly maxStatusRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly h1Request: H1Request | undefined;
  private httpAgent: HttpAgent | null = null;
  private httpsAgent: HttpsAgent | null = null;

  constructor(options: TransportOptions = {}) {
    this.delays = options.resetRetryDelaysMs ?? RESET_RETRY_DELAYS_MS;
    this.maxStatusRetries = options.maxStatusRetries ?? MAX_STATUS_RETRIES;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((): void => undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.h1Request = options.h1Request;
    this.pool = new H2Pool({
      connect: options.connectH2 ?? defaultConnectH2,
      connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
      sessionIdleMs: options.sessionIdleMs ?? SESSION_IDLE_MS,
      log: (line) => this.log(line)
    });
  }

  close(): void {
    this.pool.closeAll();
    this.httpAgent?.destroy();
    this.httpsAgent?.destroy();
    this.httpAgent = null;
    this.httpsAgent = null;
  }

  async *stream(req: ChatStreamRequest): AsyncGenerator<string, void, undefined> {
    const { profile } = req;
    const url = chatUrl(profile, req.path);
    let key: string | null = null;
    if (profile.needsKey) {
      // Prima la destinazione, poi la chiave: verso un host sbagliato la chiave non viene nemmeno letta.
      assertKeyDestination(profile, url);
      key = req.getKey?.()?.trim() ?? null;
      if (key === null || key === '') {
        throw new TransportError('provider_unavailable', `${profile.id}: chiave non impostata`, { retryable: false });
      }
    }
    const scrub = (text: string): string => scrubSecret(text, key);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (key !== null) headers.authorization = `Bearer ${key}`;
    const payload = JSON.stringify(req.body);

    let resets = 0;
    let statusRetries = 0;
    for (;;) {
      if (req.signal.aborted) throw cancelled();
      const attempt = new AbortController();
      const onAbort = (): void => attempt.abort(cancelled());
      req.signal.addEventListener('abort', onAbort, { once: true });
      let wire: Wire | null = null;
      let yielded = false;
      let waitMs = 0;
      // Un solo timer per tentativo: primo byte, poi silenzio fra blocchi; scadendo annulla il tentativo.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };
      const arm = (ms: number, what: string): void => {
        disarm();
        timer = setTimeout(() => attempt.abort(new TransportError('timeout', `${profile.id}: ${what} oltre ${ms} ms`, { retryable: true, afterFirstByte: yielded })), ms);
      };
      try {
        arm(req.firstByteMs, 'nessuna risposta');
        wire = await this.open(profile, url, headers, payload, attempt.signal);
        if (wire.status !== 200) {
          arm(req.idleMs, 'corpo dell\'errore fermo');
          const text = scrub(await readText(wire.body, ERROR_BODY_MAX)).replace(/\s+/g, ' ').trim().slice(0, 300);
          throw statusError(profile.id, wire.status, text, parseRetryAfter(wire.header('retry-after'), this.now()));
        }
        const decoder = new TextDecoder();
        const parser = new SseParser();
        let first = true;
        for (;;) {
          if (!first) arm(req.idleMs, 'silenzio fra due blocchi');
          const r = await wire.body.next();
          disarm();
          if (attempt.signal.aborted) throw attempt.signal.reason;
          first = false;
          const text = r.done ? decoder.decode() : decoder.decode(r.value, { stream: true });
          const events = r.done ? [...parser.push(text), ...parser.end()] : parser.push(text);
          for (const event of events) {
            if (isDone(event.data)) return;
            yielded = true;
            yield event.data;
            if (attempt.signal.aborted) throw attempt.signal.reason;
          }
          if (r.done) throw new Error('flusso chiuso dal server prima di [DONE]');
        }
      } catch (raw) {
        const err: unknown = attempt.signal.aborted ? attempt.signal.reason : raw;
        if (err instanceof TransportError) throw err;
        if (err instanceof RetryableStatus) {
          const wait = err.waitMs ?? 1_000 * 2 ** statusRetries;
          if (statusRetries >= this.maxStatusRetries || wait > this.maxRetryAfterMs) {
            const why = wait > this.maxRetryAfterMs ? `il server chiede di riprovare fra ${Math.ceil(wait / 1_000)} s` : `ancora dopo ${statusRetries} nuovi tentativi`;
            throw new TransportError('provider_unavailable', `${err.message} (${why})`, { retryable: true, status: err.status });
          }
          statusRetries++;
          waitMs = wait;
          this.log(`${profile.id}: HTTP ${err.status}, nuovo tentativo ${statusRetries}/${this.maxStatusRetries} fra ${wait} ms`);
        } else {
          const detail = scrub(describe(err));
          if (yielded) {
            throw new TransportError('provider_unavailable', `${profile.id}: flusso interrotto a metà (${detail})`, { retryable: true, afterFirstByte: true });
          }
          if (resets >= this.delays.length) {
            throw new TransportError('provider_unavailable', `${profile.id}: connessione non riuscita dopo ${resets + 1} tentativi (${detail})`, { retryable: true });
          }
          waitMs = this.delays[resets] ?? 0;
          resets++;
          this.log(`${profile.id}: errore prima del primo byte (${detail}), nuovo tentativo ${resets}/${this.delays.length} fra ${waitMs} ms`);
        }
      } finally {
        disarm();
        req.signal.removeEventListener('abort', onAbort);
        wire?.close();
      }
      await this.sleep(waitMs, req.signal);
    }
  }

  private open(profile: ProviderProfile, url: URL, headers: Record<string, string>, payload: string, signal: AbortSignal): Promise<Wire> {
    return profile.keepalive === 'h2-ping' ? this.openH2(url, headers, payload, signal) : this.openFetch(url, headers, payload, signal);
  }

  private async openH2(url: URL, headers: Record<string, string>, payload: string, signal: AbortSignal): Promise<Wire> {
    const entry = await abortable(this.pool.get(url), signal);
    if (entry === 'http/1.1') return this.openH1(url, headers, payload, signal);
    this.pool.acquire(entry);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.pool.release(entry);
    };
    let stream: ClientHttp2Stream;
    try {
      stream = entry.session.request({ ':method': 'POST', ':path': `${url.pathname}${url.search}`, ...headers }, { endStream: false });
    } catch (err) {
      release();
      throw err;
    }
    const body = new Channel<Uint8Array>();
    return new Promise<Wire>((resolve, reject) => {
      let responded = false;
      let ended = false;
      const fail = (err: unknown): void => {
        if (responded) body.fail(err);
        else reject(err);
      };
      const close = (): void => {
        signal.removeEventListener('abort', onAbort);
        if (!stream.closed && !stream.destroyed) stream.close(H2.NGHTTP2_CANCEL);
        release();
        body.end();
      };
      const onAbort = (): void => {
        fail(signal.reason);
        close();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      stream.on('error', (err) => {
        fail(err);
        release();
      });
      stream.on('response', (h) => {
        responded = true;
        resolve({ status: Number(h[':status'] ?? 0), header: (n) => firstValue(h[n]), body, close });
      });
      stream.on('data', (chunk: Buffer) => body.push(chunk));
      // Una sessione distrutta dal server può chiudere il lato in lettura («end») SENZA risposta: senza
      // intestazioni non è una fine, è un guasto (provato: altrimenti l'apertura resterebbe appesa per sempre).
      stream.on('end', () => {
        ended = responded;
        if (responded) body.end();
      });
      stream.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        release();
        if (!ended) fail(new Error(`stream HTTP/2 chiuso prima della fine (codice ${stream.rstCode ?? '?'})`));
      });
      stream.end(payload);
    });
  }

  private openH1(url: URL, headers: Record<string, string>, payload: string, signal: AbortSignal): Promise<Wire> {
    return new Promise<Wire>((resolve, reject) => {
      const secure = url.protocol === 'https:';
      const agent = secure ? (this.httpsAgent ??= new HttpsAgent({ keepAlive: true })) : (this.httpAgent ??= new HttpAgent({ keepAlive: true }));
      const send: H1Request = this.h1Request ?? (secure ? httpsRequest : httpRequest);
      const body = new Channel<Uint8Array>();
      let responded = false;
      const fail = (err: unknown): void => {
        if (responded) body.fail(err);
        else reject(err);
      };
      const request = send(url, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(payload)) }, agent });
      const close = (): void => {
        signal.removeEventListener('abort', onAbort);
        request.destroy();
        body.end();
      };
      const onAbort = (): void => {
        fail(signal.reason);
        close();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      request.on('socket', (socket) => socket.setKeepAlive(true, H1_KEEPALIVE_MS));
      request.on('error', fail);
      request.on('response', (res: IncomingMessage) => {
        responded = true;
        res.on('data', (chunk: Buffer) => body.push(chunk));
        res.on('end', () => body.end());
        res.on('error', (err) => body.fail(err));
        res.on('close', () => {
          if (!res.complete) body.fail(new Error('risposta interrotta a metà dal server'));
        });
        resolve({ status: res.statusCode ?? 0, header: (n) => firstValue(res.headers[n]), body, close });
      });
      request.end(payload);
    });
  }

  private async openFetch(url: URL, headers: Record<string, string>, payload: string, signal: AbortSignal): Promise<Wire> {
    // `redirect: 'manual'`: un 3xx torna com'è e viene rifiutato, la chiave non segue mai un reindirizzamento.
    const res = await this.fetchImpl(url, { method: 'POST', headers, body: payload, signal, redirect: 'manual' });
    const body = new Channel<Uint8Array>();
    const reader = res.body?.getReader();
    const stop = (): void => {
      void reader?.cancel().catch(() => undefined);
    };
    const onAbort = (): void => {
      body.fail(signal.reason);
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (reader) {
      void (async (): Promise<void> => {
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            body.push(r.value);
          }
          body.end();
        } catch (err) {
          body.fail(err);
        }
      })();
    } else {
      body.end();
    }
    return {
      status: res.status,
      header: (n) => res.headers.get(n) ?? undefined,
      body,
      close: () => {
        signal.removeEventListener('abort', onAbort);
        body.end();
        stop();
      }
    };
  }
}

function statusError(profileId: string, status: number, text: string, retryAfterMs: number | null): Error {
  const detail = text ? `: ${text}` : '';
  if (status === 401 || status === 403) {
    return new TransportError('provider_unavailable', `${profileId}: chiave rifiutata (HTTP ${status})${detail}`, { retryable: false, status });
  }
  if (status >= 300 && status < 400) {
    return new TransportError('provider_unavailable', `${profileId}: reindirizzamento rifiutato (HTTP ${status}): la chiave va solo all'host del profilo`, { retryable: false, status });
  }
  if (RETRY_STATUS.has(status)) return new RetryableStatus(status, retryAfterMs, `${profileId}: HTTP ${status}${detail}`);
  return new TransportError(status >= 500 ? 'provider_unavailable' : 'engine_error', `${profileId}: HTTP ${status}${detail}`, { retryable: status >= 500, status });
}

/** Il corpo di una risposta d'errore, fino a `max` byte; un guasto a metà restituisce ciò che è arrivato. */
async function readText(body: Channel<Uint8Array>, max: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const r = await body.next();
      if (r.done) break;
      text += decoder.decode(r.value, { stream: true });
      if (text.length >= max) break;
    }
  } catch {
    // il corpo dell'errore è solo un dettaglio
  }
  return text.slice(0, max);
}

/** Il trasporto predefinito del motore integrato. */
export function createChatTransport(options: TransportOptions = {}): ChatTransport {
  return new HttpChatTransport(options);
}
