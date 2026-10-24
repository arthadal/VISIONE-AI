// Finestra di un agente — Fase 18; tab e chat diretta in Fase 21 (P-67). Tutto da fonti reali:
// definizione e istanza dal core (`agents.list`), stato/turni/messaggi/tool/risultati dagli eventi
// filtrati **per agentId**, terminale = sessione PTY reale dell'agente (`terminal.list` →
// `owner.agentId`, con `TerminalPane` filtrato per `processId`: nessun cross-talk). La chat invia con
// `agents.tell`: un task assegnato a QUESTO agente, senza passaggio dal Director. Se una cosa non
// esiste (sessione, usage) lo dice (N/D), non la inventa. Il tab predefinito è TERMINAL (Terminal Mode).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentView, CommandResult, Language, VisioneEvent, TerminalSession } from '../../../shared/contracts/index.ts';
import { TerminalPane } from '../../app/TerminalView.tsx';
import { translate, useLanguage, useT } from '../../lib/i18n/index.ts';
import { AttachButton, pasteHandler, useAttachDrop } from '../../app/Attach.tsx';
import { appendPaths } from '../../app/attach-logic.ts';
import { clockText } from '../locale.ts';
import { agentStream, mergeStreamEvents } from './agentStream.ts';

type Tab = 'overview' | 'chat' | 'terminal' | 'tasks' | 'events' | 'tools' | 'logs' | 'metrics';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'chat', label: 'CHAT' },
  { id: 'terminal', label: 'TERMINAL' },
  { id: 'tasks', label: 'TASKS' },
  { id: 'events', label: 'EVENTS' },
  { id: 'tools', label: 'TOOLS' },
  { id: 'logs', label: 'LOGS' },
  { id: 'metrics', label: 'METRICS' }
];

interface AgentEventLine { id: string; at: number; type: string; text: string; taskId: string | null }

/** Proiezione degli eventi di UN agente: stato, messaggi, tool, risultati, errori, correlationId. */
export function agentTimeline(events: readonly VisioneEvent[], agentId: string, lang: Language = 'it'): AgentEventLine[] {
  const out: AgentEventLine[] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (p.agentId !== agentId && p.producedBy !== agentId && p.from !== agentId) continue;
    const taskId = typeof p.taskId === 'string' ? p.taskId : null;
    let text = '';
    if (e.type === 'agent.status.changed') text = `${String(p.from ?? '—')} → ${String(p.to)}`;
    else if (e.type === 'agent.turn.started') text = translate(lang, 'windows.stream.turnStarted');
    else if (e.type === 'agent.turn.finished') text = translate(lang, 'windows.stream.turnFinished', { outcome: String(p.outcome) });
    else if (e.type === 'agent.message.text') text = String(p.text ?? '').slice(0, 400);
    else if (e.type === 'agent.message.sent') text = `${String(p.from)} → ${String(p.to)} · ${String(p.act)}: ${String(p.subject)}`;
    else if (e.type === 'tool.call.started') text = `tool ${String(p.tool)}`;
    else if (e.type === 'tool.call.finished') text = translate(lang, p.ok === false ? 'windows.stream.toolFinishedErr' : 'windows.stream.toolFinishedOk', { tool: String(p.tool) });
    else if (e.type === 'tool.call.denied') text = translate(lang, 'windows.stream.toolDenied', { tool: String(p.tool), reason: String(p.reason) });
    else if (e.type === 'task.created') text = String(p.title ?? translate(lang, 'windows.stream.newTask'));
    else if (e.type === 'task.assigned') text = translate(lang, 'windows.stream.assigned', { previous: String(p.previousAgentId ?? '—') });
    else if (e.type === 'task.result.recorded') text = `${String(p.outcome)}: ${String(p.summary ?? '').slice(0, 300)}`;
    else if (e.type === 'task.status.changed') text = `${String(p.from ?? '—')} → ${String(p.to)} · ${String(p.reason)}`;
    else text = JSON.stringify(p).slice(0, 200);
    out.push({ id: e.id, at: e.ts, type: e.type, text, taskId });
  }
  return out.slice(-300);
}

