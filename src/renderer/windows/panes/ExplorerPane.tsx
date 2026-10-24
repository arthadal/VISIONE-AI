// Esplora VISIONE (11/10/2026, richiesta del proprietario): il file manager nello stile di VISIONE,
// al posto della finestra File semplice (P-72). Barra laterale con le cartelle, percorso cliccabile,
// griglia con miniature o elenco, selezione multipla, copia/taglia/incolla, rinomina, nuova cartella,
// Cestino (recuperabile), trascinamento sulle cartelle (Ctrl = copia), anteprima (immagini, video,
// audio, prima pagina dei PDF, testo) e ricerca. Tutto passa dai comandi del core e dagli schemi
// delle anteprime del main: il renderer non tocca il filesystem.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rememberRecent } from '../../app/StartMenu.tsx';
import { useLanguage, useT } from '../../lib/i18n/index.ts';
import { localeFor } from '../locale.ts';
import {
  canDrop, crumbs, displayName, extOf, fileUrl, formatDate, formatSize, hasThumb, parentPath, previewKind, selectAt, shortCrumbs, sortEntries, thumbUrl,
  type ExplorerEntry, type SortKey
} from './explorer-logic.ts';

interface Root { id: string; name: string; path: string; exists: boolean }
type View = 'grid' | 'list';

const PREFS_KEY = 'visione.esplora.v1';
const DRAG_TYPE = 'application/x-visione-paths';

function readPrefs(): { view: View; sort: SortKey; hidden: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { view?: unknown; sort?: unknown; hidden?: unknown };
    return { view: v.view === 'list' ? 'list' : 'grid', sort: v.sort === 'date' || v.sort === 'size' ? v.sort : 'name', hidden: v.hidden === true };
  } catch {
    return { view: 'grid', sort: 'name', hidden: false };
  }
}

/** Icona disegnata: la cartella nello stile di VISIONE, il file con la sua estensione (quando Windows non ne dà una). */
function TypeIcon({ entry }: { entry: Pick<ExplorerEntry, 'name' | 'kind'> }) {
  if (entry.kind === 'directory') {
    return <svg className="ex-svg dir" viewBox="0 0 48 40" aria-hidden="true"><path d="M2 6a3 3 0 0 1 3-3h13l4 5h21a3 3 0 0 1 3 3v24a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" /></svg>;
  }
  const ext = extOf(entry.name).slice(0, 4).toUpperCase();
  return (
    <svg className="ex-svg file" viewBox="0 0 40 48" aria-hidden="true">
      <path d="M4 2h22l10 10v32a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <path className="fold" d="M26 2v10h10" />
      {ext && <text x="20" y="36" textAnchor="middle">{ext}</text>}
    </svg>
  );
}

/** Appunti dell'Esplora, condivisi fra le finestre aperte (copia in una, incolla nell'altra). */
let clip: { mode: 'copy' | 'cut'; paths: string[] } | null = null;
const clipListeners = new Set<() => void>();
const setClip = (next: typeof clip): void => { clip = next; for (const l of clipListeners) l(); };

