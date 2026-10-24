// Vista Terminal (VISIONE_ARCHITECTURE §18, DECISIONI P-45; P-94): un xterm per la sessione scelta, per
// tutta la vita della vista. All'apertura lo scrollback del core, poi i blocchi `process.stdout` (flusso
// `pty`) con `seq` successivo. Input e ridimensionamento solo per le sessioni interattive (shell del
// proprietario, agenti `pty-generic`); le sessioni degli altri agenti sono in sola lettura.
// P-94: comportamento da terminale normale — il selettore apre il terminale di QUALSIASI agente (PTY
// reale per i motori interattivi via `agents.start`; flusso reale del turno per i motori headless), il ×
// chiude ogni scheda e termina la sessione (per gli agenti passa dall'Agent Manager), e la scheda di una
// sessione terminata sparisce da sola dopo un breve stato «terminato»: niente schede morte con
// `operation_failed: sessione terminata`.
// Fase G5 (P-77): il tema xterm a 16 colori e le schede-sessione adottano il vocabolario del JARVIS
// del proprietario (MIT © 2026 Aditya Dewaskar, `src/ui/Terminali.tsx` e `src/ui/terminali.css`):
// fondo trasparente (il vetro della finestra resta visibile), ciano per cursore/selezione, schede con
// spia di stato e bordo inferiore attivo.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentView, CommandError, VisioneEvent, TerminalSession } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { clockText } from '../windows/locale.ts';
import { agentStream, mergeStreamEvents } from '../windows/panes/agentStream.ts';
import { AttachButton, attachFromPaste, pasteHandler, useAttachDrop } from './Attach.tsx';
import { appendPaths, quotePaths } from './attach-logic.ts';
import { EMPTY_TABS, hideTerminalTab, unhideTerminalTab, updateTerminalTabs, type TerminalTabMemory } from './terminalTabs.ts';

const INPUT_FLUSH_MS = 16;
/** Tetto del buffer in attesa dello snapshot (P-74): una sessione che parla a raffica non lo fa crescere. */
const MAX_EARLY_CHUNKS = 2_000;
/** Eventi vivi tenuti dal flusso di un agente headless (lo storico arriva dal journal all'apertura). */
const MAX_LIVE_EVENTS = 800;

/** Tema xterm del riferimento JARVIS (16 colori) adattato al ciano `#00e5ff` e al nero `#01060c`. */
const TEMA = {
  background: 'rgba(2, 8, 14, 0)',
  foreground: '#cdefff',
  cursor: '#00e5ff',
  cursorAccent: '#02080e',
  selectionBackground: 'rgba(0, 229, 255, 0.28)',
  black: '#0b1620',
  red: '#ff6b6b',
  green: '#7dffb2',
  yellow: '#ffd479',
  blue: '#3f9fe0',
  magenta: '#a78bfa',
  cyan: '#00e5ff',
  white: '#cdefff',
  brightBlack: '#4a6378',
  brightRed: '#ff8f8f',
  brightGreen: '#a6ffcb',
  brightYellow: '#ffe3a3',
  brightBlue: '#7fd4ff',
  brightMagenta: '#c4b1ff',
  brightCyan: '#9ff4ff',
  brightWhite: '#ffffff'
} as const;

/** Spia di stato della scheda-sessione dal lessico `.term-spia` (solo stati reali del processo). */
function processTone(status: string, ended: boolean): 'on' | 'idle' | 'warn' | 'error' | 'off' {
  if (ended) return 'off';
  if (status === 'running' || status === 'idle') return 'on';
  if (status === 'failed' || status === 'crashed' || status === 'error' || status === 'timed_out') return 'error';
  if (status === 'stopped' || status === 'succeeded' || status === 'cancelled') return 'off';
  return 'warn';
}

