// Centro errori (P-95): pannello con gli errori REALI (eventi del journal con gravità error/critical
// e istanze di agente in errore/interrotte) e un tentativo di riparazione vero per ciascuno, via
// agenti/Director/motori. Ogni clic esegue un comando reale (auditato o con eventi); se l'errore non
// è riparabile lo dichiara «ERRORE FISSO» col motivo. Mai un «risolto» finto: l'esito mostrato è la
// risposta reale del core (avviato o no, task creato o no, motori pronti o no).
import { useEffect, useMemo, useState } from 'react';
import type { AgentView, CoreStateSnapshot, VisioneEvent } from '../../../shared/contracts/index.ts';
import { errorEntryIn, instanceErrorEntryIn, mergeErrorEntries, pickRetryTask, repairFor, type ErrorEntry, type RepairPlan } from '../../app/error-center.ts';
import { useLanguage, useT, type MessageKey } from '../../lib/i18n/index.ts';
import { formatDuration } from '../../lib/time.ts';
import { dateTimeText } from '../locale.ts';

interface Attempt {
  at: number;
  action: string;
  ok: boolean;
  detail: string;
}

const PLAN_LABEL: Record<RepairPlan['kind'], MessageKey> = {
  'restart-agent': 'windows.errors.plan.restartAgent',
  'retry-task': 'windows.errors.plan.retryTask',
  'probe-engines': 'windows.errors.plan.probeEngines',
  'verify-core': 'windows.errors.plan.verifyCore',
  fixed: 'windows.errors.plan.fixed'
};

