// Canale degli hook delle CLI (MUNDER_CLI_RUNTIME §10, reimplementato): server su named pipe
// (socket Unix fuori da Windows), una riga JSON per richiesta e una per risposta, frame ≤ 256 KB,
// token per agente obbligatorio (Munder non autenticava la pipe). Lo shim è node puro, generico,
// scritto dal core nella cartella runtime: la CLI lo esegue come comando di hook.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Logger } from '../../shared/node/logging.ts';

export const HOOK_FRAME_MAX = 256 * 1024;
export const HOOK_PROTOCOL_VERSION = 1;
/** Lo shim legge da stdin fino a qui (poi riduce il payload): tagliato prima del parse, il JSON non si leggerebbe più. */
export const HOOK_INPUT_MAX = 64 * 1024 * 1024;
/** Campo di `tool_input` tenuto quando il payload va ridotto (contenuti voluminosi oltre: tolti). */
export const HOOK_FIELD_MAX = 64 * 1024;
/** Il gestore non ha risposto in tempo: la risposta è `ok: false`, non «nessuna decisione». */
const HANDLER_TIMEOUT = Symbol('timeout');

export interface HookRequest {
  readonly agentId: string;
  /** Nome dell'hook passato allo shim (es. `Stop`). */
  readonly event: string;
  readonly payload: unknown;
}

/** Risposta per la CLI (stampata dallo shim su stdout) oppure null = nessuna decisione. */
export type HookHandler = (req: HookRequest) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

export interface HookServer {
  readonly address: string;
  start(): Promise<void>;
  /** Registra un agente: restituisce il token da passare al suo processo (mai persistito). */
  register(agentId: string, handler: HookHandler): string;
  unregister(agentId: string): void;
  close(): Promise<void>;
  readonly stats: { accepted: number; rejected: number };
}

