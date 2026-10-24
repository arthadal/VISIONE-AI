// Dock dei pannelli (P-96): rende le colonne dei pannelli gestibili come finestre — × che chiude,
// tendina, trascinamento (anche tra le colonne) e ingrandimento a tutto schermo.
// P-98: trascinando un pannello lo si può posare OVUNQUE nella finestra (posizione assoluta,
// persistita) e riportarlo al dock con doppio click sulla testata o «Reimposta layout»; rilasciarlo
// sopra una colonna lo riordina come P-96. Il trascinamento è a puntatore (listener su `window`,
// come il Window Manager): funziona anche con gli eventi sintetici dei test. Tutto ciò che decide lo
// stato vive in `panels.ts` (puro).
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import {
  clampFloat, clearFloat, dropBefore, floatingOf, floatingSizeOf, isCollapsed, movePanel, panelTitle, resizeRect, setFloat, setSize,
  toggleCollapsed, visibleIds, PANELS,
  type DockState, type FloatPos, type PanelColumn, type PanelId, type ResizeHandle
} from './panels.ts';

/**
 * Tendina del dock per i pannelli che hanno una testata propria (`HudPanel`): quando il pannello è
 * dentro un `DockItem` la verità è UNA — quella del dock; la tendina interna del componente (e la
 * chiave storica `visione.hud.ridotti`) non deve nascondere il corpo per conto suo.
 */
export const DockCollapsedContext = createContext<boolean | null>(null);

/** Zona di presa: tutta la parte superiore del pannello (px dalla cima), non un solo punto (P-97). */
const ZONA_PRESA_PX = 42;
/** Spostamento minimo (px) perché il gesto conti come trascinamento e non come click. */
const SOGLIA_TRASCINAMENTO_PX = 3;
/** Larghezza di riferimento di un pannello libero (px): la stessa del CSS `.dock-float`. */
const FLOAT_WIDTH_REF = 300;
/** Margine di caduta sopra una colonna (px): dentro questo bordo il rilascio ri-ancora il pannello. */
const DROP_PAD_PX = 18;

export function useDockCollapsed(): boolean | null {
  return useContext(DockCollapsedContext);
}

/** Controlli della testata: maniglia di trascinamento, tendina, tutto schermo, chiudi. */
export function DockControls({ id, collapsed, onToggle, onMaximize, onClose }: {
  id: PanelId; collapsed: boolean;
  onToggle: () => void; onMaximize: () => void; onClose: () => void;
}) {
  const t = useT();
  const title = panelTitle(id, useLanguage());
  return (
    <span className="dock-controls">
      <span className="dock-grip" aria-hidden="true" title={t('shell.dock.grip')}>⠿</span>
      <button
        type="button" className="dk-btn" data-testid={`panel-collapse-${id}`}
        aria-label={collapsed ? t('shell.dock.expand', { title }) : t('shell.dock.collapse', { title })} aria-pressed={collapsed}
        title={collapsed ? t('shell.dock.expandTitle') : t('shell.dock.collapseTitle')}
        onClick={onToggle}
      >{collapsed ? '+' : '−'}</button>
      <button
        type="button" className="dk-btn" data-testid={`panel-max-${id}`}
        aria-label={t('shell.dock.maxAria', { title })} title={t('shell.dock.maxTitle')}
        onClick={onMaximize}
      >⛶</button>
      <button
        type="button" className="dk-btn dock-close" data-testid={`panel-close-${id}`}
        aria-label={t('shell.dock.closeAria', { title })} title={t('shell.dock.closeTitle')}
        onClick={onClose}
      >×</button>
    </span>
  );
}

/** Maniglie di ridimensionamento (P-99): un bordo o un angolo per volta, solo sui pannelli liberi. */
const RESIZE_HANDLES: readonly ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function DockItem({ id, collapsed, dragging, anchor, floating, style, onPointerDown, onDoubleClick, onToggleCollapse, onMaximize, onClose, onResizeStart, children }: {
  id: PanelId; collapsed: boolean; dragging: boolean; anchor: boolean; floating?: boolean;
  style?: CSSProperties;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onToggleCollapse: () => void; onMaximize: () => void; onClose: () => void;
  onResizeStart?: (handle: ResizeHandle) => (e: React.PointerEvent) => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div
      className={`dock-item${collapsed ? ' dock-collapsed' : ''}${dragging ? ' dock-dragging' : ''}${anchor ? ' dock-anchor' : ''}${floating ? ' dock-float' : ''}`}
      data-panel={id}
      data-panel-collapsed={collapsed ? 'true' : 'false'}
      data-panel-float={floating ? 'true' : 'false'}
      style={style}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title={floating ? t('shell.dock.floatTitle') : undefined}
    >
      <DockControls id={id} collapsed={collapsed} onToggle={onToggleCollapse} onMaximize={onMaximize} onClose={onClose} />
      {floating && onResizeStart && RESIZE_HANDLES.map((h) => (
        <span
          key={h}
          className={`dock-resize r-${h}`}
          data-resize-handle={h}
          {...(h === 'se' ? { 'data-testid': `panel-resize-${id}` } : {})}
          aria-hidden="true"
          onPointerDown={onResizeStart(h)}
        />
      ))}
      <DockCollapsedContext.Provider value={collapsed}>{children}</DockCollapsedContext.Provider>
    </div>
  );
}

