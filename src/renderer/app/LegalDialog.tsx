// Finestra «Privacy e licenza» (11/10/2026): i testi di `src/renderer/legal/` nella lingua dell'interfaccia.
import { useEffect, useState } from 'react';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { LEGAL_TEXTS, legalSection, type LegalDoc } from './legal.ts';

export function LegalDialog({ onClose, initial = 'privacy' }: { onClose: () => void; initial?: LegalDoc }) {
  const t = useT();
  const lang = useLanguage();
  const [doc, setDoc] = useState<LegalDoc>(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="report-backdrop" role="dialog" aria-modal="true" aria-label={t('legal.title')} data-testid="legal-dialog" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="report-card legal-card">
        <h2>{t('legal.title')}</h2>
        <div className="pane-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={doc === 'privacy'} onClick={() => setDoc('privacy')} data-testid="legal-privacy">{t('legal.privacy')}</button>
          <button type="button" role="tab" aria-selected={doc === 'license'} onClick={() => setDoc('license')} data-testid="legal-license">{t('legal.license')}</button>
        </div>
        <pre className="legal-text" data-testid="legal-text">{legalSection(LEGAL_TEXTS[doc], lang)}</pre>
        <div className="report-actions">
          <button type="button" className="setup-primary" onClick={onClose}>{t('report.close')}</button>
        </div>
      </div>
    </div>
  );
}
