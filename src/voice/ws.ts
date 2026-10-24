// Client WebSocket minimo (RFC 6455, solo client) su `node:http`/`node:https`: serve SOLO al
// protocollo Edge Read Aloud (P-84), che rifiuta un handshake senza header browser (misurato il
// 05/10/2026: HTTP 403 senza Origin/User-Agent — il WebSocket globale di Node non permette header
// propri). Niente dipendenze nuove: upgrade TLS, maschera dei frame client, frammentazione,
// ping/pong e close sono implementati qui e coperti dai test; nessuna estensione negoziata.
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Tetto difensivo: nessun frame di questo protocollo arriva vicino a questa dimensione. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const WS_OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface WsFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Uint8Array;
}

/** Frame WebSocket: mascherato se `mask` è dato (client), altrimenti in chiaro (fixture dei test). */
export function encodeFrame(opcode: number, payload: Uint8Array, mask?: Uint8Array): Uint8Array {
  const masking = mask !== undefined;
  const header = [0x80 | (opcode & 0x0f)];
  if (payload.length <= 125) header.push((masking ? 0x80 : 0) | payload.length);
  else if (payload.length <= 0xffff) header.push((masking ? 0x80 : 0) | 126, payload.length >> 8, payload.length & 0xff);
  else {
    header.push((masking ? 0x80 : 0) | 127);
    const big = BigInt(payload.length);
    for (let i = 7; i >= 0; i--) header.push(Number((big >> BigInt(8 * i)) & 0xffn));
  }
  const out = new Uint8Array(header.length + (masking ? 4 : 0) + payload.length);
  out.set(header);
  let offset = header.length;
  if (masking) {
    out.set(mask, offset);
    offset += 4;
    for (let i = 0; i < payload.length; i++) out[offset + i] = payload[i]! ^ mask[i % 4]!;
  } else {
    out.set(payload, offset);
  }
  return out;
}

/** Estrae i frame completi da `input`; `rest` è la coda incompleta da conservare. Lancia su frame invalidi. */
export function decodeFrames(input: Uint8Array): { frames: WsFrame[]; rest: Uint8Array } {
  const frames: WsFrame[] = [];
  let offset = 0;
  for (;;) {
    if (input.length - offset < 2) break;
    const b0 = input[offset]!;
    const b1 = input[offset + 1]!;
    const fin = (b0 & 0x80) !== 0;
    if ((b0 & 0x70) !== 0) throw new Error('frame WebSocket con bit RSV non gestiti');
    const opcode = b0 & 0x0f;
    if ((opcode >= 0x3 && opcode <= 0x7) || opcode >= 0x0b) throw new Error(`opcode WebSocket riservato: ${opcode}`);
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (input.length - cursor < 2) break;
      length = (input[cursor]! << 8) | input[cursor + 1]!;
      cursor += 2;
    } else if (length === 127) {
      if (input.length - cursor < 8) break;
      let big = 0n;
      for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(input[cursor + i]!);
      if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('frame WebSocket troppo grande');
      length = Number(big);
      cursor += 8;
    }
    if (opcode >= 0x8 && (!fin || length > 125)) throw new Error('frame di controllo WebSocket non valido');
    let mask: Uint8Array | null = null;
    if (masked) {
      if (input.length - cursor < 4) break;
      mask = input.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (input.length - cursor < length) break;
    const raw = input.subarray(cursor, cursor + length);
    const payload = mask === null ? Uint8Array.from(raw) : raw.map((v, i) => v ^ mask![i % 4]!);
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: input.slice(offset) };
}

export interface WsHandlers {
  open(): void;
  message(data: string | Uint8Array): void;
  error(err: Error): void;
  close(): void;
}

export interface WsSocket {
  send(text: string): void;
  close(): void;
  terminate(): void;
}

/**
 * Connessione WebSocket client: `headers` sono quelli dell'upgrade HTTP (il servizio Edge li esige).
 * `open` parte solo a handshake completato; i frame del server sono consegnati interi (frammenti
 * riuniti), i ping ricevono il pong; un errore chiude tutto e non viene segnalato due volte.
 */
