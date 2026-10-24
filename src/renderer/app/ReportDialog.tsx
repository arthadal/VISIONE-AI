// Segnala un problema (11/10/2026, prima dell'uscita): il tester descrive cosa è successo e VISIONE
// prepara un pacchetto ripulito (core: `support.report`) da allegare a un'email. Niente viene inviato.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n/index.ts';

export function ReportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ file: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    area.current?.focus();
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const create = (): void => {
    setBusy(true);
    setError(null);
    void window.visione.support.report(note).then((res) => {
      setBusy(false);
      if (res.ok) setResult({ file: res.data.file }); else setError(res.error.message);
    });
  };
  const folderOf = (file: string): string => file.replace(/[\\/][^\\/]*$/, '');

  return (
    <div className="report-backdrop" role="dialog" aria-modal="true" aria-label={t('report.title')} data-testid="report-dialog" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="report-card">
        <h2>{t('report.title')}</h2>
        {result === null ? (
          <>
            <label className="report-label" htmlFor="report-note">{t('report.what')}</label>
            <textarea id="report-note" ref={area} rows={5} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} placeholder={t('report.placeholder')} data-testid="report-note" />
            <p className="muted small">{t('report.contents')}</p>
            <p className="muted small">{t('report.local')}</p>
            {error && <p className="error small">{error}</p>}
            <div className="report-actions">
              <button type="button" onClick={onClose}>{t('report.close')}</button>
              <button type="button" className="setup-primary" onClick={create} disabled={busy} data-testid="report-create">{busy ? t('report.creating') : t('report.create')}</button>
            </div>
          </>
        ) : (
          <>
            <p className="report-done" data-testid="report-done">{t('report.done', { file: result.file })}</p>
            <p className="muted small">{t('report.local')}</p>
            {copied && <p className="muted small">{t('report.copied')}</p>}
            <div className="report-actions">
              <button type="button" onClick={() => { void navigator.clipboard.writeText(result.file).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{t('report.copyPath')}</button>
              <button type="button" onClick={() => { void window.visione.files.open(folderOf(result.file)); }} data-testid="report-open-folder">{t('report.openFolder')}</button>
              <button type="button" className="setup-primary" onClick={onClose}>{t('report.close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
