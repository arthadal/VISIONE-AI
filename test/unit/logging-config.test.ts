import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_VERSION, DEFAULT_CONFIG, loadConfig, migrateConfig, visioneConfigSchema } from '../../src/shared/node/config.ts';
import { createConsoleSink, createFileSink, createLogger, guardOutputStreams, isBrokenPipeError, type LogRecord, type OutputStream } from '../../src/shared/node/logging.ts';
import { resolveHome, resolvePaths, pendingLegacyHome } from '../../src/shared/node/paths.ts';
import { describeSecret, resolveSecret, secretRefSchema } from '../../src/shared/node/secrets.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const homes: Array<() => void> = [];
afterEach(() => {
  while (homes.length > 0) homes.pop()?.();
});
function home(): string {
  const h = tempHome();
  homes.push(h.cleanup);
  return h.dir;
}

describe('logger', () => {
  it('scrive righe JSONL strutturate e filtra per livello', () => {
    const records: LogRecord[] = [];
    const log = createLogger({ proc: 'core', level: 'info', sinks: [{ write: (l) => records.push(JSON.parse(l) as LogRecord) }], now: () => 0 });
    log.debug('nascosto');
    log.info('visibile', { correlationId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', n: 1 });
    log.child('db').warn('attenzione');
    log.error('errore', { err: new Error('boom') });
    expect(records.map((r) => r.level)).toEqual(['info', 'warn', 'error']);
    expect(records[0]).toEqual({
      ts: '1970-01-01T00:00:00.000Z', level: 'info', proc: 'core', module: '', msg: 'visibile',
      correlationId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', data: { n: 1 }
    });
    expect(records[1]?.module).toBe('db');
    expect((records[2]?.data as { err: { message: string } }).err.message).toBe('boom');
  });

  it('non registra segreti né valori di chiavi sensibili', () => {
    const { log, records } = memoryLogger();
    log.info(`chiave nvapi-${'q'.repeat(30)}`, { apiKey: 'abc12345', headers: { authorization: 'Bearer abcdefghijklmnop' } });
    const line = JSON.stringify(records);
    expect(line).not.toContain('nvapi-qqq');
    expect(line).not.toContain('abc12345');
    expect(line).not.toContain('abcdefghijklmnop');
  });

  it('ruota il file per dimensione', () => {
    const dir = home();
    const sink = createFileSink(dir, 'main', { maxBytes: 200, maxFiles: 2 });
    for (let i = 0; i < 20; i++) sink.write(JSON.stringify({ i, pad: 'x'.repeat(40) }));
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['main.1.jsonl', 'main.2.jsonl', 'main.jsonl']);
    for (const f of files) expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(200);
  });

  it('un sink che fallisce non fa cadere il logger', () => {
    const log = createLogger({ proc: 'p', level: 'debug', sinks: [{ write: () => { throw new Error('disco pieno'); } }] });
    expect(() => log.error('x')).not.toThrow();
  });

  // P-97 — il bug reale: il main scriveva su stdout, il processo padre (console/npm/e2e) non c'era
  // più e l'EPIPE diventava un'eccezione non gestita → dialogo di errore Electron a ogni riavvio.
  it('console sink P-97: un EPIPE sincrono non fa cadere il logger e continua sul ripiego', () => {
    const ripiego: string[] = [];
    const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    const rotto: OutputStream = { write: () => { throw epipe; }, destroyed: false, writable: true, writableEnded: false, on: () => undefined };
    const sink = createConsoleSink({ stdout: rotto, stderr: rotto, fallback: { write: (l) => ripiego.push(l) } });
    const log = createLogger({ proc: 'main', level: 'info', sinks: [sink] });
    expect(() => log.info('prima')).not.toThrow();
    expect(() => log.error('dopo', { n: 1 })).not.toThrow();
    expect(ripiego).toHaveLength(2);
    expect(JSON.parse(ripiego[1] as string)).toMatchObject({ level: 'error', proc: 'main', msg: 'dopo' });
  });

  it('console sink P-97: anche l’EPIPE asincrono del canale (error event) è assorbito', () => {
    const ripiego: string[] = [];
    const ascoltatori: Array<(e: unknown) => void> = [];
    const rotto: OutputStream = {
      // Dopo l'EPIPE asincrono il canale non è più scrivibile: la sink deve usare il ripiego, non lanciare.
      write: () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }); },
      destroyed: false, writable: true, writableEnded: false,
      on: (_e, listener) => { ascoltatori.push(listener); return undefined; }
    };
    const sink = createConsoleSink({ stdout: rotto, stderr: rotto, fallback: { write: (l) => ripiego.push(l) } });
    expect(ascoltatori.length).toBeGreaterThan(0);
    expect(() => { for (const l of ascoltatori) l(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })); }).not.toThrow();
    expect(() => sink.write(JSON.stringify({ ts: 'x', level: 'info', proc: 'main', module: '', msg: 'continua' }))).not.toThrow();
    expect(ripiego).toHaveLength(1);
    expect(JSON.parse(ripiego[0] as string).msg).toBe('continua');
  });

  it('guardOutputStreams P-97: un canale già distrutto è riconosciuto e non viene mai scritto', () => {
    expect(isBrokenPipeError(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true);
    expect(isBrokenPipeError(new Error('altro'))).toBe(false);
    const scritti: string[] = [];
    const distrutto: OutputStream = { write: (l) => { scritti.push(l); return true; }, destroyed: true, writable: false, writableEnded: true, on: () => undefined };
    const sink = createConsoleSink({ stdout: distrutto, stderr: distrutto });
    expect(() => sink.write(JSON.stringify({ level: 'info', msg: 'x' }))).not.toThrow();
    expect(scritti).toHaveLength(0);
    // La guardia è idempotente: nessun doppio listener anche chiamandola più volte.
    guardOutputStreams([distrutto, distrutto]);
  });
});

