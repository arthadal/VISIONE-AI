// Pannelli HUD flottanti (Fase G1, P-73; fase G4, P-76): chrome comune (header, stato, riduzione) e
// pannelli alimentati SOLO da dati reali — voce, sistema, director, task/eventi. Dove un dato non
// esiste: `N/D`, spento, con una nota che spiega perché la fonte manca (come i riquadri `.hs-*`
// del JARVIS del proprietario, MIT). La grafica è decorativa solo nel layer `HudDeco`.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CommandResult, CoreStateSnapshot, Language, VisioneEvent } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { formatAgo } from '../lib/time.ts';
import { Reactor, type ReactorState } from '../reactor/Reactor.tsx';
import { VoiceVisualizer, voiceVisualState } from '../voice/VoiceVisualizer.tsx';
import { useDockCollapsed } from './Dock.tsx';
import { buildSections, clamp01, isNa, metricText, naText, STALE_MS, type BusTelemetry, type Metric } from './hud-metrics.ts';
import { describeEvent, isRoutine } from './log-logic.ts';

/** Orario locale compatto per le righe HUD (usato anche dai pannelli agenti); la lingua è facoltativa (default italiano). */
export function hms(ts: number, lang: Language = 'it'): string {
  return new Date(ts).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'it-IT', { hour12: false });
}

/** Quali pannelli sono ridotti, ricordato per chi guarda (come `jarvis.hud.ridotti`). */
const HUD_MIN_KEY = 'visione.hud.ridotti';
function readMin(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(HUD_MIN_KEY) ?? '{}') as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
function writeMin(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(HUD_MIN_KEY, JSON.stringify(v));
  } catch {
    // archivio locale non disponibile: la riduzione vale per questa sessione
  }
}

/** Chrome dei pannelli HUD: titolo maiuscolo, stato a destra, riduzione (il contenuto resta nel DOM). */
export function HudPanel({ title, status, children, className = '', testId, bodyClass = '', note }: {
  title: string; status?: string | null; children: ReactNode; className?: string; testId?: string; bodyClass?: string; note?: string;
}) {
  const t = useT();
  const dockCollapsed = useDockCollapsed();
  const [min, setMin] = useState(() => readMin()[title] === true);
  // Dentro il dock la tendina la decide il dock (una sola verità): la chiave storica non nasconde
  // il corpo quando il pannello è espanso. Fuori dal dock (finestre) il comportamento è quello di prima.
  const shown = dockCollapsed ?? min;
  const toggle = (): void => {
    setMin((v) => {
      const next = !v;
      writeMin({ ...readMin(), [title]: next });
      return next;
    });
  };
  return (
    <section className={`hud-panel${className ? ` ${className}` : ''}${shown ? ' min' : ''}`} aria-label={title} data-testid={testId}>
      <span className="p-wipe" aria-hidden="true" />
      <header className="hp-head">
        <span className="hp-title">{title}</span>
        {status != null && <span className="hp-status mono">{status}</span>}
        <button type="button" className="hp-min" aria-label={shown ? t('settings.hud.expand') : t('settings.hud.collapse')} aria-pressed={shown} onClick={toggle}>{shown ? '+' : '−'}</button>
      </header>
      <div className={`hp-body${bodyClass ? ` ${bodyClass}` : ''}`}>
        {note != null && note !== '' && <p className="hp-nota">{note}</p>}
        {children}
      </div>
    </section>
  );
}

export interface HudRow { k: string; v: string; s?: string; title?: string }

/** Righe chiave→valore in mono, con guida puntinata: il linguaggio dei pannelli dello screenshot. */
export function HudRows({ rows }: { rows: HudRow[] }) {
  return (
    <ul className="hp-rows">
      {rows.map((r) => (
        <li key={r.k}>
          <span className="k">{r.k}</span>
          <span className="lead" aria-hidden="true" />
          <span className={`v mono${r.s ? ` ${r.s}` : ''}${isNa(r.v) ? ' nd' : ''}`} title={r.title}>{r.v}</span>
        </li>
      ))}
    </ul>
  );
}

