// Start di VISIONE (11/10/2026): tasto in basso a sinistra e pannello nello stile di VISIONE.
// Ricerca unica (app installate, impostazioni, file nelle cartelle dell'utente), app fissate,
// cartelle rapide, recenti, accensione con conferma, e il pulsante per lo Start vero di Windows.
// Tutto passa dai comandi del core già esistenti: nessun accesso diretto al sistema dal renderer.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage, useT, type MessageKey } from '../lib/i18n/index.ts';
import { settingSearchTable } from './settings-meta.ts';
import {
  addRecent, initials, rankApps, rankSettings, readStartPrefs, START_PREFS_KEY, togglePin,
  type StartApp, type StartPrefs
} from './start-logic.ts';

interface Root { id: string; name: string; path: string; exists: boolean }
interface FoundFile { name: string; path: string; kind: 'file' | 'directory' }

function loadPrefs(): StartPrefs {
  try { return readStartPrefs(localStorage.getItem(START_PREFS_KEY)); } catch { return readStartPrefs(null); }
}
function savePrefs(p: StartPrefs): void {
  try { localStorage.setItem(START_PREFS_KEY, JSON.stringify(p)); } catch { /* preferenza per PC: se manca, pazienza */ }
}

/** Il recente aperto da qualunque parte (Start o Esplora): si registra qui, si legge nello Start. */
export function rememberRecent(item: StartPrefs['recent'][number]): void {
  savePrefs(addRecent(loadPrefs(), item));
}

type Power = 'lock' | 'sleep' | 'restart' | 'shutdown' | 'quit' | 'quit-shutdown';
const POWER: ReadonlyArray<{ id: Power; label: MessageKey; confirm: boolean }> = [
  { id: 'lock', label: 'settings.start.powerLock', confirm: false },
  { id: 'sleep', label: 'settings.start.powerSleep', confirm: false },
  { id: 'restart', label: 'settings.start.powerRestart', confirm: true },
  { id: 'shutdown', label: 'settings.start.powerShutdown', confirm: true },
  // 12/10/2026: chiudere solo VISIONE, o chiuderla e poi spegnere il PC.
  { id: 'quit', label: 'settings.start.quit', confirm: true },
  { id: 'quit-shutdown', label: 'settings.start.quitShutdown', confirm: true }
];

