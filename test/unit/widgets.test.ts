// Widget del cruscotto (11/10/2026): serie e onde dei grafici, simboli del meteo, città valide; e il
// meteo del core — solo i due host consentiti, lettura delle risposte reali, memoria fino a scadenza.
import { describe, expect, it } from 'vitest';
import { cityValid, gb, pushSample, rateText, SERIES_MAX, wavePath, weatherKind } from '../../src/renderer/app/widgets/widgets-logic.ts';
import { cacheUntil, createWeather, parseMet, parsePlace, WEATHER_HOSTS, type WeatherFetch } from '../../src/core/weather/index.ts';

describe('grafici: serie e onda con il picco', () => {
  it('la serie tiene gli ultimi 120 campioni reali; i valori non finiti si scartano', () => {
    let s: number[] = [];
    for (let i = 0; i < 130; i++) s = pushSample(s, i);
    expect(s.length).toBe(SERIES_MAX);
    expect(s[0]).toBe(10);
    expect(s.at(-1)).toBe(129);
    expect(pushSample(s, Number.NaN)).toBe(s);
    expect(pushSample(s, null)).toBe(s);
  });

  it('onda: passa per i campioni, l\'ultimo sul bordo destro, il picco è il massimo (il più recente a parità)', () => {
    const w = wavePath([10, 80, 30, 80, 20], 300, 40, 100, 5);
    expect(w.line.startsWith('M0,')).toBe(true);
    expect(w.peak).toMatchObject({ i: 3, v: 80, x: 225 });
    expect(w.peak!.y).toBeCloseTo(40 - 0.8 * 38 - 1, 5);
    expect(w.area.endsWith('Z')).toBe(true);
    // Pochi campioni: stanno a destra (il tempo scorre da destra a sinistra), non stirati.
    const few = wavePath([50, 60], 300, 40, 100);
    expect(few.peak!.x).toBe(300);
    expect(wavePath([], 300, 40)).toEqual({ line: '', area: '', peak: null });
    // Fondo scala libero (rete): il massimo della finestra con margine, mai fuori dal riquadro.
    const free = wavePath([1, 1000, 5], 300, 40, null, 3);
    expect(free.peak!.y).toBeGreaterThan(0);
  });

  it('unità leggibili', () => {
    expect(gb(1024 ** 3 * 1.5)).toBeCloseTo(1.5, 9);
    expect(gb(null)).toBeNull();
    expect(rateText(512)).toBe('512 B/s');
    expect(rateText(2048)).toBe('2.0 KB/s');
    expect(rateText(3 * 1024 ** 2)).toBe('3.0 MB/s');
  });
});

describe('meteo: simboli e città', () => {
  it('i simboli di MET Norway diventano un tipo di tempo', () => {
    expect(weatherKind('clearsky_day')).toBe('clear');
    expect(weatherKind('partlycloudy_night')).toBe('partly');
    expect(weatherKind('lightrainshowersandthunder_day')).toBe('thunder');
    expect(weatherKind('heavysleet')).toBe('sleet');
    expect(weatherKind('lightrain')).toBe('lightrain');
    expect(weatherKind('fog')).toBe('fog');
    expect(weatherKind(null)).toBe('unknown');
    expect(weatherKind('qualcosa')).toBe('unknown');
  });

  it('città: lettere (anche accentate), spazi, apostrofi; niente indirizzi o comandi', () => {
    for (const ok of ['Roma', "L'Aquila", 'Reggio nell’Emilia', 'São Paulo', 'Zürich', 'Saint-Étienne', 'New York']) expect(cityValid(ok), ok).toBe(true);
    for (const no of ['', 'R', 'http://x', '12345', 'Roma; rm -rf', 'a'.repeat(81), '<script>']) expect(cityValid(no), no).toBe(false);
  });
});

const MET_SAMPLE = {
  properties: {
    meta: { updated_at: '2026-10-11T01:30:00Z' },
    timeseries: [
      { time: '2026-10-11T01:00:00Z', data: { instant: { details: { air_temperature: 15.2, relative_humidity: 98, wind_speed: 1.6 } }, next_1_hours: { summary: { symbol_code: 'fog' } }, next_6_hours: { summary: { symbol_code: 'fog' } } } },
      { time: '2026-10-11T11:00:00Z', data: { instant: { details: { air_temperature: 23.8 } }, next_6_hours: { summary: { symbol_code: 'partlycloudy_day' } } } },
      { time: '2026-10-11T20:00:00Z', data: { instant: { details: { air_temperature: 17 } }, next_1_hours: { summary: { symbol_code: 'clearsky_night' } } } },
      { time: '2026-10-12T05:00:00Z', data: { instant: { details: { air_temperature: 14.1 } }, next_6_hours: { summary: { symbol_code: 'clearsky_day' } } } },
      { time: '2026-10-12T11:00:00Z', data: { instant: { details: { air_temperature: 24.4 } }, next_6_hours: { summary: { symbol_code: 'clearsky_day' } } } }
    ]
  }
};