/** Riga di metrica con testid e stato (`metric-*`): barra per le percentuali, `N/D` spento. */
function MetricRow({ m }: { m: Metric }) {
  const t = useT();
  const lang = useLanguage();
  const missing = m.status !== 'ok';
  return (
    <li
      className="hp-riga"
      data-testid={`metric-${m.key}`}
      data-status={m.status}
      title={`${t('settings.hud.source', { source: m.source })}${m.sampledAt ? ` · ${hms(m.sampledAt, lang)}` : ''}`}
    >
      <span className="k">{m.label}</span>
      {m.bar != null
        ? <span className="mtr" aria-hidden="true"><i style={{ width: `${Math.round(clamp01(m.bar) * 100)}%` }} /></span>
        : <span className="lead" aria-hidden="true" />}
      <span className={`v mono${missing ? ' nd' : ''}`}>{metricText(m, lang)}</span>
    </li>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <li className="hp-riga">
      <span className="k">{k}</span>
      <span className="lead" aria-hidden="true" />
      <span className={`v mono${isNa(v) ? ' nd' : ''}`}>{v}</span>
    </li>
  );
}

/** Etichetta del microfono in uso: nome reale del dispositivo quando il browser lo espone. */
function useMicLabel(): string {
  const t = useT();
  // Nome reale del dispositivo, oppure «predefinito»/«selezionato» (tradotti al momento di mostrarli).
  const [dev, setDev] = useState<{ name: string; kind: 'default' | 'selected' }>({ name: '', kind: 'default' });
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      let id = '';
      try {
        id = localStorage.getItem('visione.mic') ?? '';
      } catch {
        // archivio locale non disponibile
      }
      if (!navigator.mediaDevices?.enumerateDevices) return;
      void navigator.mediaDevices.enumerateDevices().then((list) => {
        if (cancelled) return;
        const found = list.find((d) => d.kind === 'audioinput' && d.deviceId === id && id !== '');
        // I nomi arrivano solo dopo il permesso al microfono: fino ad allora niente etichette inventate.
        setDev({ name: found?.label || '', kind: id === '' ? 'default' : 'selected' });
      }).catch(() => undefined);
    };
    load();
    try {
      navigator.mediaDevices?.addEventListener('devicechange', load);
    } catch {
      // devicechange non supportato
    }
    return () => {
      cancelled = true;
      try {
        navigator.mediaDevices?.removeEventListener('devicechange', load);
      } catch {
        // ignorato
      }
    };
  }, []);
  return dev.name || t(dev.kind === 'default' ? 'settings.hud.mic.default' : 'settings.hud.mic.selected');
}

