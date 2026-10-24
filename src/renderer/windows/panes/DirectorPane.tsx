// Finestra di Director (Fase 18; tab reali in Fase 20, P-66): pannello operativo con
// OVERVIEW · CHAT · TERMINAL · TASKS · AGENTS · EVENTS · LOGS · METRICS. Tutto ciò che appare viene
// dallo stato reale del core e dagli eventi reali (`director.*`, `task.*`, `agent.*`, `process.*`,
// `tool.*`, `system.*`): nessun pensiero interno inventato e nessun comando inventato. La console
// invia obiettivi reali (`director.submit`); il terminale di sistema è una shell PTY reale del core.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreStateSnapshot, VisioneEvent, TerminalSession } from '../../../shared/contracts/index.ts';
import { TerminalPane } from '../../app/TerminalView.tsx';
import { sendGoal } from '../../app/offline-store.ts';
import { useLanguage, useT } from '../../lib/i18n/index.ts';
import { formatDuration } from '../../lib/time.ts';
import { clockText } from '../locale.ts';

type Tab = 'overview' | 'chat' | 'terminal' | 'tasks' | 'agents' | 'events' | 'logs' | 'metrics';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'chat', label: 'CHAT' },
  { id: 'terminal', label: 'TERMINAL' },
  { id: 'tasks', label: 'TASKS' },
  { id: 'agents', label: 'AGENTS' },
  { id: 'events', label: 'EVENTS' },
  { id: 'logs', label: 'LOGS' },
  { id: 'metrics', label: 'METRICS' }
];

function payloadOf(event: VisioneEvent): string {
  return JSON.stringify(event.payload ?? null).slice(0, 160);
}

function EventRows({ rows, limit = 80 }: { rows: VisioneEvent[]; limit?: number }) {
  const t = useT();
  const lang = useLanguage();
  if (rows.length === 0) return <p className="muted small">{t('windows.director.noEvents')}</p>;
  return (
    <>
      {rows.slice(-limit).map((e) => (
        <div key={e.id} className={`feed-line sev-${e.severity}`}>
          <span className="mono small">{clockText(e.ts, lang)}</span>
          <span className="type small">{e.type}</span>
          <span className="muted small">{payloadOf(e)}</span>
        </div>
      ))}
    </>
  );
}