export function hookPipeAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash('sha1').update(home.toLowerCase()).digest('hex').slice(0, 12);
  return platform === 'win32' ? `\\\\.\\pipe\\visione-hooks-${hash}` : join(home, 'runtime', `hooks-${hash}.sock`);
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export function createHookServer(opts: { address: string; log: Logger; responseTimeoutMs?: number }): HookServer {
  const agents = new Map<string, { token: Buffer; handler: HookHandler }>();
  const responseTimeoutMs = opts.responseTimeoutMs ?? 4_500;
  const sockets = new Set<Socket>();
  const stats = { accepted: 0, rejected: 0 };
  let server: Server | null = null;

  const reply = (socket: Socket, body: Record<string, unknown>): void => {
    if (!socket.destroyed) socket.end(JSON.stringify(body) + '\n');
  };
  const reject = (socket: Socket, error: string): void => {
    stats.rejected++;
    opts.log.warn('richiesta di hook rifiutata', { error });
    reply(socket, { ok: false, error });
  };

  const handle = async (socket: Socket, line: string): Promise<void> => {
    let frame: { v?: unknown; agentId?: unknown; token?: unknown; event?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return reject(socket, 'frame non JSON');
    }
    if (frame.v !== HOOK_PROTOCOL_VERSION || typeof frame.agentId !== 'string' || typeof frame.token !== 'string' || typeof frame.event !== 'string') {
      return reject(socket, 'frame non valido');
    }
    const agent = agents.get(frame.agentId);
    if (!agent || !timingSafeEqual(agent.token, digest(frame.token))) return reject(socket, 'agente o token non validi');
    stats.accepted++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        Promise.resolve(agent.handler({ agentId: frame.agentId, event: frame.event.slice(0, 64), payload: frame.payload ?? null })),
        new Promise<typeof HANDLER_TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(HANDLER_TIMEOUT), responseTimeoutMs); })
      ]);
      // Timeout ed errori del gestore sono `ok: false`, distinti da «nessuna decisione» (`response: null`): con la
      // policy attiva lo shim nega PreToolUse invece di lasciar passare un'azione non controllata.
      if (response === HANDLER_TIMEOUT) {
        opts.log.warn('gestore di un hook senza risposta in tempo', { agentId: frame.agentId, event: frame.event, timeoutMs: responseTimeoutMs });
        reply(socket, { ok: false, error: 'timeout' });
      } else {
        reply(socket, { ok: true, response: response ?? null });
      }
    } catch (err) {
      opts.log.error('errore nel gestore di un hook', { agentId: frame.agentId, event: frame.event, err });
      reply(socket, { ok: false, error: 'errore del gestore' });
    } finally {
      clearTimeout(timer);
    }
  };

  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buf = '';
    let handled = false;
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) {
        if (Buffer.byteLength(buf) > HOOK_FRAME_MAX) {
          handled = true;
          reject(socket, `frame oltre ${HOOK_FRAME_MAX} byte`);
        }
        return;
      }
      handled = true;
      const line = buf.slice(0, nl);
      if (Buffer.byteLength(line) > HOOK_FRAME_MAX) return reject(socket, `frame oltre ${HOOK_FRAME_MAX} byte`);
      void handle(socket, line);
    });
  };

  return {
    address: opts.address,
    stats,
    start() {
      if (server) return Promise.resolve();
      if (process.platform !== 'win32' && existsSync(opts.address)) rmSync(opts.address, { force: true });
      const s = createServer(onConnection);
      server = s;
      return new Promise((resolve, reject) => {
        // Avvio fallito (es. pipe ancora del core di prima): il server si dimentica, così si può riprovare
        // davvero (prima un secondo `start` rispondeva «partito» senza ascoltare).
        const failed = (err: Error): void => {
          if (server === s) server = null;
          reject(err);
        };
        s.once('error', failed);
        s.listen(opts.address, () => {
          s.off('error', failed);
          s.on('error', (err) => opts.log.error('errore del server degli hook', { err }));
          resolve();
        });
      });
    },
    register(agentId, handler) {
      const token = randomBytes(24).toString('base64url');
      agents.set(agentId, { token: digest(token), handler });
      return token;
    },
    unregister(agentId) {
      agents.delete(agentId);
    },
    close() {
      for (const s of sockets) s.destroy();
      const s = server;
      server = null;
      agents.clear();
      if (!s) return Promise.resolve();
      return new Promise((resolve) => s.close(() => resolve()));
    }
  };
}

/**
 * Shim eseguito dalla CLI per ogni hook: `node visione-hook.cjs <Evento>`. Esce sempre con 0.
 * Con la policy di VISIONE attiva (`VISIONE_HOOK_FAIL_CLOSED=1`, lo mette l'adapter) un `PreToolUse` che non riceve
 * una risposta valida (pipe assente, timeout, token rifiutato, errore) NEGA lo strumento: un'azione non
 * controllata non passa. Un payload troppo grande si riduce tenendo i campi che la policy legge, mai svuotato.
 */
