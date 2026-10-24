// Motore integrato F2 (piano MOTORE_INTEGRATO_PIANO §5-6, P-107w): il trasporto contro il server finto locale
// (127.0.0.1, nessuna rete esterna). Via h2 in chiaro (h2c) con PING e sessione condivisa, ripiego HTTP/1.1,
// fetch per i profili locali; tempi, ritentativi, annullamento e la chiave che non esce mai negli errori.
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatAccumulator } from '../../src/core/adapters/integrato/sse.ts';
import {
  HttpChatTransport,
  TransportError,
  chatUrl,
  isLoopback,
  parseRetryAfter,
  scrubSecret,
  type ChatStreamRequest,
  type ProviderProfile,
  type TransportOptions
} from '../../src/core/adapters/integrato/transport.ts';
import { startFakeOpenAI, type FakeOpenAI } from '../fixtures/fake-openai.ts';

const BODY = { model: 'finto/modello', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'ciao' }] };

/** Chiave inventata, costruita a runtime: nel sorgente non c'è mai la forma completa. */
const makeKey = (): string => ['nv', 'api'].join('') + '-' + randomBytes(24).toString('hex');

const waitFor = async (cond: () => boolean, what: string, ms = 3_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout in attesa di ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

let fake: FakeOpenAI;
let transport: HttpChatTransport | null = null;
let sleeps: number[] = [];
let logs: string[] = [];

beforeEach(async () => {
  fake = await startFakeOpenAI();
  sleeps = [];
  logs = [];
});

afterEach(async () => {
  transport?.close();
  transport = null;
  await fake.close();
});

function make(options: TransportOptions = {}): HttpChatTransport {
  transport = new HttpChatTransport({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logs.push(line),
    ...options
  });
  return transport;
}

const h2Profile = (): ProviderProfile => ({ id: 'remoto', baseURL: fake.h2Base, needsKey: true, keepalive: 'h2-ping' });
const localProfile = (): ProviderProfile => ({ id: 'locale', baseURL: fake.h1Base, needsKey: false, keepalive: 'none' });

function request(profile: ProviderProfile, extra: Partial<ChatStreamRequest> = {}): ChatStreamRequest {
  return { profile, body: BODY, signal: new AbortController().signal, firstByteMs: 2_000, idleMs: 2_000, getKey: () => 'chiave-di-prova-locale', ...extra };
}

async function collect(t: HttpChatTransport, req: ChatStreamRequest, onData?: (data: string) => void): Promise<{ data: string[]; error: TransportError | null }> {
  const data: string[] = [];
  try {
    for await (const d of t.stream(req)) {
      data.push(d);
      onData?.(d);
    }
    return { data, error: null };
  } catch (err) {
    if (err instanceof TransportError) return { data, error: err };
    throw err;
  }
}

const textOf = (data: string[]): string => {
  const acc = new ChatAccumulator();
  for (const d of data) acc.push(d);
  return acc.result().text;
};

describe('funzioni del trasporto', () => {
  it('Retry-After in secondi o come data; URL dal baseURL; loopback; redazione della chiave esatta', () => {
    expect(parseRetryAfter('3', 0)).toBe(3_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter('domani', 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
    const p = { id: 'p', baseURL: 'https://esempio.test/v1/', needsKey: true, keepalive: 'h2-ping' } as const;
    expect(chatUrl(p).href).toBe('https://esempio.test/v1/chat/completions');
    expect(chatUrl(p, 'models').href).toBe('https://esempio.test/v1/models');
    expect(() => chatUrl({ ...p, baseURL: 'ftp://esempio.test' })).toThrow(TransportError);
    expect(isLoopback('127.0.0.1') && isLoopback('localhost') && isLoopback('[::1]')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
    const key = 'qualunque-valore-segreto-1234';
    expect(scrubSecret(`errore con ${key} dentro`, key)).toBe('errore con [REDACTED] dentro');
  });
});

describe('trasporto fetch (profilo locale)', () => {
  it('testo semplice: i `data` fino a [DONE] escluso, senza chiave', async () => {
    const r = await collect(make(), request(localProfile()));
    expect(r.error).toBeNull();
    expect(r.data.at(-1)).not.toBe('[DONE]');
    expect(textOf(r.data)).toBe('Ciao mondo è');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers.authorization).toBeUndefined();
    expect(fake.requests[0]!.path).toBe('/v1/chat/completions');
    expect(JSON.parse(fake.requests[0]!.body)).toEqual(BODY);
  });

  it('socket chiuso prima del primo byte: ritentato (0,5 s), poi riesce', async () => {
    fake.enqueue({ kind: 'reset' }, { kind: 'text' });
    const r = await collect(make(), request(localProfile()));
    expect(r.error).toBeNull();
    expect(textOf(r.data)).toBe('Ciao mondo è');
    expect(sleeps).toEqual([500]);
    expect(fake.requests).toHaveLength(2);
  });

  it('reset ripetuti: due ritentativi (0,5 s e 2 s), poi `provider_unavailable`', async () => {
    fake.enqueue({ kind: 'reset' }, { kind: 'reset' }, { kind: 'reset' });
    const r = await collect(make(), request(localProfile()));
    expect(r.error?.error.code).toBe('provider_unavailable');
    expect(r.error?.afterFirstByte).toBe(false);
    expect(sleeps).toEqual([500, 2_000]);
    expect(fake.requests).toHaveLength(3);
  });

  it('429 con Retry-After: attende quanto chiesto e riprova', async () => {
    fake.enqueue({ kind: 'status', status: 429, retryAfter: '1' }, { kind: 'text' });
    const r = await collect(make(), request(localProfile()));
    expect(r.error).toBeNull();
    expect(sleeps).toEqual([1_000]);
  });

  it('503 ripetuto: al massimo 3 ritentativi; Retry-After oltre il limite: nessuna attesa', async () => {
    fake.enqueue(...Array.from({ length: 4 }, () => ({ kind: 'status', status: 503 }) as const));
    const r = await collect(make(), request(localProfile()));
    expect(r.error?.error.code).toBe('provider_unavailable');
    expect(r.error?.status).toBe(503);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(fake.requests).toHaveLength(4);

    sleeps = [];
    fake.enqueue({ kind: 'status', status: 429, retryAfter: '3600' });
    const late = await collect(transport!, request(localProfile()));
    expect(late.error?.status).toBe(429);
    expect(late.error?.message).toContain('3600 s');
    expect(sleeps).toEqual([]);
  });

  it('silenzio prima del primo byte e fra due blocchi: `timeout`', async () => {
    fake.enqueue({ kind: 'silence', chunks: 0 });
    const first = await collect(make(), request(localProfile(), { firstByteMs: 150 }));
    expect(first.error?.error.code).toBe('timeout');
    expect(first.error?.afterFirstByte).toBe(false);

    fake.enqueue({ kind: 'silence', chunks: 1 });
    const idle = await collect(transport!, request(localProfile(), { idleMs: 150 }));
    expect(idle.data).toHaveLength(1);
    expect(idle.error?.error.code).toBe('timeout');
    expect(idle.error?.afterFirstByte).toBe(true);
    expect(fake.requests).toHaveLength(2); // nessun ritentativo sui tempi scaduti
    await waitFor(() => fake.requests.every((q) => q.closed), 'chiusura degli stream fermi');
  });

  it('chiusura a metà flusso: errore con `afterFirstByte`, nessun ritentativo', async () => {
    fake.enqueue({ kind: 'cut' });
    const r = await collect(make(), request(localProfile()));
    expect(r.data).toHaveLength(2);
    expect(r.error?.error.code).toBe('provider_unavailable');
    expect(r.error?.afterFirstByte).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('reindirizzamento rifiutato, mai seguito', async () => {
    fake.enqueue({ kind: 'redirect', location: 'http://127.0.0.2:9/v1/chat/completions' });
    const r = await collect(make(), request(localProfile()));
    expect(r.error?.status).toBe(307);
    expect(r.error?.error.retryable).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  it('annullamento: lo stream si chiude subito, anche in pieno silenzio', async () => {
    fake.enqueue({ kind: 'silence', chunks: 1 });
    const ctrl = new AbortController();
    const started = Date.now();
    const r = await collect(make(), request(localProfile(), { signal: ctrl.signal, idleMs: 10_000 }), () => setTimeout(() => ctrl.abort(), 20));
    expect(r.error?.error.code).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitFor(() => fake.requests[0]!.closed, 'chiusura lato server');
  });
});

describe('trasporto HTTP/2 (h2c sul server finto)', () => {
  it('testo e poi strumento sulla STESSA sessione; chiave solo nell\'intestazione', async () => {
    const t = make();
    const text = await collect(t, request(h2Profile()));
    expect(text.error).toBeNull();
    expect(textOf(text.data)).toBe('Ciao mondo è');
    fake.enqueue({ kind: 'tool' });
    const tool = await collect(t, request(h2Profile()));
    const acc = new ChatAccumulator();
    for (const d of tool.data) acc.push(d);
    expect(acc.result().toolCalls).toEqual([{ index: 0, id: 'call_1', name: 'read_file', args: '{"path":"a.txt"}' }]);
    expect(fake.h2Stats().opened).toBe(1);
    expect(fake.requests.every((q) => q.via === 'h2' && q.headers.authorization === 'Bearer chiave-di-prova-locale')).toBe(true);
    expect(fake.requests[0]!.body).not.toContain('chiave-di-prova-locale');
  });

  it('PING solo a richiesta aperta; sessione chiusa dopo l\'inattività', async () => {
    const t = make({ pingIntervalMs: 25, sessionIdleMs: 150 });
    fake.enqueue({ kind: 'silence', chunks: 1 });
    const ctrl = new AbortController();
    const r = await collect(t, request(h2Profile(), { signal: ctrl.signal, idleMs: 5_000 }), () => setTimeout(() => ctrl.abort(), 250));
    expect(r.error?.error.code).toBe('cancelled');
    const pings = fake.h2Stats().pings;
    expect(pings).toBeGreaterThan(2);
    await waitFor(() => fake.requests[0]!.closed, 'chiusura dello stream annullato');
    await new Promise((res) => setTimeout(res, 60)); // un PING già in viaggio può ancora arrivare
    const settled = fake.h2Stats().pings;
    await new Promise((res) => setTimeout(res, 100));
    expect(fake.h2Stats().pings).toBe(settled); // nessuna richiesta aperta: niente PING
    await waitFor(() => fake.h2Stats().open === 0, 'chiusura della sessione inattiva');
  });

  it('sessione distrutta prima del primo byte: ritentato su una sessione nuova', async () => {
    fake.enqueue({ kind: 'reset' }, { kind: 'text' });
    const r = await collect(make(), request(h2Profile()));
    expect(r.error).toBeNull();
    expect(textOf(r.data)).toBe('Ciao mondo è');
    expect(sleeps).toEqual([500]);
    expect(fake.h2Stats().opened).toBe(2);
  });

  it('chiusura a metà flusso e 429 con Retry-After anche su h2', async () => {
    fake.enqueue({ kind: 'cut' });
    const cut = await collect(make(), request(h2Profile()));
    expect(cut.data).toHaveLength(2);
    expect(cut.error?.afterFirstByte).toBe(true);

    fake.enqueue({ kind: 'status', status: 429, retryAfter: '2' }, { kind: 'text' });
    const limited = await collect(transport!, request(h2Profile()));
    expect(limited.error).toBeNull();
    expect(sleeps).toEqual([2_000]);
  });

  it('server che non negozia h2: ripiego su HTTP/1.1', async () => {
    const t = make({ connectH2: async () => 'http/1.1', h1Request: httpRequest });
    const profile: ProviderProfile = { ...h2Profile(), baseURL: fake.h1Base };
    const r = await collect(t, request(profile));
    expect(r.error).toBeNull();
    expect(textOf(r.data)).toBe('Ciao mondo è');
    expect(fake.requests[0]!.via).toBe('h1');
    expect(fake.requests[0]!.headers.authorization).toBe('Bearer chiave-di-prova-locale');
    expect(logs.some((l) => l.includes('ripiego'))).toBe(true);
  });
});

describe('la chiave (P-107w)', () => {
  it('401/403 mai ritentati; la chiave non compare in errori né log, anche se il server la rimanda indietro', async () => {
    const key = makeKey();
    const seen: string[] = [];
    const t = make({ log: (line) => logs.push(line) });
    const getKey = (): string => key;

    fake.enqueue({ kind: 'status', status: 401, echoAuth: true });
    const denied = await collect(t, request(h2Profile(), { getKey }));
    expect(denied.error?.error.code).toBe('provider_unavailable');
    expect(denied.error?.error.retryable).toBe(false);
    expect(denied.error?.status).toBe(401);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${key}`); // la chiave è davvero partita…
    expect(denied.error?.message).toContain('[REDACTED]'); // …ed è tornata indietro, redatta

    fake.enqueue({ kind: 'status', status: 403, echoAuth: true }, { kind: 'reset' }, { kind: 'reset' }, { kind: 'reset' }, { kind: 'cut' });
    const forbidden = await collect(t, request(h2Profile(), { getKey }));
    const resets = await collect(t, request(h2Profile(), { getKey }));
    const cut = await collect(t, request(h2Profile(), { getKey }));
    for (const r of [denied, forbidden, resets, cut]) {
      expect(r.error).not.toBeNull();
      seen.push(r.error!.message, String(r.error), r.error!.stack ?? '', JSON.stringify(r.error!.error), JSON.stringify(r.data));
    }
    seen.push(...logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const text of seen) expect(text).not.toContain(key);
    expect(fake.requests.every((q) => !q.body.includes(key))).toBe(true);
  });

  it('mai verso un host diverso dal profilo, mai in chiaro fuori dalla macchina, mai senza chiave', async () => {
    let asked = 0;
    const getKey = (): string => {
      asked++;
      return makeKey();
    };
    const port = new URL(fake.h2Base).port;
    const other = await collect(make(), request(h2Profile(), { getKey, path: `http://localhost:${port}/v1/chat/completions` }));
    expect(other.error?.error.code).toBe('policy_denied');
    const plain = await collect(transport!, request({ ...h2Profile(), baseURL: 'http://esempio.invalid/v1' }, { getKey }));
    expect(plain.error?.error.code).toBe('policy_denied');
    expect(asked).toBe(0); // la chiave non viene nemmeno letta
    const missing = await collect(transport!, request(h2Profile(), { getKey: () => null }));
    expect(missing.error?.error.code).toBe('provider_unavailable');
    expect(fake.requests).toHaveLength(0);
  });
});