export function TerminalPane({ session }: { session: TerminalSession }) {
  const t = useT();
  // L'effetto sotto vive quanto la sessione: il testo si legge dal riferimento, non dalla chiusura.
  const tRef = useRef(t);
  tRef.current = t;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const ended = session.endedAt !== null;
  // Allegati (12/10/2026): nella shell interattiva si scrivono i percorsi, come trascinando in Windows Terminal.
  const canType = session.interactive && !ended;
  const typePaths = useCallback((paths: string[]): void => {
    if (!session.interactive || session.endedAt !== null) return;
    void window.visione.terminal.input(session.processId, `${quotePaths(paths)} `).then((res) => setError(res.ok ? null : res.error));
  }, [session.processId, session.interactive, session.endedAt]);
  const typePathsRef = useRef(typePaths);
  typePathsRef.current = typePaths;
  const drop = useAttachDrop(typePaths, canType);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Ctrl+V con file o screenshot negli appunti: prima di xterm, che incollerebbe solo testo.
    const onPaste = (e: ClipboardEvent): void => {
      if (!session.interactive || session.endedAt !== null) return;
      if (attachFromPaste(e.clipboardData, (p) => typePathsRef.current(p))) { e.preventDefault(); e.stopPropagation(); }
    };
    host.addEventListener('paste', onPaste, true);
    const term = new Terminal({
      convertEol: false,
      scrollback: 5_000,
      // A sessione terminata il terminale è in sola lettura: niente input che il core rifiuterebbe.
      disableStdin: !session.interactive || session.endedAt !== null,
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.12,
      cursorBlink: true,
      allowTransparency: true,
      theme: TEMA
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    let lastSeq = 0;
    let ready = false;
    const early: Array<{ seq: number; text: string }> = [];
    const write = (seq: number, text: string): void => {
      if (seq <= lastSeq) return;
      lastSeq = seq;
      term.write(text);
    };
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      const p = e.payload as { processId?: string; seq?: number; text?: string; stream?: string };
      if (e.type !== 'process.stdout' || p.processId !== session.processId || p.stream !== 'pty') return;
      if (ready) write(p.seq ?? 0, p.text ?? '');
      else {
        early.push({ seq: p.seq ?? 0, text: p.text ?? '' });
        if (early.length > MAX_EARLY_CHUNKS) early.splice(0, early.length - MAX_EARLY_CHUNKS);
      }
    });
    void window.visione.terminal.snapshot(session.processId).then((res) => {
      if (res.ok) {
        if (res.data.truncated) term.write(`\x1b[2m${tRef.current('windows.term.scrollbackTruncated')}\x1b[0m\r\n`);
        term.write(res.data.text);
        lastSeq = res.data.seq;
      } else {
        setError(res.error);
      }
      ready = true;
      for (const c of early.splice(0)) write(c.seq, c.text);
    });
    // Input a lotti (un comando ogni 16 ms al più), solo se la sessione lo consente ed è viva.
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dataSub = term.onData((d) => {
      if (!session.interactive || session.endedAt !== null) return;
      buffer += d;
      timer ??= setTimeout(() => {
        timer = null;
        const data = buffer;
        buffer = '';
        void window.visione.terminal.input(session.processId, data).then((res) => setError(res.ok ? null : res.error));
      }, INPUT_FLUSH_MS);
    });
    const resize = (): void => {
      try {
        fit.fit();
      } catch {
        return;
      }
      // Anche in sola lettura: il programma deve disegnare per la larghezza vera della finestra (17/10/2026).
      if (!session.endedAt) void window.visione.terminal.resize(session.processId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(host);
    resize();
    return () => {
      host.removeEventListener('paste', onPaste, true);
      off();
      dataSub.dispose();
      if (timer) clearTimeout(timer);
      ro.disconnect();
      term.dispose();
    };
  }, [session.processId, session.interactive, session.endedAt]);
  return (
    <div className={`terminal-pane${drop.over ? ' attach-over' : ''}`} {...drop.handlers}>
      {canType && <div className="terminal-tools"><AttachButton onPaths={typePaths} testId="terminal-attach" /></div>}
      <div className="terminal-host" ref={hostRef} data-testid="terminal-host" data-process={session.processId} />
      {drop.over && <div className="attach-drop small">{t('windows.attach.drop')}</div>}
      {ended && <p className="muted small" data-testid="terminal-ended-note">{t('windows.term.ended', { status: session.status })}</p>}
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </div>
  );
}

