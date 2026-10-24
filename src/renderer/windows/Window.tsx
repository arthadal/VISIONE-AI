// Chrome di una finestra JARVIS (Fase 18): intestazione con titolo/sottotitolo e controlli (tendina,
// minimizza, massimizza, chiudi), trascinamento dal titolo, ridimensionamento dall'angolo. Il
// meccanismo drag/resize è adattato (MIT, Dix01/JARVIS `Floating.tsx`): i listener stanno su `window`
// durante l'operazione, così funzionano anche con eventi sintetici dei test; la geometria è vincolata
// al viewport. Fase G5 (P-77): la testata adotta il vocabolario `.term-testa` del JARVIS del
// proprietario (MIT © 2026 Aditya Dewaskar, `src/ui/Terminali.tsx`): spia di stato reale, stato breve,
// tasti quadrati; il corpo ha la scanline interna e l'angolo di resize a due tacche. Nessun testid
// o comportamento del Window Manager (P-68) cambia.
import { useEffect, useRef } from 'react';
import { useT } from '../lib/i18n/index.ts';
import { snapBounds, type WindowBounds, type WindowState } from './manager.ts';
import type { WindowStatus } from './status.ts';

export interface WindowChromeProps {
  win: WindowState;
  focused: boolean;
  /** Stato reale della finestra (proiezione `windows/status.ts`), mostrato nella testata. */
  status: WindowStatus;
  maximized: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleShade: () => void;
  onMaximize: () => void;
  onBounds: (bounds: WindowBounds) => void;
  children: React.ReactNode;
}

export function WindowChrome({ win, focused, status, maximized, onFocus, onClose, onMinimize, onToggleShade, onMaximize, onBounds, children }: WindowChromeProps) {
  const t = useT();
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resize = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);
  const boundsRef = useRef(win.bounds);
  boundsRef.current = win.bounds;

  const clamp = (b: WindowBounds): WindowBounds => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(300, Math.min(b.w, Math.max(300, vw)));
    const h = Math.max(200, Math.min(b.h, Math.max(200, vh)));
    return { x: Math.max(0, Math.min(b.x, Math.max(0, vw - w))), y: Math.max(0, Math.min(b.y, Math.max(0, vh - h))), w, h };
  };

  const fromControl = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    return el?.closest?.('button, input, select, textarea, a') != null;
  };

  const startDrag = (e: React.PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return;
    // G5: un click sui tasti della testata NON avvia il trascinamento (niente snap involontario).
    if (fromControl(e.target)) return;
    onFocus();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: win.bounds.x, oy: win.bounds.y };
    // Durante il trascinamento le pagine del browser non devono catturare il puntatore (CSS).
    document.documentElement.dataset.winDrag = '1';
    e.preventDefault();
  };
  const onHeadDoubleClick = (e: React.MouseEvent): void => {
    if (fromControl(e.target)) return;
    onToggleShade();
  };
  const startResize = (e: React.PointerEvent): void => {
    e.stopPropagation();
    if (e.button !== undefined && e.button !== 0) return;
    onFocus();
    resize.current = { sx: e.clientX, sy: e.clientY, ow: win.bounds.w, oh: win.bounds.h };
    document.documentElement.dataset.winDrag = '1';
    e.preventDefault();
  };
  // I listener stanno su `window`: il drag continua anche se il puntatore esce dall'header.
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (drag.current) {
        const d = drag.current;
        onBounds(clamp({ ...boundsRef.current, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
      } else if (resize.current) {
        const r = resize.current;
        onBounds(clamp({ ...boundsRef.current, w: r.ow + (e.clientX - r.sx), h: r.oh + (e.clientY - r.sy) }));
      }
    };
    const up = (): void => {
      // Aggancio ai bordi (P-68): il rilascio vicino a un bordo allinea la finestra; sgancio = trascinare via.
      if (drag.current) onBounds(snapBounds(boundsRef.current, window.innerWidth, window.innerHeight));
      drag.current = null;
      resize.current = null;
      delete document.documentElement.dataset.winDrag;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [onBounds]);

  const b = win.bounds;
  const snapped = b.x === 0 || b.y === 0 || Math.abs(b.x + b.w - window.innerWidth) <= 1;
  return (
    <section
      className={`jwin${focused ? ' focused' : ''}${win.shaded ? ' shaded' : ''}${snapped ? ' snapped' : ''}${maximized ? ' maximized' : ''}`}
      data-window={win.id}
      data-kind={win.kind}
      data-ref={win.ref ?? ''}
      style={{ left: b.x, top: b.y, width: b.w, height: win.shaded ? 'auto' : b.h, zIndex: 70 + win.z }}
      onPointerDown={onFocus}
    >
      {/* Cornici a parentesi anche sugli angoli non coperti dai pseudo-elementi condivisi. */}
      <span className="jwin-brk jwin-brk-tr" aria-hidden="true" />
      <span className="jwin-brk jwin-brk-bl" aria-hidden="true" />
      {/* G6: sweep una tantum all'apertura della finestra (`.p-wipe` del riferimento). */}
      <span className="p-wipe" aria-hidden="true" />
      <header className="jwin-head" onPointerDown={startDrag} onDoubleClick={onHeadDoubleClick} data-testid={`win-head-${win.id}`} title={t('windows.chrome.headTitle')}>
        <span className="jwin-grip" aria-hidden="true" />
        <span className={`jwin-spia tone-${status.tone}`} aria-hidden="true" />
        <div className="jwin-titles">
          <h3 className="type" title={win.title}>{win.title}</h3>
          {win.subtitle && <span className="muted small" title={win.subtitle}>{win.subtitle}</span>}
        </div>
        <span className="jwin-stato mono" title={status.title}>{status.text}</span>
        <div className="jwin-controls">
          <button type="button" onClick={onToggleShade} aria-label={t('windows.chrome.shadeAria', { title: win.title })} title={t('windows.chrome.shadeTitle')}>{win.shaded ? '▸' : '▾'}</button>
          <button type="button" onClick={onMinimize} aria-label={t('windows.chrome.minimizeAria', { title: win.title })} title={t('windows.chrome.minimizeTitle')}>—</button>
          <button type="button" aria-pressed={maximized} onClick={onMaximize} aria-label={t(maximized ? 'windows.chrome.restoreAria' : 'windows.chrome.maximizeAria', { title: win.title })} title={t(maximized ? 'windows.chrome.restoreTitle' : 'windows.chrome.maximizeTitle')}>{maximized ? '⤡' : '⤢'}</button>
          <button type="button" className="jwin-close" onClick={onClose} aria-label={t('windows.chrome.closeAria', { title: win.title })} title={t('windows.chrome.closeTitle')}>×</button>
        </div>
      </header>
      {!win.shaded && <div className="jwin-body">{children}</div>}
      {!win.shaded && <span className="jwin-scan" aria-hidden="true" />}
      {!win.shaded && <div className="jwin-resize" onPointerDown={startResize} aria-hidden="true" title={t('windows.chrome.resizeTitle')} />}
    </section>
  );
}
