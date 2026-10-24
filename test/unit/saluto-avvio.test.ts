// Saluto all'avvio del 22/10/2026 («buongiorno signore bentornato, dice il meteo, fa una battuta, lo stato del PC e
// dei sistemi e se ha fatto qualcosa mentre non c'ero»): pezzi puri e testo per un modello rapido.
import { describe, expect, it } from 'vitest';
import { cleanQuip, composeBriefing, quipPrompt, resolveGreeting, weatherSentence, weatherWords, type BriefingFacts } from '../../src/core/assistant/briefing.ts';
import { NVIDIA_CHAT_URL, NVIDIA_QUICK_MODELS, nvidiaQuickText } from '../../src/core/adapters/providers/nvidia.ts';

const KEY = ['nvapi', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'].join('-');
const base: BriefingFacts = {
  greeting: 'Buongiorno signore, bentornato.', pc: { cpuPercent: 12, ramPercent: 48 }, engines: [{ name: 'OpenCode', ok: true }],
  unclean: false, unfinished: [], approvals: 0, agentsInError: [], agenda: null
};

describe('saluto dell\'ora', () => {
  it('{saluto} diventa buongiorno, buon pomeriggio o buonasera; maiuscola solo a inizio frase', () => {
    expect(resolveGreeting('{saluto} signore, bentornato.', 7)).toBe('Buongiorno signore, bentornato.');
    expect(resolveGreeting('{saluto} signore, bentornato.', 15)).toBe('Buon pomeriggio signore, bentornato.');
    expect(resolveGreeting('{saluto} signore, bentornato.', 23)).toBe('Buonasera signore, bentornato.');
    expect(resolveGreeting('{saluto} signore, bentornato.', 3)).toBe('Buonasera signore, bentornato.');
    expect(resolveGreeting('Signore, {saluto}.', 9)).toBe('Signore, buongiorno.');
    expect(resolveGreeting('{saluto}, sir. Welcome back.', 9, 'en')).toBe('Good morning, sir. Welcome back.');
    // Senza segnaposto la frase resta quella scelta dal proprietario.
    expect(resolveGreeting('Bentornato, signore.', 9)).toBe('Bentornato, signore.');
  });
});

describe('meteo detto a voce', () => {
  it('i simboli di MET in parole: prima i fenomeni, poi il cielo', () => {
    expect(weatherWords('clearsky_day')).toBe('cielo sereno');
    expect(weatherWords('partlycloudy_night')).toBe('cielo parzialmente nuvoloso');
    expect(weatherWords('lightrainshowersandthunder_day')).toBe('temporale');
    expect(weatherWords('heavyrain')).toBe('pioggia forte');
    expect(weatherWords('rainshowers_day')).toBe('rovesci');
    expect(weatherWords('lightsnow')).toBe('neve');
    expect(weatherWords('fog', 'en')).toBe('fog');
    expect(weatherWords('sconosciuto')).toBeNull();
    expect(weatherWords(null)).toBeNull();
  });

  it('adesso e il giorno; la sera si dice domani; sotto zero «meno»', () => {
    expect(weatherSentence({ place: 'Cassolnovo', tempC: 13.6, symbol: 'clearsky_day', day: { when: 'today', minC: 8.6, maxC: 17.2, symbol: 'fair_day' } }))
      .toBe('A Cassolnovo ci sono 14 gradi e cielo sereno. Oggi fra 9 e 17 gradi.');
    expect(weatherSentence({ place: 'Cassolnovo', tempC: -0.6, symbol: 'snow', day: { when: 'tomorrow', minC: -3, maxC: 2, symbol: 'lightrain' } }))
      .toBe("A Cassolnovo c'è meno 1 grado e neve. Domani pioggia leggera, fra meno 3 e 2 gradi.");
    expect(weatherSentence({ place: 'Rome', tempC: 20, symbol: null, day: null }, 'en')).toBe('In Rome it is 20 degrees.');
    expect(weatherSentence({ place: 'Roma', tempC: null, symbol: null, day: null })).toBeNull();
  });
});

describe('battuta', () => {
  it('la richiesta porta solo i fatti veri e vieta di inventarne', () => {
    const p = quipPrompt({ hour: 7, weekday: 3, pending: 0 });
    expect(p.system).toContain('UNA');
    expect(p.system).toContain('inventare fatti su di lui');
    expect(p.system).toContain('Non salutare');
    // Niente numeri del PC (la battuta li contraddiceva) e niente meteo (22/10/2026: lo dice già il saluto).
    expect(p.user).toBe('Ora: 7:00, mercoledì\nLavori in sospeso: 0');
    expect(quipPrompt({ hour: 21, weekday: 0, pending: 2 }, 'en').user).toBe('Time: 21:00, Sunday\nUnfinished jobs: 2');
  });

  it('frase motivazionale sul ridere, ispirata alle sue frasi, col tono imparato dai suoi giudizi', () => {
    const p = quipPrompt({
      hour: 9, weekday: 4, pending: 1,
      sayings: [{ ago: 'ieri', text: 'che faticaccia quel codice' }],
      liked: ['Anche Roma è stata un cantiere.'],
      disliked: ['Il lunedì è un lunedì.']
    });
    expect(p.system).toContain('motivazionale messa sul ridere');
    expect(p.system).toContain('mai su persone reali, lutti precisi');
    expect(p.system).toContain('niente meteo');
    expect(p.user).toBe('Ora: 9:00, giovedì\nLavori in sospeso: 1\n' +
      'Cose dette o chieste da lui di recente:\n- (ieri) che faticaccia quel codice\n' +
      'Battute che gli sono piaciute (segui questo tono):\n- Anche Roma è stata un cantiere.\n' +
      'Battute che non gli sono piaciute (evita questo tono, non ripeterle):\n- Il lunedì è un lunedì.');
  });

  it('una riga pulita, oppure niente', () => {
    expect(cleanQuip('«Il caffè lo preparo appena mi danno le mani, signore»')).toBe('Il caffè lo preparo appena mi danno le mani, signore.');
    expect(cleanQuip('**Oggi** il sole\nlavora più di me.')).toBe('Oggi il sole lavora più di me.');
    expect(cleanQuip('<think>forse</think> ciao')).toBeNull();
    expect(cleanQuip('ok')).toBeNull();
    expect(cleanQuip(Array(40).fill('parola').join(' '))).toBeNull();
    // Il saluto che il modello aggiunge si toglie; di più frasi resta la prima (prova vera del 22/10/2026).
    expect(cleanQuip('Buonasera. Alle due di notte il PC lavora più di lei. Un giovedì come tanti.')).toBe('Alle due di notte il PC lavora più di lei.');
    expect(cleanQuip('Good evening, sir. The clouds are as idle as your queue.')).toBe('The clouds are as idle as your queue.');
    expect(cleanQuip(null)).toBeNull();
  });
});

describe('composeBriefing con meteo, battuta e «mentre non c\'eri»', () => {
  it('nell\'ordine chiesto: saluto, meteo, battuta, PC e sistemi, cosa è successo', () => {
    const text = composeBriefing({
      ...base,
      weather: { place: 'Cassolnovo', tempC: 14, symbol: 'clearsky_day', day: null },
      quip: 'Il cielo è sereno, la casella di posta un po\' meno.',
      meanwhile: { done: ['Revisione del codice', 'Revisione del codice', 'Riassunto del progetto', 'Test della guidata'], failed: ['Ricerca dei prezzi'] }
    });
    expect(text).toBe([
      'Buongiorno signore, bentornato.',
      'A Cassolnovo ci sono 14 gradi e cielo sereno.',
      'Il cielo è sereno, la casella di posta un po\' meno.',
      'Il PC sta bene: processore al 12 per cento e memoria al 48 per cento.',
      'Ho verificato il motore: OpenCode è pronto.',
      'Dal tuo ultimo comando ho concluso «Revisione del codice» 2 volte, «Riassunto del progetto» e altri 1.',
      'Non è andato a buon fine «Ricerca dei prezzi».',
      'Nessun lavoro in sospeso.'
    ].join(' '));
  });

  it('senza meteo, battuta e lavori nuovi il saluto resta quello di prima', () => {
    expect(composeBriefing({ ...base, weather: null, quip: null, meanwhile: { done: [], failed: [] } }))
      .toBe(composeBriefing(base));
  });

  it('prima della procedura guidata solo il benvenuto: niente motori «non pronti», PC o recupero (VM, 22/10/2026)', () => {
    const facts: BriefingFacts = { ...base, firstRun: true, unclean: true, pc: { cpuPercent: 100, ramPercent: 81 }, engines: [{ name: 'Claude', ok: false, detail: 'non trovato' }] };
    expect(composeBriefing({ ...facts, greeting: 'VISIONE online. Sistemi operativi.' }))
      .toBe('VISIONE online. Sistemi operativi. Benvenuto: prepariamo VISIONE insieme, segui i passi sullo schermo.');
    expect(composeBriefing({ ...facts, greeting: 'VISIONE online. All systems operational.' }, 'en'))
      .toBe("VISIONE online. All systems operational. Welcome: let's set up VISIONE together, follow the steps on the screen.");
  });
});

describe('nvidiaQuickText', () => {
  it('ragionamento spento, chiave solo nell\'intestazione; un modello tolto passa al successivo', async () => {
    const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body });
      if (body.model === NVIDIA_QUICK_MODELS[0]) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: ' Battuta pronta. ' } }] }), { status: 200 });
    }) as typeof fetch;
    expect(await nvidiaQuickText(KEY, { system: 's', user: 'u', maxTokens: 80 }, fetchImpl, 4_000)).toBe('Battuta pronta.');
    expect(seen.map((s) => s.body.model)).toEqual([...NVIDIA_QUICK_MODELS]);
    expect(seen[1]).toMatchObject({ url: NVIDIA_CHAT_URL, auth: `Bearer ${KEY}`, body: { max_tokens: 80, stream: false, chat_template_kwargs: { enable_thinking: false } } });
    expect(JSON.stringify(seen.map((s) => s.body))).not.toContain(KEY);
    // «quality» (la battuta del saluto): prima il modello grande.
    seen.length = 0;
    expect(await nvidiaQuickText(KEY, { system: 's', user: 'u', maxTokens: 80, prefer: 'quality' }, fetchImpl, 4_000)).toBe('Battuta pronta.');
    expect(seen.map((s) => s.body.model)).toEqual([NVIDIA_QUICK_MODELS[1]]);
  });

  it('chiave assente, rete giù o tempo finito: null, mai un errore', async () => {
    const never = (async () => { throw new Error('non doveva chiamare'); }) as typeof fetch;
    expect(await nvidiaQuickText('', { system: 's', user: 'u', maxTokens: 80 }, never)).toBeNull();
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await nvidiaQuickText(KEY, { system: 's', user: 'u', maxTokens: 80 }, down)).toBeNull();
    const silent = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const t0 = Date.now();
    expect(await nvidiaQuickText(KEY, { system: 's', user: 'u', maxTokens: 80 }, silent, 600)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