export function DirectorPane({ core, events, ready }: { core: CoreStateSnapshot | null; events: VisioneEvent[]; ready: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const [tab, setTab] = useState<Tab>('overview');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shell, setShell] = useState<TerminalSession | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const operational = useMemo(
    () => events.filter((e) => /^(director|task|agent|process|tool)\./.test(e.type) || e.type === 'system.error'),
    [events]
  );
  const feed = useMemo(() => operational.slice(-80), [operational]);
  const chatFeed = useMemo(() => events.filter((e) => e.type.startsWith('director.') || e.type.startsWith('task.')).slice(-40), [events]);
  const taskFeed = useMemo(() => operational.filter((e) => e.type.startsWith('task.')).slice(-40), [operational]);
  const agentFeed = useMemo(() => operational.filter((e) => e.type.startsWith('agent.') || e.type.startsWith('tool.')).slice(-40), [operational]);
  const logs = useMemo(() => events.filter((e) => e.severity === 'error' || e.severity === 'warning' || e.type === 'system.error').slice(-60), [events]);
  useEffect(() => {
    if (tab === 'terminal') endRef.current?.scrollIntoView({ block: 'end' });
  }, [tab, feed.length]);

  const lastGoal = useMemo(() => [...events].reverse().find((e) => e.type === 'director.goal.received'), [events]);
  const decision = core?.director.lastDecision ?? null;
  const state = (core?.director.activeGoals ?? 0) > 0 ? 'working' : 'idle';

  const goals = useMemo(() => {
    const ids: string[] = [];
    for (const e of events) {
      if (e.type === 'director.goal.received') ids.push((e.payload as { rootTaskId: string }).rootTaskId);
    }
    return [...new Set(ids)].reverse().slice(0, 6);
  }, [events]);

  const submit = (): void => {
    const text = goal.trim();
    if (text === '') return;
    // Offline (17/10/2026) la frase va al modello locale: la risposta compare sopra la barra comandi.
    void sendGoal(text).then((res) => {
      setError(res.ok ? null : `${res.error.code}: ${res.error.message}`);
      if (res.ok) setGoal('');
    });
  };
  const cancel = (taskId: string): void => {
    void window.visione.tasks.cancel(taskId, t('windows.director.cancelReason')).then((res) => setError(res.ok ? null : `${res.error.code}: ${res.error.message}`));
  };
  // «Interrompi tutto» (12/10/2026): tutti gli obiettivi non conclusi, con i task degli agenti.
  const [interruptMsg, setInterruptMsg] = useState<string | null>(null);
  const interruptAll = (): void => {
    void window.visione.director.interrupt(t('windows.director.interruptAllReason')).then((res) => {
      if (!res.ok) { setError(`${res.error.code}: ${res.error.message}`); return; }
      setInterruptMsg(res.data.goals > 0 ? t('windows.director.interruptedAll', { goals: res.data.goals, tasks: res.data.cancelled.length }) : t('windows.director.nothingToInterrupt'));
    });
  };
  const openShell = (): void => {
    void window.visione.terminal.open(100, 26).then((res) => {
      if (res.ok) setShell(res.data.session);
      else setError(`${res.error.code}: ${res.error.message}`);
    });
  };

  return (
    <div className="pane director-pane" data-testid="win-director">
      <div className="tabs pane-tabs">
        {TABS.map((tb) => (
          <button key={tb.id} type="button" aria-selected={tab === tb.id} data-testid={`director-tab-${tb.id}`} onClick={() => setTab(tb.id)}>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <dl className="kv">
            <dt>{t('windows.director.name')}</dt><dd className="type">Director</dd>
            <dt>{t('windows.director.role')}</dt><dd>{t('windows.director.roleValue')}</dd>
            <dt>{t('windows.director.status')}</dt><dd className={`mono st-${state}`}>{state}</dd>
            <dt>{t('windows.director.goals')}</dt><dd className="mono">{core ? t('windows.director.goalsValue', { goals: core.director.activeGoals, tasks: core.tasks.active }) : '—'}</dd>
            <dt>{t('windows.director.lastDecision')}</dt><dd className="mono small">{decision ? `${decision.decision} ${decision.agentId ?? ''}` : t('windows.director.noneF')}</dd>
            <dt>{t('windows.director.lastGoal')}</dt><dd className="mono small">{lastGoal ? (lastGoal.payload as { rootTaskId: string }).rootTaskId : t('windows.common.none')}</dd>
          </dl>
          <div className="m-interrupt">
            <button type="button" className="interrupt-btn" data-testid="director-interrupt-all" onClick={interruptAll} disabled={!ready} title={t('windows.director.interruptAllTitle')}>{t('windows.director.interruptAll')}</button>
            {interruptMsg && <span className="small" data-testid="director-interrupt-msg">{interruptMsg}</span>}
          </div>
          {goals.length > 0 && (
            <div className="m-goals">
              {goals.map((id) => (
                <span key={id} className="chip mono small">
                  {id.slice(-6)}
                  <button type="button" onClick={() => cancel(id)} title={t('windows.director.cancelGoalTitle')} disabled={!ready}>{t('windows.director.interrupt')}</button>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'chat' && (
        <div className="m-feed" data-testid="director-chat">
          {chatFeed.length === 0 ? <p className="muted small">{t('windows.director.chatEmpty')}</p> : chatFeed.map((e) => (
            <div key={e.id} className="chat-line">
              <span className="mono small who">{e.type.split('.')[0]}</span>
              <span className="type small">{e.type}</span>
              <span className="muted small">{payloadOf(e)}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'terminal' && (
        <>
          <div className="m-feed" data-testid="director-feed">
            <EventRows rows={feed} />
            <div ref={endRef} />
          </div>
          <div className="m-terminal">
            <div className="row">
              <h4>{t('windows.director.terminalTitle')}</h4>
              <button type="button" onClick={openShell} disabled={!ready} data-testid="director-open-shell">{t('windows.common.newShell')}</button>
            </div>
            {shell ? <TerminalPane session={shell} /> : <p className="muted small">{t('windows.director.noShell')}</p>}
          </div>
        </>
      )}

      {tab === 'tasks' && (
        <>
          <dl className="kv">
            <dt>{t('windows.director.active')}</dt><dd className="mono">{core?.tasks.active ?? 0}</dd>
            {(core ? Object.entries(core.tasks.byStatus).filter(([, n]) => n > 0) : []).map(([status, n]) => (
              <Fragment key={status}><dt>{status}</dt><dd className="mono">{n}</dd></Fragment>
            ))}
            <dt>{t('windows.director.last')}</dt><dd className="mono small">{core?.tasks.last ? `${core.tasks.last.taskId} · ${core.tasks.last.status}` : t('windows.common.none')}</dd>
          </dl>
          <div className="m-feed" data-testid="director-tasks"><EventRows rows={taskFeed} /></div>
        </>
      )}

      {tab === 'agents' && (
        <>
          <dl className="kv">
            <dt>{t('windows.director.defined')}</dt><dd className="mono">{core?.agents.defined ?? 0}</dd>
            <dt>{t('windows.director.live')}</dt><dd className="mono">{core?.agents.live ?? 0}</dd>
            <dt>{t('windows.director.working')}</dt><dd className="mono st-working">{core?.agents.working ?? 0}</dd>
            <dt>{t('windows.director.last')}</dt><dd className="mono small">{core?.agents.last ? `${core.agents.last.agentId} · ${core.agents.last.status}` : t('windows.common.none')}</dd>
          </dl>
          <div className="m-feed" data-testid="director-agents"><EventRows rows={agentFeed} /></div>
        </>
      )}

      {tab === 'events' && <div className="m-feed" data-testid="director-events"><EventRows rows={events} limit={100} /></div>}

      {tab === 'logs' && <div className="m-feed" data-testid="director-logs"><EventRows rows={logs} /></div>}

      {tab === 'metrics' && (
        <dl className="kv">
          <dt>{t('windows.director.uptime')}</dt><dd className="mono">{core ? formatDuration(Date.now() - core.core.startedAt, lang) : '—'}</dd>
          <dt>{t('windows.director.events')}</dt><dd className="mono">{core?.events.sinceStart ?? 0}{core?.events.rejected ? ` · ${t('windows.director.rejectedN', { n: core.events.rejected })}` : ''}</dd>
          <dt>journal</dt><dd className="mono">{core ? t('windows.director.journalValue', { seq: core.database.journalLastSeq, rows: core.database.journalCount, status: core.database.status }) : '—'}</dd>
          <dt>IPC</dt><dd className="mono">{core ? t('windows.director.ipcValue', { ok: core.ipc.commandsCompleted, ko: core.ipc.commandsFailed, rejected: core.ipc.commandsRejected }) : '—'}</dd>
          <dt>{t('windows.director.processes')}</dt><dd className="mono">{core ? t('windows.director.processesValue', { active: core.processes.active, created: core.processes.created, failed: core.processes.failed }) : '—'}</dd>
          <dt>{t('windows.director.operations')}</dt><dd className="mono">{core?.operations.count ?? 0}</dd>
          <dt>{t('windows.director.errors')}</dt><dd className="mono">{core?.error.count ?? 0}</dd>
          <dt>app/core</dt><dd className="mono small">{core ? `${core.version.app} · ${core.version.core} · schema ${core.version.dbSchema}` : '—'}</dd>
        </dl>
      )}

      <form className="m-console" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <span className="prompt mono">director&gt;</span>
        <input aria-label={t('windows.director.goalAria')} data-testid="director-input" placeholder={t('windows.director.goalPlaceholder')} value={goal} onChange={(e) => setGoal(e.target.value)} />
        <button type="submit" data-testid="director-submit" disabled={!ready || goal.trim() === ''}>{t('windows.common.send')}</button>
      </form>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
