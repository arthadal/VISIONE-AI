// Livello delle finestre JARVIS (Fase 18): rende le finestre aperte sopra il Command Center e una dock
// per quelle minimizzate. Ogni finestra è indipendente; chiudere una finestra NON ferma agenti, task o
// processi (è solo lifecycle della UI). Il contenuto è scelto dal tipo di finestra. Fase G5 (P-77):
// la testata e la dock usano lo stato reale proiettato da `windows/status.ts` (spia + stato breve) e
// il vocabolario `.term-*` del JARVIS del proprietario (MIT): gettoni in basso con spia di sessione.
import { useEffect } from 'react';
import type { AgentView, CommandResult, CoreStateSnapshot, VisioneEvent } from '../../shared/contracts/index.ts';
import { useLanguage, useT, type Translate } from '../lib/i18n/index.ts';
import type { NeuralStats } from '../neural/NeuralView.tsx';
import { Reactor } from '../reactor/Reactor.tsx';
import { reactorState } from '../reactor/shader.ts';
import { VoiceVisualizer } from '../voice/VoiceVisualizer.tsx';
import type { BusTelemetry } from '../app/Hud.tsx';
import { WindowChrome } from './Window.tsx';
import { frontWindow, type WindowsAction, type WindowsState, type WindowState } from './manager.ts';
import { windowStatus, type WindowStatusContext } from './status.ts';
import { AgentPane } from './panes/AgentPane.tsx';
import { DirectorPane } from './panes/DirectorPane.tsx';
import { TaskPane } from './panes/TaskPane.tsx';
import { ApprovalsPane, LogsPane, MemoryPane, SettingsPane, TelemetryPane, TerminalListPane } from './panes/SimplePanes.tsx';
import { ErrorsPane } from './panes/ErrorsPane.tsx';
import { LauncherPane } from './panes/LauncherPane.tsx';
import { BrowserPane } from './panes/BrowserPane.tsx';
import { TrainingPane } from './panes/TrainingPane.tsx';
import { ExplorerPane } from './panes/ExplorerPane.tsx';
import { SystemPane } from './panes/SystemPane.tsx';

export interface WindowsLayerProps {
  state: WindowsState;
  dispatch: React.Dispatch<WindowsAction>;
  ready: boolean;
  core: CoreStateSnapshot | null;
  events: VisioneEvent[];
  /** Definizioni e istanze reali degli agenti (condivise dall'App, G4): stato nella testata. */
  agents: AgentView[] | null;
  scene: NeuralStats | null;
  pingMs: number | null;
  /** Telemetria condivisa (G4): la finestra non apre una seconda sottoscrizione al bus. */
  bus: BusTelemetry;
  /** Informazioni macchina condivise (G4): una lettura in App, usata anche dal pannello SISTEMA. */
  sysInfo: CommandResult<'system.control.info'> | null;
  sysInfoError: string | null;
  reducedMotion: boolean;
  onReducedMotion: (v: boolean) => void;
  voiceLevel: number;
  /** Finestre espanse a tutto viewport (tasto E o controllo della testata). */
  zoomedIds: ReadonlySet<string>;
  onToggleZoom: (win: WindowState) => void;
  /** Apre un indirizzo nel Browser di VISIONE (Addestramento: ricerca facoltativa di altre idee). */
  onOpenBrowser?: (url: string) => void;
}