describe('configurazione', () => {
  it('senza file usa i default e, se è il proprietario, crea il file', () => {
    const file = join(home(), 'config', 'visione.json');
    const loaded = loadConfig(file, { env: {}, createIfMissing: true });
    expect(loaded.source).toBe('defaults');
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_CONFIG);
  });

  it('il main legge senza creare', () => {
    const file = join(home(), 'config', 'visione.json');
    loadConfig(file, { env: {} });
    expect(existsSync(file)).toBe(false);
  });

  it('completa un file parziale con i default', () => {
    const file = join(home(), 'visione.json');
    writeFileSync(file, JSON.stringify({ version: 1, supervisor: { maxRestarts: 2 } }));
    const loaded = loadConfig(file, { env: {} });
    expect(loaded.source).toBe('file');
    expect(loaded.config.supervisor.maxRestarts).toBe(2);
    expect(loaded.config.supervisor.heartbeatIntervalMs).toBe(DEFAULT_CONFIG.supervisor.heartbeatIntervalMs);
    expect(loaded.problems).toEqual([]);
  });

  it('file non valido, chiave sconosciuta o versione futura → default, file intatto', () => {
    const dir = home();
    const cases: Array<[string, RegExp]> = [
      ['{ non json', /JSON non valido/],
      [JSON.stringify({ version: 1, sconosciuta: true }), /non valida/],
      [JSON.stringify({ version: 99 }), /più recente/],
      [JSON.stringify({ logging: { level: 'info' } }), /versione mancante/]
    ];
    cases.forEach(([content, problem], i) => {
      const file = join(dir, `c${i}.json`);
      writeFileSync(file, content);
      const loaded = loadConfig(file, { env: {}, createIfMissing: true });
      expect(loaded.source).toBe('defaults');
      expect(loaded.problems.join(' ')).toMatch(problem);
      expect(readFileSync(file, 'utf8')).toBe(content);
    });
  });

  it('rifiuta valori con forma di segreto nel file', () => {
    const file = join(home(), 'visione.json');
    writeFileSync(file, JSON.stringify({ version: 1, note: `nvapi-${'k'.repeat(30)}` }));
    const loaded = loadConfig(file, { env: {} });
    expect(loaded.source).toBe('defaults');
    expect(loaded.problems.join(' ')).toMatch(/forma di segreto/);
    expect(JSON.stringify(loaded)).not.toContain('nvapi-kkk');
  });

  it('applica VISIONE_LOG_LEVEL e ignora valori non validi', () => {
    const file = join(home(), 'visione.json');
    expect(loadConfig(file, { env: { VISIONE_LOG_LEVEL: 'debug' } }).config.logging.level).toBe('debug');
    const bad = loadConfig(file, { env: { VISIONE_LOG_LEVEL: 'verbose' } });
    expect(bad.config.logging.level).toBe('info');
    expect(bad.problems.join(' ')).toMatch(/VISIONE_LOG_LEVEL/);
  });

  it('17/10/2026: il vecchio predefinito heartbeatTimeoutMs 10 s scritto nel file diventa 30 s; un valore a mano resta', () => {
    const lift = (ms: number) => (migrateConfig({ version: CONFIG_VERSION, supervisor: { heartbeatTimeoutMs: ms } }) as { value: { supervisor: { heartbeatTimeoutMs: number } } }).value.supervisor.heartbeatTimeoutMs;
    expect(lift(10_000)).toBe(30_000);
    expect(lift(12_000)).toBe(12_000);
    expect(DEFAULT_CONFIG.supervisor.heartbeatTimeoutMs).toBe(30_000);
  });

  it('migrateConfig riconosce solo la versione corrente', () => {
    expect(migrateConfig({ version: CONFIG_VERSION }).ok).toBe(true);
    expect(migrateConfig([]).ok).toBe(false);
    expect(migrateConfig(null).ok).toBe(false);
  });

  it('voce P-84/P-103/P-110: provider TTS predefinito la voce VISIONE (Cosimo di Windows come ripiego); Windows, Kokoro ed Edge restano validi', () => {
    expect(DEFAULT_CONFIG.voice.tts).toEqual({ provider: 'visione', voice: 'Microsoft Cosimo', rate: '+8%', pitch: '-2Hz' });
    const kokoro = visioneConfigSchema.safeParse({ version: 1, voice: { tts: { provider: 'kokoro' } } });
    expect(kokoro.success && kokoro.data.voice.tts.provider).toBe('kokoro');
    const windows = visioneConfigSchema.safeParse({ version: 1, voice: { tts: { provider: 'windows' } } });
    expect(windows.success && windows.data.voice.tts.provider).toBe('windows');
    const edge = visioneConfigSchema.safeParse({ version: 1, voice: { tts: { provider: 'edge', voice: 'it-IT-DiegoNeural' } } });
    expect(edge.success).toBe(true);
    if (edge.success) expect(edge.data.voice.tts).toEqual({ provider: 'edge', voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz' });
    expect(visioneConfigSchema.safeParse({ version: 1, voice: { tts: { provider: 'cloud' } } }).success).toBe(false);
    expect(visioneConfigSchema.safeParse({ version: 1, voice: { tts: { provider: 'edge', voice: '' } } }).success).toBe(false);
  });

  it('interfaccia P-85/P-99: default interattivo e nome del Director', () => {
    expect(DEFAULT_CONFIG.ui).toEqual({ desktop: false, fullscreen: true, scene: 'jarvis', directorName: 'Director', nodeLingerSec: 30, startWithWindows: false, expert: false, light: false, guideSeen: false, weatherCity: '' });
    const wall = visioneConfigSchema.safeParse({ version: 1, ui: { desktop: true } });
    expect(wall.success).toBe(true);
    if (wall.success) expect(wall.data.ui).toEqual({ desktop: true, fullscreen: true, scene: 'jarvis', directorName: 'Director', nodeLingerSec: 30, startWithWindows: false, expert: false, light: false, guideSeen: false, weatherCity: '' });
    // P-99: il nome del Director si può cambiare (persistito) ma non può essere vuoto.
    const named = visioneConfigSchema.safeParse({ version: 1, ui: { directorName: 'Capo' } });
    expect(named.success).toBe(true);
    if (named.success) expect(named.data.ui.directorName).toBe('Capo');
    expect(visioneConfigSchema.safeParse({ version: 1, ui: { directorName: '   ' } }).success).toBe(false);
  });

  it('scena P-89: default jarvis, pixel-office valida, valori estranei rifiutati', () => {
    expect(DEFAULT_CONFIG.ui.scene).toBe('jarvis');
    const office = visioneConfigSchema.safeParse({ version: 1, ui: { scene: 'pixel-office' } });
    expect(office.success).toBe(true);
    if (office.success) expect(office.data.ui.scene).toBe('pixel-office');
    expect(visioneConfigSchema.safeParse({ version: 1, ui: { scene: 'ufficio' } }).success).toBe(false);
  });

  it('coder P-91: abilitato con id e nome neutri, modello vuoto = agents.defaultModel', () => {
    expect(DEFAULT_CONFIG.agents.coder).toEqual({ enabled: true, agentId: 'coder', name: 'Coder', model: '' });
    const custom = visioneConfigSchema.safeParse({ version: 1, agents: { coder: { model: 'nvidia/deepseek-ai/deepseek-v4.1-flash', enabled: false } } });
    expect(custom.success).toBe(true);
    if (custom.success) expect(custom.data.agents.coder).toEqual({ enabled: false, agentId: 'coder', name: 'Coder', model: 'nvidia/deepseek-ai/deepseek-v4.1-flash' });
  });

  it('ultra P-93: analista Nemo Ultra garantito, modello vuoto = non creato finché non configurato', () => {
    expect(DEFAULT_CONFIG.agents.ultra).toEqual({ enabled: true, agentId: 'ultra', name: 'Ultra', model: '' });
    const custom = visioneConfigSchema.safeParse({ version: 1, agents: { ultra: { model: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', enabled: false } } });
    expect(custom.success).toBe(true);
    if (custom.success) expect(custom.data.agents.ultra).toEqual({ enabled: false, agentId: 'ultra', name: 'Ultra', model: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b' });
    expect(visioneConfigSchema.safeParse({ version: 1, agents: { ultra: { agentId: '' } } }).success).toBe(false);
  });
});

describe('percorsi', () => {
  it('VISIONE_HOME assoluta ha la precedenza; altrimenti profilo dev o installato', () => {
    const appData = home();
    const override = home();
    expect(resolveHome({ VISIONE_HOME: override }, { appDataDir: appData, packaged: true })).toBe(override);
    expect(resolveHome({}, { appDataDir: appData, packaged: true })).toBe(join(appData, 'VISIONE'));
    expect(resolveHome({}, { appDataDir: appData, packaged: false })).toBe(join(appData, 'VISIONE-dev'));
    expect(() => resolveHome({ VISIONE_HOME: 'relativo' }, { appDataDir: appData, packaged: true })).toThrow(/assoluto/);
  });

  it('migra la home storica PROTON-dev nella nuova VISIONE-dev (una tantum)', () => {
    const appData = home();
    mkdirSync(join(appData, 'PROTON-dev', 'config'), { recursive: true });
    writeFileSync(join(appData, 'PROTON-dev', 'config', 'proton.json'), '{}');
    expect(resolveHome({}, { appDataDir: appData, packaged: false })).toBe(join(appData, 'VISIONE-dev'));
    expect(existsSync(join(appData, 'PROTON-dev'))).toBe(false);
    expect(existsSync(join(appData, 'VISIONE-dev', 'config', 'proton.json'))).toBe(true);
    expect(pendingLegacyHome({}, { appDataDir: appData, packaged: false })).toBeNull();
  });

  it('resolvePaths migra config e database storici al primo uso', () => {
    const h = home();
    mkdirSync(join(h, 'config'), { recursive: true });
    mkdirSync(join(h, 'data'), { recursive: true });
    writeFileSync(join(h, 'config', 'proton.json'), '{}');
    writeFileSync(join(h, 'data', 'proton.db'), 'db');
    writeFileSync(join(h, 'data', 'proton.db-wal'), 'wal');
    const p = resolvePaths(h);
    expect(existsSync(p.configFile)).toBe(true);
    expect(existsSync(join(h, 'config', 'proton.json'))).toBe(false);
    expect(existsSync(p.dbFile)).toBe(true);
    expect(existsSync(join(h, 'data', 'visione.db-wal'))).toBe(true);
    expect(existsSync(join(h, 'data', 'proton.db-wal'))).toBe(false);
  });

  it('il layout dei dati è sotto la home', () => {
    const h = home();
    const p = resolvePaths(h);
    for (const value of Object.values(p)) expect(value.startsWith(h)).toBe(true);
    expect(p.dbFile).toBe(join(h, 'data', 'visione.db'));
    mkdirSync(p.dataDir, { recursive: true });
  });
});

describe('segreti', () => {
  it('risolve solo per nome di variabile, senza esporre il valore nella descrizione', () => {
    const ref = secretRefSchema.parse({ env: 'NVIDIA_API_KEY' });
    expect(resolveSecret(ref, { NVIDIA_API_KEY: 'valore' })).toBe('valore');
    expect(resolveSecret(ref, { NVIDIA_API_KEY: '  ' })).toBeUndefined();
    expect(describeSecret(ref, { NVIDIA_API_KEY: 'valore' })).toEqual({ ref: 'env:NVIDIA_API_KEY', present: true });
    expect(secretRefSchema.safeParse({ env: 'nome-non-valido' }).success).toBe(false);
    expect(secretRefSchema.safeParse({ env: 'X', value: 'segreto' }).success).toBe(false);
  });
});