export function connectWebSocket(url: string, headers: Record<string, string>, handlers: WsHandlers): WsSocket {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'wss:';
  if (!secure && parsed.protocol !== 'ws:') throw new Error(`protocollo WebSocket non supportato: ${parsed.protocol}`);
  const key = randomBytes(16).toString('base64');
  const request: ClientRequest = (secure ? httpsRequest : httpRequest)({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : secure ? 443 : 80,
    path: `${parsed.pathname}${parsed.search}`,
    headers: {
      ...headers,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key
    }
  });

  let socket: Duplex | null = null;
  let state: 'connecting' | 'open' | 'closed' = 'connecting';
  let buffer: Uint8Array = new Uint8Array(0);
  let fragment: { opcode: number; parts: Uint8Array[] } | null = null;

  const finish = (err?: Error): void => {
    if (state === 'closed') return;
    state = 'closed';
    try {
      socket?.destroy();
    } catch {
      /* già chiuso */
    }
    try {
      request.destroy();
    } catch {
      /* già conclusa */
    }
    if (err) handlers.error(err);
    handlers.close();
  };

  const sendFrame = (opcode: number, payload: Uint8Array): void => {
    if (!socket) throw new Error('WebSocket non connesso');
    socket.write(encodeFrame(opcode, payload, randomBytes(4)));
  };

  const deliver = (opcode: number, payload: Uint8Array): void => {
    if (opcode === WS_OPCODES.text) handlers.message(new TextDecoder().decode(payload));
    else handlers.message(payload);
  };

  const onData = (chunk: Buffer): void => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    let decoded: { frames: WsFrame[]; rest: Uint8Array };
    try {
      decoded = decodeFrames(buffer);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === WS_OPCODES.close) {
        try {
          sendFrame(WS_OPCODES.close, new Uint8Array(0));
        } catch {
          /* socket già in chiusura */
        }
        socket?.end();
        finish();
        return;
      }
      if (frame.opcode === WS_OPCODES.ping) {
        try {
          sendFrame(WS_OPCODES.pong, frame.payload);
        } catch {
          /* socket già in chiusura */
        }
        continue;
      }
      if (frame.opcode === WS_OPCODES.pong) continue;
      if (frame.opcode === WS_OPCODES.continuation) {
        if (!fragment) {
          finish(new Error('frammento WebSocket senza frame iniziale'));
          return;
        }
        fragment.parts.push(frame.payload);
        if (frame.fin) {
          const { opcode, parts } = fragment;
          fragment = null;
          const total = parts.reduce((n, p) => n + p.length, 0);
          const joined = new Uint8Array(total);
          let at = 0;
          for (const part of parts) {
            joined.set(part, at);
            at += part.length;
          }
          deliver(opcode, joined);
        }
        continue;
      }
      if (!frame.fin) {
        fragment = { opcode: frame.opcode, parts: [frame.payload] };
        continue;
      }
      deliver(frame.opcode, frame.payload);
    }
  };

  request.on('upgrade', (res: IncomingMessage, rawSocket: Duplex) => {
    const accept = res.headers['sec-websocket-accept'];
    const expected = createHash('sha1').update(key + GUID).digest('base64');
    if (accept !== expected) {
      rawSocket.destroy();
      finish(new Error('handshake WebSocket non valido'));
      return;
    }
    socket = rawSocket;
    state = 'open';
    rawSocket.on('data', onData);
    rawSocket.on('error', (err: Error) => finish(err.message ? err : new Error('errore di rete WebSocket')));
    rawSocket.on('close', () => finish());
    handlers.open();
  });
  request.on('response', (res: IncomingMessage) => {
    res.resume();
    finish(new Error(`upgrade WebSocket rifiutato: HTTP ${res.statusCode ?? 'sconosciuto'}`));
  });
  request.on('error', (err: Error) => finish(err.message ? err : new Error('errore di rete WebSocket')));
  request.end();

  return {
    send(text) {
      sendFrame(WS_OPCODES.text, new TextEncoder().encode(text));
    },
    close() {
      if (state === 'closed') return;
      try {
        sendFrame(WS_OPCODES.close, new Uint8Array(0));
      } catch {
        /* mai aperto */
      }
      finish();
    },
    terminate() {
      finish();
    }
  };
}
