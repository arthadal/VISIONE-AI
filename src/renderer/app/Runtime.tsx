// Vista del CLI Runtime (Fase 5): contatori dallo stato del core, processi vivi riletti a ogni
// variazione dello stato `processes` (nessun polling), stop di un processo esistente e verifica
// dei motori. La UI non avvia processi: chiede al core, che applica policy e runtime.
// P-99: il pannello MOTORI mostra tutte le info reali (nome, versione, stato, percorso, problemi,
// agenti sul motore), ri-verifica e riavvia i motori («Riavvia motori»), prova UN motore con debug
// chiaro e, se qualcosa non va, sottopone al Director un task reale di riparazione con esito vero.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentView, CommandError, CoreStateSnapshot, EngineProbe, ProcessInfo } from '../../shared/contracts/index.ts';
import { useLanguage, useT, type Translate } from '../lib/i18n/index.ts';
import { clockText } from '../windows/locale.ts';
import { engineDebugRows, engineFixGoal, fixVerdict, isPermanentErrorVerdict, restartDetail, restartSummary, withAgentProblems, type RestartOutcome } from './engines-logic.ts';

function owner(p: ProcessInfo, t: Translate): string {
  const parts = [p.owner.agentId && t('windows.runtime.ownerAgent', { id: p.owner.agentId }), p.owner.sessionId && t('windows.runtime.ownerSession', { id: p.owner.sessionId }), p.owner.taskId && `task ${p.owner.taskId}`];
  return parts.filter(Boolean).join(' · ') || p.kind;
}

