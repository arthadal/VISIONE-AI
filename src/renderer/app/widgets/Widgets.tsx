// Widget del cruscotto (11/10/2026): Orologio, Meteo e Grafici di sistema. Vivono nel dock come le
// altre schede (chiudi, tendina, sposta ovunque, ridimensiona, tutto schermo) e si accendono dal
// menu «Widget». Dati solo reali: l'ora del PC, la previsione chiesta dal core (il renderer resta
// senza rete), i campioni di telemetria che già arrivano al pannello Sistema.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandResult } from '../../../shared/contracts/index.ts';
import { HudPanel } from '../HudPanels.tsx';
import type { BusTelemetry } from '../hud-metrics.ts';
import { useLanguage, useT, type MessageKey } from '../../lib/i18n/index.ts';
import { cityValid, gb, pushSample, rateText, SERIES_MAX, wavePath, WEATHER_ICON, WEATHER_REFRESH_MS, weatherKind } from './widgets-logic.ts';

const localeOf = (lang: string): string => (lang === 'it' ? 'it-IT' : 'en-GB');

// --- Orologio ------------------------------------------------------------------------------------

export function ClockWidget() {
  const t = useT();
  const lang = useLanguage();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Allineato al cambio di secondo: niente secondi che «saltano».
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      setNow(new Date());
      timer = setTimeout(tick, 1_000 - (Date.now() % 1_000) + 5);
    };
    timer = setTimeout(tick, 1_000 - (Date.now() % 1_000) + 5);
    return () => clearTimeout(timer);
  }, []);
  const locale = localeOf(lang);
  const time = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const date = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sweep = (now.getSeconds() + now.getMilliseconds() / 1000) / 60;
  return (
    <HudPanel title={t('widgets.clock.title')} testId="widget-clock" className="widget widget-clock">
      <div className="wg-clock">
        <svg className="wg-clock-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="44" className="wg-ring-bg" />
          <circle cx="50" cy="50" r="44" className="wg-ring" strokeDasharray={`${(sweep * 276.5).toFixed(1)} 276.5`} transform="rotate(-90 50 50)" />
        </svg>
        <div className="wg-clock-text">
          <span className="wg-time mono" data-testid="widget-clock-time">{time}<span className="wg-sec">{seconds}</span></span>
          <span className="wg-date">{date}</span>
          <span className="wg-tz muted small">{t('widget.clock.tz', { tz })}</span>
        </div>
      </div>
    </HudPanel>
  );
}

// --- Meteo ---------------------------------------------------------------------------------------

const CITY_KEY = 'visione.widget.meteo.v1';
type Report = CommandResult<'widgets.weather'>;

function readCity(): string {
  try {
    const v = JSON.parse(localStorage.getItem(CITY_KEY) ?? 'null') as { city?: unknown } | null;
    return typeof v?.city === 'string' && cityValid(v.city) ? v.city : '';
  } catch {
    return '';
  }
}
function writeCity(city: string): void {
  try {
    localStorage.setItem(CITY_KEY, JSON.stringify({ city }));
  } catch {
    // archivio locale non disponibile: la città vale per questa sessione
  }
}
/**
 * La città va anche nella configurazione (22/10/2026): il saluto all'avvio la legge dal core. All'avvio dell'app
 * (anche col widget nascosto) si copia quella già scritta, solo se è diversa.
 */
export function syncWeatherCity(config: Record<string, unknown>): void {
  const city = readCity();
  if (city !== '' && (config.ui as { weatherCity?: unknown } | undefined)?.weatherCity !== city) {
    void window.visione.config.update({ ui: { weatherCity: city } });
  }
}