/** VOCE — fase, microfono, motori e latenze reali (dal core e dal bus), ascolto/parlato/barge-in. */
export function VoicePanel({ core, level, reducedMotion, state, bus, onOpenReactor }: {
  core: CoreStateSnapshot | null; level: number; reducedMotion: boolean; state: ReactorState; bus: BusTelemetry; onOpenReactor: () => void;
}) {
  const t = useT();
  const lang = useLanguage();
  const voice = core?.voice ?? null;
  const vstate = voiceVisualState(voice);
  const micDevice = useMicLabel();
  const mic = voice?.status === 'off' ? t('settings.hud.offMasc') : micDevice;
  // Il motivo reale può essere lungo (elenco dei modelli mancanti): in riga è troncato, il testo
  // completo resta nel `title` (niente valori inventati, solo visualizzazione compatta).
  const errFull = voice && (voice.status === 'failed' || voice.status === 'unavailable') ? (voice.reason ?? voice.status) : null;
  const err = errFull !== null && errFull.length > 140 ? `${errFull.slice(0, 140)}…` : errFull;
  // Wake (P-81): configurazione e stato REALI dal processo; N/D se la voce non è pronta.
  const wake = voice?.status === 'ready' ? voice.wake : null;
  const na = naText(lang);
  const wakeText = wake === null ? na : wake.armed ? t('settings.hud.waiting') : wake.enabled ? (wake.available ? t('settings.hud.active') : t('settings.hud.unavailable')) : t('settings.hud.offFem');
  const rows: HudRow[] = [
    { k: t('settings.hud.voice.phase'), v: vstate.toUpperCase(), s: `voice-${vstate}` },
    { k: t('settings.hud.voice.mic'), v: mic },
    { k: t('settings.hud.voice.sttEngine'), v: voice?.engines?.stt ?? na },
    { k: t('settings.hud.voice.sttLatency'), v: bus.sttMs != null ? `${bus.sttMs} ms` : na },
    { k: t('settings.hud.voice.ttsEngine'), v: voice?.engines?.tts ?? na },
    { k: t('settings.hud.voice.ttsLatency'), v: bus.ttsMs != null ? `${bus.ttsMs} ms` : na },
    { k: 'WAKE', v: wakeText, s: wake?.armed ? 'ok' : undefined },
    { k: t('settings.hud.voice.wakePhrase'), v: wake && wake.phrase.length > 0 ? `«${wake.phrase}»` : na },
    { k: t('settings.hud.voice.listening'), v: voice ? (voice.listening ? t('settings.hud.yes') : t('settings.hud.no')) : na },
    { k: t('settings.hud.voice.speaking'), v: voice ? (voice.speaking != null ? t('settings.hud.yes') : t('settings.hud.no')) : na },
    { k: 'BARGE-IN', v: bus.bargeInMs != null ? `${bus.bargeInMs} ms` : na },
    { k: t('settings.hud.voice.lastError'), v: err ?? (voice ? t('settings.hud.none') : na), s: err ? 'bad' : undefined, title: errFull ?? undefined }
  ];
  // La nota spiega la fonte mancante, breve: il dettaglio completo sta in ULTIMO ERRORE.
  const note = !core
    ? t('settings.hud.voice.noCore')
    : voice == null
      ? t('settings.hud.voice.notPublished')
      : voice.status === 'failed' || voice.status === 'unavailable'
        ? t('settings.hud.voice.enginesFailed', { status: voice.status })
        : voice.status === 'starting'
          ? t('settings.hud.voice.loading')
          : voice.status === 'ready' && voice.engines == null
            ? t('settings.hud.voice.undeclared')
            : undefined;
  return (
    <HudPanel title={t('settings.hud.voice.title')} status={vstate.toUpperCase()} testId="panel-voice" className="panel-voice" note={note}>
      <div className="voice-core">
        <Reactor size={72} level={level} state={state} reducedMotion={reducedMotion} />
        <VoiceVisualizer voice={voice} level={level} />
      </div>
      <HudRows rows={rows} />
      <div className="hp-actions">
        <button type="button" className="small" onClick={onOpenReactor} data-testid="open-reactor-window">Reactor</button>
      </div>
    </HudPanel>
  );
}

/** DIRECTOR — presenza reale dell'orchestrazione: obiettivi, task, agenti, ultima decisione. */
export function DirectorPanel({ core, onOpen }: { core: CoreStateSnapshot | null; onOpen: () => void }) {
  const t = useT();
  const lang = useLanguage();
  const na = naText(lang);
  const d = core?.director ?? null;
  const rows: HudRow[] = [
    { k: t('settings.hud.director.status'), v: d ? (d.activeGoals > 0 ? t('settings.hud.director.inProgress') : t('settings.hud.waiting')) : na, s: d && d.activeGoals > 0 ? 'ok' : undefined },
    { k: t('settings.hud.director.goals'), v: d ? String(d.activeGoals) : na },
    { k: t('settings.hud.director.tasks'), v: core ? String(core.tasks.active) : na },
    { k: t('settings.hud.director.agents'), v: core ? `${core.agents.working}/${core.agents.live}` : na },
    { k: t('settings.hud.director.lastDecision'), v: d?.lastDecision ? `${d.lastDecision.decision} · ${hms(d.lastDecision.at, lang)}` : (d ? t('settings.hud.noneFem') : na) }
  ];
  return (
    <HudPanel title="Director" status={d && d.activeGoals > 0 ? t('settings.hud.director.activeBadge') : 'idle'} testId="panel-director" className="panel-director"
      note={core ? undefined : t('settings.hud.director.noCore')}>
      <HudRows rows={rows} />
      <div className="hp-actions">
        <button type="button" className="small" onClick={onOpen} data-testid="panel-open-director">{t('settings.common.open')}</button>
      </div>
    </HudPanel>
  );
}

