// Modalità offline nell'interfaccia (17/10/2026, richiesta del proprietario): la spia online/offline, il tasto
// «Entra in modalità offline» / «Torna online», l'avviso sui limiti (a conferma quando ci si entra col tasto,
// come pannello che non blocca quando ci si passa da soli), le risposte del modello locale e il riquadro del
// modello (stato, download su consenso con dimensione e licenza).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OfflineState, VisioneEvent } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { formatSize, setOffline, setOfflineState, useOfflineState } from './offline-store.ts';

/** Stato iniziale dal core e aggiornamenti dagli eventi: da montare una volta (in App). */
export function useOfflineSync(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void window.visione.offline.status().then((res) => { if (alive && res.ok) setOfflineState(res.data); });
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.type === 'offline.changed') setOfflineState((e.payload as { state: OfflineState }).state);
    });
    return () => { alive = false; off(); };
  }, [ready]);
}

type Progress = { phase: string; received: number; total: number; error: string | null };

/** Riquadro del modello locale: stato, scaricamento con avanzamento, annullamento. */
export function OfflineModelBox() {
  const t = useT();
  const lang = useLanguage();
  const s = useOfflineState();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => window.visione.events.subscribe((e: VisioneEvent) => {
    if (e.type !== 'offline.model.progress') return;
    const p = e.payload as Progress;
    setProgress(p);
    if (p.phase === 'completato') setNote(t('offline.model.done'));
    else if (p.phase === 'errore') setNote(t('offline.model.failed', { error: p.error ?? '' }));
    else if (p.phase === 'annullato') setNote(null);
  }), [t]);
  if (!s) return null;
  const m = s.model;
  const size = formatSize(m.sizeBytes, lang);
  const status = m.status === 'missing' ? t('offline.model.missing', { size, license: m.license })
    : m.status === 'downloading' ? t('offline.model.downloading', { done: formatSize(progress?.received ?? m.received, lang), size })
    : m.status === 'loading' ? t('offline.model.loading')
    : m.status === 'ready' ? t('offline.model.ready', { name: m.name })
    : m.status === 'error' ? t('offline.model.error', { error: m.error ?? '' })
    : t('offline.model.idle', { name: m.name });
  const pct = m.status === 'downloading' && m.sizeBytes > 0 ? Math.min(100, Math.round(((progress?.received ?? m.received) / m.sizeBytes) * 100)) : null;
  return (
    <div className="offline-model small" data-testid="offline-model">
      <div><strong>{t('offline.model.title')}:</strong> <span data-testid="offline-model-status">{status}</span></div>
      {pct !== null && <progress max={100} value={pct} aria-label={status} />}
      {m.status === 'missing' && (
        <>
          <p className="muted">{t('offline.model.consent', { name: m.name, license: m.license })}</p>
          {!s.ramOk && <p className="restart-warn">{t('offline.model.ram')}</p>}
          <button type="button" data-testid="offline-download" disabled={s.network === 'offline'} onClick={() => { setNote(null); void window.visione.offline.download(); }}>{t('offline.model.download', { size })}</button>
          {s.network === 'offline' && <p className="muted">{t('offline.notice.missingNoNet')}</p>}
        </>
      )}
      {m.status === 'downloading' && <button type="button" data-testid="offline-download-cancel" onClick={() => void window.visione.offline.cancelDownload()}>{t('offline.model.cancel')}</button>}
      {note && <p className="muted" role="status" data-testid="offline-model-note">{note}</p>}
    </div>
  );
}

/** I limiti, detti allo stesso modo nell'avviso a conferma e in quello automatico. */
function Limits({ manual }: { manual: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const s = useOfflineState();
  return (
    <ul className="small restart-list">
      <li>{t('offline.notice.what')}</li>
      <li className="restart-warn">{t('offline.notice.not')}</li>
      <li>{t('offline.notice.risk')}</li>
      <li>{t('offline.notice.slow')}</li>
      <li>{manual ? t('offline.notice.backManual') : t('offline.notice.backAuto')}</li>
      {s && s.model.status === 'missing' && <li className="restart-warn" data-testid="offline-notice-missing">{t('offline.notice.missing', { size: formatSize(s.model.sizeBytes, lang) })}</li>}
    </ul>
  );
}

/** Conferma prima di entrare col tasto: «Annulla» è la scelta proposta (e anche Esc). */
function OfflineConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  const s = useOfflineState();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="restart-backdrop" role="presentation">
      <section className="restart-prompt expert-confirm offline-confirm hud-panel" role="alertdialog" aria-modal="true" aria-labelledby="offline-title" data-testid="offline-confirm">
        <h2 id="offline-title">{t('offline.notice.title')}</h2>
        <Limits manual />
        {s?.model.status === 'missing' && <OfflineModelBox />}
        <div className="restart-actions">
          <button type="button" onClick={onCancel} className="setup-primary" data-testid="offline-cancel" autoFocus>{t('offline.notice.cancel')}</button>
          <button type="button" onClick={onConfirm} data-testid="offline-ok">{t('offline.notice.ok')}</button>
        </div>
      </section>
    </div>
  );
}

