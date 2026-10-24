// Allegati (12/10/2026, richiesta del proprietario): nei terminali e nelle chat degli agenti si
// aggiungono file, cartelle e screenshot — trascinandoli (da Windows o dall'Esplora di VISIONE), con
// il pulsante «+» o incollando con Ctrl+V. All'agente arriva il percorso (logica in `attach-logic.ts`).
import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent } from 'react';
import { useT } from '../lib/i18n/index.ts';
import { VISIONE_DRAG_TYPE, visioneDragPaths } from './attach-logic.ts';

/** Il trascinamento porta file (da Windows) o percorsi dell'Esplora di VISIONE? */
function carriesPaths(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = [...dt.types];
  return types.includes('Files') || types.includes(VISIONE_DRAG_TYPE);
}

function pathsOfTransfer(dt: DataTransfer): string[] {
  const internal = dt.getData(VISIONE_DRAG_TYPE);
  if (internal) return visioneDragPaths(internal);
  return [...dt.files].map((f) => window.visione.files.pathOf(f)).filter((p) => p.length > 0).slice(0, 50);
}

/** Trascinamento: gestori da mettere sul contenitore e lo stato «ci stai passando sopra». */
export function useAttachDrop(onPaths: (paths: string[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const onDragEnter = useCallback((e: DragEvent): void => {
    if (!enabled || !carriesPaths(e.dataTransfer)) return;
    depth.current += 1;
    setOver(true);
  }, [enabled]);
  const onDragOver = useCallback((e: DragEvent): void => {
    if (!enabled || !carriesPaths(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [enabled]);
  const onDragLeave = useCallback((): void => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }, []);
  const onDrop = useCallback((e: DragEvent): void => {
    depth.current = 0;
    setOver(false);
    if (!enabled || !carriesPaths(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = pathsOfTransfer(e.dataTransfer);
    if (paths.length > 0) onPaths(paths);
  }, [enabled, onPaths]);
  return { over, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

/**
 * Incolla: se negli appunti ci sono file (copiati in Esplora risorse) o un'immagine, si allegano i
 * percorsi; il testo normale resta un incolla normale. Restituisce true se l'ha gestito.
 */
export function attachFromPaste(data: DataTransfer | null, onPaths: (paths: string[]) => void): boolean {
  if (!data) return false;
  const types = [...data.types];
  const hasFiles = data.files.length > 0 || types.includes('Files');
  const hasImage = [...data.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!hasFiles && !hasImage) return false;
  const direct = [...data.files].map((f) => window.visione.files.pathOf(f)).filter((p) => p.length > 0);
  if (direct.length > 0) onPaths(direct);
  else void window.visione.files.fromClipboard().then((paths) => { if (paths.length > 0) onPaths(paths); });
  return true;
}

/** Gestore `onPaste` per i campi di testo: allega file e immagini, lascia passare il testo. */
export function pasteHandler(onPaths: (paths: string[]) => void) {
  return (e: ReactClipboardEvent): void => {
    if (attachFromPaste(e.clipboardData, onPaths)) e.preventDefault();
  };
}

/** Pulsante «+»: file, cartelle o l'immagine negli appunti. */
export function AttachButton({ onPaths, disabled = false, testId, filesOnly = false, label }: { onPaths: (paths: string[]) => void; disabled?: boolean; testId?: string; filesOnly?: boolean; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  useEffect(() => {
    if (!note) return;
    const h = setTimeout(() => setNote(null), 4_000);
    return () => clearTimeout(h);
  }, [note]);
  const pick = (kind: 'files' | 'folder'): void => {
    setOpen(false);
    void window.visione.files.pick(kind).then((paths) => { if (paths.length > 0) onPaths(paths); });
  };
  const clip = (): void => {
    setOpen(false);
    void window.visione.files.fromClipboard().then((paths) => {
      if (paths.length > 0) onPaths(paths);
      else setNote(t('windows.attach.noClipboard'));
    });
  };
  return (
    <span className="attach" ref={box}>
      <button type="button" className="attach-btn" disabled={disabled} onClick={() => setOpen((v) => !v)} title={t('windows.attach.title')} aria-haspopup="menu" aria-expanded={open} data-testid={testId}>
        {label ?? t('windows.attach.add')}
      </button>
      {open && (
        <span className="attach-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick('files')} data-testid={testId ? `${testId}-files` : undefined}>{t('windows.attach.files')}</button>
          {!filesOnly && <button type="button" role="menuitem" onClick={() => pick('folder')} data-testid={testId ? `${testId}-folder` : undefined}>{t('windows.attach.folder')}</button>}
          <button type="button" role="menuitem" onClick={clip} data-testid={testId ? `${testId}-clipboard` : undefined}>{t('windows.attach.clipboard')}</button>
        </span>
      )}
      {note && <span className="attach-note small muted">{note}</span>}
    </span>
  );
}
