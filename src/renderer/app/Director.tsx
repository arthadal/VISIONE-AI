// Viste minime dell'orchestrazione (Fase 6): agenti, obiettivi e task, approvazioni. Solo comandi
// al core (window.visione): nessun accesso a file, database o processi. I dati si rileggono quando
// cambia il riepilogo corrispondente nello stato del core (nessun polling). La UI completa
// (Agents, Tasks, HUD) è della Fase 8: queste schede ne sono le viste Agents, Tasks e Approvazioni;
// l'obiettivo si invia dalla barra comandi (`CommandBar.tsx`).
// Fase G4 (P-76): il pannello AGENTI parla il linguaggio HUD (righe mono, stato, attività reale
// dagli eventi); la lista arriva dall'App (una sola lettura di `agents.list` per tutta la UI).
import { useEffect, useState } from 'react';
import type { AgentView, Approval, CommandError, CoreStateSnapshot, VisioneEvent, Task } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { agentActivity, agentReasonText, agentStateLabel, agentStatusIsTerminal, naText } from './hud-metrics.ts';
import { hms, HudPanel, HudRows } from './HudPanels.tsx';

type Ready = { core: CoreStateSnapshot | null; ready: boolean };

/** Rilegge quando cambia `key` (derivata dallo stato del core); `load` null = niente da leggere. */
function useReload<T>(ready: boolean, key: string, load: (() => Promise<{ ok: true; data: T } | { ok: false; error: CommandError }>) | null): [T | null, CommandError | null] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (!load) {
      setData(null);
      return;
    }
    let current = true;
    void load().then((res) => {
      if (!current) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
    return () => {
      current = false;
    };
    // `load` è una funzione nuova a ogni render: la rilettura la decide `key`.
  }, [ready, key]);
  return [data, error];
}