describe('meteo nel core', () => {
  it('Nominatim: primo risultato → luogo; risposte vuote o rotte → nessun luogo', () => {
    expect(parsePlace([{ lat: '41.8933', lon: '12.4829', name: 'Roma', address: { state: 'Lazio', country: 'Italia' } }])).toEqual({ name: 'Roma', region: 'Lazio', country: 'Italia', lat: 41.8933, lon: 12.4829 });
    expect(parsePlace([])).toBeNull();
    expect(parsePlace({ error: 'x' })).toBeNull();
    expect(parsePlace([{ lat: 'nord', lon: '12' }])).toBeNull();
  });

  it('MET Norway: adesso è la riga più vicina; i giorni nell\'ora locale stimata, min/max e simbolo di mezzogiorno', () => {
    const r = parseMet(MET_SAMPLE, 12.48, Date.parse('2026-10-11T01:48:00Z'))!;
    expect(r.now).toEqual({ at: '2026-10-11T01:00:00Z', tempC: 15.2, symbol: 'fog', windMs: 1.6, humidity: 98 });
    expect(r.days.map((d) => d.date)).toEqual(['2026-10-11', '2026-10-12']);
    expect(r.days[0]).toMatchObject({ minC: 15.2, maxC: 23.8, symbol: 'partlycloudy_day' });
    expect(r.days[1]).toMatchObject({ minC: 14.1, maxC: 24.4, symbol: 'clearsky_day' });
    expect(r.updatedAt).toBe('2026-10-11T01:30:00Z');
    expect(parseMet({}, 0, 0)).toBeNull();
  });

  it('scadenza della previsione: quella del server fra 10 e 60 minuti; senza intestazione 30', () => {
    const now = Date.parse('2026-10-11T02:00:00Z');
    expect(cacheUntil('Sun, 11 Oct 2026 02:25:00 GMT', now) - now).toBe(25 * 60_000);
    expect(cacheUntil('Sun, 11 Oct 2026 02:01:00 GMT', now) - now).toBe(10 * 60_000);
    expect(cacheUntil('Sun, 11 Oct 2026 05:00:00 GMT', now) - now).toBe(60 * 60_000);
    expect(cacheUntil(null, now) - now).toBe(30 * 60_000);
  });

  it('chiede solo ai due host, si identifica, ricorda luogo e previsione fino a scadenza', async () => {
    const calls: Array<{ url: string; ua: string }> = [];
    let now = Date.parse('2026-10-11T01:48:00Z');
    const fetchFake: WeatherFetch = async (url, init) => {
      calls.push({ url, ua: init.headers['User-Agent'] ?? '' });
      const body = url.includes('nominatim') ? [{ lat: '41.8933', lon: '12.4829', name: 'Roma', address: { country: 'Italia' } }] : MET_SAMPLE;
      return { ok: true, status: 200, headers: { get: (n: string) => (n === 'expires' ? 'Sun, 11 Oct 2026 02:30:00 GMT' : null) }, text: async () => JSON.stringify(body) };
    };
    const w = createWeather({ userAgent: 'VISIONE/prova', fetch: fetchFake, now: () => now });
    const a = await w.report('Roma', 'it');
    expect(a.cached).toBe(false);
    expect(a.place.name).toBe('Roma');
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['nominatim.openstreetmap.org', 'api.met.no']);
    expect(calls.every((c) => c.ua === 'VISIONE/prova')).toBe(true);
    // Coordinate a 2 decimali verso MET (il servizio ne accetta al più 4).
    expect(calls[1]!.url).toContain('lat=41.89&lon=12.48');
    expect(calls[0]!.url).toContain('accept-language=it');
    const b = await w.report(' roma ', 'it');
    expect(b.cached).toBe(true);
    expect(calls.length).toBe(2);
    now += 45 * 60_000; // oltre la scadenza del server
    expect((await w.report('Roma', 'it')).cached).toBe(false);
    expect(calls.length).toBe(3); // il luogo resta in memoria, si richiede solo la previsione
    expect(WEATHER_HOSTS).toEqual(['nominatim.openstreetmap.org', 'api.met.no']);
  });

  it('città sconosciuta, servizio giù o risposta enorme: errore chiaro, nessun dato inventato', async () => {
    const reply = (status: number, body: string): WeatherFetch => async () => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => body });
    await expect(createWeather({ userAgent: 'x', fetch: reply(200, '[]') }).report('Atlantide', 'it')).rejects.toMatchObject({ code: 'not_found' });
    await expect(createWeather({ userAgent: 'x', fetch: reply(503, '') }).report('Roma', 'it')).rejects.toMatchObject({ code: 'operation_failed' });
    await expect(createWeather({ userAgent: 'x', fetch: reply(200, 'x'.repeat(50)), maxBytes: 10 }).report('Roma', 'it')).rejects.toMatchObject({ code: 'operation_failed' });
    const slow: WeatherFetch = (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    await expect(createWeather({ userAgent: 'x', fetch: slow, timeoutMs: 20 }).report('Roma', 'it')).rejects.toMatchObject({ code: 'operation_failed', message: expect.stringContaining('nessuna risposta') });
  });
});
