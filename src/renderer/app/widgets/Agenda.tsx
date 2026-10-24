// Widget Agenda (beta.5, P-109): promemoria e appuntamenti dell'Assistente. Si scrive la frase come
// la si direbbe («tra un'ora fare la spesa», «domani alle 15 dentista») e il core mostra subito
// quando l'ha capita; poi l'elenco con Fatto, Rimanda di 10 minuti e Annulla. Tutto resta sul PC.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantList, CommandResult, Reminder } from '../../../shared/contracts/index.ts';
import { useLanguage, useT } from '../../lib/i18n/index.ts';
import { HudPanel } from '../HudPanels.tsx';
import { groupReminders, timeLabel } from './agenda-logic.ts';

const localeOf = (lang: string): string => (lang === 'it' ? 'it-IT' : 'en-GB');

/** Promemoria aperti dal core, aggiornati a ogni evento `assistant.reminder.*` (nessun polling). */
export function useReminders(): readonly Reminder[] {
  const [list, setList] = useState<readonly Reminder[]>([]);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void window.visione.assistant.list().then((res) => {
        if (alive && res.ok) setList(res.data.reminders);
      });
    };
    load();
    const off = window.visione.events.subscribe((e) => {
      if (e.type.startsWith('assistant.reminder.')) load();
    });
    // All'avvio il widget c'è prima del core: l'elenco si richiede di nuovo quando il core è pronto
    // (anche dopo un suo riavvio), altrimenti l'Agenda resterebbe vuota con i promemoria salvati.
    const offReady = window.visione.supervisor.subscribe((s) => {
      if (s.state === 'ready') load();
    });
    return () => { alive = false; off(); offReady(); };
  }, []);
  return list;
}

/** P-109b: le liste dell'Assistente, rilette a ogni `assistant.list.changed` (nessun polling). */
export function useAssistantLists(): readonly AssistantList[] {
  const [lists, setLists] = useState<readonly AssistantList[]>([]);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void window.visione.assistant.lists().then((res) => {
        if (alive && res.ok) setLists(res.data.lists);
      });
    };
    load();
    const off = window.visione.events.subscribe((e) => {
      if (e.type === 'assistant.list.changed') load();
    });
    const offReady = window.visione.supervisor.subscribe((s) => {
      if (s.state === 'ready') load();
    });
    return () => { alive = false; off(); offReady(); };
  }, []);
  return lists;
}

type Preview = CommandResult<'assistant.parse'>;