export function StartMenu({ ready, onOpenFolder, onOpenSettings, onReport, onGuide, onLegal, onBrowser, onTraining }: {
  ready: boolean; onOpenFolder: (path: string) => void; onOpenSettings: () => void; onReport?: () => void; onGuide?: () => void; onLegal?: () => void; onBrowser?: () => void; onTraining?: () => void;
}) {
  const t = useT();
  const lang = useLanguage();
  const locale = lang === 'en' ? 'en-GB' : 'it';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState<StartApp[]>([]);
  const [roots, setRoots] = useState<Root[]>([]);
  const [files, setFiles] = useState<FoundFile[]>([]);
  const [prefs, setPrefs] = useState<StartPrefs>(loadPrefs);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Power | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const asked = useRef(0);

  // App e cartelle si chiedono alla prima apertura (l'elenco delle app costa qualche secondo).
  useEffect(() => {
    if (!open || !ready) return;
    // Ogni apertura riparte pulita (prima Esc lasciava la ricerca vecchia e nascondeva cartelle e recenti).
    setQuery('');
    setConfirming(null);
    setMessage(null);
    setPrefs(loadPrefs());
    setTimeout(() => inputRef.current?.focus(), 0);
    if (apps.length === 0) void window.visione.system.apps.list().then((res) => { if (res.ok) setApps(res.data.apps); });
    if (roots.length === 0) void window.visione.files.roots().then((res) => { if (res.ok) setRoots(res.data.roots.filter((r) => r.exists)); });
  }, [open, ready]);

  // Esc chiude; il pannello si chiude anche cliccando fuori.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setOpen(false); e.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  // File: ricerca nelle cartelle dell'utente dopo una breve pausa della tastiera.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || roots.length === 0) { setFiles([]); return; }
    const id = ++asked.current;
    const timer = setTimeout(() => {
      void Promise.all(roots.slice(0, 4).map((r) => window.visione.files.search(r.path, q))).then((all) => {
        if (id !== asked.current) return;
        setFiles(all.flatMap((res) => (res.ok ? res.data.results : [])).slice(0, 8));
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [query, roots]);

  const foundApps = useMemo(() => (query.trim() ? rankApps(apps, query, 8, locale) : []), [apps, query, locale]);
  const foundSettings = useMemo(() => rankSettings(settingSearchTable(lang), query, 5, locale), [query, lang, locale]);
  const pinned = useMemo(() => prefs.pins.map((id) => apps.find((a) => a.id === id)).filter((a): a is StartApp => a !== undefined), [prefs, apps]);

  const close = (): void => { setOpen(false); setQuery(''); setConfirming(null); setMessage(null); };
  const launch = (app: StartApp): void => {
    void window.visione.system.apps.launch(app.id).then((res) => {
      if (res.ok) close(); else setMessage(`${app.name}: ${res.error.message}`);
    });
  };
  const openPath = (item: FoundFile): void => {
    const next = addRecent(prefs, item);
    setPrefs(next);
    savePrefs(next);
    if (item.kind === 'directory') { onOpenFolder(item.path); close(); return; }
    void window.visione.files.open(item.path).then((res) => { if (res.ok) close(); else setMessage(res.error.message); });
  };
  const pin = (app: StartApp): void => {
    const next = togglePin(prefs, app.id);
    setPrefs(next);
    savePrefs(next);
  };
  const power = (p: (typeof POWER)[number]): void => {
    if (p.confirm && confirming !== p.id) { setConfirming(p.id); return; }
    if (p.id === 'quit' || p.id === 'quit-shutdown') {
      close();
      void window.visione.system.quit({ shutdown: p.id === 'quit-shutdown' });
      return;
    }
    const action = p.id;
    void window.visione.system.control.exec(p.confirm ? { action, confirm: true } : { action }).then((res) => {
      if (!res.ok) setMessage(res.error.message);
    });
    close();
  };
  const windowsStart = (): void => {
    close();
    void window.visione.system.control.exec({ action: 'start-menu' }).then((res) => { if (!res.ok) setMessage(res.error.message); });
  };

  const first = foundApps[0] ?? null;
  return (
    <>
      <button type="button" className={`start-button${open ? ' on' : ''}`} onClick={() => (open ? close() : setOpen(true))} aria-expanded={open} aria-label={t('settings.start.name')} title={t('settings.start.name')} data-testid="start-button">
        <span className="start-glyph" aria-hidden="true">◈</span>
      </button>
      {open && (
        <>
          <div className="start-scrim" onClick={close} />
          <div className="start-panel" role="dialog" aria-label={t('settings.start.name')} data-testid="start-panel">
            <input
              ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && first) launch(first); }}
              placeholder={t('settings.start.searchPlaceholder')} aria-label={t('settings.start.searchAria')} data-testid="start-search"
            />
            {message && <p className="small warn start-msg" role="status">{message}</p>}
            {query.trim() ? (
              <div className="start-results" data-testid="start-results">
                {foundApps.length > 0 && <h4>{t('settings.start.apps')}</h4>}
                {foundApps.map((a) => (
                  <div key={a.id} className="start-row">
                    <button type="button" className="start-item" onClick={() => launch(a)} data-testid="start-app"><span className="start-tile">{initials(a.name)}</span>{a.name}</button>
                    <button type="button" className="small start-pin" onClick={() => pin(a)} title={prefs.pins.includes(a.id) ? t('settings.start.unpin') : t('settings.start.pin')}>{prefs.pins.includes(a.id) ? '★' : '☆'}</button>
                  </div>
                ))}
                {foundSettings.length > 0 && <h4>{t('settings.start.settings')}</h4>}
                {foundSettings.map((s) => (
                  <button key={s.path} type="button" className="start-item" onClick={() => { onOpenSettings(); close(); }} data-testid="start-setting"><span className="start-tile">⚙</span>{s.label}</button>
                ))}
                {files.length > 0 && <h4>{t('settings.start.files')}</h4>}
                {files.map((f) => (
                  <button key={f.path} type="button" className="start-item" onClick={() => openPath(f)} title={f.path} data-testid="start-file"><span className="start-tile">{f.kind === 'directory' ? '▤' : '▢'}</span>{f.name}</button>
                ))}
                {foundApps.length + foundSettings.length + files.length === 0 && <p className="muted small">{t('settings.start.noResults')}</p>}
              </div>
            ) : (
              <div className="start-home">
                <h4>{t('settings.start.pinnedHeading')}</h4>
                {pinned.length === 0 ? <p className="muted small">{t('settings.start.pinHint')}</p> : (
                  <div className="start-grid" data-testid="start-pinned">
                    {pinned.map((a) => (
                      <button key={a.id} type="button" className="start-pinned" onClick={() => launch(a)} onContextMenu={(e) => { e.preventDefault(); pin(a); }} title={t('settings.start.pinnedTitle', { name: a.name })}>
                        <span className="start-tile big">{initials(a.name)}</span><span className="start-name">{a.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <h4>{t('settings.start.folders')}</h4>
                <div className="start-folders" data-testid="start-folders">
                  {roots.map((r) => <button key={r.id} type="button" className="small" onClick={() => { onOpenFolder(r.path); close(); }}>{r.name}</button>)}
                </div>
                <h4>{t('settings.start.recent')}</h4>
                {prefs.recent.length === 0 ? <p className="muted small">{t('settings.start.recentHint')}</p> : (
                  <div className="start-recent">
                    {prefs.recent.slice(0, 6).map((r) => (
                      <button key={r.path} type="button" className="start-item" onClick={() => openPath(r)} title={r.path}><span className="start-tile">{r.kind === 'directory' ? '▤' : '▢'}</span>{r.name}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="start-foot">
              <button type="button" className="small start-windows" onClick={windowsStart} data-testid="start-windows" title={t('settings.start.windowsTitle')}>{t('settings.start.windows')}</button>
              {onBrowser && <button type="button" className="small" onClick={() => { close(); onBrowser(); }} data-testid="start-browser" title={t('settings.start.browserTitle')}>{t('settings.start.browser')}</button>}
              {onTraining && <button type="button" className="small" onClick={() => { close(); onTraining(); }} data-testid="start-training" title={t('settings.start.trainingTitle')}>{t('settings.start.training')}</button>}
              {onGuide && <button type="button" className="small" onClick={() => { close(); onGuide(); }} data-testid="start-guide">{t('guide.open')}</button>}
              {onReport && <button type="button" className="small" onClick={() => { close(); onReport(); }} data-testid="start-report">{t('report.open')}</button>}
              {onLegal && <button type="button" className="small" onClick={() => { close(); onLegal(); }} data-testid="start-legal">{t('legal.open')}</button>}
              <span className="start-power">
                {POWER.map((p) => (
                  <button key={p.id} type="button" className={`small${confirming === p.id ? ' warn' : ''}`} onClick={() => power(p)} data-testid={`start-power-${p.id}`}>
                    {confirming === p.id ? t('settings.start.powerSure', { label: t(p.label) }) : t(p.label)}
                  </button>
                ))}
              </span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