export function ProcessesCard({ core, ready }: { core: CoreStateSnapshot | null; ready: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const counters = core?.processes ?? null;
  const [live, setLive] = useState<ProcessInfo[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  // Rilettura guidata dallo stato: cambia solo quando un processo nasce o finisce.
  const key = counters ? `${counters.created}:${counters.active}:${counters.last?.at ?? 0}` : '';

  useEffect(() => {
    if (!ready) return;
    let current = true;
    void window.visione.runtime.processes({ live: true }).then((res) => {
      if (!current) return;
      if (res.ok) {
        setLive(res.data.processes);
        setError(null);
      } else {
        setError(res.error);
      }
    });
    return () => {
      current = false;
    };
  }, [ready, key]);

  const stop = (id: string): void => {
    void window.visione.runtime.stop(id).then((res) => setError(res.ok ? null : res.error));
  };

  return (
    <article className="card" aria-label={t('windows.runtime.processes')}>
      <h2>{t('windows.runtime.processes')}</h2>
      <p className="state" data-testid="processes-active">{counters ? t('windows.runtime.activeN', { n: counters.active }) : '—'}</p>
      <dl>
        <dt>{t('windows.runtime.started')}</dt><dd className="mono" data-testid="processes-created">{counters?.created ?? '—'}</dd>
        <dt>{t('windows.runtime.failed')}</dt><dd className="mono" data-testid="processes-failed">{counters?.failed ?? '—'}</dd>
        <dt>{t('windows.runtime.last')}</dt>
        <dd className="mono" data-testid="processes-last">
          {counters?.last ? `${counters.last.status} · ${clockText(counters.last.at, lang)}` : t('windows.common.none')}
        </dd>
      </dl>
      {live.length > 0 && (
        <ul className="rows" data-testid="processes-live">
          {live.map((p) => (
            <li key={p.id}>
              <span className="mono">{p.pid ?? '—'}</span>
              <span className={`mono proc-${p.status}`}>{p.status}</span>
              <span className="muted small">{owner(p, t)}</span>
              <button type="button" onClick={() => stop(p.id)} disabled={!ready || p.status === 'stopping'}>{t('windows.runtime.stop')}</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </article>
  );
}

export function EnginesCard({ ready, agents = null }: { ready: boolean; /** Rubrica reale (P-99): mostra quali agenti usano ogni motore, senza inventare. */ agents?: AgentView[] | null }) {
  const t = useT();
  const lang = useLanguage();
  const [engines, setEngines] = useState<EngineProbe[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const [probeAt, setProbeAt] = useState<number | null>(null);
  // P-99 — «Riavvia motori»: esito reale (probe + riavvio sessioni in errore) con dettagli.
  const [restartBusy, setRestartBusy] = useState(false);
  const [restart, setRestart] = useState<RestartOutcome | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  // P-99 — test di UN motore con debug e riparazione via Director.
  const [selected, setSelected] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [tested, setTested] = useState<{ probe: EngineProbe; at: number } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [fix, setFix] = useState<{ taskId: string; status: string; summary: string | null; errorCode: string | null; errorMessage: string | null } | null>(null);
  const [fixVerdictText, setFixVerdictText] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pollRef.current !== null) clearTimeout(pollRef.current);
  }, []);

  const probe = (): void => {
    setBusy(true);
    void window.visione.engines.probe(true).then((res) => {
      setBusy(false);
      if (res.ok) {
        setEngines(res.data.engines);
        setProbeAt(Date.now());
        setError(null);
      } else {
        setError(res.error);
      }
    });
  };

  // Opzioni del menu: i motori verificati più quelli usati dagli agenti reali (anche prima del probe).
  const adapterIds = useMemo(() => {
    const ids = new Set<string>((engines ?? []).map((e) => e.adapter));
    for (const a of agents ?? []) ids.add(a.definition.engine.adapter);
    return [...ids].sort();
  }, [engines, agents]);
  useEffect(() => {
    if (selected === '' && adapterIds.length > 0) setSelected(adapterIds[0] as string);
  }, [adapterIds, selected]);

  /** Confronta la verifica fresca con l'elenco mostrato (una sola fonte per pannello e debug). */
  const mergeProbe = (p: EngineProbe): void => {
    setTested({ probe: p, at: Date.now() });
    setEngines((prev) => {
      const others = (prev ?? []).filter((e) => e.adapter !== p.adapter);
      return [...others, p].sort((a, b) => a.adapter.localeCompare(b.adapter));
    });
  };

  const testOne = (): void => {
    if (selected === '') return;
    setTestBusy(true);
    setTestError(null);
    void window.visione.engines.probe(true, selected).then((res) => {
      setTestBusy(false);
      if (!res.ok) {
        setTestError(`${res.error.code}: ${res.error.message}`);
        setTested(null);
        return;
      }
      const fresh = res.data.engines[0] ?? null;
      if (fresh === null) {
        setTestError(t('windows.runtime.noResultFor', { id: selected }));
        setTested(null);
        return;
      }
      mergeProbe(fresh);
    });
  };

  const restartAll = (): void => {
    setRestartBusy(true);
    setRestartError(null);
    setRestart(null);
    void window.visione.engines.restart().then((res) => {
      setRestartBusy(false);
      if (!res.ok) {
        setRestartError(`${res.error.code}: ${res.error.message}`);
        return;
      }
      setRestart(res.data);
      if (res.data.probes.length > 0) {
        setEngines(res.data.probes);
        setProbeAt(Date.now());
      }
    });
  };

  /**
   * «Fai sistemare al Director»: sottopone un task vero di riparazione e ne segue l'esito reale.
   * Alla fine ri-verifica DAVVERO il motore (probe + agenti freschi): nessun «risolto» senza prova.
   */
  const fixEngine = (): void => {
    const target = tested === null ? null : withAgentProblems(tested.probe, agents ?? [], lang);
    if (!target) return;
    setFixBusy(true);
    setFixError(null);
    setFix(null);
    setFixVerdictText(null);
    void window.visione.director.submit({ goal: engineFixGoal(target, lang), title: t('windows.runtime.fixGoalTitle', { adapter: target.adapter }) }).then((res) => {
      if (!res.ok) {
        setFixBusy(false);
        setFixError(`${res.error.code}: ${res.error.message}`);
        setFixVerdictText(fixVerdict({ taskStatus: 'failed', errorCode: res.error.code, errorMessage: res.error.message, probeAfter: null }, lang));
        return;
      }
      const taskId = res.data.rootTaskId;
      const finish = (status: string, summary: string | null, errorCode: string | null, errorMessage: string | null): void => {
        // Verifica fresca: probe reale + rubrica riletta (gli agenti in errore sono un problema vero).
        void window.visione.engines.probe(true, target.adapter).then(async (after) => {
          const rawFresh = after.ok ? after.data.engines[0] ?? null : null;
          const list = await window.visione.agents.list(false);
          const freshAgents = list.ok ? list.data.agents : (agents ?? []);
          const fresh = rawFresh === null ? null : withAgentProblems(rawFresh, freshAgents, lang);
          setFix({ taskId, status, summary, errorCode, errorMessage });
          setFixVerdictText(fixVerdict({ taskStatus: status, summary, errorCode, errorMessage, probeAfter: fresh }, lang));
          if (rawFresh !== null) mergeProbe(rawFresh);
          setFixBusy(false);
        });
      };
      const poll = (attempt: number): void => {
        void window.visione.tasks.get(taskId).then((got) => {
          const task = got.ok ? got.data.task : null;
          const terminal = task !== null && ['succeeded', 'failed', 'cancelled', 'waiting'].includes(task.status);
          if (terminal && task !== null) {
            finish(task.status, task.result?.summary ?? null, task.error?.code ?? null, task.error?.message ?? null);
            return;
          }
          if (attempt >= 30) {
            // ~90 s: onesto — il task è ancora in corso, nessun esito dichiarato.
            finish(task?.status ?? 'in corso', null, null, null);
            return;
          }
          pollRef.current = setTimeout(() => poll(attempt + 1), 3_000);
        });
      };
      poll(0);
    });
  };

  const liveAgents = (agents ?? []).filter((a) => a.instance !== null && a.instance !== undefined && !['stopped', 'crashed'].includes(a.instance.status));
  // P-99: «fixabile» anche quando la verifica risponde ma gli agenti di quel motore sono in errore.
  const testedFull = tested === null ? null : withAgentProblems(tested.probe, agents ?? [], lang);
  const fixable = testedFull !== null && (!testedFull.available || testedFull.problems.length > 0);

  return (
    <article className="card" aria-label={t('windows.runtime.engines')}>
      <h2>{t('windows.runtime.engines')}</h2>
      {engines === null ? (
        <p className="muted" data-testid="engines-state">{busy ? t('windows.runtime.checking') : t('windows.runtime.notChecked')}</p>
      ) : (
        <ul className="rows" data-testid="engines">
          {engines.map((e) => {
            const users = (agents ?? []).filter((a) => a.definition.engine.adapter === e.adapter);
            return (
              <li key={e.adapter} data-testid={`engine-${e.adapter}`}>
                <span className="type">{e.adapter}</span>
                <span className={e.available ? 'ok' : 'bad'}>{e.available ? t('windows.runtime.available') : t('windows.runtime.unavailable')}</span>
                <span className="mono small">{e.version ?? '—'}</span>
                <span className="muted small" title={e.path ?? undefined}>{e.path ?? t('windows.runtime.pathNA')}</span>
                {e.problems.length > 0 && <span className="muted small">{e.problems.join('; ')}</span>}
                <span className="muted small mono" data-testid={`engine-last-${e.adapter}`}>
                  {t('windows.runtime.lastResult', { result: e.available ? t('windows.runtime.resultOk') : t('windows.runtime.resultKo') })}{probeAt !== null ? ` · ${clockText(probeAt, lang)}` : ''}
                </span>
                <span className="muted small" data-testid={`engine-agents-${e.adapter}`}>
                  {users.length === 0 ? t('windows.runtime.noAgents') : users.map((u) => `${u.definition.name} (${u.instance?.status ?? t('windows.common.neverStarted')})`).join(' · ')}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small" data-testid="engines-live">
        {t('windows.runtime.liveAgents', { value: agents === null ? t('windows.common.na') : `${liveAgents.length}/${agents.length}` })}
        {agents !== null && liveAgents.length > 0 ? ` · ${liveAgents.map((a) => `${a.definition.id}:${a.instance?.status ?? '—'}`).join(', ')}` : ''}
      </p>
      <div className="actions">
        <button type="button" onClick={probe} disabled={!ready || busy}>{t('windows.runtime.verify')}</button>
        <button type="button" onClick={restartAll} disabled={!ready || restartBusy} data-testid="engines-restart" title={t('windows.runtime.restartTitle')}>
          {restartBusy ? t('windows.runtime.restarting') : t('windows.runtime.restart')}
        </button>
      </div>
      {restart && (
        <p className="muted small" data-testid="engines-restart-outcome">
          <span className="mono">↻</span> {restartSummary(restart, lang)} — {restartDetail(restart, lang)}
        </p>
      )}
      {restartError && <p className="error small" data-testid="engines-restart-error">{restartError}</p>}

      <div className="engines-test">
        <p className="hp-group-title">{t('windows.runtime.testTitle')}</p>
        <div className="form">
          <select
            aria-label={t('windows.runtime.testAria')} data-testid="engine-test-select" value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {adapterIds.length === 0 && <option value="">{t('windows.runtime.checkFirst')}</option>}
            {adapterIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <button type="button" onClick={testOne} disabled={!ready || testBusy || selected === ''} data-testid="engine-test-run">
            {testBusy ? t('windows.runtime.testing') : t('windows.runtime.test')}
          </button>
          <button
            type="button" onClick={fixEngine} disabled={!ready || fixBusy || !fixable} data-testid="engine-test-fix"
            title={fixable ? t('windows.runtime.fixTitleOn') : t('windows.runtime.fixTitleOff')}
          >
            {fixBusy ? t('windows.runtime.fixing') : t('windows.runtime.fix')}
          </button>
        </div>
        {testedFull && (
          <ul className="rows engines-debug" data-testid="engine-test-debug">
            {engineDebugRows(testedFull, lang).map((r) => (
              <li key={r.k}>
                <span className="k muted small">{r.k}</span>
                <span className="v mono small">{r.v}</span>
              </li>
            ))}
            <li><span className="k muted small">{t('windows.runtime.verifiedAt')}</span><span className="v mono small">{clockText(tested?.at ?? Date.now(), lang)}</span></li>
          </ul>
        )}
        {testError && <p className="error small" data-testid="engine-test-error">{testError}</p>}
        {fix && (
          <p className="muted small" data-testid="engine-fix-outcome">
            task {fix.taskId} · {fix.status}
            {fix.summary ? ` · ${fix.summary}` : ''}
            {fix.errorCode ? ` · ${fix.errorCode}: ${fix.errorMessage ?? ''}` : ''}
          </p>
        )}
        {fixVerdictText && (
          <p className={`small ${isPermanentErrorVerdict(fixVerdictText) ? 'error' : 'engines-ok'}`} data-testid="engine-fix-verdict">{fixVerdictText}</p>
        )}
        {fixError && <p className="error small" data-testid="engine-fix-error">{fixError}</p>}
      </div>
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </article>
  );
}
