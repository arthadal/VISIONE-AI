// Vista Events: eventi recenti (proiezione della UI) con filtri, caricamento dal journal con i filtri
// del core e dettaglio del payload come testo (mai HTML). 11/10/2026: ogni riga dice in italiano chi fa
// cosa e cosa tocca; la routine (telemetria al secondo, ping, livelli voce) è fuori salvo richiesta.
import { useMemo, useState } from 'react';
import type { EventCategory, VisioneEvent, Severity } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { clockText } from '../windows/locale.ts';
import { describeEvent, isRoutine } from './log-logic.ts';

const CATEGORIES: EventCategory[] = ['agent', 'task', 'director', 'tool', 'memory', 'approval', 'process', 'terminal', 'file', 'git', 'error', 'system', 'telemetry', 'voice', 'ui'];

const SEVERITIES: Severity[] = ['debug', 'info', 'warning', 'error', 'critical'];
const RANK: Record<Severity, number> = { debug: 0, info: 1, warning: 2, error: 3, critical: 4 };

export function EventsView({ events, ready, listTestId = 'events', initialSeverity = 'debug', names = {} }: { events: VisioneEvent[]; ready: boolean; listTestId?: string; initialSeverity?: Severity; /** Nomi degli agenti per le frasi (id → nome). */ names?: Readonly<Record<string, string>> }) {
  const t = useT();
  const lang = useLanguage();
  const [category, setCategory] = useState<EventCategory | ''>('');
  const [severity, setSeverity] = useState<Severity>(initialSeverity);
  const [text, setText] = useState('');
  const [journal, setJournal] = useState<VisioneEvent[] | null>(null);
  const [selected, setSelected] = useState<VisioneEvent | null>(null);
  const [routine, setRoutine] = useState(false);

  const source = journal ?? events;
  const shown = useMemo(() => source
    .filter((e) => (routine || !isRoutine(e)) && (category === '' || e.category === category) && RANK[e.severity] >= RANK[severity] && (text === '' || e.type.includes(text) || e.correlationId.includes(text) || describeEvent(e, names, lang).toLowerCase().includes(text.toLowerCase())))
    .slice()
    .reverse()
    .slice(0, journal ? 200 : 15), [source, category, severity, text, journal, routine, names, lang]);

  const load = (): void => {
    void window.visione.events.list({ limit: 200, ...(category ? { categories: [category] } : {}), ...(severity !== 'debug' ? { minSeverity: severity } : {}) }).then((res) => {
      if (res.ok) setJournal(res.data.events);
    });
  };

  return (
    <section className="events-view" aria-label={t('windows.events.aria')}>
      <div className="filters">
        <select aria-label={t('windows.events.category')} value={category} onChange={(e) => setCategory(e.target.value as EventCategory | '')}>
          <option value="">{t('windows.events.allCategories')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label={t('windows.events.severity')} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
          {SEVERITIES.map((s) => <option key={s} value={s}>≥ {s}</option>)}
        </select>
        <input aria-label={t('windows.events.filter')} placeholder={t('windows.events.filterPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
        <label className="small" title={t('windows.events.routineTitle')}>
          <input type="checkbox" checked={routine} onChange={(e) => setRoutine(e.target.checked)} data-testid={`${listTestId}-routine`} /> {t('windows.events.routine')}
        </label>
        <button type="button" onClick={load} disabled={!ready}>{t('windows.events.fromJournal')}</button>
        {journal && <button type="button" onClick={() => setJournal(null)}>Live</button>}
        <span className="muted small">{journal ? `journal · ${journal.length}` : 'live'}</span>
      </div>
      <div className="events-split">
        <ol data-testid={listTestId} className="events-list">
          {shown.map((e) => (
            <li key={e.id} className={`event sev-${e.severity}${selected?.id === e.id ? ' selected' : ''}`}>
              <button type="button" className="event-row" onClick={() => setSelected(e)}>
                <span className="mono">{e.seq ?? '—'}</span>
                <span className="mono">{clockText(e.ts, lang)}</span>
                <span className="event-what" title={`${e.type} · ${e.source.kind}:${e.source.id}`}>{describeEvent(e, names, lang)}</span>
              </button>
            </li>
          ))}
        </ol>
        {selected && (
          <div className="event-detail" data-testid="event-detail">
            <p className="type">{selected.type} <button type="button" onClick={() => setSelected(null)} aria-label={t('windows.events.closeDetail')}>×</button></p>
            <pre className="mono small">{JSON.stringify({ ...selected, payload: selected.payload }, null, 2)}</pre>
          </div>
        )}
      </div>
    </section>
  );
}