/**
 * Terminale di un agente con motore headless (P-93): nessuna sessione PTY esiste, quindi qui si mostra
 * il flusso REALE del turno (eventi del bridge, ANSI rimosso) con lo storico dal journal all'apertura.
 * Nessuna riga inventata, nessun prompt finto. In fondo si scrive all'agente (P-105, richiesta del
 * proprietario): il testo parte come messaggio vero (`agents.tell`) e la risposta arriva nel flusso;
 * le righe scritte qui restano visibili, segnate come «tu».
 */
function AgentStreamPane({ agentId, view }: { agentId: string; view: AgentView | null }) {
  const t = useT();
  const lang = useLanguage();
  const [history, setHistory] = useState<VisioneEvent[]>([]);
  const [live, setLive] = useState<VisioneEvent[]>([]);
  useEffect(() => {
    let alive = true;
    setHistory([]);
    setLive([]);
    void window.visione.events.list({ limit: 500 }).then((res) => {
      if (alive && res.ok) setHistory(res.data.events);
    });
    const off = window.visione.events.subscribe((e) => {
      setLive((prev) => (prev.length >= MAX_LIVE_EVENTS ? [...prev.slice(-(MAX_LIVE_EVENTS - 1)), e] : [...prev, e]));
    });
    return () => {
      alive = false;
      off();
    };
  }, [agentId]);
  const [sent, setSent] = useState<Array<{ id: string; at: number; text: string }>>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => setSent([]), [agentId]);
  const addPaths = useCallback((paths: string[]): void => setDraft((d) => appendPaths(d, paths)), []);
  const streamDrop = useAttachDrop(addPaths, !sending);
  const lines = useMemo(() => {
    const stream = agentStream(mergeStreamEvents(history, live), agentId, lang);
    if (sent.length === 0) return stream;
    return [...stream, ...sent.map((m) => ({ id: m.id, at: m.at, kind: 'tu', text: t('windows.term.youLine', { text: m.text }) }))].sort((a, b) => a.at - b.at);
  }, [history, live, agentId, sent, lang, t]);
  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    const res = await window.visione.agents.tell({ agentId, text });
    setSending(false);
    if (!res.ok) return setSendError(res.error.message || res.error.code);
    setSent((prev) => [...prev, { id: `tu-${res.data.taskId}`, at: Date.now(), text }]);
    setDraft('');
  };
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className="terminal-stream" data-testid={`terminal-stream-${agentId}`}>
      <p className="muted small mono">
        {t('windows.stream.headless', { model: view?.definition.engine.model ?? t('windows.stream.defaultModel') })}
      </p>
      <div className="terminal-stream-feed" ref={feedRef} data-testid={`terminal-stream-feed-${agentId}`}>
        {lines.length === 0 ? (
          <p className="muted small">{t('windows.term.streamEmpty')}</p>
        ) : lines.map((l) => (
          <div key={l.id} className={`stream-line k-${l.kind}`}>
            <span className="mono small at">{clockText(l.at, lang)}</span>
            <span className="type small">{l.text}</span>
          </div>
        ))}
      </div>
      <form className={`terminal-stream-input${streamDrop.over ? ' attach-over' : ''}`} onSubmit={(e) => { e.preventDefault(); void send(); }} data-testid={`terminal-stream-input-${agentId}`} {...streamDrop.handlers}>
        <span className="mono small">{view?.definition.name ?? agentId} ›</span>
        <AttachButton onPaths={addPaths} disabled={sending} testId={`stream-attach-${agentId}`} />
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onPaste={pasteHandler(addPaths)} placeholder={t('windows.term.streamPlaceholder', { name: view?.definition.name ?? agentId })} maxLength={20_000} disabled={sending} aria-label={t('windows.term.streamAria', { name: view?.definition.name ?? agentId })} />
        <button type="submit" disabled={sending || !draft.trim()}>{sending ? t('windows.term.sending') : t('windows.common.send')}</button>
      </form>
      {sendError && <p className="error small">{sendError}</p>}
    </div>
  );
}