/** TASK / EVENTI — contatori reali e ultimi eventi veri dal bus (niente feed simulati). */
export function TasksEventsPanel({ core, events, names = {} }: { core: CoreStateSnapshot | null; events: VisioneEvent[]; names?: Readonly<Record<string, string>> }) {
  const t = useT();
  const lang = useLanguage();
  const na = naText(lang);
  // 11/10/2026: solo le operazioni importanti, scritte come frase (la routine resta nei Log).
  const recent = useMemo(() => events.filter((e) => !isRoutine(e)).slice(-7).reverse(), [events]);
  const rows: HudRow[] = [
    { k: t('settings.hud.tasks.activeGoals'), v: core ? String(core.director.activeGoals) : na },
    { k: t('settings.hud.tasks.activeTasks'), v: core ? String(core.tasks.active) : na },
    { k: t('settings.hud.tasks.lastTask'), v: core?.tasks.last ? `${core.tasks.last.status}` : (core ? t('settings.hud.none') : na) },
    { k: t('settings.hud.tasks.events'), v: core ? String(core.events.sinceStart) : na },
    { k: t('settings.hud.tasks.errors'), v: core ? String(core.error.count) : na, s: core && core.error.count > 0 ? 'bad' : undefined }
  ];
  return (
    <HudPanel title={t('settings.hud.tasks.title')} status={core ? t('settings.hud.tasks.status', { n: core.tasks.active }) : null} testId="panel-tasks" className="panel-tasks"
      note={core ? undefined : t('settings.hud.tasks.noCore')}>
      <HudRows rows={rows} />
      <ul className="hp-feed" data-testid="panel-feed">
        {recent.length === 0 && <li className="muted small">{t('settings.hud.tasks.noEvents')}</li>}
        {recent.map((e) => {
          // G6: la riga dice da sé che tipo di evento è — errore, avviso, strumento — e lo dice con
          // il colore/glow una tantum sul mount; nessuna decorazione senza evento.
          const cls = e.severity === 'error' || e.severity === 'critical' ? 'fx-evt-error'
            : e.severity === 'warning' ? 'fx-evt-warning'
              : e.type.startsWith('tool.') ? 'fx-tool' : '';
          return (
            <li key={e.id} className={cls || undefined}>
              <span className="mono ts">{hms(e.ts, lang)}</span>
              <span className="type" title={e.type}>{describeEvent(e, names, lang)}</span>
            </li>
          );
        })}
      </ul>
    </HudPanel>
  );
}

