// Centro notifiche (Fase 23, P-70): campanella nella barra con contatore delle non lette e pannello
// delle notizie reali (proiezione pura in `notifications.ts`). Click su una notizia → la finestra
// dell'entità. Nessuna notizia inventata e nessuna animazione casuale.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Language, VisioneEvent } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { collectNotices, countUnread, type Notice } from './notifications.ts';

function clock(ts: number, lang: Language): string {
  return new Date(ts).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'it-IT', { hour12: false });
}

export function Notifications({ events, onOpen }: { events: readonly VisioneEvent[]; onOpen: (notice: Notice) => void }) {
  const t = useT();
  const lang = useLanguage();
  const [open, setOpen] = useState(false);
  const [seenTs, setSeenTs] = useState(() => Date.now());
  const notices = useMemo(() => collectNotices(events, 50, lang), [events, lang]);
  const unread = countUnread(notices, seenTs);
  const box = useRef<HTMLDivElement>(null);
  // P-105 (collaudo 10/10/2026): restava aperto sopra la barra degli agenti; ora si chiude con Esc
  // o con un clic fuori, come ci si aspetta da un pannello a comparsa.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: PointerEvent): void => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  return (
    <div className="notify" ref={box}>
      <button
        type="button"
        className="notify-bell"
        data-testid="notify-bell"
        aria-expanded={open}
        aria-label={unread > 0 ? t('shell.notify.bellUnread', { n: unread }) : t('shell.notify.bell')}
        title={t('shell.notify.title')}
        onClick={() => setOpen((v) => !v)}
      >
        ◈
        {unread > 0 && <span className="notify-badge" data-testid="notify-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notify-panel" role="dialog" aria-label={t('shell.notify.dialog')} data-testid="notify-panel">
          <div className="row">
            <h4>{t('shell.notify.heading')}</h4>
            <button type="button" data-testid="notify-clear" disabled={unread === 0} onClick={() => setSeenTs(Date.now())}>
              {t('shell.notify.markRead')}
            </button>
          </div>
          {notices.length === 0 ? (
            <p className="muted small">{t('shell.notify.empty')}</p>
          ) : (
            <ul className="notify-list">
              {notices.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`notify-item sev-${n.severity}`}
                    data-testid={`notify-item-${n.id}`}
                    disabled={n.target === null}
                    onClick={() => {
                      onOpen(n);
                      setOpen(false);
                    }}
                  >
                    <span className="mono small">{clock(n.ts, lang)}</span>
                    <span className="type small">{n.title}</span>
                    <span className="muted small">{n.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
