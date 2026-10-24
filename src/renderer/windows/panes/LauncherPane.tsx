// Launcher (Fase 24, P-71): elenco REALE delle applicazioni installate (menu Start di Windows via
// core) e avvio col meccanismo supportato (`shell:AppsFolder`). Nessuna lista statica nel prodotto:
// se l'elenco non arriva, si dichiara l'errore; l'avvio è consentito solo per id del catalogo.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../lib/i18n/index.ts';

interface OsApp {
  id: string;
  name: string;
}

export function LauncherPane({ ready }: { ready: boolean }) {
  const t = useT();
  const [apps, setApps] = useState<OsApp[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (): void => {
    if (!ready) return;
    setLoading(true);
    void window.visione.system.apps.list().then((res) => {
      setLoading(false);
      if (res.ok) {
        setApps(res.data.apps);
        setError(null);
      } else {
        setError(`${res.error.code}: ${res.error.message}`);
      }
    });
  };
  useEffect(load, [ready]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q === '' ? apps : apps.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
    return list.slice(0, 200);
  }, [apps, query]);

  const launch = (app: OsApp): void => {
    setBusy(app.id);
    void window.visione.system.apps.launch(app.id).then((res) => {
      setBusy(null);
      setError(res.ok ? null : `${res.error.code}: ${res.error.message}`);
    });
  };

  return (
    <div className="pane launcher-pane" data-testid="win-apps">
      <div className="row">
        <input
          aria-label={t('windows.apps.searchAria')}
          data-testid="apps-search"
          placeholder={t('windows.apps.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={load} disabled={!ready || loading} data-testid="apps-reload">{loading ? '…' : t('windows.common.refresh')}</button>
      </div>
      {error && <p className="error small">{error}</p>}
      {apps.length === 0 && !loading ? (
        <p className="muted small">{t('windows.apps.empty')}</p>
      ) : (
        <ul className="apps-list" data-testid="apps-list">
          {filtered.map((a, i) => (
            <li key={a.id}>
              <button type="button" className="app-item" data-testid={`app-item-${i}`} disabled={busy !== null} onClick={() => launch(a)} title={a.id}>
                <span className="type small">{a.name}</span>
                <span className="muted small mono">{a.id.slice(0, 64)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