const gb = (n: number): string => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
const uptime = (s: number): string => `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;

/**
 * SISTEMA — il riquadro del riferimento: metriche reali dalla telemetria condivisa (`bus`, una sola
 * sottoscrizione in tutta la UI) più le informazioni macchina da `system.control.info` (una lettura
 * per avvio del core, nessun polling). Temperature `N/D` finché il provider sensori locale non c'è:
 * la nota lo dichiara, così l'assenza non sembra un guasto.
 */
export function SystemPanel({ core, ready, bus, scene, pingMs, info, infoError, onOpen }: {
  core: CoreStateSnapshot | null; ready: boolean; bus: BusTelemetry; scene: { fps: number | null; quality: 0 | 1 | 2; context: string } | null; pingMs: number | null;
  info: CommandResult<'system.control.info'> | null; infoError: string | null; onOpen?: () => void;
}) {
  const t = useT();
  const lang = useLanguage();
  const na = naText(lang);
  const now = Date.now();
  const sections = useMemo(() => buildSections(core, bus, scene, pingMs, now, lang), [core, bus, scene, pingMs, now, lang]);
  const sys = bus.sys;
  const sysAge = bus.sysAt === null ? null : now - bus.sysAt;
  const live = sysAge !== null && sysAge <= STALE_MS;
  const status = live ? 'live' : sysAge === null ? t('settings.hud.system.na') : 'stale';
  const ageText = sysAge === null ? t('settings.hud.system.na') : sysAge < 1_500 ? t('settings.hud.system.now') : formatAgo(sysAge, lang);
  const system = sections.find((s) => s.id === 'system');
  const orchestration = sections.find((s) => s.id === 'orchestration');
  const notes: string[] = [];
  if (!ready || sys === null) notes.push(t('settings.hud.system.waitingSample'));
  else if (sys.cpuTemperatureC === null || sys.gpuTemperatureC === null) {
    notes.push(t('settings.hud.system.tempNote'));
  }
  if (infoError) notes.push(t('settings.hud.system.machineError', { error: infoError }));
  else if (info === null) notes.push(t('settings.hud.system.machineWaiting'));
  return (
    <HudPanel
      title={t('settings.hud.system.title')}
      status={ageText}
      testId="panel-system"
      className="panel-system"
      bodyClass="hp-scroll"
      note={notes.join(' ')}
    >
      <header className="hp-live-head">
        <span className={`hud-live${live ? ' on' : ''}`} data-testid="hud-live" data-live={String(live)}
          title={sysAge === null ? t('settings.hud.system.noSample') : t('settings.hud.system.lastSample', { s: Math.round(sysAge / 100) / 10 })}>
          {status}
        </span>
      </header>
      <div className="hp-groups" data-testid="hud">
        {system && (
          <div className="hp-group">
            <p className="hp-group-title">{t('settings.hud.system.title')}</p>
            <ul className="hp-rows">
              {system.metrics.map((m) => <MetricRow key={m.key} m={m} />)}
            </ul>
          </div>
        )}
        {/* P-87: dettagli dichiarati ma chiusi all'apertura, come la reference (il riquadro SISTEMA
            resta corto); un click li apre. I testid e i valori reali restano nel DOM. */}
        <details className="hp-details">
          <summary>{t('settings.hud.system.machineOrchestration')}</summary>
          {system && (
            <div className="hp-group">
              <p className="hp-group-title">{t('settings.hud.system.machine')}</p>
              <ul className="hp-rows">
                <InfoRow k={t('settings.hud.system.name')} v={info?.hostname ?? na} />
                <InfoRow k="Windows" v={info?.windows ?? na} />
                <InfoRow k={t('settings.hud.system.processor')} v={info ? t('settings.hud.system.cpuCores', { model: info.cpuModel, count: info.cpuCount }) : na} />
                <InfoRow k={t('settings.hud.system.disk')} v={info?.disk ? `${gb(info.disk.totalBytes - info.disk.freeBytes)} / ${gb(info.disk.totalBytes)}` : na} />
                <InfoRow k="Uptime" v={info ? uptime(info.uptimeSec) : na} />
                <InfoRow k={t('settings.hud.system.load')} v={info?.loadavg ? info.loadavg.map((v) => v.toFixed(2)).join(' / ') : na} />
                <InfoRow k={t('settings.hud.system.sample')} v={sysAge === null ? na : ageText} />
              </ul>
            </div>
          )}
          {orchestration && (
            <div className="hp-group">
              <p className="hp-group-title">{t('settings.hud.system.orchestration')}</p>
              <ul className="hp-rows">
                {orchestration.metrics.map((m) => <MetricRow key={m.key} m={m} />)}
              </ul>
            </div>
          )}
        </details>
      </div>
      <div className="hp-actions">
        {onOpen && <button type="button" className="small" onClick={onOpen} data-testid="panel-open-system">{t('settings.hud.system.title')}</button>}
      </div>
    </HudPanel>
  );
}

/** Layer decorativo (nessun dato): etichette tecniche e marcatori come nello screenshot. */
export function HudDeco() {
  const t = useT();
  return (
    <div className="hud-deco" aria-hidden="true">
      <span className="d1">NEURAL INTERFACE</span>
      <span className="d2">{t('settings.hud.deco.signal')}</span>
      <span className="d3">{t('settings.hud.deco.systems')}</span>
      <span className="d4">WEB</span>
      <span className="d5">{t('settings.hud.deco.coordinates')}</span>
      <i className="tick t1" /><i className="tick t2" /><i className="tick t3" /><i className="tick t4" />
    </div>
  );
}