export function ExplorerPane({ ready, start, find = null }: { ready: boolean; start: string | null; /** Ricerca a voce: parole da cercare in tutte le cartelle dell'utente. */ find?: string | null }) {
  const t = useT();
  const lang = useLanguage();
  const locale = localeFor(lang);
  const [roots, setRoots] = useState<Root[]>([]);
  const [path, setPath] = useState<string | null>(start);
  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [results, setResults] = useState<{ query: string; entries: ExplorerEntry[] } | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState(readPrefs);
  const [noThumb, setNoThumb] = useState<Set<string>>(new Set());
  const [, setClipTick] = useState(0);
  const [history, setHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const hiddenRef = useRef(prefs.hidden);
  hiddenRef.current = prefs.hidden;

  useEffect(() => {
    const l = (): void => setClipTick((n) => n + 1);
    clipListeners.add(l);
    return () => { clipListeners.delete(l); };
  }, []);
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* preferenza per PC */ } }, [prefs]);

  const load = useCallback((target: string): Promise<void> => {
    return window.visione.files.list(target, hiddenRef.current).then((res) => {
      if (res.ok) {
        setPath(res.data.path);
        setEntries(res.data.entries);
        setResults(null);
        setSelection(new Set());
        setAnchor(null);
      } else setMessage({ ok: false, text: res.error.message });
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    void window.visione.files.roots().then((res) => {
      if (!res.ok) { setMessage({ ok: false, text: res.error.message }); return; }
      const list = res.data.roots.filter((r) => r.exists);
      setRoots(list);
      const first = start ?? list[0]?.path ?? null;
      if (!first) return;
      void load(first).then(() => {
        if (!find) return;
        // Ricerca a voce: tutte le cartelle dell'utente tranne il Profilo intero (le contiene già).
        setQuery(find);
        void Promise.all(list.filter((r) => r.id !== 'home').map((r) => window.visione.files.search(r.path, find))).then((all) => {
          const seen = new Set<string>();
          const found: ExplorerEntry[] = [];
          for (const res of all) {
            if (!res.ok) continue;
            for (const x of res.data.results) if (!seen.has(x.path)) { seen.add(x.path); found.push({ ...x, size: null, modifiedAt: null }); }
          }
          setResults({ query: find, entries: found });
          setSelection(new Set());
        });
      });
    });
  }, [ready, start, find, load]);

  const navigate = (target: string): void => {
    if (path) setHistory((h) => ({ back: [...h.back, path].slice(-50), forward: [] }));
    setQuery('');
    load(target);
  };
  const goBack = (): void => {
    const prev = history.back.at(-1);
    if (!prev) return;
    setHistory((h) => ({ back: h.back.slice(0, -1), forward: path ? [path, ...h.forward] : h.forward }));
    load(prev);
  };
  const goForward = (): void => {
    const next = history.forward[0];
    if (!next) return;
    setHistory((h) => ({ back: path ? [...h.back, path] : h.back, forward: h.forward.slice(1) }));
    load(next);
  };
  const reload = (): void => { if (path) load(path); };

  const shown = useMemo(() => sortEntries(results ? results.entries : entries, prefs.sort, lang), [results, entries, prefs.sort, lang]);
  const selected = shown.filter((e) => selection.has(e.path));
  const single = selected.length === 1 ? selected[0]! : null;
  const trail = useMemo(() => (path ? shortCrumbs(crumbs(path, roots)) : []), [path, roots]);
  const atRoot = path !== null && roots.some((r) => r.path.toLowerCase() === path.toLowerCase());

  const say = (ok: boolean, text: string): void => setMessage({ ok, text });
  const run = async <T,>(work: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>, done: (data: T) => void): Promise<void> => {
    setBusy(true);
    const res = await work();
    setBusy(false);
    if (res.ok) done(res.data); else say(false, res.error.message);
  };

  const open = (e: ExplorerEntry): void => {
    if (e.kind === 'directory') { navigate(e.path); return; }
    rememberRecent({ path: e.path, name: e.name, kind: e.kind });
    void run(() => window.visione.files.open(e.path), () => say(true, t('windows.explorer.opened', { name: e.name })));
  };
  const trash = (): void => {
    if (selected.length === 0) return;
    void run(() => window.visione.files.trash(selected.map((e) => e.path)), (d) => {
      say(d.failed.length === 0, d.failed.length === 0 ? t('windows.explorer.trashed', { n: d.trashed.length }) : t('windows.explorer.trashedPartial', { done: d.trashed.length, failed: d.failed.length }));
      reload();
    });
  };
  const copyOrCut = (mode: 'copy' | 'cut'): void => {
    if (selected.length === 0) return;
    setClip({ mode, paths: selected.map((e) => e.path) });
    say(true, t(mode === 'copy' ? 'windows.explorer.copiedHint' : 'windows.explorer.cutHint', { n: selected.length }));
  };
  const transfer = (mode: 'copy' | 'move', paths: string[], toDir: string): void => {
    void run(() => (mode === 'copy' ? window.visione.files.copy(paths, toDir) : window.visione.files.move(paths, toDir)), (d) => {
      say(true, t(mode === 'copy' ? 'windows.explorer.doneCopied' : 'windows.explorer.doneMoved', { n: d.done.length }));
      reload();
    });
  };
  const paste = (): void => {
    if (!clip || !path) return;
    const c = clip;
    if (c.mode === 'cut') setClip(null);
    transfer(c.mode === 'cut' ? 'move' : 'copy', c.paths, path);
  };
  const newFolder = (): void => {
    if (!path) return;
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    let name = t('windows.explorer.newFolderName');
    for (let n = 2; names.has(name.toLowerCase()); n++) name = t('windows.explorer.newFolderNameN', { n });
    void run(() => window.visione.files.mkdir(path, name), (d) => {
      load(path);
      setRenaming({ path: d.path, value: name });
    });
  };
  const commitRename = (): void => {
    if (!renaming) return;
    const r = renaming;
    setRenaming(null);
    const old = r.path.split(/[\\/]/).pop() ?? '';
    if (r.value.trim() === '' || r.value === old) return;
    void run(() => window.visione.files.rename(r.path, r.value.trim()), () => reload());
  };
  const search = (): void => {
    const q = query.trim();
    if (!path || q.length === 0) { setResults(null); return; }
    void run(() => window.visione.files.search(path, q), (d) => {
      setResults({ query: q, entries: d.results.map((x) => ({ ...x, size: null, modifiedAt: null })) });
      setSelection(new Set());
    });
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (renaming || (e.target as HTMLElement).tagName === 'INPUT') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete') { e.preventDefault(); trash(); }
    else if (e.key === 'F2' && single) { e.preventDefault(); setRenaming({ path: single.path, value: single.name }); }
    else if (e.key === 'F5') { e.preventDefault(); reload(); }
    else if (e.key === 'Enter' && single) { e.preventDefault(); open(single); }
    else if ((e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) && path) { e.preventDefault(); if (e.key === 'Backspace' && !atRoot) navigate(parentPath(path)); else goBack(); }
    else if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); copyOrCut('copy'); }
    else if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); copyOrCut('cut'); }
    else if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); }
    else if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(new Set(shown.map((x) => x.path))); }
    else if (e.key === 'Escape') { setSelection(new Set()); setResults(null); }
  };

  // Trascinamento: gli elementi selezionati vanno sulle cartelle (Ctrl = copia).
  const dragPaths = (e: React.DragEvent): string[] => {
    try { return JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as string[]; } catch { return []; }
  };
  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((cur) => (cur === target ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const paths = dragPaths(e);
      // La copia nella stessa cartella è lecita (diventa «nome (2)»); dentro sé stessa mai.
      if (!canDrop(paths, target, e.ctrlKey ? () => '' : parentPath)) { say(false, t('windows.explorer.dropRefused')); return; }
      transfer(e.ctrlKey ? 'copy' : 'move', paths, target);
    }
  });

  const preview = single && single.kind === 'file' ? single : null;
  return (
    <div className="pane files-pane explorer" data-testid="win-files" tabIndex={0} ref={paneRef} onKeyDown={onKey}>
      <aside className="ex-side" aria-label={t('windows.explorer.sideAria')}>
        {roots.map((r) => (
          <button key={r.id} type="button" className={`ex-root${path?.toLowerCase().startsWith(r.path.toLowerCase()) ? ' on' : ''}${dropTarget === r.path ? ' drop' : ''}`}
            onClick={() => navigate(r.path)} data-testid={`files-root-${r.id}`} {...dropProps(r.path)}>{r.name}</button>
        ))}
      </aside>
      <section className="ex-main">
        <div className="ex-bar">
          <button type="button" className="small" onClick={goBack} disabled={history.back.length === 0} title={t('windows.explorer.backTitle')} aria-label={t('windows.explorer.back')}>←</button>
          <button type="button" className="small" onClick={goForward} disabled={history.forward.length === 0} title={t('windows.explorer.forward')} aria-label={t('windows.explorer.forward')}>→</button>
          <button type="button" className="small" onClick={() => path && navigate(parentPath(path))} disabled={!path || atRoot} title={t('windows.explorer.upTitle')} aria-label={t('windows.explorer.up')}>↑</button>
          <nav className="ex-crumbs" aria-label={t('windows.explorer.crumbsAria')} data-testid="files-crumbs">
            {trail.map((c, i) => (
              <span key={c.path}>
                {i > 0 && <span className="ex-sep">›</span>}
                <button type="button" className={`ex-crumb${dropTarget === c.path ? ' drop' : ''}`} onClick={() => navigate(c.path)} title={c.hidden ?? c.path} {...dropProps(c.path)}>{c.label}</button>
              </span>
            ))}
          </nav>
          <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); if (e.target.value === '') setResults(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }} placeholder={t('windows.explorer.searchPlaceholder')} aria-label={t('windows.explorer.searchAria')} data-testid="files-search" />
          <select value={prefs.sort} onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as SortKey }))} aria-label={t('windows.explorer.sortAria')}>
            <option value="name">{t('windows.explorer.sortName')}</option><option value="date">{t('windows.explorer.sortDate')}</option><option value="size">{t('windows.explorer.sortSize')}</option>
          </select>
          <button type="button" className="small" onClick={() => setPrefs((p) => ({ ...p, view: p.view === 'grid' ? 'list' : 'grid' }))} title={prefs.view === 'grid' ? t('windows.explorer.viewList') : t('windows.explorer.viewGrid')} data-testid="files-view">{prefs.view === 'grid' ? '☰' : '▦'}</button>
          <button type="button" className={`small${prefs.hidden ? ' on' : ''}`} aria-pressed={prefs.hidden} data-testid="files-hidden"
            onClick={() => { hiddenRef.current = !prefs.hidden; setPrefs((p) => ({ ...p, hidden: !p.hidden })); if (path) load(path); }}
            title={t('windows.explorer.hiddenTitle')}>{t('windows.explorer.hidden')}</button>
        </div>
        <div className="ex-actions">
          <button type="button" className="small" onClick={newFolder} disabled={busy || !path || results !== null} data-testid="files-mkdir">{t('windows.explorer.newFolderButton')}</button>
          <button type="button" className="small" onClick={() => single && setRenaming({ path: single.path, value: single.name })} disabled={!single || busy}>{t('windows.explorer.rename')}</button>
          <button type="button" className="small" onClick={() => copyOrCut('copy')} disabled={selected.length === 0}>{t('windows.explorer.copy')}</button>
          <button type="button" className="small" onClick={() => copyOrCut('cut')} disabled={selected.length === 0}>{t('windows.explorer.cut')}</button>
          <button type="button" className="small" onClick={paste} disabled={!clip || !path || busy || results !== null} data-testid="files-paste">{t('windows.explorer.paste')}{clip ? ` (${clip.paths.length})` : ''}</button>
          <button type="button" className="small warn" onClick={trash} disabled={selected.length === 0 || busy} data-testid="files-trash">{t('windows.explorer.trash')}</button>
          <button type="button" className="small" onClick={() => single && open(single)} disabled={!single}>{t('windows.common.open')}</button>
          <button type="button" className="small" onClick={reload} disabled={!path} title={t('windows.explorer.refreshTitle')}>⟳</button>
        </div>
        {message && <p className={`small ex-msg${message.ok ? '' : ' error'}`} role="status">{message.text}</p>}
        {results && <p className="small muted ex-msg">{t('windows.explorer.resultsFor', { query: results.query, n: results.entries.length })} <button type="button" className="small" onClick={() => { setResults(null); setQuery(''); }}>×</button></p>}
        <div className={`ex-items ${prefs.view}`} data-testid="files-list" onClick={(e) => { if (e.target === e.currentTarget) setSelection(new Set()); }} {...(path ? dropProps(path) : {})}>
          {shown.length === 0 && <p className="muted small">{results ? t('windows.explorer.noResults') : t('windows.explorer.emptyFolder')}</p>}
          {shown.map((entry, i) => {
            const isSel = selection.has(entry.path);
            // Foto, video e PDF: la miniatura; gli altri file: l'icona vera di Windows; altrimenti l'icona disegnata.
            const photo = hasThumb(entry.name);
            const thumb = entry.kind === 'file' && !noThumb.has(entry.path);
            return (
              <div
                key={entry.path} className={`ex-item${isSel ? ' sel' : ''}${dropTarget === entry.path ? ' drop' : ''}${clip?.mode === 'cut' && clip.paths.includes(entry.path) ? ' cut' : ''}`}
                draggable={!renaming} data-testid="files-entry" title={entry.path}
                onClick={(e) => { const r = selectAt(selection, shown, i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }, anchor); setSelection(r.selection); setAnchor(r.anchor); paneRef.current?.focus(); }}
                onDoubleClick={() => open(entry)}
                onDragStart={(e) => {
                  const paths = isSel ? selected.map((x) => x.path) : [entry.path];
                  if (!isSel) setSelection(new Set([entry.path]));
                  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
                  e.dataTransfer.effectAllowed = 'copyMove';
                }}
                {...(entry.kind === 'directory' ? dropProps(entry.path) : {})}
              >
                <span className={`ex-icon${thumb && !photo ? ' ico' : ''}`}>
                  {thumb
                    ? <img src={thumbUrl(entry.path, photo && prefs.view === 'grid' ? 96 : 32)} alt="" loading="lazy" onError={() => setNoThumb((s) => new Set(s).add(entry.path))} />
                    : <TypeIcon entry={entry} />}
                </span>
                {renaming?.path === entry.path ? (
                  <input className="ex-rename" autoFocus value={renaming.value} onChange={(e) => setRenaming({ path: entry.path, value: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }} onBlur={commitRename} onClick={(e) => e.stopPropagation()} />
                ) : <span className="ex-name">{displayName(entry.name)}</span>}
                {prefs.view === 'list' && <span className="ex-meta">{entry.kind === 'file' ? formatSize(entry.size, lang) : ''}</span>}
                {prefs.view === 'list' && <span className="ex-meta">{formatDate(entry.modifiedAt, locale)}</span>}
              </div>
            );
          })}
        </div>
        <p className="small muted ex-status">{t(shown.length === 1 ? 'windows.explorer.itemsOne' : 'windows.explorer.itemsOther', { n: shown.length })}{selected.length > 0 ? ` · ${t('windows.explorer.selectedCount', { n: selected.length })}` : ''} · {t('windows.explorer.dragHint')}</p>
      </section>
      {preview && <Preview entry={preview} onOpen={() => open(preview)} />}
    </div>
  );
}

