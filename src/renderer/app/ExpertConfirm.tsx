// Avviso prima di accendere la modalità esperto (17/10/2026, richiesta del proprietario): mostra impostazioni
// tecniche che, cambiate male, possono fermare gli agenti o la voce. Si conferma solo per accenderla; «Annulla»
// è la scelta proposta (e anche Esc). Stesso aspetto della richiesta di riavvio.
import { useEffect } from 'react';
import { useT } from '../lib/i18n/index.ts';

export function ExpertConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="restart-backdrop" role="presentation">
      <section className="restart-prompt expert-confirm hud-panel" role="alertdialog" aria-modal="true" aria-labelledby="expert-title" data-testid="expert-confirm">
        <h2 id="expert-title">{t('mode.confirm.title')}</h2>
        <ul className="small restart-list">
          <li>{t('mode.confirm.what')}</li>
          <li className="restart-warn">{t('mode.confirm.risk')}</li>
          <li>{t('mode.confirm.safe')}</li>
        </ul>
        <div className="restart-actions">
          <button type="button" onClick={onCancel} className="setup-primary" data-testid="expert-cancel" autoFocus>{t('mode.confirm.cancel')}</button>
          <button type="button" onClick={onConfirm} data-testid="expert-ok">{t('mode.confirm.ok')}</button>
        </div>
      </section>
    </div>
  );
}