export function AgendaWidget() {
  const t = useT();
  const locale = localeOf(useLanguage());
  const reminders = useReminders();
  const lists = useAssistantLists();
  const [now, setNow] = useState(() => Date.now());
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);

  // Le etichette «oggi/domani» cambiano col tempo: un aggiornamento al minuto basta.
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, [now]);

  // Anteprima del «quando» mentre si scrive (una richiesta dopo una breve pausa della tastiera).
  useEffect(() => {
    const value = text.trim();
    if (value.length === 0) { setPreview(null); return; }
    const id = ++asked.current;
    const timer = setTimeout(() => {
      void window.visione.assistant.parse(value).then((res) => {
        if (id === asked.current && res.ok) setPreview(res.data);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  const sections = useMemo(() => groupReminders(reminders, now), [reminders, now]);
  const open = reminders.filter((r) => r.status === 'pending' || r.status === 'fired').length;

  const add = (): void => {
    const value = text.trim();
    if (value.length === 0 || busy) return;
    setBusy(true);
    const done = (reply: string): void => {
      setBusy(false);
      setText('');
      setPreview(null);
      setMessage({ ok: true, text: reply });
    };
    // P-109b: prima come a voce (liste, timer, ricorrenti, «cosa devo fare oggi»); se la frase non è per
    // l'Assistente, è un promemoria da aggiungere col suo «quando».
    void window.visione.assistant.ask(value).then((asked) => {
      if (asked.ok && asked.data.handled) { done(asked.data.reply ?? ''); return; }
      void window.visione.assistant.add(value).then((res) => {
        if (res.ok) done(res.data.reply);
        else { setBusy(false); setMessage({ ok: false, text: res.error.message }); }
      });
    });
  };
  const removeItem = (id: string): void => {
    void window.visione.assistant.removeItem(id).then((res) => {
      if (!res.ok) setMessage({ ok: false, text: res.error.message });
    });
  };
  // L'anteprima del «quando» serve ai promemoria; liste, timer e domande hanno la loro risposta.
  const forReminder = preview !== null && (preview.request === null || preview.request === 'reminder');
  const act = (r: Reminder, action: 'done' | 'cancel' | 'snooze'): void => {
    void window.visione.assistant.update(r.id, action, action === 'snooze' ? 10 : undefined).then((res) => {
      if (!res.ok) setMessage({ ok: false, text: res.error.message });
    });
  };

  const sectionTitle = (id: string): string => t(`widget.agenda.section.${id as 'fired' | 'today' | 'tomorrow' | 'later'}`);

  return (
    <HudPanel title={t('widget.agenda.title')} status={open > 0 ? t('widget.agenda.count', { n: open }) : null} testId="widget-agenda" className="widget widget-agenda">
      <form className="wg-agenda-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input
          type="text" value={text} maxLength={500} onChange={(e) => { setText(e.target.value); setMessage(null); }}
          placeholder={t('widget.agenda.placeholder')} aria-label={t('widget.agenda.placeholder')} data-testid="widget-agenda-input"
        />
        <button type="submit" className="small" disabled={busy || text.trim().length === 0 || (forReminder && preview?.at === null)} data-testid="widget-agenda-add">{t('widget.agenda.add')}</button>
      </form>
      {preview && forReminder && (
        <p className={`small wg-agenda-preview${preview.at === null || preview.past ? ' warn' : ''}`} data-testid="widget-agenda-preview">
          {preview.at === null
            ? t('widget.agenda.noWhen')
            : preview.past
              ? t('widget.agenda.past', { when: preview.label ?? '' })
              : `→ ${preview.label ?? ''}${preview.text ? ` · ${preview.text}` : ''}${preview.appointment ? ` · ${t('widget.agenda.lead')}` : ''}${preview.exact ? '' : ` · ${t('widget.agenda.approx')}`}`}
        </p>
      )}
      {message && <p className={`small wg-agenda-msg${message.ok ? '' : ' warn'}`} role="status" data-testid="widget-agenda-msg">{message.text}</p>}
      {sections.length === 0 ? (
        <p className="muted small" data-testid="widget-agenda-empty">{t('widget.agenda.empty')}</p>
      ) : (
        <div className="wg-agenda-list" data-testid="widget-agenda-list">
          {sections.map((s) => (
            <section key={s.id} className={`wg-agenda-sec wg-agenda-${s.id}`}>
              <h4 className="wg-agenda-h">{sectionTitle(s.id)}</h4>
              <ul>
                {s.items.map((r) => (
                  <li key={r.id} className={`wg-agenda-item${r.kind === 'appointment' ? ' appt' : ''}`} data-testid="widget-agenda-item">
                    <span className="wg-agenda-time">{timeLabel(r, now, locale)}</span>
                    <span className="wg-agenda-text" title={r.repeat ? `${r.text} · ${t(`widget.agenda.repeat.${r.repeat}`)}` : r.text}>
                      {r.kind === 'timer' && <span className="wg-agenda-mark" aria-label={t('widget.agenda.timer')}>⏱ </span>}
                      {r.repeat && <span className="wg-agenda-mark" aria-label={t(`widget.agenda.repeat.${r.repeat}`)} data-testid="widget-agenda-repeat">↻ </span>}
                      {r.text}
                    </span>
                    <span className="wg-agenda-acts">
                      <button type="button" className="small" onClick={() => act(r, 'done')} title={t('widget.agenda.done')} aria-label={t('widget.agenda.done')} data-testid="widget-agenda-done">✓</button>
                      <button type="button" className="small" onClick={() => act(r, 'snooze')} title={t('widget.agenda.snooze')} aria-label={t('widget.agenda.snooze')} data-testid="widget-agenda-snooze">+10′</button>
                      <button type="button" className="small" onClick={() => act(r, 'cancel')} title={t('widget.agenda.cancel')} aria-label={t('widget.agenda.cancel')} data-testid="widget-agenda-cancel">×</button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {lists.length > 0 && (
        <div className="wg-agenda-lists" data-testid="widget-agenda-lists">
          {lists.map((l) => (
            <section key={l.name} className="wg-agenda-sec">
              <h4 className="wg-agenda-h">{l.name === 'spesa' || l.name === 'shopping' ? t('widget.agenda.shopping') : t('widget.agenda.list', { name: l.name })}</h4>
              <ul className="wg-agenda-listitems">
                {l.items.map((i) => (
                  <li key={i.id} className="wg-agenda-listitem" data-testid="widget-agenda-listitem">
                    <span className="wg-agenda-text" title={i.text}>{i.text}</span>
                    <button type="button" className="small" onClick={() => removeItem(i.id)} title={t('widget.agenda.removeItem')} aria-label={t('widget.agenda.removeItem')}>✓</button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p className="muted small wg-agenda-hint">{t('widget.agenda.voiceHint')}</p>
    </HudPanel>
  );
}
