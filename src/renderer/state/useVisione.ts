// Collega la proiezione a `window.visione`: sottoscrizioni (supervisore, stato del core, eventi),
// risincronizzazione quando il core torna pronto o quando manca un pezzo della sequenza, ping di
// verifica del collegamento. Nessun polling: tutto arriva per notifica.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { initialState, reduce, type ViewState } from './projection.ts';

export interface VisioneView {
  state: ViewState;
  ping(): void;
  refresh(): void;
}

export function useVisione(): VisioneView {
  const [state, dispatch] = useReducer(reduce, initialState);
  const lastSeq = useRef(0);
  lastSeq.current = state.lastSeq;

  const ping = useCallback(() => {
    const started = performance.now();
    void window.visione.system.ping('ui').then((res) => {
      const at = Date.now();
      if (res.ok) dispatch({ type: 'ping', at, rttMs: Math.round((performance.now() - started) * 10) / 10, result: res.data });
      else dispatch({ type: 'ping-failed', at, error: res.error });
    });
  }, []);

  const refresh = useCallback(() => {
    const after = lastSeq.current;
    void window.visione.events.list(after > 0 ? { afterSeq: after, limit: 500 } : { limit: 50 }).then((res) => {
      if (res.ok) dispatch({ type: 'page', events: res.data.events, lastSeq: res.data.lastSeq });
      else dispatch({ type: 'error', error: res.error });
    });
    void window.visione.system.status().then((res) => {
      if (res.ok) dispatch({ type: 'status', status: res.data });
    });
    void window.visione.state.get().then((res) => {
      if (res.ok) dispatch({ type: 'state', snapshot: res.data });
      else dispatch({ type: 'error', error: res.error });
    });
  }, []);

  useEffect(() => {
    const offSupervisor = window.visione.supervisor.subscribe((snapshot) => dispatch({ type: 'supervisor', snapshot }));
    const offEvents = window.visione.events.subscribe((event) => dispatch({ type: 'event', event }));
    const offState = window.visione.state.subscribe((snapshot) => dispatch({ type: 'state', snapshot }));
    void window.visione.supervisor.get().then((snapshot) => dispatch({ type: 'supervisor', snapshot }));
    return () => {
      offSupervisor();
      offEvents();
      offState();
    };
  }, []);

  const ready = state.supervisor?.state === 'ready';
  useEffect(() => {
    if (ready && state.needsResync) {
      refresh();
      ping();
    }
  }, [ready, state.needsResync, refresh, ping]);

  return { state, ping, refresh };
}
