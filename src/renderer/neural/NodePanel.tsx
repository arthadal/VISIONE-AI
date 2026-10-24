// Pannello contestuale di un nodo della scena Neural (Fase 12.5). Mostra SOLO dati reali letti dal
// core tramite i comandi esistenti (agents.*, tasks.*) o dallo snapshot dello stato: nessun valore
// inventato. Se un dato non è disponibile lo dice esplicitamente.
import { useEffect, useState } from 'react';
import type { AgentView, CoreStateSnapshot, Task } from '../../shared/contracts/index.ts';
import { trustedAgentsOf, withTrust } from '../app/settings-meta.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { formatAgo } from '../lib/time.ts';
import type { NodeView } from './engine.ts';
import { nodeDisplayName } from './labels.ts';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="np-row">
      <span className="np-k">{k}</span>
      <span className="np-v">{children}</span>
    </div>
  );
}

export function NodePanel({ node, core, onClose, onOpenTerminal }: { node: NodeView; core: CoreStateSnapshot | null; onClose: () => void; onOpenTerminal?: (agentId: string) => void }) {
  const t = useT();
  const lang = useLanguage();
  const TRUST_HELP = t('widgets.nodePanel.trustHelp');
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  // P-102: agenti in modalità fiducia, letti dalla configurazione reale (null = non ancora letti).
  const [trusted, setTrusted] = useState<string[] | null>(null);
  // Chi comanda è sempre in fiducia (24/10/2026): interruttore acceso e bloccato.
  const [trustNote, setTrustNote] = useState<string | null>(null);

  // P-105 (collaudo 10/10/2026): Esc chiude il pannello come le altre finestre sovrapposte.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadTrust = (): void => {
    void window.visione.config.get().then((res) => {
      if (!res.ok) return;
      setTrusted(trustedAgentsOf(res.data.config));
    });
  };

  useEffect(() => {
    setAgent(null);
    setAgents(null);
    setTask(null);
    setError(null);
    setTrustNote(null);
    if (node.id.startsWith('agent:')) {
      const id = node.id.slice('agent:'.length);
      void window.visione.agents.list(true).then((res) => {
        if (res.ok) setAgent(res.data.agents.find((a) => a.definition.id === id) ?? null);
        else setError(`${res.error.code}: ${res.error.message}`);
      });
      loadTrust();
    } else if (node.id === 'director') {
      // Il Director coordina senza eseguire comandi propri: qui si governa la fiducia degli agenti.
      void window.visione.agents.list(false).then((res) => {
        if (res.ok) setAgents(res.data.agents);
        else setError(`${res.error.code}: ${res.error.message}`);
      });
      loadTrust();
    } else if (node.id.startsWith('task:')) {
      void window.visione.tasks.get(node.id.slice('task:'.length)).then((res) => {
        if (res.ok) setTask(res.data.task);
        else setError(`${res.error.code}: ${res.error.message}`);
      });
    }
  }, [node.id]);

  const toggleTrust = (agentId: string, on: boolean): void => {
    if (trusted === null) return;
    setError(null);
    void window.visione.config.update({ policy: { trustedAgents: withTrust(trusted, agentId, on) } }).then((res) => {
      if (!res.ok) {
        setError(`${res.error.code}: ${res.error.message}`);
        return;
      }
      setTrustNote(t(on ? 'widgets.nodePanel.trustOn' : 'widgets.nodePanel.trustOff', { agent: agentId }));
      loadTrust();
    });
  };

  const relative = node.lastEventAt > 0 ? formatAgo(Date.now() - node.lastEventAt, lang) : t('widgets.neural.never');

  return (
    <aside className="node-panel" data-testid="node-panel">
      <header>
        <span className="type" data-testid="node-panel-title">{nodeDisplayName(node.id, node.kind, node.label, lang)}</span>
        <span className="muted mono small">{node.kind}</span>
        <button type="button" onClick={onClose} aria-label={t('widgets.nodePanel.close')}>×</button>
      </header>
      <Row k={t('widgets.nodePanel.status')}>{node.status}</Row>
      <Row k={t('widgets.nodePanel.lastEvent')}>{relative}</Row>
      {node.id === 'director' && (
        <>
          <Row k={t('widgets.nodePanel.role')}>{t('widgets.nodePanel.coordinator')}</Row>
          <Row k={t('widgets.nodePanel.activeGoals')}>{core?.director.activeGoals ?? '—'}</Row>
          <Row k={t('widgets.nodePanel.activeTasks')}>{core?.tasks.active ?? '—'}</Row>
          <Row k={t('widgets.nodePanel.approvals')}>{core?.approvals.pending ?? '—'}</Row>
          <Row k={t('widgets.nodePanel.lastDecision')}>{core?.director.lastDecision ? `${core.director.lastDecision.decision} ${core.director.lastDecision.agentId ?? ''}` : t('widgets.nodePanel.noDecision')}</Row>
          {agents && trusted && (
            <div className="np-trust" data-testid="node-trust-list" title={TRUST_HELP}>
              <span className="np-k">{t('widgets.nodePanel.trustAgents')}</span>
              {agents.length === 0 && <span className="muted small">{t('widgets.nodePanel.noAgents')}</span>}
              {agents.map((a) => (
                <label key={a.definition.id} className="small">
                  <input
                    type="checkbox" data-testid={`node-trust-${a.definition.id}`}
                    checked disabled
                    onChange={(e) => toggleTrust(a.definition.id, e.target.checked)}
                  /> {a.definition.name}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {agent && (
        <>
          <Row k={t('widgets.nodePanel.engine')}>{agent.definition.engine.adapter}</Row>
          <Row k={t('widgets.nodePanel.competences')}>{agent.definition.competences.join(', ') || '—'}</Row>
          <Row k={t('widgets.nodePanel.instance')}>{agent.instance?.status ?? t('widgets.nodePanel.neverStarted')}</Row>
          {agent.breaker !== 'closed' && <Row k="breaker">{agent.breaker}</Row>}
          {trusted && (
            <div className="np-trust" title={TRUST_HELP}>
              <label className="small">
                <input
                  type="checkbox" data-testid="node-trust"
                  checked disabled
                  onChange={(e) => toggleTrust(agent.definition.id, e.target.checked)}
                /> {t('widgets.nodePanel.trustMode')}
              </label>
            </div>
          )}
        </>
      )}
      {node.kind === 'agent' && onOpenTerminal && (
        <button type="button" data-testid="node-terminal" onClick={() => onOpenTerminal(node.id.slice('agent:'.length))}>{t('widgets.nodePanel.terminal')}</button>
      )}
      {task && (
        <>
          <Row k={t('widgets.nodePanel.taskTitle')}>{task.title}</Row>
          <Row k={t('widgets.nodePanel.assigned')}>{task.assigneeAgentId ?? '—'}</Row>
          {task.result && <Row k={t('widgets.nodePanel.result')}>{task.result.summary.slice(0, 400)}</Row>}
          {task.error && <Row k={t('widgets.nodePanel.error')}>{task.error.code}: {task.error.message}</Row>}
        </>
      )}
      {!agent && node.kind === 'agent' && <p className="muted small">{t('widgets.nodePanel.noDetails')}</p>}
      {trustNote && <p className="muted small" data-testid="node-trust-note">{trustNote}</p>}
      {error && <p className="error small">{error}</p>}
    </aside>
  );
}
