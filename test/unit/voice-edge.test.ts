// Voce Edge (P-84): costruzione di URL/SSML/messaggi, parsing dei frame, robustezza a risposte
// anomale e fallback su Kokoro. Nessuna rete: la connessione è finta (`connect` iniettato) e i
// messaggi del servizio sono fixture costruite qui; le latenze usano un orologio finto.
import { describe, expect, it } from 'vitest';
import {
  buildConfigMessage,
  buildEdgeUrl,
  buildSsml,
  buildSsmlMessage,
  createEdgeTts,
  createTtsForProvider,
  edgeHeaders,
  escapeXml,
  parseAudioFrame,
  secMsGec,
  type EdgeConnect,
  type EdgeTimers
} from '../../src/voice/edge.ts';
import type { TtsChunk, TtsEngine } from '../../src/voice/engines.ts';
import { Mp3Framer, mp3FrameSize } from '../../src/voice/mp3.ts';
import type { WsHandlers, WsSocket } from '../../src/voice/ws.ts';

// --- fixture del protocollo ------------------------------------------------------------------------

/** Frame WebSocket con FIN e opcode scelti (lato server, mai mascherato): non usa `src/voice/ws.ts`. */
function serverFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const header: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length <= 125) header.push(payload.length);
  else if (payload.length <= 0xffff) header.push(126, payload.length >> 8, payload.length & 0xff);
  else {
    header.push(127);
    const big = BigInt(payload.length);
    for (let i = 7; i >= 0; i--) header.push(Number((big >> BigInt(8 * i)) & 0xffn));
  }
  const out = new Uint8Array(header.length + payload.length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Frame binario del servizio (payload del messaggio WebSocket): 2 byte di lunghezza, intestazione, audio. */
function edgeAudioFrame(path: string, audio: Uint8Array): Uint8Array {
  const header = enc(`X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:${path}\r\n`);
  const body = new Uint8Array(2 + header.length + audio.length);
  body[0] = header.length >> 8;
  body[1] = header.length & 0xff;
  body.set(header, 2);
  body.set(audio, 2 + header.length);
  return body;
}

/** Un frame MP3 sintetico valido (MPEG-2 Layer III, 24 kHz, 48 kbps → 144 byte reali). */
function mp3Frame(fill: number): Uint8Array {
  const frame = new Uint8Array(144).fill(fill);
  frame[0] = 0xff;
  frame[1] = 0xf2; // MPEG-2, Layer III
  frame[2] = 0x64; // 48 kbps, 24 kHz, no padding → 144 byte
  frame[3] = 0x00;
  return frame;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --- doppioni di connessione ----------------------------------------------------------------------

class FakeSocket implements WsSocket {
  readonly sent: string[] = [];
  closed = false;
  terminated = false;
  readonly handlers: WsHandlers;
  constructor(handlers: WsHandlers) {
    this.handlers = handlers;
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
    this.handlers.close();
  }
  terminate(): void {
    this.terminated = true;
  }
}

class FakeClock {
  nowMs = 1_700_000_000_000;
  private tasks = new Map<number, () => void>();
  private seq = 0;
  readonly timers: EdgeTimers = {
    set: (fn) => {
      const id = ++this.seq;
      this.tasks.set(id, fn);
      return id;
    },
    clear: (handle) => {
      this.tasks.delete(handle as number);
    }
  };
  fire(): void {
    const next = [...this.tasks.entries()][0];
    if (!next) return;
    this.tasks.delete(next[0]);
    next[1]();
  }
  get pending(): number {
    return this.tasks.size;
  }
}

function fakeEnv() {
  const sockets: FakeSocket[] = [];
  let url = '';
  let headers: Record<string, string> = {};
  const clock = new FakeClock();
  const connect: EdgeConnect = (u, h, handlers) => {
    url = u;
    headers = h;
    const socket = new FakeSocket(handlers);
    sockets.push(socket);
    return socket;
  };
  return {
    sockets,
    clock,
    connect,
    get url() {
      return url;
    },
    get headers() {
      return headers;
    }
  };
}

const VERSION = '154.0.4258.53';

function makeEngine(env: ReturnType<typeof fakeEnv>, extra: Partial<Parameters<typeof createEdgeTts>[0]> = {}) {
  return createEdgeTts({
    voice: 'it-IT-DiegoNeural',
    rate: '+8%',
    pitch: '-2Hz',
    connect: env.connect,
    version: () => VERSION,
    now: () => env.clock.nowMs,
    timers: env.clock.timers,
    ...extra
  });
}

class RecordingTts implements TtsEngine {
  readonly name = 'kokoro if_sara';
  readonly texts: string[] = [];
  synthesize(text: string, onChunk: (chunk: TtsChunk) => boolean): Promise<void> {
    this.texts.push(text);
    onChunk({ kind: 'pcm', samples: new Float32Array(4), sampleRate: 24_000 });
    return Promise.resolve();
  }
}

// --- test ------------------------------------------------------------------------------------------

describe('protocollo Edge (P-84)', () => {
  it('secMsGec: SHA-256 dei tick Windows arrotondati a 5 minuti (valori fissi), stabile nel blocco', () => {
    expect(secMsGec(0)).toBe('7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C');
    expect(secMsGec(1_700_000_000_000)).toBe('42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF');
    expect(secMsGec(1_700_000_060_000)).toBe(secMsGec(1_700_000_000_000));
    expect(secMsGec(1_700_000_150_000)).not.toBe(secMsGec(1_700_000_000_000));
  });

  it('escapeXml e SSML: testo escapato, voce e prosodia richieste, lingua italiana', () => {
    expect(escapeXml(`a<b>&"'`)).toBe('a&lt;b&gt;&amp;&quot;&apos;');
    const ssml = buildSsml({ text: 'Ciao & <amici>', voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz' });
    expect(ssml).toContain(`xml:lang='it-IT'`);
    expect(ssml).toContain(`name='it-IT-DiegoNeural'`);
    expect(ssml).toContain(`rate='+8%'`);
    expect(ssml).toContain(`pitch='-2Hz'`);
    expect(ssml).toContain('Ciao &amp; &lt;amici&gt;');
    expect(ssml).not.toContain('<amici>');
    const message = buildSsmlMessage('req-1', ssml);
    expect(message).toContain('X-RequestId:req-1');
    expect(message).toContain('Content-Type:application/ssml+xml');
    expect(message).toContain('Path:ssml');
    expect(message.endsWith(ssml)).toBe(true);
  });

  it('messaggio di configurazione: JSON valido con MP3 24 kHz e niente confini di parola', () => {
    const message = buildConfigMessage();
    expect(message).toContain('Path:speech.config');
    expect(message).toContain('Content-Type:application/json');
    const json = JSON.parse(message.split('\r\n\r\n')[1]!);
    expect(json.context.synthesis.audio.outputFormat).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(json.context.synthesis.audio.metadataoptions).toEqual({ sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' });
  });

  it('URL e header: token pubblico, ConnectionId, GEC e versione; Origin/User-Agent browser', () => {
    const url = buildEdgeUrl({ chromium: VERSION, connectionId: 'abc123', gec: 'ABC' });
    expect(url).toContain('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1');
    expect(url).toContain('TrustedClientToken=');
    expect(url).toContain('ConnectionId=abc123');
    expect(url).toContain('Sec-MS-GEC=ABC');
    expect(url).toContain(`Sec-MS-GEC-Version=1-${VERSION}`);
    const headers = edgeHeaders(VERSION);
    expect(headers.Origin).toMatch(/^chrome-extension:\/\//);
    expect(headers['User-Agent']).toContain('Edg/154');
  });

  it('parseAudioFrame: frame valido, troncato e path non audio', () => {
    const audio = mp3Frame(1);
    const parsed = parseAudioFrame(edgeAudioFrame('audio', audio));
    expect(parsed).toMatchObject({ path: 'audio' });
    expect(parsed?.audio).toEqual(audio);
    expect(parseAudioFrame(new Uint8Array([0x00]))).toBeNull();
    expect(parseAudioFrame(new Uint8Array([0x00, 0xff, 1, 2]))).toBeNull(); // intestazione oltre il frame
    expect(parseAudioFrame(edgeAudioFrame('audio.metadata', new Uint8Array(0)))?.path).toBe('audio.metadata');
  });
});

describe('Mp3Framer', () => {
  it('riconosce i frame MPEG-2 Layer III a 24 kHz/48 kbps e scarta il rumore fuori sincrono', () => {
    const frame = mp3Frame(7);
    expect(mp3FrameSize(frame, 0)).toBe(144);
    expect(mp3FrameSize(join(new Uint8Array([1, 2, 3]), frame), 3)).toBe(144);
    expect(mp3FrameSize(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 0)).toBe(417); // MPEG-1 Layer III 128 kbps
    expect(mp3FrameSize(new Uint8Array([0, 0, 0, 0]), 0)).toBeNull();
    expect(mp3FrameSize(new Uint8Array([0xff, 0xf2, 0x04, 0x00]), 0)).toBeNull(); // bitrate 0 (libero)
  });

  it('emette solo frame interi e conserva il parziale tra i blocchi', () => {
    const framer = new Mp3Framer();
    const whole = join(mp3Frame(1), mp3Frame(2));
    expect(framer.feed(whole.subarray(0, 100))).toEqual([]); // frame incompleto
    const first = framer.feed(whole.subarray(100, 150)); // completa il primo frame, restano 6 byte
    expect(first).toHaveLength(1);
    expect(first[0]!.length).toBe(144);
    expect(framer.feed(whole.subarray(150, 200))).toEqual([]); // 56 byte: ancora incompleto
    const second = framer.feed(whole.subarray(200)); // 56 + 88 = 144: il secondo frame è intero
    expect(second).toHaveLength(1);
    expect(second[0]!.length).toBe(144);
    expect(framer.flush()).toBeNull();
  });

  it('salta il rumore iniziale e conserva la coda non allineata in flush', () => {
    const framer = new Mp3Framer();
    const out = framer.feed(join(new Uint8Array([9, 9]), mp3Frame(3)));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(144);
    expect(framer.frames).toBe(1);
    const framer2 = new Mp3Framer();
    framer2.feed(mp3Frame(4).subarray(0, 50));
    const tail = framer2.flush();
    expect(tail?.length).toBe(50);
    expect(framer2.flush()).toBeNull();
  });
});

describe('motore Edge con connessione finta', () => {
  it('invia config e SSML nell\'ordine giusto e risolve al turn.end con i blocchi MP3', async () => {
    const env = fakeEnv();
    const engine = makeEngine(env);
    const chunks: Uint8Array[] = [];
    const done = engine.synthesize('Buonasera, & signore.', (chunk) => {
      if (chunk.kind === 'mp3') chunks.push(chunk.bytes);
      return true;
    });
    const socket = env.sockets[0]!;
    expect(socket.sent).toEqual([]); // niente prima dell'apertura
    socket.handlers.open();
    expect(socket.sent[0]).toContain('Path:speech.config');
    expect(socket.sent[1]).toContain('Path:ssml');
    expect(socket.sent[1]).toContain('Buonasera, &amp; signore.');
    expect(env.url).toContain(`Sec-MS-GEC-Version=1-${VERSION}`);
    expect(env.headers.Origin).toMatch(/^chrome-extension:\/\//);

    // Audio spezzato in due frame binari: il framer deve produrre solo frame interi.
    const audio = join(mp3Frame(1), mp3Frame(2), mp3Frame(3));
    socket.handlers.message(edgeAudioFrame('audio', audio.subarray(0, 200)));
    socket.handlers.message(edgeAudioFrame('audio', audio.subarray(200)));
    socket.handlers.message('X-RequestId:abc\r\nPath:turn.end\r\n\r\n');
    await done;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(audio.length);
    expect(chunks.every((c) => c.length % 144 === 0)).toBe(true);
    expect(chunks[0]![0]).toBe(0xff);
    expect(socket.closed).toBe(true);
  });

  it('risposte anomale: frame troncato e header non audio ignorati, poi errore onesto senza audio', async () => {
    const env = fakeEnv();
    const engine = makeEngine(env);
    const done = engine.synthesize('Ciao', () => true);
    const socket = env.sockets[0]!;
    socket.handlers.open();
    socket.handlers.message(serverFrame(0x2, new Uint8Array([0x00, 0xff, 0x01]))); // intestazione oltre il frame
    socket.handlers.message(edgeAudioFrame('audio.metadata', new Uint8Array(0)));
    socket.handlers.message('X-RequestId:abc\r\nPath:turn.end\r\n\r\n');
    await expect(done).rejects.toThrow(/nessun audio ricevuto/);
  });

  it('errore del websocket: reject; il timeout termina il socket e fallisce', async () => {
    const env = fakeEnv();
    const engine = makeEngine(env);
    const failed = engine.synthesize('Ciao', () => true);
    const socket = env.sockets[0]!;
    socket.handlers.open();
    socket.handlers.error(new Error('boom'));
    await expect(failed).rejects.toThrow('boom');

    const env2 = fakeEnv();
    const engine2 = makeEngine(env2);
    const timedOut = engine2.synthesize('Ciao', () => true);
    const socket2 = env2.sockets[0]!;
    socket2.handlers.open();
    expect(env2.clock.pending).toBe(1);
    env2.clock.fire();
    await expect(timedOut).rejects.toThrow(/nessuna risposta/);
    expect(socket2.terminated).toBe(true);
  });
});

describe('ripiego su Kokoro (P-84)', () => {
  it('Edge fallisce prima dell\'audio: parla Kokoro, con notifica; per 30 s non si ritenta Edge', async () => {
    const env = fakeEnv();
    const fallback = new RecordingTts();
    const reasons: string[] = [];
    const engine = makeEngine(env, { fallback, onFallback: (reason) => reasons.push(reason) });
    const chunks: TtsChunk[] = [];
    const first = engine.synthesize('Prima frase', (chunk) => {
      chunks.push(chunk);
      return true;
    });
    const socket = env.sockets[0]!;
    socket.handlers.open();
    socket.handlers.error(new Error('rete assente'));
    await first;
    expect(fallback.texts).toEqual(['Prima frase']);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('pcm');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('rete assente');

    // Circuito aperto: la seconda frase va dritta al ripiego, senza nuova connessione.
    await engine.synthesize('Seconda frase', () => true);
    expect(fallback.texts).toEqual(['Prima frase', 'Seconda frase']);
    expect(env.sockets).toHaveLength(1);

    // Dopo il raffreddamento Edge è ritentato.
    env.clock.nowMs += 31_000;
    const third = engine.synthesize('Terza frase', () => true);
    expect(env.sockets).toHaveLength(2);
    env.sockets[1]!.handlers.error(new Error('ancora giù'));
    await third;
    expect(fallback.texts).toEqual(['Prima frase', 'Seconda frase', 'Terza frase']);
  });

  it('Edge fallisce dopo aver consegnato audio: nessun doppio parlato, errore dichiarato', async () => {
    const env = fakeEnv();
    const fallback = new RecordingTts();
    const engine = makeEngine(env, { fallback });
    const done = engine.synthesize('Frase lunga', () => true);
    const socket = env.sockets[0]!;
    socket.handlers.open();
    socket.handlers.message(edgeAudioFrame('audio', mp3Frame(5)));
    socket.handlers.error(new Error('caduto a metà'));
    await expect(done).rejects.toThrow(/interrotta dopo l'inizio/);
    expect(fallback.texts).toEqual([]);
  });

  it('senza ripiego l\'errore arriva al chiamante; il motivo non è mai vuoto', async () => {
    const env = fakeEnv();
    const engine = makeEngine(env);
    expect(engine.name).toBe('edge it-IT-DiegoNeural');
    const done = engine.synthesize('Ciao', () => true);
    env.sockets[0]!.handlers.error(new Error('giù'));
    await expect(done).rejects.toThrow(/voce Edge non disponibile: giù/);

    // Un errore di rete senza messaggio non deve produrre un motivo vuoto (visto nell'app reale).
    const env2 = fakeEnv();
    const engine2 = makeEngine(env2);
    const empty = engine2.synthesize('Ciao', () => true);
    env2.sockets[0]!.handlers.error(new Error(''));
    await expect(empty).rejects.toThrow(/voce Edge non disponibile: errore senza dettaglio/);
  });
});

describe('selezione provider (P-84)', () => {
  it('kokoro: resta il motore locale e il riscaldamento lo usa; nessuna rete', async () => {
    const kokoro = new RecordingTts();
    const chosen = createTtsForProvider({ provider: 'kokoro', voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz' }, kokoro);
    expect(chosen.tts).toBe(kokoro);
    await chosen.warmup();
    expect(kokoro.texts).toEqual(['a']);
  });

  it('edge: avvolge il motore con il ripiego Kokoro e conserva la voce configurata', async () => {
    const env = fakeEnv();
    const kokoro = new RecordingTts();
    const reasons: string[] = [];
    const chosen = createTtsForProvider(
      { provider: 'edge', voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz' },
      kokoro,
      { onFallback: (r) => reasons.push(r), edge: { connect: env.connect, version: () => VERSION, now: () => env.clock.nowMs, timers: env.clock.timers } }
    );
    expect(chosen.tts.name).toBe('edge it-IT-DiegoNeural + kokoro');
    await chosen.warmup();
    expect(kokoro.texts).toEqual(['a']);

    const done = chosen.tts.synthesize('Prova selezione', () => true);
    const socket = env.sockets[0]!;
    socket.handlers.open();
    expect(socket.sent[1]).toContain(`name='it-IT-DiegoNeural'`);
    socket.handlers.error(new Error('offline'));
    await done;
    expect(kokoro.texts).toEqual(['a', 'Prova selezione']);
    expect(reasons).toHaveLength(1);
  });
});
