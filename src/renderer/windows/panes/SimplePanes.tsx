// Finestre di supporto (Fase 18): Telemetria, Log, Impostazioni, Memoria, Approvazioni, Terminale.
// Riutilizzano componenti già collegati a dati reali; ogni finestra ha un testid proprio.
import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n/index.ts';
import type { CommandResult, CoreStateSnapshot, VisioneEvent, TerminalSession } from '../../../shared/contracts/index.ts';
import { ApprovalsCard } from '../../app/Director.tsx';
import { MemoryDrawer, SettingsDrawer } from '../../app/Drawers.tsx';
import { EventsView } from '../../app/EventsView.tsx';
import type { BusTelemetry } from '../../app/Hud.tsx';
import { SystemPanel } from '../../app/HudPanels.tsx';
import type { NeuralStats } from '../../neural/NeuralView.tsx';
import { TerminalPane } from '../../app/TerminalView.tsx';

export function TelemetryPane({ core, scene, pingMs, bus, info, infoError }: {
  core: CoreStateSnapshot | null; scene: NeuralStats | null; pingMs: number | null;
  bus: BusTelemetry; info: CommandResult<'system.control.info'> | null; infoError: string | null;
}) {
  return (
    <div className="pane" data-testid="win-telemetry">
      <SystemPanel core={core} ready scene={scene} pingMs={pingMs} bus={bus} info={info} infoError={infoError} />
    </div>
  );
}

export function LogsPane({ events, ready }: { events: VisioneEvent[]; ready: boolean }) {
  return <div className="pane" data-testid="win-logs"><EventsView events={events} ready={ready} listTestId="win-logs-list" initialSeverity="debug" /></div>;
}

export function SettingsPane({ ready, reducedMotion, onReducedMotion, models = [] }: { ready: boolean; reducedMotion: boolean; onReducedMotion: (v: boolean) => void; models?: readonly string[] }) {
  return <div className="pane" data-testid="win-settings"><SettingsDrawer ready={ready} reducedMotion={reducedMotion} onReducedMotion={onReducedMotion} modelSuggestions={models} /></div>;
}

export function MemoryPane({ ready }: { ready: boolean }) {
  return <div className="pane" data-testid="win-memory"><MemoryDrawer ready={ready} /></div>;
}

export function ApprovalsPane({ core, ready }: { core: CoreStateSnapshot | null; ready: boolean }) {
  return <div className="pane" data-testid="win-approvals"><ApprovalsCard core={core} ready={ready} /></div>;
}

export function TerminalListPane({ ready }: { ready: boolean }) {
  const t = useT();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const reload = (): void => {
    void window.visione.terminal.list().then((res) => { if (res.ok) setSessions(res.data.sessions); });
  };
  useEffect(() => {
    if (!ready) return;
    reload();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      if (!/^(process\.|terminal\.)/.test(e.type)) return;
      t ??= setTimeout(() => { t = null; reload(); }, 100);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [ready]);
  const open = (): void => {
    void window.visione.terminal.open(100, 30).then((res) => { if (res.ok) { setSelected(res.data.session.processId); reload(); } });
  };
  const current = sessions.find((s) => s.processId === selected) ?? sessions.find((s) => s.endedAt === null) ?? sessions[0] ?? null;
  // Spia della testata della vista: stato reale della sessione corrente (lessico `.term-spia`).
  const tone = current === null ? 'off' : current.endedAt !== null ? 'off' : current.status === 'running' ? 'on' : current.status === 'failed' || current.status === 'crashed' ? 'error' : 'warn';
  return (
    <div className="pane terminal-pane-wrap" data-testid="win-terminal">
      <div className="term-controlli">
        <button type="button" className="term-tasto-testo term-primario" onClick={open} disabled={!ready}>{t('windows.common.newShell')}</button>
        <span className="muted small mono">{t(sessions.length === 1 ? 'windows.termlist.sessionsOne' : 'windows.termlist.sessionsOther', { n: sessions.length })}</span>
      </div>
      <ul className="term-schede">
        {sessions.map((s) => (
          <li key={s.processId}>
            <button
              type="button"
              className={`term-scheda-tasto${s.processId === current?.processId ? ' term-attiva' : ''}`}
              onClick={() => setSelected(s.processId)}
              title={`${s.title} · ${s.status}${s.owner.agentId ? ` · ${s.owner.agentId}` : ''}${s.interactive ? '' : ` · ${t('windows.common.readOnly')}`}`}
            >
              <span className={`term-spia tone-${s.endedAt !== null ? 'off' : s.status === 'running' ? 'on' : s.status === 'failed' || s.status === 'crashed' ? 'error' : 'warn'}`} aria-hidden="true" />
              <span className="term-nome">{s.owner.agentId ? `${s.owner.agentId} · ${s.title}` : s.title}</span>
              <span className={`term-stato-scheda st-${s.status}`}>{s.status}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="term-barra mono">
        <span className={tone === 'on' ? 'term-vivo' : 'term-fioco'}>■ {current === null ? t('windows.common.noSession') : current.endedAt !== null ? t('windows.termlist.ended') : current.status}{current ? ` · pty ${current.processId}` : ''}</span>
        <span className="term-fioco">{current && !current.interactive ? t('windows.common.readOnly') : current ? t('windows.termlist.inputEnabled') : ''}</span>
      </div>
      {current ? <TerminalPane session={current} /> : <p className="muted small">{t('windows.termlist.empty')}</p>}
    </div>
  );
}
