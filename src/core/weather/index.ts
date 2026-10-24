// Meteo per il widget del cruscotto (11/10/2026, richiesta del proprietario). Eccezione dichiarata
// alla regola «niente rete dal core» (VISIONE_SECURITY_MODEL §3): parte SOLO quando il widget Meteo
// è acceso e il proprietario ha scritto una città, verso due host fissi e nient'altro:
//   - nominatim.openstreetmap.org: dalla città alle coordinate (una volta per città, poi in memoria);
//   - api.met.no (Istituto meteorologico norvegese): previsioni, libere anche per uso commerciale
//     (CC BY 4.0 — l'attribuzione è nel widget), con le regole del servizio: User-Agent che
//     identifica l'app, coordinate al più a 4 decimali (qui 2), niente richieste prima della
//     scadenza indicata dal server.
// Nessun dato del PC esce: solo il nome della città e le sue coordinate. Logica di lettura pura e
// testata (`parseMet`, `parsePlace`); la rete passa da `fetch` iniettabile.
import { CommandFailure, type CommandRouter } from '../commands/index.ts';

export const WEATHER_HOSTS: readonly string[] = ['nominatim.openstreetmap.org', 'api.met.no'];

export interface WeatherPlace {
  name: string;
  region: string | null;
  country: string | null;
  lat: number;
  lon: number;
}

export interface WeatherNow {
  at: string;
  tempC: number | null;
  symbol: string | null;
  windMs: number | null;
  humidity: number | null;
}

export interface WeatherDay {
  date: string;
  minC: number | null;
  maxC: number | null;
  symbol: string | null;
}

export interface WeatherReport {
  place: WeatherPlace;
  now: WeatherNow;
  days: WeatherDay[];
  updatedAt: string | null;
  fetchedAt: number;
  cached: boolean;
  source: 'met.no';
}

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type WeatherFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 120): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);

/** Primo risultato di Nominatim (`format=jsonv2`, `addressdetails=1`) → luogo, o null. */
export function parsePlace(json: unknown): WeatherPlace | null {
  const first = Array.isArray(json) ? (json[0] as Record<string, unknown> | undefined) : undefined;
  if (!first || typeof first !== 'object') return null;
  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const address = (first.address ?? {}) as Record<string, unknown>;
  const name = str(first.name) ?? str(address.city) ?? str(address.town) ?? str(address.village) ?? str(String(first.display_name ?? '').split(',')[0]);
  if (name === null) return null;
  return { name, region: str(address.state) ?? str(address.county), country: str(address.country), lat, lon };
}

/**
 * Previsione «compact» di MET Norway → tempo di adesso e fino a 4 giorni. I giorni si contano
 * nell'ora locale del luogo, stimata dalla longitudine (15° = 1 h): niente database dei fusi.
 */
export function parseMet(json: unknown, lon: number, nowMs: number): { now: WeatherNow; days: WeatherDay[]; updatedAt: string | null } | null {
  const props = (json as { properties?: { meta?: { updated_at?: unknown }; timeseries?: unknown } } | null)?.properties;
  const series = Array.isArray(props?.timeseries) ? (props.timeseries as Array<Record<string, unknown>>) : [];
  const rows = series
    .map((r) => {
      const time = str(r.time, 40);
      const at = time ? Date.parse(time) : NaN;
      const data = (r.data ?? {}) as Record<string, Record<string, Record<string, unknown>> | undefined>;
      const details = (data.instant?.details ?? {}) as Record<string, unknown>;
      const symbol = str(data.next_1_hours?.summary?.symbol_code, 60) ?? str(data.next_6_hours?.summary?.symbol_code, 60) ?? str(data.next_12_hours?.summary?.symbol_code, 60);
      const six = str(data.next_6_hours?.summary?.symbol_code, 60);
      return { time, at, temp: num(details.air_temperature), wind: num(details.wind_speed), hum: num(details.relative_humidity), symbol, six };
    })
    .filter((r): r is typeof r & { time: string } => r.time !== null && Number.isFinite(r.at));
  if (rows.length === 0) return null;
  // Adesso: la riga più vicina al momento presente (la previsione parte dall'ora in corso).
  const current = rows.reduce((best, r) => (Math.abs(r.at - nowMs) < Math.abs(best.at - nowMs) ? r : best));
  const offsetMs = Math.round(lon / 15) * 3_600_000;
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const day = new Date(r.at + offsetMs).toISOString().slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(r);
    else byDay.set(day, [r]);
  }
  const days: WeatherDay[] = [...byDay.entries()].slice(0, 4).map(([date, list]) => {
    const temps = list.map((r) => r.temp).filter((t): t is number => t !== null);
    // Il simbolo del giorno è quello delle 6 ore attorno a mezzogiorno locale, se c'è.
    const noon = list.reduce((best, r) => {
      const h = new Date(r.at + offsetMs).getUTCHours();
      const bh = new Date(best.at + offsetMs).getUTCHours();
      return Math.abs(h - 12) < Math.abs(bh - 12) ? r : best;
    });
    return { date, minC: temps.length ? Math.min(...temps) : null, maxC: temps.length ? Math.max(...temps) : null, symbol: noon.six ?? noon.symbol };
  });
  return {
    now: { at: current.time, tempC: current.temp, symbol: current.symbol, windMs: current.wind, humidity: current.hum },
    days,
    updatedAt: str(props?.meta?.updated_at, 40)
  };
}