export function WeatherWidget() {
  const t = useT();
  const lang = useLanguage();
  const [city, setCity] = useState(readCity);
  const [draft, setDraft] = useState(city);
  const [editing, setEditing] = useState(city === '');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [round, setRound] = useState(0);
  const waits = useRef(0);

  useEffect(() => {
    if (city === '' || editing) return;
    let alive = true;
    setLoading(true);
    setError(null);
    let retry: ReturnType<typeof setTimeout> | null = null;
    void window.visione.widgets.weather(city, lang).then((res) => {
      if (!alive) return;
      // All'avvio il core può non essere ancora pronto: si riprova da soli, senza mostrare errori.
      if (!res.ok && (res.error.code === 'core_unavailable' || res.error.code === 'shutting_down') && waits.current < 10) {
        waits.current += 1;
        retry = setTimeout(() => setRound((n) => n + 1), 3_000);
        return;
      }
      waits.current = 0;
      setLoading(false);
      if (res.ok) setReport(res.data);
      else setError(res.error.message);
    });
    // Il core tiene la previsione in memoria fino alla scadenza del servizio: ogni 30 minuti si
    // richiede, e se è ancora valida torna quella senza uscire dal PC.
    const timer = setTimeout(() => setRound((n) => n + 1), WEATHER_REFRESH_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
      if (retry !== null) clearTimeout(retry);
    };
  }, [city, lang, editing, round]);

  const save = (): void => {
    const c = draft.trim();
    if (!cityValid(c)) return setError(t('widget.weather.invalid'));
    writeCity(c);
    void window.visione.config.update({ ui: { weatherCity: c } });
    setReport(null);
    setError(null);
    setCity(c);
    setEditing(false);
  };

  const locale = localeOf(lang);
  const kind = weatherKind(report?.now.symbol);
  return (
    <HudPanel title={t('widgets.weather.title')} status={report ? report.place.name : null} testId="widget-weather" className="widget widget-weather">
      {editing ? (
        <form className="wg-weather-ask" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <p className="small">{t('widget.weather.ask')}</p>
          <label className="small">{t('widget.weather.city')}
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={80} autoComplete="off" data-testid="widget-weather-city" />
          </label>
          <button type="submit" className="setup-primary" data-testid="widget-weather-save" disabled={draft.trim() === ''}>{t('widget.weather.save')}</button>
          <p className="muted small">{t('widget.weather.privacy')}</p>
          {error && <p className="error small">{error}</p>}
        </form>
      ) : (
        <div className="wg-weather" data-testid="widget-weather-body">
          {loading && !report && <p className="muted small">{t('widget.weather.loading')}</p>}
          {error && (
            <p className="error small" data-testid="widget-weather-error">
              {t('widget.weather.error', { error })} <button type="button" className="small" onClick={() => setRound((n) => n + 1)}>{t('widget.weather.retry')}</button>
            </p>
          )}
          {report && (
            <>
              <div className="wg-now">
                <span className="wg-icon" aria-hidden="true">{WEATHER_ICON[kind]}</span>
                <span className="wg-temp mono" data-testid="widget-weather-temp">{report.now.tempC === null ? t('widgets.common.na') :`${Math.round(report.now.tempC)}°`}</span>
                <span className="wg-now-text">
                  <span>{t(`widget.weather.kind.${kind}` as MessageKey)}</span>
                  <span className="muted small">{[report.place.name, report.place.region, report.place.country].filter(Boolean).join(', ')}</span>
                  <span className="muted small">
                    {report.now.windMs !== null ? t('widget.weather.wind', { kmh: Math.round(report.now.windMs * 3.6) }) : ''}
                    {report.now.windMs !== null && report.now.humidity !== null ? ' · ' : ''}
                    {report.now.humidity !== null ? t('widget.weather.humidity', { pct: Math.round(report.now.humidity) }) : ''}
                  </span>
                </span>
              </div>
              <ol className="wg-days">
                {report.days.map((d) => (
                  <li key={d.date}>
                    <span className="small">{new Date(`${d.date}T12:00:00Z`).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })}</span>
                    <span className="wg-icon-s" aria-hidden="true">{WEATHER_ICON[weatherKind(d.symbol)]}</span>
                    <span className="mono small">{d.maxC === null ? '–' : `${Math.round(d.maxC)}°`} <span className="muted">{d.minC === null ? '–' : `${Math.round(d.minC)}°`}</span></span>
                  </li>
                ))}
              </ol>
              <p className="wg-credit muted small">
                {t('widget.weather.updated', { time: new Date(report.fetchedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) })} · {t('widget.weather.credit')}
              </p>
            </>
          )}
          <button type="button" className="small wg-change" onClick={() => { setDraft(city); setEditing(true); }} data-testid="widget-weather-change">{t('widget.weather.change')}</button>
        </div>
      )}
    </HudPanel>
  );
}

// --- Grafici di sistema --------------------------------------------------------------------------

