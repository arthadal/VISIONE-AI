// Server finto compatibile OpenAI per le prove del trasporto del motore integrato (piano MOTORE_INTEGRATO_PIANO
// §6, fase F2). Solo 127.0.0.1, porta scelta dal sistema, nessuna rete esterna. Due server con lo stesso copione:
// `node:http` (SSE su HTTP/1.1: fetch e ripiego) e `http2.createServer` in chiaro (h2c: la via h2 con i PING).
// Ogni richiesta prende il prossimo scenario dalla coda (vuota: testo semplice) e viene registrata.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createH2Server, type ServerHttp2Session } from 'node:http2';
import type { AddressInfo } from 'node:net';

export type FakeScenario =
  | { kind: 'text' }
  | { kind: 'tool' }
  /** Stato HTTP con corpo JSON d'errore; `echoAuth` rimette nel corpo l'intestazione `authorization` ricevuta. */
  | { kind: 'status'; status: number; retryAfter?: string; echoAuth?: boolean }
  /** Connessione chiusa appena arrivata la richiesta, prima di qualunque byte. */
  | { kind: 'reset' }
  /** Intestazioni, poi `chunks` blocchi di testo, poi silenzio (fino alla chiusura del client). */
  | { kind: 'silence'; chunks: number }
  /** Due blocchi, poi la connessione si chiude a metà flusso. */
  | { kind: 'cut' }
  | { kind: 'redirect'; location: string }
  /** Pezzi grezzi scritti uno per volta, senza aggiungere niente. */
  | { kind: 'raw'; pieces: Array<string | Uint8Array> };

export interface FakeRequest {
  readonly via: 'h1' | 'h2';
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** La risposta è stata chiusa (finita o interrotta dal client). */
  closed: boolean;
}

export interface FakeOpenAI {
  /** `http://127.0.0.1:<porta>/v1` del server HTTP/1.1. */
  readonly h1Base: string;
  /** `http://127.0.0.1:<porta>/v1` del server h2c. */
  readonly h2Base: string;
  readonly requests: FakeRequest[];
  enqueue(...scenarios: FakeScenario[]): void;
  /** Sessioni h2 aperte in tutto, ancora aperte, PING ricevuti. */
  h2Stats(): { opened: number; open: number; pings: number };
  close(): Promise<void>;
}

export const sseChunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const USAGE = `data: ${JSON.stringify({ id: 'chatcmpl-finto', choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`;

/** Testo «Ciao mondo è»: commento keepalive, ragionamento, `\r\n`, un blocco spezzato a metà riga e una «è» spezzata fra i byte. */
export function textPieces(): Array<string | Uint8Array> {
  const crlf = sseChunk({ content: 'Ciao' }).replaceAll('\n', '\r\n');
  const accent = Buffer.from(sseChunk({ content: ' mondo è' }), 'utf8');
  const cut = accent.indexOf(0xc3) + 1; // a metà dei due byte di «è»
  return [
    sseChunk({ role: 'assistant', content: '' }),
    ': keepalive\n\n',
    sseChunk({ reasoning_content: 'penso a cosa rispondere' }),
    crlf.slice(0, 20),
    crlf.slice(20),
    accent.subarray(0, cut),
    accent.subarray(cut),
    sseChunk({}, 'stop'),
    USAGE,
    'data: [DONE]\n\n'
  ];
}

/** Una chiamata a `read_file` con gli argomenti spezzati in tre blocchi. */
export function toolPieces(): string[] {
  return [
    sseChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
    sseChunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
    sseChunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
    sseChunk({}, 'tool_calls'),
    'data: [DONE]\n\n'
  ];
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Quel che serve della risposta, uguale per `node:http` e per la compatibilità di `node:http2`. */
interface Out {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string | Uint8Array): unknown;
  end(chunk?: string): unknown;
  on(event: 'close', fn: () => void): unknown;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const queue: FakeScenario[] = [];
  const requests: FakeRequest[] = [];
  const h2Sessions = new Set<ServerHttp2Session>();
  let opened = 0;
  let pings = 0;

  const handle = async (via: 'h1' | 'h2', req: AsyncIterable<Buffer> & { url?: string; headers: IncomingHttpHeaders }, out: Out, kill: () => void): Promise<void> => {
    let body = '';
    for await (const c of req) body += c.toString('utf8');
    const record: FakeRequest = { via, path: req.url ?? '', headers: req.headers, body, closed: false };
    requests.push(record);
    out.on('close', () => {
      record.closed = true;
    });
    const scenario = queue.shift() ?? { kind: 'text' };
    const gone = (): boolean => out.destroyed || out.writableEnded;
    const play = async (pieces: Array<string | Uint8Array>): Promise<void> => {
      out.writeHead(200, SSE_HEADERS);
      for (const p of pieces) {
        if (gone()) return;
        out.write(p);
        await pause(5);
      }
      if (!gone()) out.end();
    };
    switch (scenario.kind) {
      case 'text':
        return play(textPieces());
      case 'tool':
        return play(toolPieces());
      case 'raw':
        return play(scenario.pieces);
      case 'status': {
        const auth = String(req.headers.authorization ?? '');
        const message = scenario.echoAuth ? `Authentication failed for header ${auth}` : `errore finto ${scenario.status}`;
        out.writeHead(scenario.status, { 'content-type': 'application/json', ...(scenario.retryAfter !== undefined ? { 'retry-after': scenario.retryAfter } : {}) });
        out.end(JSON.stringify({ error: { message, type: 'finto' } }));
        return;
      }
      case 'redirect':
        out.writeHead(307, { location: scenario.location });
        out.end();
        return;
      case 'reset':
        kill();
        return;
      case 'silence': {
        out.writeHead(200, SSE_HEADERS);
        for (let i = 0; i < scenario.chunks; i++) {
          out.write(sseChunk({ content: `pezzo ${i}` }));
          await pause(5);
        }
        return; // nessun altro byte: si aspetta che il client chiuda
      }
      case 'cut': {
        out.writeHead(200, SSE_HEADERS);
        out.write(sseChunk({ content: 'prima' }));
        await pause(5);
        out.write(sseChunk({ content: ' metà' }));
        await pause(20);
        kill();
        return;
      }
    }
  };

  const h1 = createServer((req, res) => {
    void handle('h1', req, res, () => req.socket.destroy()).catch(() => undefined);
  });
  h1.on('clientError', (_err, socket) => socket.destroy());
  const h2 = createH2Server((req, res) => {
    void handle('h2', req, res as unknown as Out, () => req.stream.session?.destroy()).catch(() => undefined);
  });
  h2.on('session', (session) => {
    opened++;
    h2Sessions.add(session);
    session.on('ping', () => {
      pings++;
    });
    session.on('error', () => undefined);
    session.on('close', () => h2Sessions.delete(session));
  });
  h2.on('sessionError', () => undefined);

  const listen = (server: typeof h1 | typeof h2): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  const p1 = await listen(h1);
  const p2 = await listen(h2);

  return {
    h1Base: `http://127.0.0.1:${p1}/v1`,
    h2Base: `http://127.0.0.1:${p2}/v1`,
    requests,
    enqueue: (...scenarios) => {
      queue.push(...scenarios);
    },
    h2Stats: () => ({ opened, open: h2Sessions.size, pings }),
    close: async () => {
      h1.closeAllConnections();
      for (const s of h2Sessions) s.destroy();
      await Promise.all([new Promise<void>((r) => h1.close(() => r())), new Promise<void>((r) => h2.close(() => r()))]);
    }
  };
}
