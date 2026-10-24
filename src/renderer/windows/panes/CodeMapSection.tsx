// Mappa del codice (P-107l), dentro la finestra Addestramento: le cartelle di lavoro degli agenti che
// VISIONE indicizza, con stato, interruttore, «Aggiorna ora» e la prova di cosa riceverebbe un agente.
import { useEffect, useState } from 'react';
import type { CodeRoot } from '../../../shared/contracts/index.ts';
import { useLanguage, useT } from '../../lib/i18n/index.ts';
import { formatAgo, formatDuration } from '../../lib/time.ts';
import { shortRoot } from './training-logic.ts';

export function CodeMapSection({ ready }: { ready: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const [roots, setRoots] = useState<CodeRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [probeRoot, setProbeRoot] = useState<string>('');
  const [probe, setProbe] = useState('');
  const [preview, setPreview] = useState<{ text: string; files: number } | null>(null);

  const load = (): void => {
    if (!ready) return;
    void window.visione.codemap.status().then((res) => {
      if (res.ok) {
        setRoots(res.data.roots);
        setError(null);
        setProbeRoot((cur) => (cur && res.data.roots.some((r) => r.root === cur) ? cur : res.data.roots[0]?.root ?? ''));
      } else setError(res.error.message);
    });
  };
  useEffect(load, [ready]);

  const replace = (root: CodeRoot): void => setRoots((list) => list?.map((r) => (r.root === root.root ? root : r)) ?? list);
  const scan = (root: string): void => {
    setBusy(root);
    void window.visione.codemap.scan(root).then((res) => {
      setBusy(null);
      if (res.ok) { replace(res.data.root); setError(null); }
      else setError(res.error.message);
    });
  };
  const toggle = (r: CodeRoot): void => {
    void window.visione.codemap.set(r.root, !r.enabled).then((res) => {
      if (res.ok) { replace(res.data.root); setError(null); }
      else setError(res.error.message);
    });
  };
  const runProbe = (): void => {
    if (!probeRoot || !probe.trim()) return;
    setBusy('probe');
    void window.visione.codemap.preview(probeRoot, probe.trim()).then((res) => {
      setBusy(null);
      if (res.ok) { setPreview(res.data); setError(null); }
      else setError(res.error.message);
    });
  };

  const stateOf = (r: CodeRoot): string => {
    if (busy === r.root || r.scanning) return t('windows.codemap.scanning');
    if (r.error) return t('windows.codemap.failed', { error: r.error });
    if (r.scannedAt === null) return t('windows.codemap.never');
    return t('windows.codemap.indexed', {
      files: r.files, symbols: r.symbols, ago: formatAgo(Date.now() - r.scannedAt, lang),
      ms: r.durationMs === null ? '—' : r.durationMs < 1_000 ? `${r.durationMs} ms` : formatDuration(r.durationMs, lang)
    }) + (r.truncated ? ` · ${t('windows.codemap.truncated')}` : '');
  };

  return (
    <div className="codemap-section" data-testid="codemap-section">
      <p className="training-intro">{t('windows.codemap.intro')}</p>
      {roots === null && !error && <p className="muted small">{t('windows.training.loading')}</p>}
      {roots !== null && roots.length === 0 && <p className="muted small">{t('windows.codemap.none')}</p>}
      <ul className="training-list">
        {(roots ?? []).map((r) => (
          <li key={r.root} className={`training-card${r.enabled ? ' on' : ''}`} data-testid="codemap-root">
            <div className="training-head">
              <strong className="mono small codemap-path" title={r.root}>{shortRoot(r.root)}</strong>
              <button type="button" className="small" disabled={busy === r.root || r.scanning} onClick={() => scan(r.root)} data-testid="codemap-scan">{t('windows.codemap.scan')}</button>
              <button type="button" className={`small${r.enabled ? '' : ' primary'}`} onClick={() => toggle(r)} data-testid="codemap-toggle">
                {r.enabled ? t('windows.codemap.disable') : t('windows.codemap.enable')}
              </button>
            </div>
            <p className="muted small" data-testid="codemap-state">
              {stateOf(r)}
              {' · '}
              {r.inUse ? t('windows.codemap.inUse') : t('windows.codemap.notInUse')}
              {r.enabled ? '' : ` · ${t('windows.codemap.off')}`}
            </p>
          </li>
        ))}
      </ul>
      {roots !== null && roots.length > 0 && (
        <div className="training-form codemap-probe">
          <label className="small">{t('windows.codemap.probeLabel')}
            <input value={probe} onChange={(e) => setProbe(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') runProbe(); }} placeholder={t('windows.codemap.probeHint')} data-testid="codemap-probe" />
          </label>
          {roots.length > 1 && (
            <select value={probeRoot} onChange={(e) => setProbeRoot(e.target.value)} className="small">
              {roots.map((r) => <option key={r.root} value={r.root}>{shortRoot(r.root)}</option>)}
            </select>
          )}
          <div className="training-actions">
            <button type="button" className="small primary" disabled={!probe.trim() || busy === 'probe'} onClick={runProbe} data-testid="codemap-probe-run">{t('windows.codemap.probeRun')}</button>
          </div>
          {preview && (preview.files > 0
            ? <pre className="training-rule mono small codemap-preview" data-testid="codemap-preview">{preview.text}</pre>
            : <p className="muted small" data-testid="codemap-preview">{t('windows.codemap.probeNone')}</p>)}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
