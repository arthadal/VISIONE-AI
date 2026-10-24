// Finestra di richiesta del riavvio (11/10/2026): compare quando un'impostazione salvata vale solo dal
// riavvio di VISIONE. Se il Director o gli agenti stanno lavorando lo dice e propone di riavviare quando
// hanno finito; il riavvio a lavoro finito parte dopo un preavviso annullabile.
import type { Language } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import type { Busy } from './restart-logic.ts';
import { busyText } from './restart-logic.ts';
import { settingMeta } from './settings-meta.ts';

const labelOf = (path: string, lang: Language): string => settingMeta(path, lang).label || path;

export function RestartPrompt({ changed, busy, onNow, onWhenIdle, onLater }: {
  changed: readonly string[];
  busy: Busy | null;
  onNow: () => void;
  onWhenIdle: () => void;
  onLater: () => void;
}) {
  const t = useT();
  const lang = useLanguage();
  const working = busy !== null && busy.total > 0;
  return (
    <div className="restart-backdrop" role="presentation">
      <section className="restart-prompt hud-panel" role="alertdialog" aria-modal="true" aria-labelledby="restart-title" data-testid="restart-prompt">
        <h2 id="restart-title">{t('shell.restart.title')}</h2>
        <p className="small">{t('shell.restart.saved')}</p>
        <ul className="small restart-list" data-testid="restart-changed">
          {changed.slice(0, 8).map((p) => <li key={p} title={p}>{labelOf(p, lang)}</li>)}
          {changed.length > 8 && <li className="muted">{t('shell.restart.more', { n: changed.length - 8 })}</li>}
        </ul>
        {working ? (
          <p className="small restart-warn" data-testid="restart-busy">
            {t('shell.restart.busy', { what: busyText(busy, lang) })}
          </p>
        ) : busy === null ? (
          <p className="small muted">{t('shell.restart.unknown')}</p>
        ) : (
          <p className="small muted" data-testid="restart-idle">{t('shell.restart.idle')}</p>
        )}
        <div className="restart-actions">
          {working && (
            <button type="button" className="setup-primary" onClick={onWhenIdle} data-testid="restart-when-idle" autoFocus>
              {t('shell.restart.whenIdle')}
            </button>
          )}
          <button type="button" className={working ? undefined : 'setup-primary'} onClick={onNow} data-testid="restart-now" autoFocus={!working}>
            {working ? t('shell.restart.nowAnyway') : t('shell.restart.now')}
          </button>
          <button type="button" onClick={onLater} data-testid="restart-later">{t('shell.restart.later')}</button>
        </div>
      </section>
    </div>
  );
}

/** Striscia in alto mentre il riavvio aspetta la fine del lavoro, o conta i secondi prima di partire. */
export function RestartWaitBar({ busy, countdown, onNow, onCancel }: {
  busy: Busy | null;
  /** Secondi al riavvio (lavoro finito); null = si aspetta ancora la fine del lavoro. */
  countdown: number | null;
  onNow: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const lang = useLanguage();
  return (
    <div className="restart-bar" role="status" data-testid="restart-wait">
      <span className="mono small">
        {countdown !== null
          ? t('shell.restart.countdown', { s: countdown })
          : t('shell.restart.waiting', { what: busy && busy.total > 0 ? busyText(busy, lang) : t('shell.restart.checking') })}
      </span>
      <button type="button" className="small" onClick={onNow} data-testid="restart-wait-now">{t('shell.restart.now')}</button>
      <button type="button" className="small" onClick={onCancel} data-testid="restart-wait-cancel">{t('shell.restart.cancel')}</button>
    </div>
  );
}