/** Scadenza della risposta di MET (`Expires`), fra 10 e 60 minuti; senza intestazione 30 minuti. */
export function cacheUntil(expires: string | null, nowMs: number): number {
  const at = expires ? Date.parse(expires) : NaN;
  const ms = Number.isFinite(at) ? at - nowMs : 30 * 60_000;
  return nowMs + Math.min(60 * 60_000, Math.max(10 * 60_000, ms));
}

export interface Weather {
  report(city: string, language: 'it' | 'en'): Promise<WeatherReport>;
}

export function createWeather(deps: { userAgent: string; fetch?: WeatherFetch; now?: () => number; timeoutMs?: number; maxBytes?: number }): Weather {
  const fetchImpl: WeatherFetch = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxBytes = deps.maxBytes ?? 2_000_000;
  const places = new Map<string, WeatherPlace>();
  const reports = new Map<string, { report: Omit<WeatherReport, 'place' | 'cached'>; until: number }>();

  const get = async (url: string): Promise<{ json: unknown; expires: string | null }> => {
    const u = new URL(url);
    // Solo HTTPS e solo i due host del meteo: nessun altro indirizzo può passare da qui.
    if (u.protocol !== 'https:' || !WEATHER_HOSTS.includes(u.hostname)) throw new CommandFailure('forbidden', `host non consentito: ${u.hostname}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(u.toString(), { headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) throw new CommandFailure('operation_failed', `${u.hostname} ha risposto ${res.status}`);
      const body = await res.text();
      if (body.length > maxBytes) throw new CommandFailure('operation_failed', `${u.hostname}: risposta troppo grande`);
      return { json: JSON.parse(body) as unknown, expires: res.headers.get('expires') };
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      throw new CommandFailure('operation_failed', ctrl.signal.aborted ? `${u.hostname}: nessuna risposta in ${timeoutMs / 1000} s` : `${u.hostname}: ${(err as Error).message.slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async report(city, language) {
      const key = `${language}:${city.trim().toLowerCase()}`;
      let place = places.get(key);
      if (!place) {
        const q = new URLSearchParams({ q: city.trim(), format: 'jsonv2', limit: '1', addressdetails: '1', 'accept-language': language });
        const found = parsePlace((await get(`https://nominatim.openstreetmap.org/search?${q.toString()}`)).json);
        if (!found) throw new CommandFailure('not_found', `città non trovata: ${city.trim().slice(0, 80)}`);
        place = found;
        if (places.size > 50) places.clear();
        places.set(key, place);
      }
      const lat = place.lat.toFixed(2);
      const lon = place.lon.toFixed(2);
      const at = now();
      const hit = reports.get(`${lat},${lon}`);
      if (hit && hit.until > at) return { ...hit.report, place, cached: true };
      const { json, expires } = await get(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`);
      const parsed = parseMet(json, place.lon, at);
      if (!parsed) throw new CommandFailure('operation_failed', 'previsione non leggibile');
      const report = { ...parsed, fetchedAt: at, source: 'met.no' as const };
      if (reports.size > 50) reports.clear();
      reports.set(`${lat},${lon}`, { report, until: cacheUntil(expires, at) });
      return { ...report, place, cached: false };
    }
  };
}

export function registerWeatherCommands(router: CommandRouter, weather: Weather): void {
  router.register('widgets.weather', (payload) => weather.report(payload.city, payload.language));
}