export function TerminalView({ ready, visible, focusAgent }: { ready: boolean; visible: boolean; focusAgent?: string | null }) {
  const t = useT();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [tabs, setTabs] = useState<TerminalSession[]>([]);
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [streamAgent, setStreamAgent] = useState<string | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const tabsRef = useRef<TerminalTabMemory>(EMPTY_TABS);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  const focusedRef = useRef<string | null>(null);

  const loadAgents = (): void => {
    void window.visione.agents.list(false).then((res) => {
      if (res.ok) setAgents(res.data.agents);
    });
  };

  // Ricarica sugli eventi di ciclo di vita (nessun polling): sessioni PTY e stato degli agenti.
  reloadRef.current = (): void => {
    void window.visione.terminal.list().then((res) => {
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const now = Date.now();
      const upd = updateTerminalTabs(tabsRef.current, res.data.sessions, now);
      tabsRef.current = upd.memory;
      setSessions(res.data.sessions);
      setTabs(upd.visible);
      setEnding(new Set(upd.ending.map((s) => s.processId)));
      // Una sessione avviata dal selettore viene selezionata appena compare.
      if (pendingRef.current !== null) {
        const started = res.data.sessions.find((s) => s.owner.agentId === pendingRef.current && s.endedAt === null);
        if (started) {
          pendingRef.current = null;
          setStreamAgent(null);
          setSelected(started.processId);
        }
      }
      setSelected((prev) => {
        // Si auto-seleziona solo per sostituire una scheda sparita; all'apertura si sceglie da sé.
        if (prev === null) return null;
        if (upd.visible.some((s) => s.processId === prev)) return prev;
        return upd.visible.find((s) => s.endedAt === null)?.processId ?? null;
      });
      if (graceTimer.current) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
      // La scheda «terminato» sparisce da sola alla scadenza della grazia.
      if (upd.nextDeadline !== null) {
        graceTimer.current = setTimeout(() => {
          graceTimer.current = null;
          reloadRef.current();
        }, Math.max(50, upd.nextDeadline - now + 60));
      }
    });
  };

  useEffect(() => {
    if (!ready) return;
    reloadRef.current();
    loadAgents();
    let sessionsTimer: ReturnType<typeof setTimeout> | null = null;
    let agentsTimer: ReturnType<typeof setTimeout> | null = null;
    const off = window.visione.events.subscribe((e) => {
      if (/^(process\.(created|started|exited|failed|crashed|stopped|timeout|cancelled)|terminal\.session\.)/.test(e.type)) {
        sessionsTimer ??= setTimeout(() => {
          sessionsTimer = null;
          reloadRef.current();
        }, 100);
      }
      if (/^agent\.(status\.changed|instance\.created|definition\.)/.test(e.type)) {
        agentsTimer ??= setTimeout(() => {
          agentsTimer = null;
          loadAgents();
        }, 150);
      }
    });
    return () => {
      off();
      if (sessionsTimer) clearTimeout(sessionsTimer);
      if (agentsTimer) clearTimeout(agentsTimer);
      if (graceTimer.current) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
    };
  }, [ready]);

  const open = (): void => {
    void window.visione.terminal.open(100, 30).then((res) => {
      if (res.ok) {
        setStreamAgent(null);
        setSelected(res.data.session.processId);
        reloadRef.current();
      }
      setError(res.ok ? null : res.error);
    });
  };

  /**
   * Apre il terminale di un agente (selettore o pannello AGENTI/nodo):
   * - se la sua sessione PTY è viva → la seleziona;
   * - motore interattivo senza sessione → `agents.start` (sessione reale, poi selezione automatica);
   * - motore headless → il flusso REALE del turno (nessun processo da avviare, nessun prompt finto).
   */
  const openAgent = (agentId: string): void => {
    setNote(null);
    setError(null);
    const live = sessions.find((s) => s.owner.agentId === agentId && s.endedAt === null);
    if (live) {
      setStreamAgent(null);
      setSelected(live.processId);
      return;
    }
    const view = agents.find((a) => a.definition.id === agentId) ?? null;
    if (!(view?.capabilities.includes('turns.interactive') ?? false)) {
      setSelected(null);
      setStreamAgent(agentId);
      return;
    }
    setStreamAgent(null);
    setNote(t('windows.term.starting', { id: agentId }));
    void window.visione.agents.start(agentId).then((res) => {
      if (!res.ok) {
        setNote(t('windows.term.sessionError', { id: agentId, code: res.error.code, message: res.error.message }));
        return;
      }
      if (res.data.reason) {
        setNote(`${t('windows.term.sessionReason', { id: agentId, reason: res.data.reason })}${res.data.approvalId ? ` · ${t('windows.term.approvalSuffix', { id: res.data.approvalId })}` : ''}`);
        return;
      }
      pendingRef.current = agentId;
      setNote(t('windows.term.started', { id: agentId, status: res.data.status ?? t('windows.term.statusStarting') }));
      reloadRef.current();
      loadAgents();
    });
  };

  // Focus richiesto dal pannello di un agente o dal pannello AGENTI (Fase 12.6, P-94): apre davvero
  // il terminale dell'agente (PTY o flusso), non solo se la sessione esiste già.
  useEffect(() => {
    if (!focusAgent) {
      focusedRef.current = null;
      return;
    }
    if (focusedRef.current === focusAgent) return;
    focusedRef.current = focusAgent;
    openAgent(focusAgent);
    // `openAgent` legge lo stato corrente del render: il richiamo avviene solo al cambio di agente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAgent]);

  const close = (processId: string): void => {
    setNote(null);
    // Come un terminale normale: chiusa la scheda attiva, si passa a un'altra sessione viva.
    const next = tabs.find((s) => s.processId !== processId && s.endedAt === null)?.processId ?? null;
    // La scheda sparisce subito; se il core rifiuta la chiusura torna visibile.
    tabsRef.current = hideTerminalTab(tabsRef.current, processId);
    setTabs((prev) => prev.filter((s) => s.processId !== processId));
    setSelected((prev) => (prev === processId ? next : prev));
    void window.visione.terminal.close(processId).then((res) => {
      if (!res.ok) {
        setError(res.error);
        tabsRef.current = unhideTerminalTab(tabsRef.current, processId);
        reloadRef.current();
      }
    });
  };

  const current = tabs.find((s) => s.processId === selected) ?? null;
  const streamView = streamAgent !== null ? agents.find((a) => a.definition.id === streamAgent) ?? null : null;
  const activeAgentIds = new Set(sessions.filter((s) => s.endedAt === null && s.owner.agentId).map((s) => s.owner.agentId));
  return (
    <section className="terminal-view" aria-label={t('windows.term.viewAria')} data-testid="terminal-view">
      <div className="term-controlli">
        <button type="button" className="term-tasto-testo term-primario" onClick={open} disabled={!ready} data-testid="terminal-open">{t('windows.common.newShell')}</button>
        <label className="term-agente small" title={t('windows.term.agentPickerTitle')}>
          <span className="muted">{t('windows.term.agentLabel')}</span>
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) openAgent(id);
            }}
            disabled={!ready}
            data-testid="terminal-agent-select"
          >
            <option value="">{t('windows.term.pickAgent')}</option>
            {agents.map((a) => (
              <option key={a.definition.id} value={a.definition.id}>
                {a.definition.name || a.definition.id}
                {activeAgentIds.has(a.definition.id) ? ` · ${t('windows.term.liveSession')}` : a.instance ? ` · ${a.instance.status}` : ` · ${t('windows.common.neverStarted')}`}
              </option>
            ))}
          </select>
        </label>
        <ul className="term-schede" data-testid="terminal-sessions">
          {tabs.map((s) => {
            const isEnding = s.endedAt !== null || ending.has(s.processId);
            return (
              <li key={s.processId}>
                <button
                  type="button"
                  className={`term-scheda-tasto${s.processId === selected ? ' term-attiva' : ''}`}
                  onClick={() => {
                    setStreamAgent(null);
                    setSelected(s.processId);
                  }}
                  data-testid={`terminal-${s.processId}`}
                  title={isEnding
                    ? t('windows.term.tabEndedTitle', { title: s.title })
                    : `${s.title} · ${s.status}${s.owner.agentId ? ` · ${t('windows.term.agentOf', { id: s.owner.agentId })}` : ''}${s.interactive ? '' : ` · ${t('windows.common.readOnly')}`} · ${t('windows.term.realSession')}`}
                >
                  <span className={`term-spia tone-${processTone(s.status, isEnding)}`} aria-hidden="true" />
                  <span className="term-nome">{s.title}</span>
                  <span className={`term-stato-scheda st-${s.status}`}>{isEnding ? t('windows.term.endedLabel') : s.status}</span>
                </button>
                {s.endedAt === null && (
                  <button
                    type="button"
                    className="term-tasto"
                    onClick={() => close(s.processId)}
                    aria-label={t('windows.term.closeAria', { title: s.title })}
                    title={t('windows.term.closeTitle')}
                  >×</button>
                )}
              </li>
            );
          })}
          {streamAgent !== null && current === null && (
            <li>
              <button
                type="button"
                className="term-scheda-tasto term-attiva"
                data-testid={`terminal-stream-tab-${streamAgent}`}
                title={t('windows.term.streamTabTitle', { id: streamAgent })}
              >
                <span className="term-spia tone-on" aria-hidden="true" />
                <span className="term-nome">{t('windows.term.streamTabName', { id: streamAgent })}</span>
                <span className="term-stato-scheda">stream</span>
              </button>
              <button
                type="button"
                className="term-tasto"
                onClick={() => setStreamAgent(null)}
                aria-label={t('windows.term.closeStreamAria', { id: streamAgent })}
                title={t('windows.term.closeStreamTitle')}
              >×</button>
            </li>
          )}
        </ul>
      </div>
      {error && <p className="error small">{error.code}: {error.message}</p>}
      {note && <p className="muted small" data-testid="terminal-note">{note}</p>}
      {visible && current ? (
        <TerminalPane key={current.processId} session={current} />
      ) : visible && streamAgent !== null ? (
        <AgentStreamPane key={streamAgent} agentId={streamAgent} view={streamView} />
      ) : (
        <p className="muted small">{tabs.length === 0 && streamAgent === null ? t('windows.common.noSession') : t('windows.term.chooseSession')}</p>
      )}
      {visible && current && current.owner.agentId && !current.interactive && current.endedAt === null && (
        <TellBar key={`tell-${current.owner.agentId}`} agentId={current.owner.agentId} />
      )}
    </section>
  );
}