export function AgentsCard({ core, ready, agents, events, loadError, onOpenAgent, onOpenTerminal }: Ready & {
  /** Vista reale degli agenti (una sola lettura in App, condivisa anche dai gettoni in topbar). */
  agents: AgentView[] | null;
  events: readonly VisioneEvent[];
  loadError: string | null;
  onOpenAgent?: (agentId: string) => void;
  /** P-94: apre la vista Terminale sull'agente (PTY reale o flusso del turno per i motori headless). */
  onOpenTerminal?: (agentId: string) => void;
}) {
  const t = useT();
  const lang = useLanguage();
  const na = naText(lang);
  const a = core?.agents;
  const [form, setForm] = useState({ id: '', adapter: '', model: '', competences: 'code' });
  const [error, setError] = useState<CommandError | null>(null);

  const define = (): void => {
    void window.visione.agents.define({
      id: form.id.trim(), name: form.id.trim(), role: lang === 'en' ? `agent ${form.id.trim()}` : `agente ${form.id.trim()}`,
      competences: form.competences.split(',').map((c) => c.trim()).filter(Boolean) as AgentView['definition']['competences'],
      engine: { adapter: form.adapter.trim(), ...(form.model.trim() ? { model: form.model.trim() } : {}) },
      persona: lang === 'en' ? { instructions: 'Reply in English.', language: 'en' } : { instructions: 'Rispondi in italiano.', language: 'it' },
      workspace: { root: form.id.trim(), isolation: 'shared' },
      permissions: 'read-only',
      limits: { maxTurnMinutes: 10, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
    }).then((res) => setError(res.ok ? null : res.error));
  };

  const list = agents ?? [];
  const note = !core
    ? t('settings.agentsCard.noCore')
    : list.length === 0
      ? (ready ? t('settings.agentsCard.noAgents') : t('settings.agentsCard.waitingList'))
      : undefined;
  return (
    <HudPanel title={t('settings.agentsCard.title')} status={a ? t('settings.agentsCard.status', { working: a.working, live: a.live }) : null} testId="panel-agents" className="panel-agents" note={note}>
      <p className="hp-riepilogo" data-testid="agents-count">{a ? t('settings.agentsCard.count', { defined: a.defined, live: a.live }) : na}</p>
      {list.length > 0 && (
        <ul className="agents-hud" data-testid="agents">
          {list.map((v) => {
            const id = v.definition.id;
            const st = v.instance?.status ?? null;
            const reason = v.instance?.statusReason ?? null;
            const activity = agentActivity(events, id);
            const stateLabel = agentStateLabel(st, reason, lang);
            const stateClass = st ? `hs-stato-${st}` : 'hs-stato-idle';
            const working = st === 'working';
            return (
              <li key={id} className={`hs-agente${working ? ' hs-lavoro' : ''}${st && agentStatusIsTerminal(st) ? ' hs-terminale' : ''}`} data-testid={`agent-${id}`}>
                <div className="hs-testa-agente">
                  <span className="hs-nome hs-forte">{v.definition.name || id}</span>
                  <span className={`hs-valore ${stateClass}`} title={reason ?? t('settings.agentsCard.stateTitle')}>{stateLabel}</span>
                </div>
                {(st === 'crashed' || st === 'error' || st === 'stopped') && reason && (
                  <p className="muted small hs-motivo" title={t('settings.agentsCard.reasonTitle', { reason })}>{agentReasonText(st, reason, lang)}</p>
                )}
                {/* P-87: righe nella lingua della reference AGENTI (Munder → JARVIS, MIT): strumento,
                    ultimo segnale, modello, token, context, compito·lat·TTFT. Valori reali; dove la
                    fonte non esiste si dichiara `N/D` (mai un numero derivato). */}
                <div className="x-expert"><HudRows rows={[
                  { k: t('settings.agentsCard.rowTool'), v: activity?.tool ?? na, title: t('settings.agentsCard.rowToolTitle') },
                  {
                    k: t('settings.agentsCard.rowLastSignal'),
                    v: (v.instance?.lastEventAt ?? activity?.at) ? hms((v.instance?.lastEventAt ?? activity?.at) as number, lang) : na
                  },
                  { k: t('settings.agentsCard.rowModel'), v: v.definition.engine.model ?? na },
                  { k: 'PROVIDER', v: v.definition.engine.adapter },
                  { k: 'TOKEN', v: na, title: t('settings.agentsCard.rowTokenTitle') },
                  { k: 'CONTEXT', v: na, title: t('settings.agentsCard.rowContextTitle') },
                  { k: t('settings.agentsCard.rowTask'), v: `${v.instance?.currentTaskId ?? na} · ${na} · ${na}` }
                ]} /></div>
                <div className="hs-azioni">
                  {onOpenAgent && <button type="button" className="small" data-testid={`open-agent-${id}`} onClick={() => onOpenAgent(id)}>{t('settings.common.open')}</button>}
                  {onOpenTerminal && (
                    <button
                      type="button"
                      className="small"
                      data-testid={`open-agent-terminal-${id}`}
                      onClick={() => onOpenTerminal(id)}
                      title={t('settings.agentsCard.terminalTitle')}
                    >{t('settings.common.terminal')}</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="form x-expert">
        <input aria-label="id" placeholder="id" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
        <input aria-label="adapter" placeholder="adapter" value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value })} />
        <input aria-label={t('settings.agentsCard.modelAria')} placeholder={t('settings.agentsCard.modelPlaceholder')} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        <input aria-label={t('settings.agentsCard.skills')} placeholder={t('settings.agentsCard.skills')} value={form.competences} onChange={(e) => setForm({ ...form, competences: e.target.value })} />
        <button type="button" onClick={define} disabled={!ready || form.id.trim() === '' || form.adapter.trim() === ''}>{t('settings.agentsCard.define')}</button>
      </div>
      {error && <p className="error small">{error.code}: {error.message}</p>}
      {loadError && <p className="error small">{loadError}</p>}
    </HudPanel>
  );
}

export function TasksView({ core, ready }: Ready) {
  const tr = useT();
  const t = core?.tasks;
  const key = t ? `${t.active}:${t.last?.taskId ?? ''}:${t.last?.status ?? ''}:${t.last?.at ?? 0}` : '';
  const [roots] = useReload(ready, key, () => window.visione.tasks.list({ rootsOnly: true, limit: 10 }));
  const [selected, setSelected] = useState<string | null>(null);
  const latest: Task | undefined = roots?.tasks.find((r) => r.id === selected) ?? roots?.tasks[0];
  const [detail] = useReload(ready, `${key}:${latest?.id ?? ''}`, latest ? () => window.visione.tasks.get(latest.id) : null);
  const [error, setError] = useState<CommandError | null>(null);
  const cancel = (taskId: string): void => {
    void window.visione.tasks.cancel(taskId, 'annullato dal proprietario').then((res) => setError(res.ok ? null : res.error));
  };

  return (
    <article className="card tasks-view" aria-label="Tasks">
      <h2>Tasks · Director</h2>
      <p className="state" data-testid="goals-active">{core ? tr('settings.tasks.goalsTasks', { goals: core.director.activeGoals, tasks: core.tasks.active }) : '—'}</p>
      <ul className="rows" data-testid="goal-roots">
        {(roots?.tasks ?? []).map((r) => (
          <li key={r.id}>
            <button type="button" className={r.id === latest?.id ? 'selected' : ''} onClick={() => setSelected(r.id)}>{r.title}</button>
            <span className={`mono st-${r.status}`}>{r.status}</span>
          </li>
        ))}
      </ul>
      {latest && (
        <div data-testid="goal-latest">
          <p className="mono small">
            <span className="type">{latest.title}</span> · <span data-testid="goal-status">{latest.status}</span>
            {(latest.status === 'created' || latest.status === 'running') && (
              <button type="button" onClick={() => cancel(latest.id)} disabled={!ready}>{tr('settings.tasks.cancel')}</button>
            )}
          </p>
          <ul className="rows" data-testid="goal-tasks">
            {(detail?.children ?? []).map((c) => (
              <li key={c.id}>
                <span className="mono">{c.status}</span>
                <span className="type">{c.title}</span>
                <span className="muted small">{c.assigneeAgentId ?? '—'}</span>
                {c.result && <span className="small">{c.result.summary.slice(0, 200)}</span>}
                {c.error && <span className="bad small">{c.error.code}: {c.error.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {core?.director.lastDecision && (
        <p className="muted small" data-testid="last-decision">{tr('settings.tasks.lastDecision', { decision: core.director.lastDecision.decision, agent: core.director.lastDecision.agentId ?? '' })}</p>
      )}
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </article>
  );
}

export function ApprovalsCard({ core, ready }: Ready) {
  const t = useT();
  const key = core ? `${core.approvals.pending}:${core.tasks.last?.at ?? 0}` : '';
  const [data] = useReload(ready, key, () => window.visione.approvals.list({ status: 'pending', limit: 20 }));
  const [error, setError] = useState<CommandError | null>(null);
  const pending: Approval[] = data?.approvals ?? [];

  const decide = (id: string, decision: 'grant' | 'deny'): void => {
    void window.visione.approvals.decide(id, decision).then((res) => setError(res.ok ? null : res.error));
  };

  return (
    <article className="card" aria-label={t('settings.approvals.title')}>
      <h2>{t('settings.approvals.title')}</h2>
      <p className={`state ${core && core.approvals.pending > 0 ? 'state-starting' : ''}`} data-testid="approvals-pending">{core ? t('settings.approvals.pending', { n: core.approvals.pending }) : '—'}</p>
      <ul className="rows" data-testid="approvals">
        {pending.map((p) => (
          <li key={p.id} data-testid={`approval-${p.id}`}>
            <span className="type">{p.kind}</span>
            <span className="mono small">{p.target}</span>
            <span className="muted small">{p.reason}</span>
            <button type="button" onClick={() => decide(p.id, 'grant')} disabled={!ready}>{t('settings.approvals.grant')}</button>
            <button type="button" onClick={() => decide(p.id, 'deny')} disabled={!ready}>{t('settings.approvals.deny')}</button>
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </article>
  );
}

/**
 * Vista Director (Fase 11): piano, decisioni e sintesi dalle fonti reali (eventi `director.*` e stato
 * del core). Nessuna riga di esempio: se il Director non ha ancora deciso, la lista è vuota.
 */
export function DirectorView({ events, core }: { events: readonly VisioneEvent[]; core: CoreStateSnapshot | null }) {
  const t = useT();
  const plans = events
    .filter((e) => e.type === 'director.plan.created')
    .map((e) => e.payload as { rootTaskId: string; planner: string; taskIds: string[]; fallback: string | null })
    .slice(-5)
    .reverse();
  const decisions = events
    .filter((e) => e.type === 'director.decision')
    .map((e) => e.payload as { taskId: string | null; decision: string; agentId: string | null; reason: string })
    .slice(-20)
    .reverse();
  const summaries = events
    .filter((e) => e.type === 'director.summary')
    .map((e) => e.payload as { rootTaskId: string; outcome: string; counts: Record<string, number>; text: string })
    .slice(-3)
    .reverse();

  return (
    <section className="director-view" aria-label="Director" data-testid="director-view">
      <p className="state" data-testid="director-active-goals">
        {core ? t('settings.directorView.goalsApprovals', { goals: core.director.activeGoals, approvals: core.approvals.pending }) : '—'}
      </p>

      <h3>{t('settings.directorView.plans')}</h3>
      {plans.length === 0 ? <p className="muted small">{t('settings.directorView.noPlans')}</p> : (
        <ul className="rows" data-testid="director-plans">
          {plans.map((p, i) => (
            <li key={`${p.rootTaskId}-${i}`}>
              <span className="type">{p.planner}</span>
              <span className="mono small">{t('settings.directorView.planTasks', { n: p.taskIds.length })}</span>
              <span className="muted small">{p.fallback ? t('settings.directorView.planFallback', { fallback: p.fallback }) : t('settings.directorView.planGoal', { id: p.rootTaskId.slice(-6) })}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('settings.directorView.decisions')}</h3>
      {decisions.length === 0 ? <p className="muted small">{t('settings.directorView.noDecisions')}</p> : (
        <ul className="rows" data-testid="director-decisions">
          {decisions.map((d, i) => (
            <li key={`${d.taskId ?? 'root'}-${i}`}>
              <span className="type">{d.decision}</span>
              <span className="mono small">{d.agentId ?? '—'}</span>
              <span className="muted small">{d.reason}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('settings.directorView.summaries')}</h3>
      {summaries.length === 0 ? <p className="muted small">{t('settings.directorView.noSummaries')}</p> : (
        <ul className="rows" data-testid="director-summaries">
          {summaries.map((s, i) => (
            <li key={`${s.rootTaskId}-${i}`}>
              <span className={`mono st-${s.outcome === 'succeeded' ? 'succeeded' : 'failed'}`}>{s.outcome}</span>
              <span className="small director-summary-text">{s.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