type SeriesKey = 'cpu' | 'gpu' | 'ram' | 'vram' | 'net';
const SERIES: ReadonlyArray<{ key: SeriesKey; top: number | null; color: string; fmt: (v: number) => string }> = [
  { key: 'cpu', top: 100, color: '#25e0ff', fmt: (v) => `${Math.round(v)}%` },
  { key: 'gpu', top: 100, color: '#b18cff', fmt: (v) => `${Math.round(v)}%` },
  { key: 'ram', top: 100, color: '#45f0a0', fmt: (v) => `${Math.round(v)}%` },
  { key: 'vram', top: null, color: '#ffc04d', fmt: (v) => `${v.toFixed(1)} GB` },
  { key: 'net', top: null, color: '#5aa8ff', fmt: (v) => rateText(v) }
];
const W = 300;
const H = 40;

export type SystemSeries = Record<SeriesKey, number[]>;

/**
 * Serie degli ultimi due minuti, raccolte SEMPRE (anche a widget spento): acceso, il widget mostra
 * subito la storia recente invece di partire vuoto. Sono 5 × 120 numeri, dai campioni reali.
 */
export function useSystemSeries(bus: BusTelemetry): SystemSeries {
  const [series, setSeries] = useState<SystemSeries>({ cpu: [], gpu: [], ram: [], vram: [], net: [] });
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    const s = bus.sys;
    if (s === null || bus.sysAt === null || bus.sysAt === lastAt.current) return;
    lastAt.current = bus.sysAt;
    const ram = s.ramUsedBytes !== null && s.ramTotalBytes !== null && s.ramTotalBytes > 0 ? (s.ramUsedBytes / s.ramTotalBytes) * 100 : null;
    const net = s.netRxBytesPerSec !== null || s.netTxBytesPerSec !== null ? (s.netRxBytesPerSec ?? 0) + (s.netTxBytesPerSec ?? 0) : null;
    setSeries((p) => ({
      cpu: pushSample(p.cpu, s.cpuPercent),
      gpu: pushSample(p.gpu, s.gpuPercent),
      ram: pushSample(p.ram, ram),
      vram: pushSample(p.vram, gb(s.vramUsedBytes)),
      net: pushSample(p.net, net)
    }));
  }, [bus.sys, bus.sysAt]);
  return series;
}

export function GraphsWidget({ series }: { series: SystemSeries }) {
  const t = useT();
  const waves = useMemo(() => SERIES.map((d) => ({ ...d, wave: wavePath(series[d.key], W, H, d.top), values: series[d.key] })), [series]);
  const empty = waves.every((w) => w.values.length === 0);
  return (
    <HudPanel title={t('widgets.graphs.title')} status={empty ? null : t('widget.graphs.window', { n: SERIES_MAX })} testId="widget-graphs" className="widget widget-graphs">
      {empty ? (
        <p className="muted small">{t('widget.graphs.wait')}</p>
      ) : (
        <div className="wg-graphs">
          {waves.map((w) => {
            const last = w.values.at(-1);
            return (
              <div className="wg-graph" key={w.key} data-testid={`widget-graph-${w.key}`} data-samples={w.values.length}>
                <div className="wg-graph-head small">
                  <span className="wg-graph-name" style={{ color: w.color }}>{t(`widget.graphs.${w.key}` as MessageKey)}</span>
                  <span className="mono">{last === undefined ? t('widgets.common.na') : w.fmt(last)}</span>
                  {w.wave.peak && <span className="muted mono">{t('widget.graphs.peak', { value: w.fmt(w.wave.peak.v) })}</span>}
                </div>
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="wg-wave" aria-hidden="true">
                  <defs>
                    <linearGradient id={`wg-grad-${w.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor={w.color} stopOpacity="0.45" />
                      <stop offset="1" stopColor={w.color} stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  {w.wave.area && <path d={w.wave.area} fill={`url(#wg-grad-${w.key})`} />}
                  {w.wave.line && <path d={w.wave.line} fill="none" stroke={w.color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />}
                  {w.wave.peak && <circle cx={w.wave.peak.x} cy={w.wave.peak.y} r="2.2" fill="#fff" stroke={w.color} vectorEffect="non-scaling-stroke" />}
                </svg>
              </div>
            );
          })}
        </div>
      )}
    </HudPanel>
  );
}
