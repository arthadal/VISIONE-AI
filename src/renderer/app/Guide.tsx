// Guida al primo avvio (11/10/2026): una tappa alla volta, l'elemento vero illuminato e una scheda con
// cosa è e come si usa. Frecce ←/→ e Invio per muoversi, Esc per chiudere. Logica in `guide-logic.ts`.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n/index.ts';
import { cardPosition, GUIDE_STEPS, type Rect } from './guide-logic.ts';

const PAD = 8;

function targetRect(selector: string | null): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector);
  // Non `offsetParent`: è null anche per gli elementi `position: fixed` (Start, linguette).
  if (!(el instanceof HTMLElement)) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

export function Guide({ onClose }: { onClose: (completed: boolean) => void }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: -9999, y: -9999 });
  const card = useRef<HTMLDivElement | null>(null);
  const step = GUIDE_STEPS[index]!;
  const last = index === GUIDE_STEPS.length - 1;

  const measure = useCallback((): void => {
    const r = targetRect(step.target);
    setRect(r);
    const c = card.current?.getBoundingClientRect();
    setPos(cardPosition(r ? { x: r.x - PAD, y: r.y - PAD, w: r.w + PAD * 2, h: r.h + PAD * 2 } : null, { w: window.innerWidth, h: window.innerHeight }, { w: c?.width ?? 380, h: c?.height ?? 220 }));
  }, [step.target]);

  useLayoutEffect(() => { measure(); }, [measure, index]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const next = useCallback((): void => { if (last) onClose(true); else setIndex((i) => i + 1); }, [last, onClose]);
  const back = useCallback((): void => setIndex((i) => Math.max(0, i - 1)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(false); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, back, onClose]);

  return (
    <div className={`guide${rect ? '' : ' guide-dim'}`} role="dialog" aria-modal="true" aria-label={t('guide.aria')} data-testid="guide" data-step={step.id}>
      {rect && <div className="guide-spot" style={{ left: rect.x - PAD, top: rect.y - PAD, width: rect.w + PAD * 2, height: rect.h + PAD * 2 }} />}
      <div className="guide-card" ref={card} style={{ left: pos.x, top: pos.y }}>
        <p className="guide-progress">{t('guide.progress', { n: index + 1, total: GUIDE_STEPS.length })}</p>
        <h2>{t(step.title)}</h2>
        <p className="guide-body">{t(step.body)}</p>
        <div className="guide-actions">
          {!last && <button type="button" className="guide-skip" onClick={() => onClose(false)} data-testid="guide-skip">{t('guide.skip')}</button>}
          <span className="guide-spacer" />
          {index > 0 && <button type="button" onClick={back} data-testid="guide-back">{t('guide.back')}</button>}
          <button type="button" className="setup-primary" onClick={next} data-testid="guide-next" autoFocus>{last ? t('guide.finish') : t('guide.next')}</button>
        </div>
      </div>
    </div>
  );
}
