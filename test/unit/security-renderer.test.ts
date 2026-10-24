import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isAllowedRendererPermission, isAllowedRendererRequest, isTrustedRendererUrl } from '../../src/main/security-policy.ts';
import { connection, initialState, lastEvent, MAX_EVENTS, reduce, type ViewState } from '../../src/renderer/state/projection.ts';
import { createEvent, type VisioneEvent, type SupervisorSnapshot } from '../../src/shared/contracts/index.ts';

const rendererDir = join(process.cwd(), 'out', 'renderer');
const build = { rendererDir, devServerUrl: null };
const dev = { rendererDir: null, devServerUrl: 'http://localhost:5173/' };

describe('permessi del browser alla pagina di VISIONE', () => {
  it('microfono e sola scrittura negli appunti; nient\'altro, e mai a pagine estranee', () => {
    expect(isAllowedRendererPermission('media', true, ['audio'])).toBe(true);
    // 11/10/2026: webcam per il widget Umanoide (acceso dal proprietario), sempre e solo alla pagina di VISIONE.
    expect(isAllowedRendererPermission('media', true, ['video'])).toBe(true);
    expect(isAllowedRendererPermission('media', true, ['audio', 'video'])).toBe(true);
    expect(isAllowedRendererPermission('media', false, ['video'])).toBe(false);
    expect(isAllowedRendererPermission('media', true, ['screen'])).toBe(false);
    // P-105 (collaudo 10/10/2026): i pulsanti «Copia» della procedura guidata erano negati.
    expect(isAllowedRendererPermission('clipboard-sanitized-write', true)).toBe(true);
    expect(isAllowedRendererPermission('clipboard-read', true)).toBe(false);
    for (const p of ['geolocation', 'notifications', 'openExternal', 'fullscreen', 'display-capture']) expect(isAllowedRendererPermission(p, true), p).toBe(false);
    expect(isAllowedRendererPermission('media', false, ['audio'])).toBe(false);
    expect(isAllowedRendererPermission('clipboard-sanitized-write', false)).toBe(false);
  });
});