export interface DockBoardProps {
  dock: DockState;
  onChange: (next: DockState) => void;
  /** Rende il pannello con i suoi dati reali (usato sia nel dock sia a tutto schermo). */
  renderPanel: (id: PanelId) => ReactNode;
  onMaximize: (id: PanelId) => void;
  /** Pannello mostrato a tutto schermo: la sua copia nel dock non si duplica. */
  suppressed?: PanelId | null;
}

/**
 * Le due colonne del dock. P-98: un pannello trascinato segue il puntatore e, se rilasciato fuori
 * dalle colonne, resta in posizione libera (assoluta); sopra una colonna torna nel dock riordinato.
 */
export function DockBoard({ dock, onChange, renderPanel, onMaximize, suppressed = null }: DockBoardProps) {
  const t = useT();
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [dragPos, setDragPos] = useState<FloatPos | null>(null);
  const [resizing, setResizing] = useState<PanelId | null>(null);
  const [liveRect, setLiveRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [zMap, setZMap] = useState<Partial<Record<PanelId, number>>>({});
  const dragId = useRef<PanelId | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragRect = useRef<{ width: number; height: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragPosRef = useRef<FloatPos | null>(null);
  const dragMoved = useRef(false);
  /** P-99: ridimensionamento dal bordo/angolo — rettangolo iniziale e ultimo valido. */
  const resizeRef = useRef<{ id: PanelId; handle: ResizeHandle; start: { x: number; y: number; w: number; h: number }; px: number; py: number } | null>(null);
  const liveRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Il click che segue il rilascio di un trascinamento non deve agire (P-97). */
  const clickDaIgnorare = useRef(false);
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  /** Quota z dei pannelli liberi: l'ultimo toccato sta davanti (le sovrapposizioni sono ammesse). */
  const zRef = useRef(320);

  const raise = (id: PanelId): void => {
    const z = ++zRef.current;
    setZMap((m) => (m[id] === z ? m : { ...m, [id]: z }));
  };

  /** Colonna sotto il puntatore (con piccolo margine), o `null` se si è altrove. */
  const columnAt = (x: number, y: number): PanelColumn | null => {
    for (const [name, sel] of [['left', '.col-left'], ['right', '.col-right']] as Array<[PanelColumn, string]>) {
      const el = document.querySelector(sel);
      if (el === null) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left - DROP_PAD_PX && x <= r.right + DROP_PAD_PX && y >= r.top - DROP_PAD_PX && y <= r.bottom + DROP_PAD_PX) return name;
    }
    return null;
  };

  /** Posizione di rilascio dentro una colonna: la prima metà verticale superata. */
  const dropBeforeFor = (id: PanelId, column: PanelColumn, y: number): PanelId | null => {
    const root = column === 'left' ? '.col-left' : '.col-right';
    const rects: Array<{ id: PanelId; mid: number }> = [];
    for (const el of document.querySelectorAll<HTMLElement>(`${root} [data-panel]`)) {
      const pid = el.dataset.panel as PanelId | undefined;
      if (pid === undefined || pid === id) continue;
      const r = el.getBoundingClientRect();
      rects.push({ id: pid, mid: r.top + r.height / 2 });
    }
    return dropBefore(rects, y);
  };

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const id = dragId.current;
      if (id === null) return;
      const start = dragStart.current;
      if (start !== null && !dragMoved.current && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > SOGLIA_TRASCINAMENTO_PX) {
        dragMoved.current = true;
      }
      if (!dragMoved.current) return;
      const rect = dragRect.current;
      const pos = clampFloat(
        { x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y },
        rect?.width ?? FLOAT_WIDTH_REF, rect?.height ?? 240, window.innerWidth, window.innerHeight
      );
      dragPosRef.current = pos;
      setDragPos(pos);
    };
    const reset = (): void => {
      dragId.current = null;
      dragStart.current = null;
      dragRect.current = null;
      dragPosRef.current = null;
      dragMoved.current = false;
      setDragging(null);
      setDragPos(null);
    };
    const up = (e: PointerEvent): void => {
      const id = dragId.current;
      const moved = dragMoved.current;
      const pos = dragPosRef.current;
      reset();
      if (id === null || !moved) return;
      // P-97: il rilascio di un trascinamento NON è un click — l'handler globale che piega le
      // schede (`.card h2`) non deve scattare dopo lo spostamento. La bandierina vale per il click
      // generato da QUESTO rilascio: un nuovo `pointerdown` (interazione vera) la azzera.
      clickDaIgnorare.current = true;
      const column = columnAt(e.clientX, e.clientY);
      if (column !== null) {
        // Rilascio sopra il dock: torna in colonna, riordinato come P-96.
        changeRef.current(clearFloat(movePanel(dockRef.current, id, column, dropBeforeFor(id, column, e.clientY)), id));
      } else if (pos !== null) {
        // Rilascio libero: il pannello resta dove è stato posato (posizione persistita).
        changeRef.current(setFloat(dockRef.current, id, pos));
      }
    };
    const cancel = (): void => {
      reset();
    };
    const inghiotti = (ev: MouseEvent): void => {
      if (!clickDaIgnorare.current) return;
      clickDaIgnorare.current = false;
      ev.stopPropagation();
      ev.preventDefault();
    };
    const nuovaPressione = (): void => {
      clickDaIgnorare.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('click', inghiotti, true);
    window.addEventListener('pointerdown', nuovaPressione, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('click', inghiotti, true);
      window.removeEventListener('pointerdown', nuovaPressione, true);
    };
  }, []);

  // P-99: ridimensionamento dal bordo/angolo di un pannello libero. Stesso metodo del drag
  // (listener su `window`, funziona anche con eventi sintetici): il rettangolo segue il puntatore,
  // ai minimi si ferma, e al rilascio dimensioni e (per i lati ovest/nord) posizione si persistono.
  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const r = resizeRef.current;
      if (r === null) return;
      const rect = resizeRect(r.start, r.handle, e.clientX - r.px, e.clientY - r.py, window.innerWidth, window.innerHeight);
      liveRectRef.current = rect;
      setLiveRect(rect);
    };
    const up = (): void => {
      const r = resizeRef.current;
      const rect = liveRectRef.current;
      resizeRef.current = null;
      liveRectRef.current = null;
      setResizing(null);
      setLiveRect(null);
      if (r === null || rect === null) return;
      let next = setSize(dockRef.current, r.id, { w: rect.w, h: rect.h });
      const pos = floatingOf(next, r.id);
      if (pos === null || pos.x !== rect.x || pos.y !== rect.y) next = setFloat(next, r.id, { x: rect.x, y: rect.y });
      changeRef.current(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  const startDrag = (id: PanelId) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest('button, input, select, textarea, a, .dock-resize') !== null) return;
    // P-97: si aggancia da TUTTA la parte superiore del pannello (non da un unico punto):
    // la zona è geometrica (i primi pixel del pannello) e copre sia `.hp-head` dei pannelli HUD
    // sia l'`h2` delle schede, compreso lo spazio attorno.
    const host = e.currentTarget as HTMLElement;
    const rect = host.getBoundingClientRect();
    const inTestata = e.clientY - rect.top <= ZONA_PRESA_PX;
    if (!inTestata && el.closest('.hp-head, h2, .dock-grip') === null) return;
    // Niente `preventDefault` sul pointerdown: sopprimerebbe il click compatibile del browser e la
    // piega della scheda dall'handler globale non scatterebbe più (P-97). La selezione del testo è
    // già impedita da `user-select: none` (CSS); il click dopo un trascinamento è assorbito a parte.
    raise(id);
    dragId.current = id;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragRect.current = { width: rect.width, height: rect.height };
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragMoved.current = false;
    dragPosRef.current = null;
    setDragging(id);
    setDragPos(null);
  };

  /** Doppio click sulla testata: un pannello libero torna al dock (posizione libera dimenticata). */
  const redockOnDouble = (id: PanelId) => (e: React.MouseEvent): void => {
    const el = e.target as HTMLElement;
    if (el.closest('button, input, select, textarea, a') !== null) return;
    if (floatingOf(dockRef.current, id) === null) return;
    changeRef.current(clearFloat(dockRef.current, id));
  };

  /** P-99: presa di un bordo/angolo. Il `pointerdown` non arriva al drag della testata (stopPropagation). */
  const startResize = (id: PanelId) => (handle: ResizeHandle) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const host = (e.currentTarget as HTMLElement).closest('.dock-item') as HTMLElement | null;
    const rect = host?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    raise(id);
    const start = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    resizeRef.current = { id, handle, start, px: e.clientX, py: e.clientY };
    liveRectRef.current = start;
    setResizing(id);
    setLiveRect(start);
  };

  const itemProps = (id: PanelId) => ({
    collapsed: isCollapsed(dock, id),
    dragging: dragging === id,
    onPointerDown: startDrag(id),
    onDoubleClick: redockOnDouble(id),
    onToggleCollapse: () => onChange(toggleCollapsed(dock, id)),
    onMaximize: () => onMaximize(id),
    onClose: () => onChange({ ...dock, hidden: dock.hidden.includes(id) ? dock.hidden : [...dock.hidden, id] })
  });

  const column = (c: PanelColumn): ReactNode => (
    <>
      {visibleIds(dock, c).filter((id) => id !== suppressed && floatingOf(dock, id) === null).map((id, i) => (
        <DockItem key={id} id={id} anchor={i === 1} {...itemProps(id)}
          style={dragging === id && dragPos !== null ? { position: 'fixed', left: dragPos.x, top: dragPos.y, width: dragRect.current?.width ?? FLOAT_WIDTH_REF, zIndex: 400 } : undefined}
        >
          {renderPanel(id)}
        </DockItem>
      ))}
    </>
  );

  // Pannelli liberi (P-98): fuori dalle colonne, posizione assoluta, sopra il contenuto; le
  // sovrapposizioni sono ammesse e l'ultimo toccato sale davanti. P-99: si ridimensionano dai bordi.
  const floats = PANELS.map((p) => p.id).filter((id) => id !== suppressed && floatingOf(dock, id) !== null && !dock.hidden.includes(id));

  return (
    <>
      <aside className="col-left" aria-label={t('shell.dock.leftAria')}>{column('left')}</aside>
      <aside className="col-right" aria-label={t('shell.dock.rightAria')}>{column('right')}</aside>
      {floats.map((id) => {
        const saved = floatingOf(dock, id) as FloatPos;
        const size = floatingSizeOf(dock, id);
        const pos = clampFloat(saved, size?.w ?? FLOAT_WIDTH_REF, size?.h ?? 240, window.innerWidth, window.innerHeight);
        const active = dragging === id && dragPos !== null;
        const resizingThis = resizing === id && liveRect !== null;
        const style: CSSProperties = resizingThis
          ? { left: liveRect.x, top: liveRect.y, width: liveRect.w, height: liveRect.h, zIndex: 401 }
          : active
            ? { left: dragPos.x, top: dragPos.y, zIndex: 400 }
            : { left: pos.x, top: pos.y, zIndex: zMap[id] ?? 320, ...(size ? { width: size.w, height: size.h } : {}) };
        return (
          <DockItem key={id} id={id} floating anchor={false} {...itemProps(id)} style={style} onResizeStart={startResize(id)}>
            {renderPanel(id)}
          </DockItem>
        );
      })}
    </>
  );
}