export function ErrorsPane({ ready, core, agents }: { ready: boolean; core: CoreStateSnapshot | null; agents: AgentView[] | null }) {
  const t = useT();
  const lang = useLanguage();
  const [events, setEvents] = useState<VisioneEvent[]>([]);
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Elenco reale: lettura dal journal (gravità ≥ error) + eventi nuovi mentre il pannello è aperto.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void window.visione.events.list({ minSeverity: 'error', limit: 120 }).then((res) => {
      if (!alive) return;
      if (res.ok) setEvents(res.data.events);
      else setError(`${res.error.code}: ${res.error.message}`);
    });
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.severity !== 'error' && e.severity !== 'critical') return;
      setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e].slice(-300)));
    });
    return () => {
      alive = false;
      off();
    };
  }, [ready]);

  const entries = useMemo(
    () => mergeErrorEntries(
      events.map((e) => errorEntryIn(e, lang)).filter((e): e is ErrorEntry => e !== null),
      (agents ?? []).map((a) => instanceErrorEntryIn(a, lang)).filter((e): e is ErrorEntry => e !== null)
    ),
    [events, agents, lang]
  );

  /** Esegue il piano di riparazione REALE e registra l'esito restituito dal core. */
  const run = async (entry: ErrorEntry): Promise<void> => {
    const plan = repairFor(entry, lang);
    if (plan.kind === 'fixed') return;
    setBusy(entry.id);
    setError(null);
    const action = t(PLAN_LABEL[plan.kind]);
    let attempt: Attempt = { at: Date.now(), action, ok: false, detail: t('windows.errors.noOutcome') };
    try {
      if (plan.kind === 'restart-agent') {
        const res = await window.visione.agents.start(plan.agentId);
        attempt = res.ok
          ? res.data.started
            ? { at: Date.now(), action, ok: true, detail: t('windows.errors.sessionStarted', { status: res.data.status ?? t('windows.errors.statusStart') }) }
            : { at: Date.now(), action, ok: false, detail: t('windows.errors.notStarted', { reason: res.data.reason ?? t('windows.errors.reasonUndeclared') }) }
          : { at: Date.now(), action, ok: false, detail: `${res.error.code}: ${res.error.message}` };
      } else if (plan.kind === 'retry-task') {
        const list = await window.visione.tasks.list({ status: ['failed', 'timed_out'], limit: 100 });
        if (!list.ok) {
          attempt = { at: Date.now(), action, ok: false, detail: `${list.error.code}: ${list.error.message}` };
        } else {
          const task = pickRetryTask(list.data.tasks, plan.agentId);
          if (task === null) {
            // Nessun task da rilanciare: si avvia comunque la sessione reale dell'agente, se c'è.
            if (plan.agentId === null) {
              attempt = { at: Date.now(), action, ok: false, detail: t('windows.errors.noFailedNoAgent') };
            } else {
              const start = await window.visione.agents.start(plan.agentId);
              attempt = start.ok
                ? { at: Date.now(), action, ok: start.data.started, detail: start.data.started ? t('windows.errors.noFailedStarted') : t('windows.errors.noFailedNotStarted', { reason: start.data.reason ?? t('windows.errors.reasonUndeclared') }) }
                : { at: Date.now(), action, ok: false, detail: `${start.error.code}: ${start.error.message}` };
            }
          } else {
            const got = await window.visione.tasks.get(task.id);
            if (!got.ok || got.data.task.spec.trim() === '') {
              attempt = { at: Date.now(), action, ok: false, detail: got.ok ? t('windows.errors.noSpec') : `${got.error.code}: ${got.error.message}` };
            } else {
              const submit = await window.visione.director.submit({ goal: got.data.task.spec.slice(0, 20_000), title: t('windows.errors.retriedTitle', { title: task.title }).slice(0, 200) });
              attempt = submit.ok
                ? { at: Date.now(), action, ok: true, detail: t('windows.errors.newGoal', { id: submit.data.rootTaskId, planner: submit.data.planner, task: task.id }) }
                : { at: Date.now(), action, ok: false, detail: `${submit.error.code}: ${submit.error.message}` };
            }
          }
        }
      } else if (plan.kind === 'probe-engines') {
        const res = await window.visione.engines.probe(true);
        attempt = res.ok
          ? {
              at: Date.now(), action, ok: res.data.engines.some((e) => e.available),
              detail: res.data.engines.map((e) => `${e.adapter}:${e.available ? 'ok' : t('windows.errors.engineUnavailable')}`).join(', ') || t('windows.errors.noEngines')
            }
          : { at: Date.now(), action, ok: false, detail: `${res.error.code}: ${res.error.message}` };
      } else {
        // verify-core: si controlla che il core sia davvero vivo adesso (ping reale).
        const res = await window.visione.system.ping('centro-errori');
        attempt = res.ok
          ? { at: Date.now(), action, ok: true, detail: t('windows.errors.coreAlive', { ping: res.data.pong ? 'ok' : '?', pid: res.data.pid, uptime: formatDuration(res.data.uptimeMs, lang) }) }
          : { at: Date.now(), action, ok: false, detail: `${res.error.code}: ${res.error.message}` };
      }
    } catch (err) {
      attempt = { at: Date.now(), action, ok: false, detail: t('windows.errors.notRun', { message: err instanceof Error ? err.message : String(err) }) };
    } finally {
      setBusy(null);
      setAttempts((prev) => ({ ...prev, [entry.id]: attempt }));
    }
  };

  return (
    <div className="pane errors-pane" data-testid="errors-pane">
      <p className="muted small" data-testid="errors-summary">
        {core ? t('windows.errors.summary', { n: core.error.count }) : t('windows.errors.summaryUnavailable')} · {t('windows.errors.summaryRows', { n: entries.length })}
      </p>
      {entries.length === 0 ? (
        <p className="muted small" data-testid="errors-empty">{t('windows.errors.empty')}</p>
      ) : (
        <ul className="rows errors-list" data-testid="errors-list">
          {entries.map((e) => {
            const plan = repairFor(e, lang);
            const attempt = attempts[e.id];
            return (
              <li key={e.id} data-testid={`error-${e.id}`}>
                <span className="bad mono small">{e.severity}</span>
                <span className="type">{e.code}</span>
                <span className="small errors-messaggio">{e.message}</span>
                <span className="muted small">{dateTimeText(e.at, lang)} · {e.entity} · {e.eventType}</span>
                {plan.kind === 'fixed' ? (
                  <span className="small errors-fisso"><strong className="bad">{t('windows.errors.fixedLabel')}</strong> — {plan.reason}</span>
                ) : (
                  <button
                    type="button"
                    className="small"
                    data-testid={`error-fix-${e.id}`}
                    disabled={!ready || busy === e.id}
                    title={t('windows.errors.fixTitle', { label: t(PLAN_LABEL[plan.kind]) })}
                    onClick={() => void run(e)}
                  >{busy === e.id ? t('windows.errors.trying') : t('windows.errors.resolve')}</button>
                )}
                {attempt && (
                  <span className={`small ${attempt.ok ? 'ok' : 'error'}`} data-testid={`error-attempt-${e.id}`}>
                    {t('windows.errors.attempt', { action: attempt.action, result: attempt.ok ? t('windows.errors.succeeded') : t('windows.errors.failed'), detail: attempt.detail })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