export const HOOK_SHIM_SOURCE = `'use strict';
// VISIONE — shim degli hook (generato dal core, non modificare). Legge il JSON dell'hook da stdin,
// lo inoltra a VISIONE sulla pipe locale con il token dell'agente e stampa la risposta, se c'è.
// Se VISIONE non risponde entro il tempo previsto esce 0 senza output: l'agente non si blocca. Con la policy
// attiva (VISIONE_HOOK_FAIL_CLOSED=1) PreToolUse invece nega: un'azione non controllata non passa.
const net = require('net');
const event = String(process.argv[2] || 'unknown');
const pipe = process.env.VISIONE_HOOK_PIPE;
const agentId = process.env.VISIONE_AGENT_ID;
const token = process.env.VISIONE_AGENT_TOKEN;
const failClosed = event === 'PreToolUse' && process.env.VISIONE_HOOK_FAIL_CLOSED === '1';
// La statusLine va disegnata in fretta: attesa più breve (MUNDER_CLI_RUNTIME §10).
const timeoutMs = event === 'StatusLine' ? 1500 : Number(process.env.VISIONE_HOOK_TIMEOUT_MS || 5000);
const MAX = ${HOOK_FRAME_MAX - 4096};
// Il JSON dell'hook si legge tutto (fino a un limite largo) e si riduce dopo: tagliato prima, non si leggerebbe.
const INPUT_MAX = ${HOOK_INPUT_MAX};
const FIELD_MAX = ${HOOK_FIELD_MAX};
let input = '';
let sent = false;
function done(out) {
  if (out) process.stdout.write(out);
  process.exit(0);
}
function fail(reason) {
  if (!failClosed) return done('');
  done(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'Controllo di VISIONE non disponibile (' + reason + '): azione negata per sicurezza. Riprova tra poco.' } }));
}
// Payload troppo grande: restano i campi che la policy legge (nome dello strumento, percorsi, comando) e si
// tolgono solo i contenuti voluminosi (content, new_string...). Mai un payload vuoto.
function reduce(p) {
  const out = { truncated: true };
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (k === 'tool_input' && v && typeof v === 'object' && !Array.isArray(v)) {
      const kept = {};
      for (const f of Object.keys(v)) {
        const s = JSON.stringify(v[f]);
        if (s === undefined || s.length <= FIELD_MAX) kept[f] = v[f];
      }
      out.tool_input = kept;
    } else if (typeof v === 'string') {
      out[k] = v.length <= FIELD_MAX ? v : v.slice(0, FIELD_MAX);
    } else if (typeof v !== 'object' || v === null) {
      out[k] = v;
    }
  }
  return out;
}
function frameOf(payload) {
  return JSON.stringify({ v: ${HOOK_PROTOCOL_VERSION}, agentId: agentId, token: token, event: event, payload: payload });
}
function send() {
  if (sent) return;
  sent = true;
  if (!pipe || !agentId || !token) return fail('ambiente di VISIONE assente');
  let payload = null;
  try { payload = input.trim() ? JSON.parse(input) : null; } catch (e) { payload = { raw: input.slice(0, 4000) }; }
  let frame = frameOf(payload);
  if (Buffer.byteLength(frame) > MAX) frame = frameOf(reduce(payload));
  if (Buffer.byteLength(frame) > MAX) {
    const tool = payload && typeof payload.tool_name === 'string' ? payload.tool_name.slice(0, 200) : null;
    frame = frameOf({ truncated: true, tool_name: tool });
  }
  const timer = setTimeout(function () { fail('nessuna risposta'); }, timeoutMs);
  const sock = net.connect(pipe);
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('connect', function () { sock.write(frame + '\\n'); });
  sock.on('data', function (d) {
    buf += d;
    const nl = buf.indexOf('\\n');
    if (nl < 0) return;
    clearTimeout(timer);
    let r = null;
    try { r = JSON.parse(buf.slice(0, nl)); } catch (e) { r = null; }
    sock.destroy();
    if (!r || r.ok !== true) return fail(r && typeof r.error === 'string' ? r.error.slice(0, 200) : 'risposta illeggibile');
    done(r.response ? JSON.stringify(r.response) : '');
  });
  sock.on('error', function () { clearTimeout(timer); fail('pipe non raggiungibile'); });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (d) { if (input.length < INPUT_MAX) input += d; });
process.stdin.on('end', send);
process.stdin.on('error', send);
setTimeout(send, timeoutMs).unref();
`;

/** Scrive lo shim nella cartella indicata (solo se diverso) e ne restituisce il percorso. */
export function ensureHookShim(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'visione-hook.cjs');
  if (existsSync(file) && readFileSync(file, 'utf8') === HOOK_SHIM_SOURCE) return file;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, HOOK_SHIM_SOURCE, 'utf8');
  renameSync(tmp, file);
  return file;
}