/** Pannello a tutto schermo dentro VISIONE (nessuna finestra nativa): stesso contenuto, stessi dati. */
export function PanelMax({ id, onRestore, children }: { id: PanelId; onRestore: () => void; children: ReactNode }) {
  const t = useT();
  const title = panelTitle(id, useLanguage());
  return (
    <div className="panel-max" role="dialog" aria-modal="true" aria-label={t('shell.dock.fullAria', { title })} data-testid="panel-max">
      <header className="panel-max-head">
        <span className="hp-title">{title}</span>
        <span className="muted small mono">{t('shell.dock.fullHint')}</span>
        <span className="spacer" />
        <button type="button" className="cmd-tasto" data-testid="panel-max-restore" onClick={onRestore} title={t('shell.dock.restoreTitle')}>{t('shell.dock.restore')}</button>
        <button type="button" className="jwin-close" data-testid="panel-max-close" aria-label={t('shell.dock.fullCloseAria', { title })} onClick={onRestore}>×</button>
      </header>
      {/* A tutto schermo il pannello è ESPANSO per davvero: la tendina del dock non lo nasconde. */}
      <div className="panel-max-body" data-testid={`panel-max-body-${id}`}>
        <DockCollapsedContext.Provider value={false}>{children}</DockCollapsedContext.Provider>
      </div>
    </div>
  );
}
