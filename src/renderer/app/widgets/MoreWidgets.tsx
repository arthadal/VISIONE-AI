// Widget aggiunti con lo schermo pulito (11/10/2026): Calendario, Note veloci, Ultime risposte degli
// agenti. Si accendono dal menu «Widget» come gli altri e ne seguono le regole delle schede.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VisioneEvent } from '../../../shared/contracts/index.ts';
import { HudPanel } from '../HudPanels.tsx';
import { useLanguage, useT } from '../../lib/i18n/index.ts';
import { lastReplies, monthGrid, NOTES_MAX, shiftMonth } from './more-logic.ts';
import { reminderDays } from './agenda-logic.ts';
import { useReminders } from './Agenda.tsx';

const localeOf = (lang: string): string => (lang === 'it' ? 'it-IT' : 'en-GB');

// --- Calendario ----------------------------------------------------------------------------------

export function CalendarWidget() {
  const t = useT();
  const lang = useLanguage();
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  // Il giorno cambia a mezzanotte: un controllo al minuto basta (nessuna richiesta al core).
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, [now]);
  const locale = localeOf(lang);
  // Settimana dal lunedì (Italia e Regno Unito).
  const weekStart = 1 as const;
  const cells = useMemo(() => monthGrid(view.year, view.month, weekStart, now), [view, weekStart, now]);
  const title = new Date(view.year, view.month, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + ((i + weekStart - 1 + 7) % 7)).toLocaleDateString(locale, { weekday: 'narrow' }));
  const isCurrent = view.year === now.getFullYear() && view.month === now.getMonth();
  // Beta.5: i giorni con un promemoria dell'Assistente hanno un segno.
  const reminders = useReminders();
  const marked = useMemo(() => reminderDays(reminders), [reminders]);
  return (
    <HudPanel title={t('widget.calendar.title')} status={isCurrent ? null : t('widget.calendar.other')} testId="widget-calendar" className="widget widget-calendar">
      <div className="wg-cal">
        <div className="wg-cal-head">
          <button type="button" className="small" onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))} aria-label={t('widget.calendar.prev')} data-testid="widget-calendar-prev">‹</button>
          <button type="button" className="small wg-cal-title" onClick={() => setView({ year: now.getFullYear(), month: now.getMonth() })} title={t('widget.calendar.today')} data-testid="widget-calendar-title">{title}</button>
          <button type="button" className="small" onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))} aria-label={t('widget.calendar.next')} data-testid="widget-calendar-next">›</button>
        </div>
        <div className="wg-cal-grid" role="grid">
          {weekdays.map((d, i) => <span key={`w${i}`} className="wg-cal-wd muted">{d}</span>)}
          {cells.map((c) => (
            <span key={c.key} className={`wg-cal-day${c.inMonth ? '' : ' out'}${c.today ? ' today' : ''}${marked.has(c.key) ? ' marked' : ''}`} data-testid={c.today ? 'widget-calendar-today' : marked.has(c.key) ? 'widget-calendar-marked' : undefined}>{c.day}</span>
          ))}
        </div>
      </div>
    </HudPanel>
  );
}

// --- Note veloci ---------------------------------------------------------------------------------

const NOTES_KEY = 'visione.widget.note.v1';

function readNotes(): string {
  try {
    return (localStorage.getItem(NOTES_KEY) ?? '').slice(0, NOTES_MAX);
  } catch {
    return '';
  }
}

export function NotesWidget() {
  const t = useT();
  const [text, setText] = useState(readNotes);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const change = (value: string): void => {
    const v = value.slice(0, NOTES_MAX);
    setText(v);
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    // Salvataggio mezzo secondo dopo l'ultima battuta, su questo PC.
    timer.current = setTimeout(() => {
      try {
        localStorage.setItem(NOTES_KEY, v);
        setSaved(true);
      } catch {
        setSaved(false);
      }
    }, 500);
  };
  return (
    <HudPanel title={t('widget.notes.title')} status={saved ? t('widget.notes.saved') : t('widget.notes.saving')} testId="widget-notes" className="widget widget-notes">
      <textarea
        className="wg-notes" value={text} onChange={(e) => change(e.target.value)} maxLength={NOTES_MAX}
        placeholder={t('widget.notes.placeholder')} aria-label={t('widget.notes.title')} data-testid="widget-notes-text"
      />
      <p className="muted small wg-notes-foot">{t('widget.notes.count', { n: text.length, max: NOTES_MAX })}</p>
    </HudPanel>
  );
}

// --- Ultime risposte -----------------------------------------------------------------------------

export function RepliesWidget({ events, names, onOpen }: { events: readonly VisioneEvent[]; names: Readonly<Record<string, string>>; onOpen: (agentId: string) => void }) {
  const t = useT();
  const lang = useLanguage();
  const replies = useMemo(() => lastReplies(events, 5), [events]);
  return (
    <HudPanel title={t('widget.replies.title')} status={replies.length > 0 ? String(replies.length) : null} testId="widget-replies" className="widget widget-replies">
      {replies.length === 0 && <p className="muted small">{t('widget.replies.none')}</p>}
      <ul className="wg-replies">
        {replies.map((r) => (
          <li key={r.id}>
            <button type="button" className="wg-reply" onClick={() => onOpen(r.agentId)} title={t('widget.replies.open')}>
              <span className="wg-reply-who">{names[r.agentId] ?? r.agentId}</span>
              <span className="mono small muted">{new Date(r.at).toLocaleTimeString(localeOf(lang), { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              <span className="wg-reply-text">{r.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </HudPanel>
  );
}