function paneFor(win: WindowState, props: WindowsLayerProps, t: Translate): React.ReactNode {
  switch (win.kind) {
    case 'director':
      return <DirectorPane core={props.core} events={props.events} ready={props.ready} />;
    case 'agent':
      return win.ref ? <AgentPane agentId={win.ref} events={props.events} ready={props.ready} /> : <p className="muted small">{t('windows.layer.agentMissing')}</p>;
    case 'task':
      return win.ref ? <TaskPane taskId={win.ref} events={props.events} ready={props.ready} /> : <p className="muted small">{t('windows.layer.taskMissing')}</p>;
    case 'telemetry':
      return <TelemetryPane core={props.core} scene={props.scene} pingMs={props.pingMs} bus={props.bus} info={props.sysInfo} infoError={props.sysInfoError} />;
    case 'logs':
      return <LogsPane events={props.events} ready={props.ready} />;
    case 'errors':
      return <ErrorsPane ready={props.ready} core={props.core} agents={props.agents} />;
    case 'terminal':
      return <TerminalListPane ready={props.ready} />;
    case 'settings':
      return <SettingsPane
        ready={props.ready}
        reducedMotion={props.reducedMotion}
        onReducedMotion={props.onReducedMotion}
        models={(props.agents ?? []).map((a) => a.definition.engine.model).filter((m): m is string => typeof m === 'string')}
      />;
    case 'memory':
      return <MemoryPane ready={props.ready} />;
    case 'approvals':
      return <ApprovalsPane core={props.core} ready={props.ready} />;
    case 'apps':
      return <LauncherPane ready={props.ready} />;
    case 'files':
      // «find:<parole>» (ricerca a voce): si apre già sui risultati nelle cartelle dell'utente.
      return win.ref?.startsWith('find:')
        ? <ExplorerPane ready={props.ready} start={null} find={win.ref.slice(5)} />
        : <ExplorerPane ready={props.ready} start={win.ref ?? null} />;
    case 'system':
      return <SystemPane ready={props.ready} />;
    case 'browser':
      return <BrowserPane start={win.ref ?? null} />;
    case 'training':
      return <TrainingPane ready={props.ready} events={props.events} {...(props.onOpenBrowser ? { onOpenBrowser: props.onOpenBrowser } : {})} />;
    case 'reactor':
      return (
        <div className="pane reactor-pane" data-testid="win-reactor">
          <Reactor size={220} level={props.voiceLevel} state={reactorState(props.core)} reducedMotion={props.reducedMotion} />
          <VoiceVisualizer voice={props.core?.voice ?? null} level={props.voiceLevel} />
        </div>
      );
  }
}

export function WindowsLayer(props: WindowsLayerProps) {
  const { state, dispatch } = props;
  const t = useT();
  const lang = useLanguage();
  // Davanti sta chi è stato toccato per ultimo, fra finestre e widget liberi: prima i widget (z 320)
  // coprivano sempre le finestre, e con l'Esplora grande non si lavorava. Aprire o toccare una finestra
  // la porta sopra i widget; toccare un widget lo riporta davanti (CSS: :root[data-front]).
  useEffect(() => { if (state.top > 0) document.documentElement.dataset.front = 'windows'; }, [state.top]);
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('.jwin')) document.documentElement.dataset.front = 'windows';
      else if (t?.closest('.dock-float')) document.documentElement.dataset.front = 'widgets';
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);
  const front = frontWindow(state);
  const minimized = state.windows.filter((w) => w.minimized);
  const statusCtx: WindowStatusContext = {
    ready: props.ready,
    core: props.core,
    events: props.events,
    pingMs: props.pingMs,
    agents: props.agents,
    reducedMotion: props.reducedMotion
  };
  return (
    <div className="windows-layer" data-testid="windows-layer">
      {state.windows.filter((w) => !w.minimized).map((win) => (
        <WindowChrome
          key={win.id}
          win={win}
          focused={front?.id === win.id}
          status={windowStatus(win, statusCtx, lang)}
          maximized={props.zoomedIds.has(win.id)}
          onFocus={() => dispatch({ type: 'focus', id: win.id })}
          onClose={() => dispatch({ type: 'close', id: win.id })}
          onMinimize={() => dispatch({ type: 'minimize', id: win.id })}
          onToggleShade={() => dispatch({ type: 'toggleShade', id: win.id })}
          onMaximize={() => props.onToggleZoom(win)}
          onBounds={(bounds) => dispatch({ type: 'setBounds', id: win.id, bounds })}
        >
          {paneFor(win, props, t)}
        </WindowChrome>
      ))}
      {state.windows.length > 0 && (
        <div className="win-hint" aria-hidden="true">
          <kbd>[</kbd> <kbd>]</kbd> {t('windows.layer.hintScroll')} · <kbd>E</kbd> {t('windows.layer.hintExpand')} · <kbd>X</kbd> {t('windows.layer.hintClose')}
        </div>
      )}
      {minimized.length > 0 && (
        <div className="window-dock" data-testid="window-dock" aria-label={t('windows.layer.dockAria')}>
          {minimized.map((w) => {
            const st = windowStatus(w, statusCtx, lang);
            return (
              <button key={w.id} type="button" onClick={() => dispatch({ type: 'restore', id: w.id })} data-testid={`dock-${w.id}`} title={`${w.title} · ${st.title}`}>
                <span className={`jwin-spia tone-${st.tone}`} aria-hidden="true" />
                <span className="dock-nome">{w.title}</span>
                <span className="dock-stato mono">{st.text}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