describe('politica di rete del renderer', () => {
  it('build: solo i file del renderer, data: e blob:', () => {
    expect(isAllowedRendererRequest(pathToFileURL(join(rendererDir, 'index.html')).href, build)).toBe(true);
    expect(isAllowedRendererRequest(pathToFileURL(join(rendererDir, 'assets', 'a.js')).href, build)).toBe(true);
    expect(isAllowedRendererRequest('data:image/png;base64,AAAA', build)).toBe(true);
    expect(isAllowedRendererRequest('blob:file:///abc', build)).toBe(true);
  });

  it('blocca qualunque host esterno e il filesystem fuori dal renderer', () => {
    const blocked = [
      'https://example.com/',
      'http://example.com/x.js',
      'wss://api.example.com/socket',
      'https://integrate.api.nvidia.com/v1/models',
      'http://127.0.0.1:11500/v1',
      'ftp://example.com/',
      pathToFileURL(join(rendererDir, '..', 'main', 'index.js')).href,
      pathToFileURL(join(process.env.USERPROFILE ?? 'C:\\Users', '.claude', '.credentials.json')).href,
      'chrome://settings',
      'non un url'
    ];
    for (const url of blocked) expect(isAllowedRendererRequest(url, build), url).toBe(false);
  });

  it('sviluppo: solo il server di Vite locale (http e websocket HMR)', () => {
    expect(isAllowedRendererRequest('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    expect(isAllowedRendererRequest('ws://localhost:5173/', dev)).toBe(true);
    expect(isAllowedRendererRequest('http://127.0.0.1:5173/', dev)).toBe(true);
    expect(isAllowedRendererRequest('http://localhost:5174/', dev)).toBe(false);
    expect(isAllowedRendererRequest('https://localhost:5173/', dev)).toBe(false);
    expect(isAllowedRendererRequest('http://evil.example:5173/', dev)).toBe(false);
  });

  it('IPC accettato solo dalla pagina del renderer', () => {
    expect(isTrustedRendererUrl(pathToFileURL(join(rendererDir, 'index.html')).href, build)).toBe(true);
    expect(isTrustedRendererUrl('https://example.com/', build)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5173/', build)).toBe(false);
  });

  it('CSP stretta: niente script inline o esterni, connessioni solo locali', () => {
    const prod = contentSecurityPolicy(false);
    expect(prod).toContain("default-src 'none'");
    expect(prod).toContain("script-src 'self'");
    expect(prod).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(prod).toContain("connect-src 'self';");
    expect(contentSecurityPolicy(true)).toContain("connect-src 'self' ws://localhost:*");
  });
});

describe('proiezione dello stato della UI', () => {
  const snap = (state: SupervisorSnapshot['state'], since = 1_000): SupervisorSnapshot => ({
    state, since, pid: state === 'ready' ? 7 : null, appVersion: '0.3.0', restartsInWindow: 0, totalRestarts: 0, nextRestartAt: null, lastExit: null
  });
  const durable = (seq: number): VisioneEvent => ({ ...createEvent('app.shutdown', { reason: `e${seq}` }), seq });

  it('connessione: scollegato → in collegamento → collegato dopo il ping; un riavvio richiede un nuovo ping', () => {
    let s: ViewState = initialState;
    expect(connection(s)).toBe('disconnected');
    s = reduce(s, { type: 'supervisor', snapshot: snap('ready') });
    expect(connection(s)).toBe('connecting');
    expect(s.needsResync).toBe(true);
    s = reduce(s, { type: 'ping', at: 2_000, rttMs: 1.2, result: { pong: true, echo: 'ui', coreTs: 2_000, pid: 7, uptimeMs: 5 } });
    expect(connection(s)).toBe('connected');
    s = reduce(s, { type: 'supervisor', snapshot: snap('crashed', 3_000) });
    expect(connection(s)).toBe('disconnected');
    s = reduce(s, { type: 'supervisor', snapshot: snap('ready', 4_000) });
    expect(connection(s)).toBe('connecting');
  });

  it('deduplica per id e preferisce la versione con seq', () => {
    const e = createEvent('core.crashed', { pid: 1, exitCode: 1, reason: 'exit', detail: '', stderrTail: '', restartsInWindow: 1, willRestart: true, nextDelayMs: 1 });
    let s = reduce(initialState, { type: 'event', event: e });
    s = reduce(s, { type: 'page', events: [{ ...e, seq: 3 }], lastSeq: 3 });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]?.seq).toBe(3);
    s = reduce(s, { type: 'event', event: e });
    expect(s.events[0]?.seq).toBe(3);
    expect(lastEvent(s)?.id).toBe(e.id);
  });

  it('un buco nella sequenza seq richiede una risincronizzazione', () => {
    let s = reduce(initialState, { type: 'page', events: [durable(1), durable(2)], lastSeq: 2 });
    expect(s.needsResync).toBe(false);
    s = reduce(s, { type: 'event', event: durable(3) });
    expect(s.needsResync).toBe(false);
    s = reduce(s, { type: 'event', event: durable(6) });
    expect(s.needsResync).toBe(true);
    expect(s.lastSeq).toBe(6);
  });

  it('ordina per tempo dell\'evento anche quando il journal li ha registrati in un altro ordine', () => {
    const crash = { ...createEvent('core.crashed', { pid: 1, exitCode: 1, reason: 'exit', detail: '', stderrTail: '', restartsInWindow: 1, willRestart: true, nextDelayMs: 1 }, { now: 1_000 }), seq: 8 };
    const ready = { ...createEvent('system.ready', { startupMs: 1, journalLastSeq: 5 }, { now: 2_000 }), seq: 7 };
    const ipc = createEvent('command.completed', { commandId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', type: 'system.ping', ok: true, durationMs: 1, errorCode: null, replayed: false }, { now: 1_500 });
    const s = reduce(initialState, { type: 'page', events: [ready, crash, ipc], lastSeq: 8 });
    expect(s.events.map((e) => e.type)).toEqual(['core.crashed', 'command.completed', 'system.ready']);
    expect(lastEvent(s)?.type).toBe('system.ready');
  });

  it('conserva al massimo gli ultimi MAX_EVENTS eventi in ordine', () => {
    const total = MAX_EVENTS + 10;
    let s = initialState;
    for (let i = 1; i <= total; i++) s = reduce(s, { type: 'event', event: durable(i) });
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect(s.events[0]?.seq).toBe(total - MAX_EVENTS + 1);
    expect(lastEvent(s)?.seq).toBe(total);
  });
});