/** Spia e tasto, in alto a destra sotto la riga di stato. */
export function OfflineLamp() {
  const t = useT();
  const s = useOfflineState();
  const [ask, setAsk] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!s) return null;
  const toggle = (active: boolean): void => {
    setFailed(null);
    void setOffline(active).then((err) => { if (err) setFailed(err.message); });
  };
  // Con l'automatico spento la rete non si controlla (nessuna connessione): la spia lo dice invece di indovinare.
  const label = s.active ? (s.manual ? t('offline.lamp.manual') : t('offline.lamp.offline'))
    : s.network === 'unknown' ? (s.auto ? t('offline.lamp.unknown') : t('offline.lamp.unchecked'))
    : t('offline.lamp.online');
  const kind = s.active ? 'offline' : s.network === 'unknown' ? 'unknown' : 'online';
  // Tornare online col tasto ha senso solo se la rete c'è (o se l'automatico è spento).
  const blocked = s.active && !s.manual;
  return (
    <>
    <div className="offline-group mono" data-testid="offline-group">
      <span className={`offline-lamp offline-lamp-${kind}`} data-testid="offline-lamp" data-state={kind} title={t('offline.lamp.title')}>
        <i className="offline-dot" aria-hidden="true" />{label}
      </span>
      {s.active ? (
        <button
          type="button" className="cmd-tasto offline-toggle" data-testid="offline-leave"
          disabled={blocked} title={blocked ? t('offline.leaveBlocked') : undefined}
          onClick={() => toggle(false)}
        >{t('offline.leave')}</button>
      ) : (
        <button type="button" className="cmd-tasto offline-toggle" data-testid="offline-enter" onClick={() => setAsk(true)}>{t('offline.enter')}</button>
      )}
      {failed && <span className="offline-failed" role="alert" data-testid="offline-failed">{t('offline.setFailed', { error: failed })}</span>}
    </div>
    {/* Fuori dalla barra in alto (che ha il suo livello e il maiuscolo): disegnato direttamente nella pagina. */}
    {ask && createPortal(
      <OfflineConfirm
        onCancel={() => setAsk(false)}
        onConfirm={() => {
          setAsk(false);
          toggle(true);
        }}
      />,
      document.body
    )}
    </>
  );
}

/** Avviso quando ci si passa da soli (rete caduta): non blocca, si chiude con «Ho capito». */
export function OfflineAlert() {
  const t = useT();
  const s = useOfflineState();
  const [seen, setSeen] = useState<number | null>(null);
  if (!s || !s.active || s.manual || seen === s.since) return null;
  return (
    <section className="offline-alert hud-panel" role="alert" data-testid="offline-alert">
      <h2>{t('offline.notice.autoTitle')}</h2>
      <Limits manual={false} />
      <div className="restart-actions">
        <button type="button" className="setup-primary" data-testid="offline-alert-ok" onClick={() => setSeen(s.since)}>{t('offline.notice.understood')}</button>
      </div>
    </section>
  );
}

type Reply = { id: string; text: string; reply: string; outcome: string; understood: string | null };

/** L'ultima risposta del modello locale, sopra la barra comandi (scritta o a voce); sì/no se chiede conferma. */
export function OfflineReplies() {
  const t = useT();
  const lang = useLanguage();
  const s = useOfflineState();
  const [last, setLast] = useState<Reply | null>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => window.visione.events.subscribe((e: VisioneEvent) => {
    if (e.type !== 'offline.reply' || e.id === shown.current) return;
    shown.current = e.id;
    const p = e.payload as Omit<Reply, 'id'>;
    setLast({ id: e.id, ...p });
  }), []);
  if (!last || !s?.active) return null;
  const answer = (yes: boolean): void => { void window.visione.offline.ask(yes ? (lang === 'en' ? 'yes' : 'sì') : 'no'); };
  return (
    <div className={`offline-reply offline-reply-${last.outcome}`} role="status" aria-label={t('offline.reply.aria')} data-testid="offline-reply">
      <span className="muted">«{last.text}»</span>
      <span className="offline-reply-text" data-testid="offline-reply-text">{last.reply}</span>
      {last.understood && last.outcome !== 'confirm' && <span className="muted small">{t('offline.reply.understood', { text: last.understood })}</span>}
      {last.outcome === 'confirm' && (
        <>
          <button type="button" className="setup-primary" data-testid="offline-yes" onClick={() => answer(true)}>{t('offline.reply.yes')}</button>
          <button type="button" data-testid="offline-no" onClick={() => answer(false)}>{t('offline.reply.no')}</button>
        </>
      )}
      <button type="button" className="offline-reply-close" aria-label={t('offline.reply.close')} onClick={() => setLast(null)}>×</button>
    </div>
  );
}

/** Impostazioni: passaggio automatico e modello locale (visibili anche in modalità semplice). */
export function OfflineSettings({ auto, onAuto }: { auto: boolean; onAuto: (on: boolean) => void }) {
  const t = useT();
  return (
    <section className="settings-section" data-testid="settings-offline">
      <h3>{t('offline.settings.title')}</h3>
      <label className="small" title={t('offline.settings.autoTitle')}>
        <input type="checkbox" checked={auto} onChange={(e) => onAuto(e.target.checked)} data-testid="setting-offline-auto" /> {t('offline.settings.auto')}
      </label>
      <OfflineModelBox />
    </section>
  );
}