export function AgentPane({ agentId, events, ready }: { agentId: string; events: VisioneEvent[]; ready: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const clock = (ts: number): string => clockText(ts, lang);
  const [tab, setTab] = useState<Tab>('terminal');
  const [view, setView] = useState<AgentView | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  // «Interrompi» (12/10/2026): esito dell'ultima interruzione, mostrato sotto la console.
  const [interruptMsg, setInterruptMsg] = useState<string | null>(null);
  const [sentTexts, setSentTexts] = useState<Array<{ at: number; text: string }>>([]);
  // Menu modello/potenza (P-83): dati reali dal core (`agents.models`), applicazione con audit.
  const [tuning, setTuning] = useState<CommandResult<'agents.models'> | null>(null);
  const [tuningMsg, setTuningMsg] = useState<string | null>(null);
  const [tuningError, setTuningError] = useState<string | null>(null);
  const [tuningClock, setTuningClock] = useState(0);

  // Rilegge la definizione a ogni transizione di stato dell'agente (nessun polling).
  const agentClock = useMemo(() => events.filter((e) => e.type === 'agent.status.changed' && (e.payload as { agentId?: string }).agentId === agentId).length, [events, agentId]);
  useEffect(() => {
    if (!ready) return;
    void window.visione.agents.list(true).then((res) => {
      if (res.ok) setView(res.data.agents.find((a) => a.definition.id === agentId) ?? null);
      else setLoadError(`${res.error.code}: ${res.error.message}`);
    });
  }, [ready, agentId, agentClock]);

  // Modelli/potenza dell'agente: config del core (istantaneo) + probe reale dell'adapter.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void window.visione.agents.models(agentId, true).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setTuning(res.data);
        setTuningError(null);
      } else {
        setTuningError(`${res.error.code}: ${res.error.message}`);
      }
    });
    return () => {
      alive = false;
    };
  }, [ready, agentId, agentClock, tuningClock]);
  const applyTuning = (change: { model?: string; effort?: string | null }): void => {
    setTuningMsg(null);
    setTuningError(null);
    void window.visione.agents.tuning({ agentId, ...change }).then((res) => {
      if (!res.ok) {
        setTuningError(`${res.error.code}: ${res.error.message}`);
        return;
      }
      const where = res.data.live ? (res.data.applies === 'next-session' ? t('windows.agent.appliedNextSession') : t('windows.agent.appliedNextTurn')) : t('windows.agent.appliedNextStart');
      setTuningMsg(`${res.data.model ?? t('windows.agent.default')}${res.data.effort ? ` · ${t('windows.agent.effortOf', { effort: res.data.effort })}` : ''} → ${where}`);
      setTuningClock((c) => c + 1);
    });
  };

  // Sessioni terminale reali dell'agente (nessun terminale globale usato come se fosse suo).
  const procClock = useMemo(() => events.filter((e) => /^(process\.(created|started|exited|failed|crashed|stopped|timeout|cancelled)|terminal\.session\.)/.test(e.type)).length, [events]);
  useEffect(() => {
    if (!ready) return;
    void window.visione.terminal.list().then((res) => { if (res.ok) setSessions(res.data.sessions); });
  }, [ready, procClock]);
  const session = useMemo(() => {
    const mine = sessions.filter((s) => s.owner.agentId === agentId);
    return mine.find((s) => s.endedAt === null) ?? mine[0] ?? null;
  }, [sessions, agentId]);

  const timeline = useMemo(() => agentTimeline(events, agentId, lang), [events, agentId, lang]).reverse();
  // P-93: stream REALE del turno per i motori senza PTY (headless). All'apertura del tab si carica
  // anche lo storico dal journal (`events.list`, nessun polling): la finestra viva della UI è di 200
  // eventi e un turno appena passato non deve sparire dal terminale appena aperto.
  const [streamHistory, setStreamHistory] = useState<VisioneEvent[]>([]);
  useEffect(() => {
    if (!ready || tab !== 'terminal' || session) return;
    let alive = true;
    void window.visione.events.list({ limit: 500 }).then((res) => {
      if (alive && res.ok) setStreamHistory(res.data.events);
    });
    return () => {
      alive = false;
    };
  }, [ready, tab, session, agentId]);
  const stream = useMemo(() => agentStream(mergeStreamEvents(streamHistory, events), agentId, lang), [streamHistory, events, agentId, lang]);
  const streamRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stream.length, tab]);
  const headless = view ? !view.capabilities.includes('turns.interactive') : false;
  const status: string = view?.instance?.status ?? 'mai avviato';
  const statusText = view?.instance?.status ?? t('windows.common.neverStarted');
  const breaker = view?.breaker ?? 'closed';
  const currentTask = timeline.find((l) => l.taskId !== null)?.taskId ?? null;

  const byKind = (re: RegExp): AgentEventLine[] => timeline.filter((l) => re.test(l.type));
  const chatLines = useMemo(
    () => timeline.filter((l) => /^(agent\.(message\.text|turn\.(started|finished))|task\.(created|assigned|status\.changed|result\.recorded))$/.test(l.type)),
    [timeline]
  );
  const chat = useMemo(() => {
    const mine = sentTexts.map((s, i) => ({ id: `mine-${i}-${s.at}`, at: s.at, who: t('windows.agent.whoYou'), type: t('windows.agent.typeMessage'), text: s.text }));
    const theirs = chatLines.map((l) => ({ id: l.id, at: l.at, who: l.type.startsWith('agent.') ? t('windows.agent.whoAgent') : 'task', type: l.type, text: l.text }));
    return [...mine, ...theirs].sort((a, b) => a.at - b.at).slice(-100);
  }, [chatLines, sentTexts, t]);
  const usage = useMemo(() => {
    const ev = [...events].reverse().find((e) => e.type === 'agent.usage.updated' && (e.payload as Record<string, unknown>).agentId === agentId);
    if (!ev) return null;
    const p = ev.payload as Record<string, unknown>;
    return p.usage ?? p;
  }, [events, agentId]);

  // Allegati (12/10/2026): file, cartelle e screenshot nel messaggio all'agente, come percorsi.
  const addPaths = useCallback((paths: string[]): void => setText((d) => appendPaths(d, paths)), []);
  const consoleDrop = useAttachDrop(addPaths, ready);
  const send = (): void => {
    const body = text.trim();
    if (body === '') return;
    void window.visione.agents.tell({ agentId, text: body }).then((res) => {
      setChatError(res.ok ? null : `${res.error.code}: ${res.error.message}`);
      if (res.ok) {
        setSentTexts((prev) => [...prev.slice(-30), { at: Date.now(), text: body }]);
        setText('');
        setTab('chat');
      }
    });
  };

  const interrupt = (): void => {
    void window.visione.agents.interrupt(agentId, t('windows.agent.interruptReason')).then((res) => {
      if (!res.ok) { setInterruptMsg(`${res.error.code}: ${res.error.message}`); return; }
      setInterruptMsg(res.data.cancelled.length > 0 ? t('windows.agent.interrupted', { n: res.data.cancelled.length }) : t('windows.agent.nothingToInterrupt'));
    });
  };

  return (
    <div className="pane agent-pane" data-testid={`win-agent-${agentId}`} data-agent={agentId}>
      {tuning && (
        <div className="agent-tuning" data-testid={`agent-tuning-${agentId}`}>
          {tuning.selectable ? (
            <>
              <label className="small mono">
                {t('windows.agent.modelLabel')}
                <select
                  data-testid={`agent-model-${agentId}`}
                  value={tuning.current ?? ''}
                  disabled={!ready}
                  onChange={(e) => applyTuning({ model: e.target.value })}
                >
                  <option value="">{t('windows.agent.default')}</option>
                  {tuning.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.id}{m.detail ? ` · ${m.detail}` : ''}</option>
                  ))}
                </select>
              </label>
              {tuning.effort && (
                <label className="small mono">
                  {t('windows.agent.effortLabel')}
                  <select
                    data-testid={`agent-effort-${agentId}`}
                    value={tuning.effort.current ?? ''}
                    disabled={!ready}
                    onChange={(e) => applyTuning({ effort: e.target.value === '' ? null : e.target.value })}
                  >
                    <option value="">{t('windows.agent.defaultF')}</option>
                    {tuning.effort.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              )}
              <span className="muted small" title={tuning.applies === 'next-session' ? t('windows.agent.appliesNextSessionTitle') : t('windows.agent.appliesNextTurnTitle')}>
                {tuning.live ? (tuning.applies === 'next-session' ? t('windows.agent.nextSession') : t('windows.agent.nextTurn')) : t('windows.agent.nextStart')}
              </span>
            </>
          ) : (
            <span className="muted small">{t('windows.agent.notSelectable')}</span>
          )}
          {tuningMsg && <span className="small" data-testid={`agent-tuning-msg-${agentId}`}>{tuningMsg}</span>}
          {tuningError && <span className="error small" data-testid={`agent-tuning-error-${agentId}`}>{tuningError}</span>}
        </div>
      )}
      <div className="tabs pane-tabs">
        {TABS.map((tb) => (
          <button key={tb.id} type="button" aria-selected={tab === tb.id} data-testid={`agent-tab-${tb.id}-${agentId}`} onClick={() => setTab(tb.id)}>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <dl className="kv">
          <dt>{t('windows.agent.name')}</dt><dd className="type">{view?.definition.name ?? agentId}</dd>
          <dt>agentId</dt><dd className="mono">{agentId}</dd>
          <dt>{t('windows.agent.role')}</dt><dd>{view?.definition.role ?? '—'}</dd>
          <dt>provider</dt><dd className="mono">{view?.definition.engine.adapter ?? '—'}</dd>
          <dt>{t('windows.agent.model')}</dt><dd className="mono small">{view?.definition.engine.model ?? t('windows.agent.default')}</dd>
          <dt>{t('windows.agent.status')}</dt><dd className={`mono st-${status}`} data-testid={`agent-status-${agentId}`}>{statusText}</dd>
          <dt>breaker</dt><dd className={`mono ${breaker === 'closed' ? '' : 'bad'}`}>{breaker}</dd>
          <dt>{t('windows.agent.currentTask')}</dt><dd className="mono small">{currentTask ?? t('windows.common.none')}</dd>
        </dl>
      )}

      {tab === 'chat' && (
        <div className="m-feed" data-testid={`agent-chat-${agentId}`}>
          {chat.length === 0 ? <p className="muted small">{t('windows.agent.chatEmpty')}</p> : chat.map((l) => (
            <div key={l.id} className="chat-line">
              <span className="mono small who">{l.who}</span>
              <span className="type small">{l.type}</span>
              <span className="muted small">{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'terminal' && (
        <>
          {session ? (
            <>
              <p className="muted small mono" data-testid={`agent-term-${agentId}`}>{t('windows.agent.session', { id: session.processId, status: session.status })}{session.interactive ? '' : ` · ${t('windows.common.readOnly')}`}</p>
              <TerminalPane session={session} />
            </>
          ) : (
            <div className="agent-stream" data-testid={`agent-term-${agentId}`} data-kind="stream" data-agent={agentId}>
              <p className="muted small mono">
                {headless
                  ? t('windows.stream.headless', { model: view?.definition.engine.model ?? t('windows.stream.defaultModel') })
                  : t('windows.agent.noPty', { model: view?.definition.engine.model ?? t('windows.stream.defaultModel') })}
              </p>
              <div className="agent-stream-feed" data-testid={`agent-stream-${agentId}`} ref={streamRef}>
                {stream.length === 0 ? (
                  <p className="muted small">{t('windows.agent.noTurns')}</p>
                ) : stream.map((l) => (
                  <div key={l.id} className={`stream-line k-${l.kind}`}>
                    <span className="mono small at">{clock(l.at)}</span>
                    <span className="type small">{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'tasks' && (
        <div className="m-feed" data-testid={`agent-tasks-${agentId}`}>
          {byKind(/^task\./).length === 0 ? <p className="muted small">{t('windows.agent.tasksEmpty')}</p> : byKind(/^task\./).map((l) => (
            <div key={l.id} className="feed-line">
              <span className="mono small">{clock(l.at)}</span><span className="type small">{l.type}</span><span className="small">{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'events' && (
        <div className="m-feed" data-testid={`agent-events-${agentId}`}>
          {timeline.length === 0 ? <p className="muted small">{t('windows.agent.eventsEmpty')}</p> : timeline.slice(0, 120).map((l) => (
            <div key={l.id} className="feed-line">
              <span className="mono small">{clock(l.at)}</span><span className="type small">{l.type}</span><span className="small">{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'tools' && (
        <div className="m-feed" data-testid={`agent-tools-${agentId}`}>
          {byKind(/^tool\./).length === 0 ? <p className="muted small">{t('windows.agent.toolsEmpty')}</p> : byKind(/^tool\./).map((l) => (
            <div key={l.id} className="feed-line">
              <span className="mono small">{clock(l.at)}</span><span className="type small">{l.type}</span><span className="small">{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'logs' && (
        <div className="m-feed" data-testid={`agent-logs-${agentId}`}>
          {byKind(/^(agent\.(status\.changed|turn\.(started|finished))|error\.)/).length === 0 ? <p className="muted small">{t('windows.agent.logsEmpty')}</p> : byKind(/^(agent\.(status\.changed|turn\.(started|finished))|error\.)/).map((l) => (
            <div key={l.id} className={`feed-line sev-${l.type.startsWith('error') ? 'error' : 'info'}`}>
              <span className="mono small">{clock(l.at)}</span><span className="type small">{l.type}</span><span className="small">{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'metrics' && (
        <dl className="kv">
          <dt>{t('windows.agent.status')}</dt><dd className={`mono st-${status}`}>{statusText}</dd>
          <dt>breaker</dt><dd className="mono">{breaker}</dd>
          <dt>{t('windows.agent.limits')}</dt><dd className="mono small">{view ? t('windows.agent.limitsValue', { minutes: view.definition.limits.maxTurnMinutes, turns: view.definition.limits.maxTurnsPerTask, parallel: view.definition.limits.maxConcurrentTasks }) : '—'}</dd>
          <dt>{t('windows.agent.permissions')}</dt><dd className="mono small">{view?.definition.permissions ?? '—'}</dd>
          <dt>workspace</dt><dd className="mono small">{view?.definition.workspace.root ?? '—'} ({view?.definition.workspace.isolation ?? '—'})</dd>
          <dt>{t('windows.agent.engineSession')}</dt><dd className="mono small">{view?.session?.engineSessionId ?? '—'}</dd>
          <dt>usage</dt><dd className="mono small">{usage ? JSON.stringify(usage).slice(0, 200) : t('windows.common.na')}</dd>
          <dt>{t('windows.agent.agentEvents')}</dt><dd className="mono">{timeline.length}</dd>
        </dl>
      )}

      <form className={`m-console${consoleDrop.over ? ' attach-over' : ''}`} onSubmit={(e) => { e.preventDefault(); send(); }} {...consoleDrop.handlers}>
        <span className="prompt mono">{agentId}&gt;</span>
        <AttachButton onPaths={addPaths} disabled={!ready} testId={`agent-attach-${agentId}`} />
        <input onPaste={pasteHandler(addPaths)} aria-label={t('windows.agent.directAria', { agentId })} data-testid={`agent-chat-input-${agentId}`} placeholder={t('windows.agent.directPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" data-testid={`agent-send-${agentId}`} disabled={!ready || text.trim() === ''}>{t('windows.common.send')}</button>
        <button type="button" className="interrupt-btn" data-testid={`agent-interrupt-${agentId}`} onClick={interrupt} disabled={!ready} title={t('windows.agent.interruptTitle')}>{t('windows.agent.interrupt')}</button>
      </form>
      {interruptMsg && <p className="small" data-testid={`agent-interrupt-msg-${agentId}`}>{interruptMsg}</p>}
      {chatError && <p className="error small">{chatError}</p>}
      {loadError && <p className="error small">{loadError}</p>}
    </div>
  );
}
