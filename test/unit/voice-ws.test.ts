// Client WebSocket minimo (P-84): framing puro e un giro completo su loopback con un server locale
// (niente rete esterna): handshake, testo client mascherato, frame frammentati e binari, ping→pong,
// chiusura e rifiuto dell'upgrade.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { connectWebSocket, decodeFrames, encodeFrame, type WsFrame } from '../../src/voice/ws.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const waitFor = async (cond: () => boolean, what: string, ms = 5_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout in attesa di ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('framing WebSocket', () => {
  it('encode/decode: mascherato e non, payload corti, 16 bit e 64 bit', () => {
    const mask = new Uint8Array([1, 2, 3, 4]);
    for (const payload of [enc('ciao'), new Uint8Array(200).fill(7), new Uint8Array(70_000).fill(9)]) {
      const masked = encodeFrame(0x2, payload, mask);
      expect(masked[1]! & 0x80).toBe(0x80);
      const parsed = decodeFrames(masked);
      expect(parsed.rest.length).toBe(0);
      expect(parsed.frames).toHaveLength(1);
      expect(parsed.frames[0]!.opcode).toBe(0x2);
      expect(parsed.frames[0]!.fin).toBe(true);
      expect(parsed.frames[0]!.payload).toEqual(payload);
      const clear = encodeFrame(0x1, payload);
      expect(decodeFrames(clear).frames[0]!.payload).toEqual(payload);
    }
  });

  it('decode: conserva la coda incompleta e riunisce più frame', () => {
    const frame = encodeFrame(0x1, enc('primo'), new Uint8Array(4));
    const second = encodeFrame(0x2, enc('secondo'), new Uint8Array(4));
    const truncated = join(frame, second).subarray(0, frame.length + 3);
    const first = decodeFrames(truncated);
    expect(first.frames).toHaveLength(1);
    expect(dec(first.frames[0]!.payload)).toBe('primo');
    const rest = decodeFrames(join(first.rest, second.subarray(3)));
    expect(rest.frames).toHaveLength(1);
    expect(dec(rest.frames[0]!.payload)).toBe('secondo');
  });

  it('decode: frame invalidi segnalati (RSV, opcode riservato, controllo, 64 bit eccessivi)', () => {
    const rsv = encodeFrame(0x1, enc('x'));
    rsv[0] = rsv[0]! | 0x40;
    expect(() => decodeFrames(rsv)).toThrow(/RSV/);
    expect(() => decodeFrames(new Uint8Array([0x83, 0x00]))).toThrow(/riservato/);
    expect(() => decodeFrames(new Uint8Array([0x09, 0x00]))).toThrow(/controllo/);
    expect(() => decodeFrames(new Uint8Array([0x89, 126, 0x00, 200]))).toThrow(/controllo/);
    const huge = new Uint8Array([0x82, 127, 0x00, 0x00, 0x00, 0x00, 0x01, 0x10, 0x00, 0x00]);
    expect(() => decodeFrames(huge)).toThrow(/troppo grande/);
  });
});

describe('connectWebSocket su loopback', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('handshake, testo mascherato, frame frammentati/binari, ping→pong e chiusura', async () => {
    const received: WsFrame[] = [];
    let socket: Duplex | null = null;
    let buffer: Uint8Array = new Uint8Array(0);
    let sentFixture = false;

    const server = createServer();
    servers.push(server);
    server.on('upgrade', (req, rawSocket) => {
      socket = rawSocket;
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      rawSocket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      rawSocket.on('data', (chunk) => {
        const merged = join(buffer, chunk);
        const parsed = decodeFrames(merged);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          received.push(frame);
          if (frame.opcode === 0x1 && !sentFixture) {
            sentFixture = true;
            // Testo frammentato (FIN=0 + continuazione), poi un binario, poi un ping.
            const text = enc('Ciao, mondo');
            const head = new Uint8Array(2 + 6);
            head[0] = 0x01; // FIN=0, testo
            head[1] = 6;
            head.set(text.subarray(0, 6), 2);
            rawSocket.write(join(head, encodeFrame(0x0, text.subarray(6))));
            rawSocket.write(encodeFrame(0x2, new Uint8Array([1, 2, 3])));
            rawSocket.write(encodeFrame(0x9, enc('p')));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const messages: (string | Uint8Array)[] = [];
    const events: string[] = [];
    const ws = connectWebSocket(`ws://127.0.0.1:${port}/edge`, { Origin: 'chrome-extension://test' }, {
      open: () => {
        events.push('open');
        ws.send('richiesta');
      },
      message: (data) => messages.push(data),
      error: (err) => events.push(`error:${err.message}`),
      close: () => events.push('close')
    });

    await waitFor(() => messages.length >= 2, 'i due messaggi del server');
    expect(events[0]).toBe('open');
    expect(messages[0]).toBe('Ciao, mondo');
    expect(messages[1]).toEqual(new Uint8Array([1, 2, 3]));
    // Il testo del client è arrivato mascherato e intero.
    const clientText = received.find((f) => f.opcode === 0x1);
    expect(clientText).toBeDefined();
    expect(dec(clientText!.payload)).toBe('richiesta');
    // Il ping del server ha ricevuto il pong.
    await waitFor(() => received.some((f) => f.opcode === 0xa), 'il pong');
    expect(dec(received.find((f) => f.opcode === 0xa)!.payload)).toBe('p');

    ws.close();
    await waitFor(() => events.includes('close'), 'la chiusura');
    expect(socket).not.toBeNull();
    expect(events.filter((e) => e === 'close')).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('error'))).toHaveLength(0);
  });

  it('upgrade rifiutato: errore con lo status HTTP, nessuna apertura', async () => {
    const server = createServer();
    servers.push(server);
    server.on('upgrade', (_req, rawSocket) => {
      rawSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const events: string[] = [];
    connectWebSocket(`ws://127.0.0.1:${port}/edge`, {}, {
      open: () => events.push('open'),
      message: () => undefined,
      error: (err) => events.push(`error:${err.message}`),
      close: () => events.push('close')
    });
    await waitFor(() => events.includes('close'), 'la chiusura per rifiuto');
    expect(events).toEqual(['error:upgrade WebSocket rifiutato: HTTP 403', 'close']);
  });
});
