// Layer degli effetti one-shot (fase G6, P-78): `Effects.tsx` del JARVIS del proprietario (MIT © 2026
// Aditya Dewaskar), portato in React puro + CSS. Gli effetti sono «punteggiatura», non stato: il nodo
// esiste solo mentre l'animazione suona — montarlo per sempre lascerebbe un layer a tutto schermo per
// mezzo secondo di grafica. `at` è nella chiave, così lo stesso effetto due volte di fila riparte.
//
// Gli inneschi arrivano SOLO da eventi reali (`./effects.ts`): task, agenti, processi, voce, sistema.
// Con `reducedMotion` attivo (toggle dell'app o preferenza di sistema) non si monta nulla: la promessa
// «il moto ridotto è rispettato» vale anche per questi effetti, non solo per la media query CSS.
import { useEffect, useRef, useState } from 'react';
import type { VisioneEvent } from '../../shared/contracts/index.ts';
import { EFFECT_MS, EFFECT_TTL_MS, eventsAfter, isFresh, latestEffect, type UiEffect } from './effects.ts';

export function Effects({ events, startedAt, reducedMotion }: {
  events: readonly VisioneEvent[];
  /** Avvio del core corrente: gli eventi della storia (journal) non generano effetti. */
  startedAt: number | null;
  reducedMotion: boolean;
}) {
  const [live, setLive] = useState<UiEffect | null>(null);
  const lastId = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Nuovi eventi reali → al più un effetto per volta; l'ultimo evento della raffica vince.
  useEffect(() => {
    const tail = events.at(-1)?.id ?? null;
    if (lastId.current === null) {
      // Prima fotografia della finestra eventi (storia inclusa): si registra e basta.
      lastId.current = tail;
      return;
    }
    const fresh = eventsAfter(events, lastId.current).filter((e) => isFresh(e, startedAt));
    lastId.current = tail ?? lastId.current;
    if (fresh.length === 0) return;
    const next = latestEffect(fresh);
    if (next !== null) setLive(next);
  }, [events, startedAt]);

  // Smontaggio automatico a fine animazione (nessun timer periodico, nessun effetto residuo).
  useEffect(() => {
    if (live === null) return;
    const done = setTimeout(() => setLive((cur) => (cur === live ? null : cur)), EFFECT_TTL_MS[live.kind]);
    return () => clearTimeout(done);
  }, [live]);

  // `shake` fa tremare il frame (come il riferimento sul `.hud`): la classe vive sul contenitore
  // `.app` solo per la durata dell'effetto, anche se il componente viene smontato prima.
  useEffect(() => {
    if (live === null || live.kind !== 'shake' || reducedMotion) return;
    const app = rootRef.current?.closest('.app');
    if (!app) return;
    app.classList.add('fx-shaking');
    const done = setTimeout(() => app.classList.remove('fx-shaking'), EFFECT_MS.shake);
    return () => {
      clearTimeout(done);
      app.classList.remove('fx-shaking');
    };
  }, [live, reducedMotion]);

  // Motore ridotto: niente effetti in volo (copre anche il toggle mentre un effetto sta suonando).
  useEffect(() => {
    if (reducedMotion) setLive(null);
  }, [reducedMotion]);

  if (live === null || reducedMotion) return null;
  return (
    <div className="fx" ref={rootRef} data-testid="fx" data-fx={live.kind} data-cause={live.cause} aria-hidden="true">
      <div key={`${live.kind}-${live.at}`} className={`fx-play fx-${live.kind}`}>
        {live.kind === 'glitch' && (<><i className="fx-slice" /><i className="fx-slice" /><i className="fx-slice" /></>)}
        {live.kind === 'pulse' && (<><i className="fx-wave" /><i className="fx-wave" /></>)}
        {live.kind === 'scan' && <i className="fx-band" />}
        {live.kind === 'flash' && <i className="fx-bar" />}
      </div>
    </div>
  );
}