function Preview({ entry, onOpen }: { entry: ExplorerEntry; onOpen: () => void }) {
  const t = useT();
  const lang = useLanguage();
  const kind = previewKind(entry.name);
  const [text, setText] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    setErr(null);
    if (kind !== 'text') return;
    void window.visione.files.read(entry.path).then((res) => {
      if (res.ok) setText({ path: entry.path, text: res.data.text, truncated: res.data.truncated }); else setErr(res.error.message);
    });
  }, [entry.path, kind]);
  return (
    <aside className="ex-preview" aria-label={t('windows.explorer.previewAria')} data-testid="files-preview">
      <div className="ex-preview-body">
        {kind === 'image' && <img src={fileUrl(entry.path)} alt={entry.name} />}
        {kind === 'video' && <video src={fileUrl(entry.path)} controls preload="metadata" />}
        {kind === 'audio' && <audio src={fileUrl(entry.path)} controls preload="metadata" />}
        {kind === 'pdf' && <><img src={thumbUrl(entry.path, 800)} alt={entry.name} /><p className="muted small">{t('windows.explorer.pdfNote')}</p></>}
        {kind === 'text' && (err ? <p className="muted small">{err}</p> : <pre>{text?.path === entry.path ? text.text : '…'}{text?.truncated ? '\n…' : ''}</pre>)}
        {kind === 'other' && <p className="muted small">{t('windows.explorer.noPreview')}</p>}
      </div>
      <p className="ex-preview-name" title={entry.path}>{entry.name}</p>
      <p className="small muted">{formatSize(entry.size, lang)}{entry.modifiedAt !== null ? ` · ${formatDate(entry.modifiedAt, localeFor(lang))}` : ''}</p>
      <button type="button" className="small" onClick={onOpen}>{t('windows.common.open')}</button>
    </aside>
  );
}