/**
 * Parlare con l'agente dal suo terminale (11/10/2026). Vale per i PTY: il flusso dei motori senza
 * terminale ha già la sua riga d'invio (`AgentStreamPane`). Il PTY di un motore guidato da VISIONE resta
 * in sola lettura: tasti battuti a mano a metà turno manderebbero fuori sincrono l'adattatore. Il
 * messaggio passa quindi per la stessa via della chat della finestra dell'agente (`agents.tell`):
 * la risposta si vede scorrere qui, nel terminale reale.
 */
function TellBar({ agentId }: { agentId: string }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const addPaths = useCallback((paths: string[]): void => setText((d) => appendPaths(d, paths)), []);
  const tellDrop = useAttachDrop(addPaths, !busy);
  const send = (): void => {
    const body = text.trim();
    if (body === '' || busy) return;
    setBusy(true);
    void window.visione.agents.tell({ agentId, text: body }).then((res) => {
      setBusy(false);
      if (res.ok) {
        setText('');
        setNote({ ok: true, text: t('windows.term.tellSent') });
      } else setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
    });
  };
  return (
    <form className={`m-console term-tell${tellDrop.over ? ' attach-over' : ''}`} data-testid={`terminal-tell-${agentId}`} onSubmit={(e) => { e.preventDefault(); send(); }} {...tellDrop.handlers}>
      <span className="prompt mono">{agentId}&gt;</span>
      <AttachButton onPaths={addPaths} disabled={busy} testId={`tell-attach-${agentId}`} />
      <input
        onPaste={pasteHandler(addPaths)}
        aria-label={t('windows.term.tellAria', { id: agentId })}
        data-testid={`terminal-tell-input-${agentId}`}
        placeholder={t('windows.term.tellPlaceholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" data-testid={`terminal-tell-send-${agentId}`} disabled={busy || text.trim() === ''}>{t('windows.common.send')}</button>
      {note && <span className={note.ok ? 'muted small' : 'error small'} data-testid={`terminal-tell-note-${agentId}`}>{note.text}</span>}
    </form>
  );
}
