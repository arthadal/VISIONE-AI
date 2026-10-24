// Finestra di un task — Fase 18. Dati reali dal core (`tasks.get`): stato, agente, dipendenze,
// risultato, errore, durata. Si rilegge a ogni transizione (`task.status.changed`), nessun polling.
import { useEffect, useMemo, useState } from 'react';
import type { CommandError, VisioneEvent, Task } from '../../../shared/contracts/index.ts';
import { useT } from '../../lib/i18n/index.ts';

function ms(v: number | null | undefined): string {
  return typeof v === 'number' ? `${v} ms` : '—';
}

export function TaskPane({ taskId, ready, events }: { taskId: string; ready: boolean; events: VisioneEvent[] }) {
  const t = useT();
  const [task, setTask] = useState<Task | null>(null);
  const [children, setChildren] = useState<Task[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  const clock = useMemo(() => events.filter((e) => {
    const p = e.payload as { taskId?: string; rootId?: string };
    return e.type.startsWith('task.') && (p.taskId === taskId || p.rootId === taskId);
  }).length, [events, taskId]);
  useEffect(() => {
    if (!ready) return;
    void window.visione.tasks.get(taskId).then((res) => {
      if (res.ok) {
        setTask(res.data.task);
        setChildren(res.data.children);
        setError(null);
      } else setError(res.error);
    });
  }, [ready, taskId, clock]);

  const cancel = (): void => {
    void window.visione.tasks.cancel(taskId, t('windows.task.cancelReason')).then((res) => setError(res.ok ? null : res.error));
  };
  const duration = task?.startedAt != null && task?.endedAt != null ? task.endedAt - task.startedAt : null;

  return (
    <div className="pane task-pane" data-testid="win-task" data-task={taskId}>
      {!task && !error && <p className="muted small">{t('windows.task.loading')}</p>}
      {task && (
        <>
          <dl className="kv">
            <dt>taskId</dt><dd className="mono">{task.id}</dd>
            <dt>{t('windows.task.title')}</dt><dd className="type">{task.title}</dd>
            <dt>{t('windows.task.status')}</dt><dd className={`mono st-${task.status}`} data-testid="task-status">{task.status}</dd>
            <dt>{t('windows.task.kind')}</dt><dd className="mono">{task.kind}</dd>
            <dt>{t('windows.task.agent')}</dt><dd className="mono">{task.assigneeAgentId ?? '—'}</dd>
            <dt>root</dt><dd className="mono small">{task.rootId}</dd>
            <dt>{t('windows.task.dependencies')}</dt><dd className="mono small">{task.dependsOn.length > 0 ? task.dependsOn.join(', ') : t('windows.task.noDependencies')}</dd>
            <dt>{t('windows.task.duration')}</dt><dd className="mono">{ms(duration)}</dd>
            <dt>{t('windows.task.attempts')}</dt><dd className="mono">{task.attempts ?? 1}</dd>
          </dl>
          {task.result && <p className="small"><b>{task.result.outcome}</b>: {task.result.summary}</p>}
          {task.error && <p className="error small">{task.error.code}: {task.error.message}</p>}
          {(task.status === 'created' || task.status === 'running' || task.status === 'queued' || task.status === 'waiting') && (
            <button type="button" onClick={cancel} disabled={!ready}>{t('windows.task.cancel')}</button>
          )}
          {children.length > 0 && (
            <>
              <h4>{t('windows.task.subtasks', { n: children.length })}</h4>
              <ul className="rows" data-testid="task-children">
                {children.map((c) => (
                  <li key={c.id}>
                    <span className={`mono st-${c.status}`}>{c.status}</span>
                    <span className="type">{c.title}</span>
                    <span className="muted small">{c.assigneeAgentId ?? '—'}</span>
                    {c.result && <span className="small">{c.result.summary.slice(0, 200)}</span>}
                    {c.error && <span className="bad small">{c.error.code}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </div>
  );
}
