// Command center JARVIS (Fase 8, portato al livello Fase 18): barra superiore con reactor, pannelli
// laterali riducibili, Neural/Tasks/Director/Chat al centro, Events/Terminal in basso, HUD telemetria,
// e un **Window Manager** con finestre trascinabili (Director, agenti, task, telemetria, log,
// terminale, impostazioni, memoria, approvazioni, reactor). Ogni valore viene dal core, dal
// supervisore o dagli eventi; dove manca un dato si mostra "—". Niente stato finto.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { AgentView, CommandResult, CoreStateSnapshot, Language } from '../../shared/contracts/index.ts';
import { effectiveLanguage, LanguageContext, translate, useLanguage, useT, type MessageKey } from '../lib/i18n/index.ts';
import { ExpertContext, expertOf, lightOf, windowVisible } from '../lib/mode.ts';
import { softwareRenderer, webglRendererName } from '../lib/gpu.ts';
import { Guide } from './Guide.tsx';
import { guideSeenOf, shouldAutoShow } from './guide-logic.ts';
import { LegalDialog } from './LegalDialog.tsx';
import { ReportDialog } from './ReportDialog.tsx';
import { NeuralView, type NeuralStats } from '../neural/NeuralView.tsx';
import { reactorState } from '../reactor/shader.ts';
import { connection, coreStateIsLive, lastEvent } from '../state/projection.ts';
import { useVisione } from '../state/useVisione.ts';
import { useVoiceLevel } from '../voice/VoiceVisualizer.tsx';
import { clampBounds, EMPTY_WINDOWS, frontWindow, reduceWindows, type WindowBounds, type WindowKind, type WindowState } from '../windows/manager.ts';
import { wakeEventOf, wakePlan } from '../windows/wake.ts';
import { resolveVoiceCommand, type VoiceCommandPayload } from '../voice/commands.ts';
import { Boot } from './Boot.tsx';
import { bootComplete } from './boot.ts';
import { Notifications } from './Notifications.tsx';
import { WindowsLayer } from '../windows/WindowsLayer.tsx';
import { CommandBar } from './CommandBar.tsx';
import { DockBoard, PanelMax } from './Dock.tsx';
import { columnInUse, everythingOn, groupTitle, isWidget, keepShownTemporary, loadDock, onlyEssentials, PANEL_GROUPS, panelTitle, resetDock, saveDock, showPanel, togglePanel, withShown, type DockState, type PanelId } from './panels.ts';
import { useScreenPrefs, type ScreenPrefs } from './screen-prefs.ts';
import { SideTabs } from './SideTabs.tsx';
import { useHumanoidPrefs } from './widgets/humanoid-prefs.ts';
import { ClockWidget, GraphsWidget, syncWeatherCity, useSystemSeries, WeatherWidget } from './widgets/Widgets.tsx';
import { HumanoidWidget } from './widgets/Humanoid.tsx';
import { CalendarWidget, NotesWidget, RepliesWidget } from './widgets/MoreWidgets.tsx';
import { AgendaWidget } from './widgets/Agenda.tsx';
import { StartMenu } from './StartMenu.tsx';
import { ASSEMBLY_TOTAL_S } from './widgets/humanoid-logic.ts';
import { Effects } from './Effects.tsx';
import { ChatView } from './Chat.tsx';
import { AgentsCard, ApprovalsCard, DirectorView, TasksView } from './Director.tsx';
import { MemoryDrawer, SettingsDrawer } from './Drawers.tsx';
import { SetupWizard } from './SetupWizard.tsx';
import { SETUP_VERSION } from './setup-logic.ts';
import { nodeLingerOf, voiceVolumeOf } from './settings-meta.ts';
import { voiceAudio } from '../voice/audio.ts';
import { busyOf, changeKind, IDLE_RESTART_COUNTDOWN_S } from './restart-logic.ts';
import { RestartPrompt, RestartWaitBar } from './RestartPrompt.tsx';
import { ExpertConfirm } from './ExpertConfirm.tsx';
import { OfflineAlert, OfflineLamp, OfflineReplies, useOfflineSync } from './OfflineControls.tsx';
import { restartVoice } from './voice-restart.ts';
import { sceneOf, type SceneVariant } from '../neural/renderer3d.ts';
import { EventsView } from './EventsView.tsx';
import { useBusTelemetry } from './Hud.tsx';
import { agentActivity, agentStateLabel } from './hud-metrics.ts';
import { DirectorPanel, HudDeco, HudPanel, SystemPanel, TasksEventsPanel, VoicePanel } from './HudPanels.tsx';
import { Palette, type PaletteAction } from './Palette.tsx';
import { EnginesCard, ProcessesCard } from './Runtime.tsx';
import { TerminalView } from './TerminalView.tsx';

const CONNECTION_KEY: Record<ReturnType<typeof connection>, MessageKey> = {
  connected: 'shell.app.connected', connecting: 'shell.app.connecting', disconnected: 'shell.app.disconnected'
};

function time(ts: number, lang: Language): string {
  return new Date(ts).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'it-IT', { hour12: false });
}

function LastEvent({ core, fallback }: { core: CoreStateSnapshot | null; fallback: ReturnType<typeof lastEvent> }) {
  const t = useT();
  const lang = useLanguage();
  // Fonte primaria: lo stato del core; in sua assenza l'ultimo evento ricevuto dalla UI.
  const last = core?.events.last ?? fallback;
  if (!last) return <p className="muted">{t('shell.app.none')}</p>;
  return (
    <>
      <p className="type" data-testid="last-event">{last.type}</p>
      <dl>
        <dt>seq</dt><dd className="mono">{last.seq ?? t('shell.app.ephemeral')}</dd>
        <dt>{t('shell.app.lastTime')}</dt><dd className="mono">{time(last.ts, lang)}</dd>
        <dt>{t('shell.app.lastSource')}</dt><dd className="mono">{last.source.kind}:{last.source.id}</dd>
        <dt>{t('shell.app.lastSeverity')}</dt><dd className="mono">{last.severity}</dd>
        <dt>{t('shell.app.lastCorrelation')}</dt><dd className="mono small">{last.correlationId}</dd>
      </dl>
    </>
  );
}

const MOTION_KEY = 'visione.reducedMotion';
function initialReducedMotion(): boolean {
  try {
    const stored = localStorage.getItem(MOTION_KEY);
    if (stored !== null) return stored === 'true';
  } catch {
    // archivio locale non disponibile
  }
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** P-99: nome mostrato del Director dalla configurazione reale (`ui.directorName`). */
function directorNameOf(config: Record<string, unknown>): string {
  const ui = config.ui;
  if (ui !== null && typeof ui === 'object' && !Array.isArray(ui)) {
    const name = (ui as Record<string, unknown>).directorName;
    if (typeof name === 'string' && name.trim() !== '') return name.trim().slice(0, 80);
  }
  return 'Director';
}

const WINDOW_TITLES: Record<WindowKind, { title: MessageKey; subtitle: MessageKey | null }> = {
  director: { title: 'shell.win.director', subtitle: 'shell.win.sub.director' },
  agent: { title: 'shell.win.agent', subtitle: 'shell.win.sub.agent' },
  task: { title: 'shell.win.task', subtitle: null },
  telemetry: { title: 'shell.win.telemetry', subtitle: 'shell.win.sub.telemetry' },
  logs: { title: 'shell.win.logs', subtitle: 'shell.win.sub.logs' },
  terminal: { title: 'shell.win.terminal', subtitle: 'shell.win.sub.terminal' },
  settings: { title: 'shell.win.settings', subtitle: 'shell.win.sub.settings' },
  memory: { title: 'shell.win.memory', subtitle: 'shell.win.sub.memory' },
  approvals: { title: 'shell.win.approvals', subtitle: 'shell.win.sub.approvals' },
  reactor: { title: 'shell.win.reactor', subtitle: 'shell.win.sub.reactor' },
  apps: { title: 'shell.win.apps', subtitle: 'shell.win.sub.apps' },
  files: { title: 'shell.win.files', subtitle: 'shell.win.sub.files' },
  system: { title: 'shell.win.system', subtitle: 'shell.win.sub.system' },
  errors: { title: 'shell.win.errors', subtitle: 'shell.win.sub.errors' },
  browser: { title: 'shell.win.browser', subtitle: 'shell.win.sub.browser' },
  training: { title: 'shell.win.training', subtitle: 'shell.win.sub.training' }
};

/** Titolo e sottotitolo di default di una finestra, nella lingua indicata. */
function windowTitleOf(kind: WindowKind, lang: Language): { title: string; subtitle: string | null } {
  const meta = WINDOW_TITLES[kind];
  return { title: translate(lang, meta.title), subtitle: meta.subtitle === null ? null : translate(lang, meta.subtitle) };
}

/** Le finestre del menu «Finestre», nell'ordine mostrato (le etichette sono i titoli delle finestre). */
const WINDOW_BUTTONS: readonly WindowKind[] = ['director', 'apps', 'files', 'browser', 'system', 'telemetry', 'logs', 'errors', 'terminal', 'approvals', 'memory', 'training'];

export function App() {
  const { state, ping, refresh } = useVisione();
  const sup = state.supervisor;
  const core = state.core;
  const live = coreStateIsLive(state);
  const conn = connection(state);
  const ready = sup?.state === 'ready';
  // Modalità offline (17/10/2026): stato dal core, letto da spia, barra comandi, Chat e Director.
  useOfflineSync(ready);
  const [center, setCenter] = useState<'neural' | 'tasks' | 'director'>('neural');
  const [bottom, setBottom] = useState<'events' | 'logs' | 'terminal'>('events');
  const [drawer, setDrawer] = useState<'memory' | 'settings' | null>(null);
  const [terminalAgent, setTerminalAgent] = useState<string | null>(null);
  // Schermo pulito (11/10/2026): barra in basso, striscia agenti e linguette laterali a scelta.
  const [screen, setScreen] = useScreenPrefs();
  const [palette, setPalette] = useState(false);
  const [scene, setScene] = useState<NeuralStats | null>(null);
  // P-89: variante della scena Neural (`ui.scene`), letta alla disponibilità del core e applicata
  // dal renderer a caldo (toggle in Impostazioni → `onSceneChange`). Default `jarvis`.
  const [sceneVariant, setSceneVariant] = useState<SceneVariant>('jarvis');
  // P-99: nome mostrato del Director (`ui.directorName`), applicato a caldo alla scena.
  const [directorName, setDirectorName] = useState('Director');
  // Durata a schermo dei nodi conclusi (`ui.nodeLingerSec`), applicata subito alla scena.
  const [nodeLingerSec, setNodeLingerSec] = useState(30);
  // Impostazioni che valgono dal riavvio (11/10/2026): finestra di richiesta, attesa della fine del
  // lavoro del Director e degli agenti, preavviso annullabile. `changed` accumula le chiavi.
  const [restart, setRestart] = useState<{ phase: 'ask' | 'wait' | 'later'; changed: string[]; countdown: number | null } | null>(null);
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  const [winMenu, setWinMenu] = useState(false);
  // P-96: pannelli del dock gestibili (chiudi/riapri, tendina, sposta, tutto schermo). Lo stato del
  // layout (ordine, chiusi, ridotti) vive in `localStorage` e sopravvive al riavvio del renderer.
  const [dock, setDock] = useState<DockState>(() => loadDock());
  // Chat come pannello del dock (24/10/2026): il tasto «Chat» la porta sullo schermo o la chiude.
  const chatShown = !dock.hidden.includes('chat') && !dock.collapsed.includes('chat');
  // Portato sullo schermo da un tasto: sta davanti anche alle finestre aperte (CSS :root[data-front]).
  const bringOnScreen = (d: DockState, id: PanelId): DockState => {
    document.documentElement.dataset.front = 'widgets';
    return showPanel(d, id, window.innerWidth, window.innerHeight);
  };
  const toggleChat = (): void => setDock((d) => (!d.hidden.includes('chat') && !d.collapsed.includes('chat')
    ? togglePanel(d, 'chat', window.innerWidth, window.innerHeight)
    : bringOnScreen(d, 'chat')));
  const [maximized, setMaximized] = useState<PanelId | null>(null);
  const [widgetMenu, setWidgetMenu] = useState(false);
  // P-87: all'apertura la composizione è quella della reference (Munder → pannello JARVIS): la barra
  // inferiore parte piegata e resta a un passo (il pulsante ▸); si espande quando serve davvero.
  const [bottomShade, setBottomShade] = useState(true);
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceLevel = useVoiceLevel();
  // Fase G1: una sola sottoscrizione alla telemetria del bus, condivisa da HUD e pannello VOCE.
  const bus = useBusTelemetry();
  // P-96: il layout del dock è una preferenza del proprietario: si salva a ogni cambio.
  useEffect(() => {
    saveDock(dock);
  }, [dock]);

  // --- Window Manager (Fase 18) ---------------------------------------------------------------
  const [wins, dispatchWin] = useReducer(reduceWindows, EMPTY_WINDOWS);
  // La lingua corrente per i titoli di default: letta al momento dell'apertura, senza rifare la funzione.
  const languageRef = useRef<Language>('it');
  const openKind = useCallback((kind: WindowKind, ref: string | null = null, title?: string, subtitle?: string | null) => {
    const meta = windowTitleOf(kind, languageRef.current);
    const t = title ?? (kind === 'agent' ? ref ?? meta.title : kind === 'task' ? (ref ?? meta.title).slice(-8) : meta.title);
    dispatchWin({ type: 'open', kind, ref, title: t, subtitle: subtitle ?? meta.subtitle, vw: window.innerWidth, vh: window.innerHeight });
    setWinMenu(false);
  }, []);
  const closeAllWindows = useCallback(() => dispatchWin({ type: 'closeAll' }), []);

  // --- Dati agenti condivisi (Fase G4, P-76) ---------------------------------------------------
  // Una sola lettura di `agents.list` per tutta la UI (pannello AGENTI, gettoni in topbar, comandi
  // vocali): si rilegge quando il riepilogo reale del core cambia, mai con un polling.
  const [agentViews, setAgentViews] = useState<AgentView[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  // P-99: una rinomina (o qualunque modifica di definizione) deve rileggere la rubrica SUBITO:
  // la chiave include l'ultimo evento `agent.definition.*` e un contatore per il salvataggio locale.
  const [defsRevision, setDefsRevision] = useState(0);
  // P-105: procedura guidata; si apre da sola nell'edizione installata finché non è completata.
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupDone, setSetupDone] = useState<number | null>(null);
  // Lingua (distribuzione mondiale, 10/10/2026): `ui.language` o quella del sistema; vale subito.
  const [language, setLanguage] = useState<Language>(() => effectiveLanguage(undefined, navigator.language));
  // Modalità semplice / esperto (`ui.expert`): vale subito, anche nel CSS (`<html data-expert>`).
  const [expert, setExpert] = useState(false);
  // Modalità leggera (`ui.light`, punto 7): scena e Umanoide consumano meno, webcam spenta. Vale subito.
  const [light, setLight] = useState(false);
  // Grafica via software (PC vergine in VM, 18/10/2026): la scena va leggera da sola, o occupa un core intero.
  const softwareGpu = useMemo(() => softwareRenderer(webglRendererName()), []);
  useEffect(() => {
    if (softwareGpu) console.warn(`grafica senza accelerazione (${webglRendererName() ?? '?'}): scena in modalità leggera`);
  }, [softwareGpu]);
  const sceneLight = light || softwareGpu;
  const [reportOpen, setReportOpen] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  // Guida al primo avvio: `null` finché la configurazione non è letta.
  const [guideSeen, setGuideSeen] = useState<boolean | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const closeGuide = useCallback((): void => {
    setGuideOpen(false);
    setGuideSeen(true);
    void window.visione.config.update({ ui: { guideSeen: true } });
  }, []);
  useEffect(() => { document.documentElement.dataset.expert = expert ? 'true' : 'false'; }, [expert]);
  const applyExpert = useCallback((on: boolean) => {
    void window.visione.config.update({ ui: { expert: on } }).then((res) => { if (res.ok) setExpert(on); });
  }, []);
  // Accenderla chiede conferma (17/10/2026, `ExpertConfirm`); spegnerla no.
  const [expertAsk, setExpertAsk] = useState(false);
  const toggleExpert = useCallback(() => {
    if (expert) applyExpert(false);
    else setExpertAsk(true);
  }, [expert, applyExpert]);
  // App è il fornitore della lingua: qui si traduce direttamente (useT leggerebbe il contesto di fuori).
  languageRef.current = language;
  const t = (key: MessageKey, vars?: Record<string, string | number>): string => translate(language, key, vars);
  const changeLanguage = useCallback((next: Language): void => {
    setLanguage(next);
    // La voce ascolta e sceglie la voce di ripiego nella lingua: riparte con quella nuova.
    void window.visione.config.update({ ui: { language: next } }).then((res) => {
      if (res.ok) void window.visione.voice.restart();
    });
  }, []);
  const edition = core?.version.edition ?? null;
  useEffect(() => {
    // Configurazione ed edizione arrivano in momenti diversi: si decide quando ci sono entrambe.
    if (edition === 'tester' && setupDone !== null && setupDone < SETUP_VERSION) setSetupOpen(true);
  }, [edition, setupDone]);
  // La guida parte da sola una volta: procedura guidata fatta (nell'edizione per tester), intro finita.
  const setupComplete = setupDone !== null && edition !== null && (edition !== 'tester' || setupDone >= SETUP_VERSION);
  const defsEventKey = useMemo(() => {
    const e = [...state.events].reverse().find((ev) => ev.type.startsWith('agent.definition.'));
    return e?.id ?? '';
  }, [state.events]);
  const agentsKey = core ? `${core.agents.defined}:${core.agents.live}:${core.agents.working}:${core.agents.last?.at ?? 0}:${defsRevision}:${defsEventKey}` : '';
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void window.visione.agents.list(false).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setAgentViews(res.data.agents);
        setAgentsError(null);
      } else {
        setAgentsError(`${res.error.code}: ${res.error.message}`);
      }
    });
    return () => {
      alive = false;
    };
  }, [ready, agentsKey]);
  // P-87: striscia agenti della reference — tutti gli agenti DEFINITI con il loro stato reale (un
  // agente mai avviato si dichiara; niente agenti finti). I gettoni aprono la finestra dell'agente.
  const stripAgents = agentViews ?? [];
  // P-95: i campi modello delle Impostazioni suggeriscono i modelli REALI configurati negli agenti.
  const modelChoices = useMemo(
    () => (agentViews ?? []).map((a) => a.definition.engine.model).filter((m): m is string => typeof m === 'string'),
    [agentViews]
  );
  // Informazioni macchina (Fase G4): una lettura per avvio del core, condivisa da pannello e finestra.
  const [sysInfo, setSysInfo] = useState<CommandResult<'system.control.info'> | null>(null);
  const [sysInfoError, setSysInfoError] = useState<string | null>(null);
  const bootKey = core?.bootId ?? '';
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void window.visione.system.control.info().then((res) => {
      if (!alive) return;
      if (res.ok) {
        setSysInfo(res.data);
        setSysInfoError(null);
      } else {
        setSysInfoError(`${res.error.code}: ${res.error.message}`);
      }
    });
    return () => {
      alive = false;
    };
  }, [ready, bootKey]);

  // P-89: variante di scena dalla configurazione reale (`ui.scene`), una lettura per avvio del core.
  // Il toggle in Impostazioni aggiorna subito lo stato; il file resta la fonte alla riapertura.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void window.visione.config.get().then((res) => {
      if (!alive || !res.ok) return;
      setSceneVariant(sceneOf(res.data.config));
      setDirectorName(directorNameOf(res.data.config));
      setNodeLingerSec(nodeLingerOf(res.data.config));
      voiceAudio.setVolume(voiceVolumeOf(res.data.config));
      setSetupDone((res.data.config.setup as { completedVersion?: number } | undefined)?.completedVersion ?? 0);
      setLanguage(effectiveLanguage((res.data.config.ui as { language?: unknown } | undefined)?.language, navigator.language));
      setExpert(expertOf(res.data.config));
      setLight(lightOf(res.data.config));
      setGuideSeen(guideSeenOf(res.data.config));
      syncWeatherCity(res.data.config);
    });
    return () => {
      alive = false;
    };
  }, [ready, bootKey]);

  // Impostazioni a caldo o col riavvio (11/10/2026): ogni salvataggio, da qualunque finestra, arriva
  // come `system.config.changed`. Le chiavi a caldo si rileggono e valgono subito; quelle della voce
  // riavviano solo il processo voce (la procedura guidata lo fa da sé); le altre chiedono il riavvio.
  const setupOpenRef = useRef(setupOpen);
  setupOpenRef.current = setupOpen;
  useEffect(() => {
    if (!ready) return;
    return window.visione.events.subscribe((e) => {
      if (e.type !== 'system.config.changed') return;
      const p = e.payload as { changed: string[]; restartRequired: boolean };
      void window.visione.config.get().then((res) => {
        if (!res.ok) return;
        setSceneVariant(sceneOf(res.data.config));
        setDirectorName(directorNameOf(res.data.config));
        setNodeLingerSec(nodeLingerOf(res.data.config));
        voiceAudio.setVolume(voiceVolumeOf(res.data.config));
        setExpert(expertOf(res.data.config));
        setLight(lightOf(res.data.config));
      });
      const kind = changeKind(p.changed);
      if (kind === 'voice' && !setupOpenRef.current) void restartVoice();
      if (kind === 'app' && p.restartRequired) {
        setRestart((cur) => ({
          phase: cur && cur.phase === 'wait' ? 'wait' : 'ask',
          changed: [...new Set([...(cur?.changed ?? []), ...p.changed])],
          countdown: null
        }));
      }
    });
  }, [ready]);
  const busy = busyOf(core);
  // Apertura (11/10/2026): l'umanoide si forma grande al centro, poi si riduce e va da solo al suo
  // posto (quello fisso, nascosto finché arriva, si è formato insieme). Solo se è acceso; niente col
  // movimento ridotto.
  const [intro, setIntro] = useState<'center' | 'landing' | 'off'>(() => (initialReducedMotion() || dock.hidden.includes('humanoid') ? 'off' : 'center'));
  // Dopo la sequenza di avvio (pannello «avvio dei sistemi» chiuso) e un attimo perché la scena sia disegnata.
  const bootDone = bootComplete(sup, core);
  useEffect(() => {
    if (!shouldAutoShow({ ready: ready && bootDone, setupComplete, setupOpen, introOn: intro !== 'off', guideSeen })) return;
    const timer = setTimeout(() => setGuideOpen(true), 1_500);
    return () => clearTimeout(timer);
  }, [ready, bootDone, setupComplete, setupOpen, intro, guideSeen]);
  const [landing, setLanding] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (intro === 'off') return;
    const t = setTimeout(() => {
      if (intro === 'landing') {
        setIntro('off');
        return;
      }
      const r = document.querySelector('.dock-item[data-panel="humanoid"]')?.getBoundingClientRect();
      if (r && r.width > 0) {
        setLanding({ left: r.left, top: r.top, width: r.width, height: r.height });
        setIntro('landing');
      } else setIntro('off');
    }, intro === 'center' ? Math.round((ASSEMBLY_TOTAL_S + 1.3) * 1000) : 1_100);
    return () => clearTimeout(t);
  }, [intro]);
  // Umanoide (11/10/2026): quando VISIONE parla si apre (anche se spento o piegato) e si ingrandisce a
  // sinistra senza coprire i nodi; resta così 1,5 s dopo l'ultima frase. Spegnibile dal widget.
  const [humanoidPrefs] = useHumanoidPrefs();
  const speakingNow = core?.voice.speaking != null;
  const [speakHold, setSpeakHold] = useState(false);
  useEffect(() => {
    if (speakingNow) {
      setSpeakHold(true);
      return;
    }
    const t = setTimeout(() => setSpeakHold(false), 1_500);
    return () => clearTimeout(t);
  }, [speakingNow]);
  const humanoidGrow = humanoidPrefs.grow && speakHold;
  const shownDock = humanoidGrow ? withShown(dock, 'humanoid') : dock;
  // Nomi scelti dal proprietario per le frasi del log (id → nome), Director compreso.
  const agentNames = useMemo(() => {
    const out: Record<string, string> = { director: directorName };
    for (const a of agentViews ?? []) out[a.definition.id] = a.definition.name;
    return out;
  }, [agentViews, directorName]);
  const busyTotal = busy?.total ?? null;
  // In attesa della fine del lavoro: a lavoro finito parte il preavviso; se riprende, si torna ad aspettare.
  useEffect(() => {
    if (restart?.phase !== 'wait' || busyTotal === null) return;
    if (busyTotal === 0 && restart.countdown === null) setRestart((cur) => (cur ? { ...cur, countdown: IDLE_RESTART_COUNTDOWN_S } : cur));
    if (busyTotal > 0 && restart.countdown !== null) setRestart((cur) => (cur ? { ...cur, countdown: null } : cur));
  }, [restart?.phase, restart?.countdown, busyTotal]);
  useEffect(() => {
    if (restart?.phase !== 'wait' || restart.countdown === null) return;
    if (restart.countdown <= 0) {
      void window.visione.system.relaunch();
      return;
    }
    const tick = setTimeout(() => setRestart((cur) => (cur && cur.countdown !== null ? { ...cur, countdown: cur.countdown - 1 } : cur)), 1_000);
    return () => clearTimeout(tick);
  }, [restart?.phase, restart?.countdown]);
  const relaunchNow = (): void => {
    void window.visione.system.relaunch();
  };

  // --- Comandi vocali di ambiente (Fase 22, P-69) ----------------------------------------------
  // Il core riconosce l'azione (`voice.command`); qui la si risolve col contesto reale e si esegue.
  // I comandi della storia (riprodotti dal journal all'avvio) non si eseguono: solo quelli del core corrente.
  const voiceAgents = useMemo(
    () => (agentViews ?? []).map((a) => ({ id: a.definition.id, name: a.definition.name })),
    [agentViews]
  );
  // --- Wake «Hey Visione» → terminale dell'agente (P-83) ---------------------------------------
  // Alla detection fresca: se l'agente con terminale interattivo (capacità dichiarate dall'adapter)
  // non ha una sessione, viene avviata davvero (`agents.start`). La sua finestra NON si apre da sola
  // (24/10/2026, dal proprietario: copriva l'umanoide a ogni «hey visione»); si apre dal pannello.
  // Se non esiste un agente del genere, un avviso reale in alto.
  const lastWakeEvent = useRef<string | null>(null);
  const [wakeAlert, setWakeAlert] = useState<string | null>(null);
  useEffect(() => {
    const wake = wakeEventOf(state.events);
    if (!wake || wake.id === lastWakeEvent.current) return;
    lastWakeEvent.current = wake.id;
    const plan = wakePlan(state.events, agentViews ?? [], core?.core.startedAt ?? null, language);
    if (plan.kind === 'ignore') return;
    if (plan.kind === 'error') {
      setWakeAlert(plan.message);
      return;
    }
    setWakeAlert(null);
    void window.visione.agents.start(plan.agentId).then((res) => {
      if (!res.ok) setWakeAlert(translate(languageRef.current, 'shell.app.sessionFail', { id: plan.agentId, code: res.error.code, message: res.error.message }));
      else if (res.data.reason) setWakeAlert(translate(languageRef.current, 'shell.app.sessionReason', { id: plan.agentId, reason: res.data.reason }));
    });
  }, [state.events, agentViews, core, language]);

  const lastVoiceCommand = useRef<string | null>(null);
  useEffect(() => {
    const cmd = [...state.events].reverse().find((e) => e.type === 'voice.command');
    if (!cmd || cmd.id === lastVoiceCommand.current) return;
    const startedAt = core?.core.startedAt ?? null;
    if (startedAt === null || cmd.ts < startedAt) {
      lastVoiceCommand.current = cmd.id; // storia: non si riesegue
      return;
    }
    lastVoiceCommand.current = cmd.id;
    const front = frontWindow(wins);
    const plan = resolveVoiceCommand(cmd.payload as VoiceCommandPayload, {
      openIds: wins.windows.map((w) => w.id),
      frontKind: front?.kind ?? null,
      frontRef: front?.ref ?? null,
      agents: voiceAgents,
      status: core ? { agentsWorking: core.agents.working, tasksActive: core.tasks.active, activeGoals: core.director.activeGoals, processesActive: core.processes.active } : null
    });
    if (plan.kind === 'open') openKind(plan.windowKind, plan.ref, plan.title ?? undefined, plan.subtitle);
    else if (plan.kind === 'close') dispatchWin({ type: 'close', id: plan.id });
    else void window.visione.voice.speak(plan.text);
  }, [state.events, wins, voiceAgents, core, openKind]);

  const changeMotion = (v: boolean): void => {
    setReducedMotion(v);
    try {
      localStorage.setItem(MOTION_KEY, String(v));
    } catch {
      // preferenza solo per questa sessione
    }
  };
  // Tendina globale (Fase 18.5): click sul titolo di una scheda la piega/dispiega; il pulsante le
  // piega tutte. Vale per ogni `.card` (Agenti, HUD, Core, Database, IPC, ecc.).
  const shadeAll = useCallback((): void => {
    const cards = [...document.querySelectorAll('.card')];
    const anyOpen = cards.some((c) => !c.classList.contains('collapsed'));
    for (const c of cards) c.classList.toggle('collapsed', anyOpen);
  }, []);
  useEffect(() => {
    const onClick = (e: Event): void => {
      const target = e.target as HTMLElement | null;
      const head = target?.closest?.('.card h2, .card .hud-head') as HTMLElement | null;
      if (!head) return;
      // Un click su un controllo dentro l'intestazione non deve piegare la scheda.
      if ((target as HTMLElement).closest('button, input, select, textarea, a')) return;
      head.closest('.card')?.classList.toggle('collapsed');
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  // Dal pannello di un agente: apre la vista Terminale e ne cerca la sessione reale (P-100: se
  // serve la barra inferiore si espande, così il terminale giusto è davvero visibile).
  const openAgentTerminal = (agentId: string): void => {
    setTerminalAgent(agentId);
    setScreen({ bottom: true });
    setBottom('terminal');
    setBottomShade(false);
  };
  // Click sul nodo di Director: apre la vista Director.
  const openDirector = (): void => setCenter('director');
  // P-87: «SCHERMO INTERO» della reference. È una proprietà della finestra e si comanda nel main
  // (stessa azione di F11); l'API Fullscreen del renderer in Electron non è affidabile e qui non
  // serve un secondo percorso. Un errore IPC non spegne nulla: il tasto resta innocuo.
  const toggleFullscreen = (): void => {
    void window.visione.system.fullscreen().catch(() => undefined);
  };

  // --- Scorciatoie (G4): E espande, X chiude, [ ] scorre la finestra in fuoco ------------------
  // Attive solo con finestre aperte e fuori dai campi di testo (come le Blades del riferimento);
  // non toccano il riduttore P-68 (usano solo `focus`, `close`, `setBounds`). `AltGr` su tastiera
  // italiana produce Ctrl+Alt: per `[`/`]` è accettato.
  const winsRef = useRef(wins);
  winsRef.current = wins;
  const uiOpenRef = useRef({ palette, drawer });
  uiOpenRef.current = { palette, drawer };
  const zoomed = useRef(new Map<string, WindowBounds>());
  const toggleZoom = useCallback((win: WindowState): void => {
    const saved = zoomed.current.get(win.id);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (saved !== undefined) {
      zoomed.current.delete(win.id);
      dispatchWin({ type: 'setBounds', id: win.id, bounds: saved });
    } else {
      zoomed.current.set(win.id, win.bounds);
      // G5: parte SOTTO la topbar (46px), così la testata e i suoi controlli restano cliccabili
      // anche a finestra espansa (la topbar sta sopra le finestre per progetto).
      dispatchWin({ type: 'setBounds', id: win.id, bounds: clampBounds({ x: 12, y: 52, w: vw - 24, h: vh - 64 }, vw, vh) });
    }
  }, []);
  const cycleFocus = useCallback((dir: 1 | -1): void => {
    const front = frontWindow(winsRef.current);
    const list = winsRef.current.windows.filter((w) => !w.minimized).sort((a, b) => a.z - b.z);
    if (front === null || list.length < 2) return;
    const at = list.findIndex((w) => w.id === front.id);
    const next = list[(at + dir + list.length) % list.length] as WindowState;
    dispatchWin({ type: 'focus', id: next.id });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === 'Escape') {
        setPalette(false);
        setDrawer(null);
        setWinMenu(false);
        setWidgetMenu(false);
        setMaximized(null);
      } else if (e.altKey && ['1', '2', '3', '4', '5', '6'].includes(e.key)) {
        e.preventDefault();
        if (e.key === '1') setCenter('neural');
        if (e.key === '2') setCenter('tasks');
        if (e.key === '3') setBottom('events');
        if (e.key === '4') setBottom('terminal');
        if (e.key === '5') toggleChat();
        if (e.key === '6') setCenter('director');
      } else if (!e.repeat && !uiOpenRef.current.palette && uiOpenRef.current.drawer === null) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        const front = frontWindow(winsRef.current);
        if (front === null) return;
        const altGraph = e.ctrlKey && e.altKey && !e.metaKey;
        const simple = !e.ctrlKey && !e.metaKey && !e.altKey;
        if (simple && e.key === 'x') {
          e.preventDefault();
          zoomed.current.delete(front.id);
          dispatchWin({ type: 'close', id: front.id });
        } else if (simple && e.key === 'e') {
          e.preventDefault();
          toggleZoom(front);
        } else if ((simple || altGraph) && e.key === ']') {
          e.preventDefault();
          cycleFocus(1);
        } else if ((simple || altGraph) && e.key === '[') {
          e.preventDefault();
          cycleFocus(-1);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleZoom, cycleFocus]);

  const actions = useMemo<PaletteAction[]>(() => [
    { id: 'neural', label: translate(language, 'shell.cmd.neural'), run: () => setCenter('neural') },
    { id: 'tasks', label: translate(language, 'shell.cmd.tasks'), run: () => setCenter('tasks') },
    { id: 'director', label: translate(language, 'shell.cmd.director'), run: () => setCenter('director') },
    { id: 'chat', label: translate(language, 'shell.cmd.chat'), run: toggleChat },
    { id: 'events', label: translate(language, 'shell.cmd.events'), run: () => { setScreen({ bottom: true }); setBottom('events'); } },
    { id: 'logs', label: translate(language, 'shell.cmd.logs'), run: () => { setScreen({ bottom: true }); setBottom('logs'); } },
    { id: 'terminal', label: translate(language, 'shell.cmd.terminal'), run: () => { setScreen({ bottom: true }); setBottom('terminal'); } },
    { id: 'shell', label: translate(language, 'shell.cmd.shell'), run: () => { setScreen({ bottom: true }); setBottom('terminal'); void window.visione.terminal.open(100, 30); } },
    { id: 'win-director', label: translate(language, 'shell.cmd.winDirector'), run: () => openKind('director') },
    { id: 'win-reactor', label: translate(language, 'shell.cmd.winReactor'), run: () => openKind('reactor') },
    { id: 'win-telemetry', label: translate(language, 'shell.cmd.winTelemetry'), run: () => openKind('telemetry') },
    { id: 'win-logs', label: translate(language, 'shell.cmd.winLogs'), run: () => openKind('logs') },
    { id: 'win-errors', label: translate(language, 'shell.cmd.winErrors'), run: () => openKind('errors') },
    { id: 'win-terminal', label: translate(language, 'shell.cmd.winTerminal'), run: () => openKind('terminal') },
    { id: 'win-settings', label: translate(language, 'shell.cmd.winSettings'), run: () => openKind('settings') },
    { id: 'win-memory', label: translate(language, 'shell.cmd.winMemory'), run: () => openKind('memory') },
    { id: 'win-close-all', label: translate(language, 'shell.cmd.winCloseAll'), run: closeAllWindows },
    { id: 'memory', label: translate(language, 'shell.cmd.memory'), run: () => setDrawer('memory') },
    { id: 'settings', label: translate(language, 'shell.cmd.settings'), run: () => setDrawer('settings') },
    { id: 'replay', label: translate(language, 'shell.cmd.replay'), run: () => { setCenter('neural'); void (window as unknown as { __visioneNeural?: { replay(s: number): Promise<void> } }).__visioneNeural?.replay(20); } },
    { id: 'expert', label: translate(language, expert ? 'mode.toSimple' : 'mode.toExpert'), run: toggleExpert },
    { id: 'report', label: translate(language, 'report.open'), run: () => setReportOpen(true) },
    { id: 'legal', label: translate(language, 'legal.open'), run: () => setLegalOpen(true) },
    { id: 'guide', label: translate(language, 'guide.open'), run: () => setGuideOpen(true) },
    { id: 'browser', label: translate(language, 'shell.win.browser'), run: () => openKind('browser') },
    { id: 'training', label: translate(language, 'shell.win.training'), run: () => openKind('training') },
    { id: 'goal', label: translate(language, 'shell.cmd.goal'), run: () => goalRef.current?.focus() },
    { id: 'ping', label: translate(language, 'shell.cmd.ping'), run: ping },
    { id: 'refresh', label: translate(language, 'shell.cmd.refresh'), run: refresh }
  ], [ping, refresh, openKind, closeAllWindows, setScreen, language, expert, toggleExpert]);

  const pending = core?.approvals.pending ?? 0;

  // --- P-96: pannelli del dock gestibili (stessi contenuti e stessi dati reali) -----------------
  // Chiudi/riapri, tendina, spostamento e «a tutto schermo» passano da qui: il pannello ingrandito
  // riusa lo stesso render, quindi dati e comandi restano unici. La vecchia tendina interna della
  // Diagnostica si fonde con quella del dock (una sola fonte di verità, `panels.ts`).
  const diagPanel = (
    <section className="hud-panel panel-diag" aria-label={t('shell.panel.diag')}>
      <header className="hp-head">
        <span className="hp-title">{t('shell.panel.diag')}</span>
        <span className="hp-status mono">core · app · db · ipc</span>
      </header>
      <div className="hp-body">
        <section className="grid">
          <article className="card" aria-label={t('shell.diag.coreAria')}>
            <h2>Core</h2>
            <p className={`state state-${sup?.state ?? 'unknown'}`} data-testid="core-state">{sup?.state ?? '…'}</p>
            <dl>
              <dt>{t('shell.diag.inCore')}</dt>
              <dd className={`mono state-${core?.core.status ?? 'unknown'}`} data-testid="core-status">{core?.core.status ?? '—'}</dd>
              <dt>pid</dt><dd className="mono" data-testid="core-pid">{sup?.pid ?? '—'}</dd>
              <dt>{t('shell.diag.restarts')}</dt><dd className="mono" data-testid="core-restarts">{sup?.totalRestarts ?? 0}</dd>
              <dt>{t('shell.diag.prevStart')}</dt>
              <dd className="mono" data-testid="core-previous">
                {core ? `${core.core.previousRun ?? t('shell.app.none')}${core.core.recovered ? t('shell.diag.recoveredSuffix') : ''}` : '—'}
              </dd>
              {sup?.lastExit && (<><dt>{t('shell.diag.lastExit')}</dt><dd className="mono">{sup.lastExit.reason} ({String(sup.lastExit.code)}) {time(sup.lastExit.at, language)}</dd></>)}
              {sup?.nextRestartAt != null && (<><dt>{t('shell.diag.restartAt')}</dt><dd className="mono">{time(sup.nextRestartAt, language)}</dd></>)}
            </dl>
          </article>

          <article className="card" aria-label={t('shell.diag.app')}>
            <h2>{t('shell.diag.app')}</h2>
            <p className="state" data-testid="app-state">{core?.application.status ?? '—'}</p>
            <dl>
              <dt>app</dt><dd className="mono" data-testid="app-version">{sup?.appVersion ?? '—'}</dd>
              <dt>core</dt><dd className="mono">{core?.version.core ?? '—'}</dd>
              <dt>{t('shell.diag.dbSchema')}</dt><dd className="mono" data-testid="db-schema">{core?.version.dbSchema ?? '—'}</dd>
            </dl>
          </article>

          <article className="card" aria-label="Database">
            <h2>Database</h2>
            <p className={`state db-${core?.database.status ?? 'unknown'}`} data-testid="db-status">{core?.database.status ?? '—'}</p>
            <dl>
              <dt>journal</dt><dd className="mono" data-testid="event-count">{core ? core.database.journalCount : '—'}</dd>
              <dt>{t('shell.diag.lastSeq')}</dt><dd className="mono">{core?.database.journalLastSeq ?? '—'}</dd>
              <dt>{t('shell.diag.pending')}</dt><dd className="mono">{core?.database.pendingWrites ?? '—'}</dd>
              {core?.database.lastError && (<><dt>{t('shell.diag.error')}</dt><dd className="mono">{core.database.lastError}</dd></>)}
              {core?.database.quarantined && (<><dt>{t('shell.diag.quarantine')}</dt><dd className="mono">{core.database.quarantined}</dd></>)}
              {core !== null && core.database.corruptRows > 0 && (<><dt>{t('shell.diag.corruptRows')}</dt><dd className="mono">{core.database.corruptRows}</dd></>)}
            </dl>
          </article>

          <article className="card" aria-label={t('shell.diag.ipcAria')}>
            <h2>IPC</h2>
            <p className={`state conn-${conn}`} data-testid="connection">{t(CONNECTION_KEY[conn])}</p>
            <dl>
              <dt>{t('shell.diag.coreChannel')}</dt><dd className="mono" data-testid="ipc-status">{core?.ipc.status ?? '—'}</dd>
              <dt>ping</dt>
              <dd className="mono" data-testid="ping">
                {state.ping === null ? '—' : state.ping.ok ? `${state.ping.rttMs} ms` : state.ping.error.code}
              </dd>
              <dt>{t('shell.diag.commands')}</dt>
              <dd className="mono" data-testid="ipc-commands">
                {core ? t('shell.diag.commandsValue', { ok: core.ipc.commandsCompleted, failed: core.ipc.commandsFailed, rejected: core.ipc.commandsRejected }) : '—'}
              </dd>
              <dt>{t('shell.diag.running')}</dt><dd className="mono" data-testid="operations">{core?.operations.count ?? '—'}</dd>
            </dl>
            <div className="actions">
              <button type="button" onClick={ping} disabled={!ready}>Ping</button>
              <button type="button" onClick={refresh} disabled={!ready}>{t('shell.diag.refresh')}</button>
            </div>
          </article>

          <article className="card" aria-label={t('shell.diag.lastEvent')}>
            <h2>{t('shell.diag.lastEvent')}</h2>
            <LastEvent core={core} fallback={lastEvent(state)} />
          </article>

          <article className="card" aria-label={t('shell.diag.eventsAria')}>
            <h2>{t('shell.diag.events')}</h2>
            <dl>
              <dt>{t('shell.diag.sinceStart')}</dt><dd className="mono" data-testid="events-since-start">{core?.events.sinceStart ?? '—'}</dd>
              <dt>{t('shell.diag.rejected')}</dt><dd className="mono">{core?.events.rejected ?? '—'}</dd>
              <dt>{t('shell.diag.errors')}</dt><dd className="mono" data-testid="error-count">{core?.error.count ?? '—'}</dd>
              <dt>{t('shell.diag.lastError')}</dt>
              <dd className="mono" data-testid="last-error">
                {core?.error.last ? `${core.error.last.code} · ${time(core.error.last.at, language)}` : t('shell.app.none')}
              </dd>
            </dl>
          </article>

          <ProcessesCard core={core} ready={ready} />
        </section>
      </div>
    </section>
  );

  // Widget Grafici: la storia degli ultimi due minuti si raccoglie sempre, anche a widget spento.
  const systemSeries = useSystemSeries(bus);
  const menuItem = (id: PanelId): ReactNode => {
    const on = !dock.hidden.includes(id);
    return (
      <button
        key={id} type="button" role="menuitemcheckbox" aria-checked={on}
        data-testid={isWidget(id) ? `widget-toggle-${id}` : `panel-toggle-${id}`}
        onClick={() => setDock((d) => togglePanel(d, id, window.innerWidth, window.innerHeight))}
      >{on ? '☑' : '☐'} {panelTitle(id, language)}</button>
    );
  };
  const screenItem = (key: keyof ScreenPrefs, label: string): ReactNode => (
    <button
      type="button" role="menuitemcheckbox" aria-checked={screen[key]} data-testid={`screen-toggle-${key}`}
      onClick={() => setScreen({ [key]: !screen[key] })}
    >{screen[key] ? '☑' : '☐'} {label}</button>
  );
  const renderPanel = (id: PanelId): ReactNode => {
    switch (id) {
      case 'voice':
        return <VoicePanel core={core} level={voiceLevel} reducedMotion={reducedMotion} state={reactorState(core)} bus={bus} onOpenReactor={() => openKind('reactor')} />;
      case 'director':
        return <DirectorPanel core={core} onOpen={() => openKind('director')} />;
      case 'approvals':
        return <ApprovalsCard core={core} ready={ready} />;
      case 'system':
        return <SystemPanel core={core} ready={ready} bus={bus} scene={scene} pingMs={state.ping?.ok ? state.ping.rttMs : null} info={sysInfo} infoError={sysInfoError} onOpen={() => openKind('telemetry')} />;
      case 'agents':
        return <AgentsCard core={core} ready={ready} agents={agentViews} events={state.events} loadError={agentsError} onOpenAgent={(id) => openKind('agent', id, id, t('shell.app.agentSession'))} onOpenTerminal={openAgentTerminal} />;
      case 'tasks':
        return <TasksEventsPanel core={core} events={state.events} names={agentNames} />;
      case 'engines':
        return <EnginesCard ready={ready} agents={agentViews} />;
      case 'diag':
        return diagPanel;
      case 'clock':
        return <ClockWidget />;
      case 'weather':
        return <WeatherWidget />;
      case 'graphs':
        return <GraphsWidget series={systemSeries} />;
      case 'calendar':
        return <CalendarWidget />;
      case 'notes':
        return <NotesWidget />;
      case 'agenda':
        return <AgendaWidget />;
      case 'replies':
        return <RepliesWidget events={state.events} names={agentNames} onOpen={(id) => openKind('agent', id, id, t('shell.app.agentSession'))} />;
      case 'chat':
        return <HudPanel title={t('shell.panel.chat')} testId="widget-chat" className="widget widget-chat"><ChatView events={state.events} ready={ready} /></HudPanel>;
      case 'humanoid':
        return <HumanoidWidget voice={core?.voice ?? null} level={voiceLevel} busy={(busy?.total ?? 0) > 0} reducedMotion={reducedMotion} light={sceneLight} grown={humanoidGrow} />;
    }
  };

  return (
    <LanguageContext.Provider value={language}>
    <ExpertContext.Provider value={expert}>
    <div
      className={`app${columnInUse(shownDock, 'left') ? '' : ' hide-left'}${columnInUse(shownDock, 'right') ? '' : ' hide-right'}${screen.bottom ? '' : ' hide-bottom'}${screen.sceneInfo ? ' scene-details' : ''}${bottomShade ? ' bottom-shade' : ' bottom-open'}${reducedMotion ? ' motion-off' : ''}${humanoidGrow ? ' humanoid-grow' : ''}${intro !== 'off' ? ' humanoid-intro-on' : ''}`}
      data-motion={reducedMotion ? 'reduced' : 'full'}
    >
      <div className="jarvis-corners" aria-hidden="true"><i /><i /><i /><i /></div>
      <HudDeco />
      <Boot sup={sup} core={core} />
      {intro !== 'off' && (
        <>
          <div className={`humanoid-intro-backdrop${intro === 'landing' ? ' fading' : ''}`} aria-hidden="true" />
          <div className={`humanoid-intro humanoid-intro-${intro}`} data-testid="humanoid-intro" style={intro === 'landing' && landing ? landing : undefined}>
            <HumanoidWidget voice={core?.voice ?? null} level={voiceLevel} busy={false} reducedMotion={reducedMotion} intro />
          </div>
        </>
      )}
      {expertAsk && <ExpertConfirm onConfirm={() => { setExpertAsk(false); applyExpert(true); }} onCancel={() => setExpertAsk(false)} />}
      {restart?.phase === 'ask' && (
        <RestartPrompt
          changed={restart.changed}
          busy={busy}
          onNow={relaunchNow}
          onWhenIdle={() => setRestart((cur) => (cur ? { ...cur, phase: 'wait', countdown: null } : cur))}
          onLater={() => setRestart((cur) => (cur ? { ...cur, phase: 'later', countdown: null } : cur))}
        />
      )}
      {restart?.phase === 'wait' && (
        <RestartWaitBar
          busy={busy}
          countdown={restart.countdown}
          onNow={relaunchNow}
          onCancel={() => setRestart((cur) => (cur ? { ...cur, phase: 'later', countdown: null } : cur))}
        />
      )}
      {/* Non `setupOpen && ready` (18/10/2026): col core che riparte la procedura veniva smontata e tornava al
          primo passo, perdendo le scelte. Resta montata; finché il core non è pronto si nasconde da sé. */}
      {setupOpen && (
        <SetupWizard
          edition={core?.version.edition ?? 'sviluppo'}
          coreReady={ready}
          language={language}
          onLanguage={changeLanguage}
          onDirectorName={setDirectorName}
          onClose={() => {
            setSetupOpen(false);
            setDefsRevision((n) => n + 1);
          }}
        />
      )}
      {/* G6: effetti one-shot agganciati SOLO a eventi reali; spenti dal moto ridotto. */}
      <Effects events={state.events} startedAt={core?.core.startedAt ?? null} reducedMotion={reducedMotion} />
      <header className="topbar">
        <div className="brand">
          <h1>VISIONE</h1>
          <span className="brand-sub mono">AI OPERATING ENVIRONMENT</span>
          {/* P-98: versione del sistema sempre in alto, discreta — dati reali dal supervisore e dal core. */}
          <span className="brand-version mono" data-testid="version-badge" title={t('shell.app.versionTitle')}>
            v{sup?.appVersion ?? '…'} · core {core?.version.core ?? '…'} · db {core?.version.dbSchema ?? '…'}
          </span>
        </div>
        <div className="hud-status mono" data-testid="hud-status">
          <i className={`hud-dot state-${sup?.state ?? 'unknown'}`} aria-hidden="true" />
          <span className={`state-${sup?.state ?? 'unknown'}`}>core {sup?.state ?? '…'}</span>
          <span className="sep">│</span>
          <span className={`conn-${conn}`}>{t(CONNECTION_KEY[conn])}</span>
          {pending > 0 && <button type="button" className="alert mono approvals-cta" data-testid="approvals-badge" onClick={() => openKind('approvals')} title={t('shell.app.approvalsTitle')}>{t('shell.app.approvals', { n: pending })}</button>}
          <button
            type="button"
            className={`cmd-tasto errors-cta${core && core.error.count > 0 ? ' errors-cta-bad' : ''}`}
            data-testid="errors-badge"
            onClick={() => openKind('errors')}
            title={t('shell.app.errorsTitle')}
          >{core ? t('shell.app.errors', { n: core.error.count }) : t('shell.app.errorsNa')}</button>
          {restart?.phase === 'later' && (
            <button
              type="button" className="cmd-tasto restart-pending" data-testid="restart-pending"
              title={t('shell.app.restartPendingTitle')}
              onClick={() => setRestart((cur) => (cur ? { ...cur, phase: 'ask' } : cur))}
            >{t('shell.app.restartPending')}</button>
          )}
          <span className="muted rev x-expert" data-testid="state-revision" title={t('shell.app.revisionTitle')}>{core ? `r${core.revision}${live ? '' : t('shell.app.lastKnown')}` : t('shell.app.na')}</span>
        </div>
        {/* Spia e tasto offline: gruppo a sé sotto la riga di stato (dentro, la barra comandi lo copriva). */}
        <OfflineLamp />
        <nav className="barra-comandi" aria-label={t('shell.app.navAria')}>
          <div className="tabs" role="tablist" aria-label={t('shell.app.centerAria')}>
            <button type="button" role="tab" className={`cmd-tasto${center === 'neural' ? ' cmd-primario' : ''}`} aria-selected={center === 'neural'} onClick={() => setCenter('neural')} data-testid="tab-neural">{t('shell.app.tabCenter')}</button>
            <button type="button" role="tab" className={`cmd-tasto${center === 'tasks' ? ' cmd-primario' : ''}`} aria-selected={center === 'tasks'} onClick={() => setCenter('tasks')} data-testid="tab-tasks">Tasks</button>
            <button type="button" role="tab" className={`cmd-tasto${center === 'director' ? ' cmd-primario' : ''}`} aria-selected={center === 'director'} onClick={() => setCenter('director')} data-testid="tab-director">Director</button>
            <button type="button" role="tab" className={`cmd-tasto${chatShown ? ' cmd-primario' : ''}`} aria-selected={chatShown} onClick={toggleChat} data-testid="tab-chat">Chat</button>
          </div>
          <div className="topbar-controls">
            <div className="win-menu-wrap">
              <button type="button" className="cmd-tasto cmd-primario" data-testid="windows-menu" aria-expanded={winMenu} onClick={() => setWinMenu((v) => !v)}>{t('shell.app.menuWindows')}</button>
              {winMenu && (
                <div className="win-menu" role="menu" data-testid="windows-menu-popover">
                  {WINDOW_BUTTONS.filter((kind) => windowVisible(kind, expert)).map((kind) => (
                    <button key={kind} type="button" role="menuitem" data-testid={`win-open-${kind}`} onClick={() => openKind(kind)}>{windowTitleOf(kind, language).title}</button>
                  ))}
                  <button type="button" role="menuitem" data-testid="win-close-all" onClick={() => { closeAllWindows(); setWinMenu(false); }}>{t('shell.app.closeAll')}</button>
                </div>
              )}
            </div>
            {/* Schermo pulito (11/10/2026): un solo menu, una casella per ogni pannello e widget, per tema.
                Spenti tutti restano l'Umanoide e la scena con gli agenti; le linguette laterali aprono il resto. */}
            <div className="win-menu-wrap">
              <button
                type="button" className="cmd-tasto" data-testid="widgets-menu" aria-expanded={widgetMenu}
                onClick={() => setWidgetMenu((v) => !v)}
                title={t('widget.menu.title')}
              >{t('widget.menu')}</button>
              {widgetMenu && (
                <div className="win-menu widget-menu" role="menu" data-testid="widgets-menu-popover">
                  {menuItem('humanoid')}
                  {PANEL_GROUPS.map((g) => (
                    <div key={g.id} className="widget-menu-group" role="group" aria-label={groupTitle(g.id, language)}>
                      <div className="widget-menu-title">{groupTitle(g.id, language)}</div>
                      {g.panels.map(menuItem)}
                    </div>
                  ))}
                  <div className="widget-menu-group" role="group" aria-label={t('shell.app.screenGroup')}>
                    <div className="widget-menu-title">{t('shell.app.screenGroup')}</div>
                    {screenItem('bottom', t('shell.app.screenBottom'))}
                    {screenItem('strip', t('shell.app.screenStrip'))}
                    {screenItem('tabs', t('shell.app.screenTabs'))}
                    {screenItem('sceneInfo', t('shell.app.screenSceneInfo'))}
                  </div>
                  <div className="widget-menu-actions">
                    <button type="button" role="menuitem" data-testid="widgets-only-essentials" onClick={() => setDock(onlyEssentials)}>{t('shell.app.onlyHumanoid')}</button>
                    <button type="button" role="menuitem" data-testid="widgets-all-on" onClick={() => setDock(everythingOn)}>{t('shell.app.allOn')}</button>
                    <button type="button" role="menuitem" data-testid="shade-all" onClick={shadeAll}>{t('shell.app.collapseAll')}</button>
                    <button
                      type="button" role="menuitem" data-testid="panels-reset"
                      title={t('shell.app.resetPositionsTitle')}
                      onClick={() => { setDock(resetDock); setMaximized(null); }}
                    >{t('shell.app.resetPositions')}</button>
                  </div>
                </div>
              )}
            </div>
            <Notifications events={state.events} onOpen={(n) => { if (n.target) openKind(n.target.windowKind as WindowKind, n.target.ref, undefined, null); }} />
            {/* Addestramento in vista (17/10/2026, richiesta del proprietario): prima solo dal menu Start o da Ctrl+K. */}
            <button type="button" className="cmd-tasto" onClick={() => openKind('training')} data-testid="open-training" title={t('settings.start.trainingTitle')}>{t('shell.win.training')}</button>
            <button type="button" className="cmd-tasto" onClick={() => setDrawer(drawer === 'settings' ? null : 'settings')} data-testid="open-settings">{t('shell.win.settings')}</button>
            <button type="button" className="cmd-tasto" onClick={toggleFullscreen} data-testid="toggle-fullscreen" aria-label={t('shell.app.fullscreenAria')} title={t('shell.app.fullscreenTitle')}>{t('shell.app.fullscreenBtn')}</button>
            <button type="button" className="cmd-tasto" onClick={() => setPalette(true)} aria-label={t('shell.app.paletteAria')} data-testid="open-palette">Ctrl+K</button>
          </div>
          {screen.strip && stripAgents.length > 0 && (
            <div className="striscia-agenti" data-testid="agent-strip" aria-label={t('shell.app.stripAria')}>
              {stripAgents.slice(0, 6).map((v) => {
                const st = v.instance?.status ?? null;
                const stateLabel = agentStateLabel(st, v.instance?.statusReason ?? null, language);
                const activity = agentActivity(state.events, v.definition.id);
                const details = [stateLabel, activity?.tool ?? null, v.instance?.currentTaskId ?? null].filter(Boolean).join(' · ');
                return (
                  <button
                    key={v.definition.id}
                    type="button"
                    className={`gettone-agente gettone-${st ?? 'idle'}`}
                    title={`${v.definition.name}: ${details}`}
                    onClick={() => openKind('agent', v.definition.id, v.definition.id, t('shell.app.agentSession'))}
                  >
                    <span className="gettone-spia" aria-hidden="true" />
                    <span className="gettone-nome">{v.definition.name.toUpperCase()}</span>
                    <span className="gettone-dettagli">{details}</span>
                  </button>
                );
              })}
              {stripAgents.length > 6 && <span className="gettone-piu mono" title={t('shell.app.stripMore')}>+{stripAgents.length - 6}</span>}
            </div>
          )}
          <span className="spacer" />
        </nav>
      </header>

      {wakeAlert && (
        <div className="wake-alert" role="alert" data-testid="wake-alert">
          <span className="mono small">WAKE · {wakeAlert}</span>
          <button type="button" onClick={() => setWakeAlert(null)} aria-label={t('shell.app.wakeClose')}>×</button>
        </div>
      )}

      <OfflineAlert />

      {/* P-96: le due colonne del dock sono gestibili — × chiude (riapri da «Pannelli»), − tendina,
          trascina dall'intestazione per spostare, ⛶ a tutto schermo. */}
      <DockBoard
        dock={shownDock}
        onChange={(next) => setDock(humanoidGrow ? keepShownTemporary(next, dock, 'humanoid') : next)}
        renderPanel={renderPanel}
        onMaximize={(id) => setMaximized(id)}
        suppressed={maximized}
      />
      {screen.tabs && (
        <SideTabs
          renderPanel={renderPanel}
          onDetach={(id) => setDock((d) => bringOnScreen(d, id))}
          logView={<EventsView events={state.events} ready={ready} listTestId="side-log" initialSeverity="info" names={agentNames} />}
        />
      )}

      <main className="col-center">
        {/* Con la procedura guidata aperta la scena è coperta: ferma (18/10/2026, sul PC vergine consumava per niente). */}
        <NeuralView visible={center === 'neural' && !setupOpen} reducedMotion={reducedMotion} light={sceneLight} onStats={setScene} core={core} agents={agentViews} voiceLevel={voiceLevel} scene={sceneVariant} directorName={directorName} nodeLingerSec={nodeLingerSec} onOpenTerminal={openAgentTerminal} onOpenDirector={openDirector} onOpenWindow={(kind, ref) => openKind(kind, ref)} />
        <div hidden={center !== 'tasks'}><TasksView core={core} ready={ready} /></div>
        <div hidden={center !== 'director'}><DirectorView events={state.events} core={core} /></div>
      </main>

      <section className={`row-bottom x-expert${bottomShade ? ' collapsed' : ''}`}>
        <div className="tabs" role="tablist" aria-label={t('shell.app.bottomAria')}>
          <button type="button" data-testid="toggle-bottom-shade" aria-pressed={bottomShade} onClick={() => setBottomShade((v) => !v)} title={t('shell.app.bottomShade')}>{bottomShade ? '▸' : '▾'}</button>
          <button type="button" role="tab" aria-selected={bottom === 'events'} onClick={() => setBottom('events')} data-testid="tab-events">{t('shell.app.tabEvents')}</button>
          <button type="button" role="tab" aria-selected={bottom === 'logs'} onClick={() => setBottom('logs')} data-testid="tab-logs">Logs</button>
          <button type="button" role="tab" aria-selected={bottom === 'terminal'} onClick={() => setBottom('terminal')} data-testid="tab-terminal">{t('shell.app.tabTerminal')}</button>
          {state.lastError && <span className="error small" role="status">{t('shell.app.lastError', { code: state.lastError.code, message: state.lastError.message })}</span>}
        </div>
        <div hidden={bottom !== 'events'}><EventsView events={state.events} ready={ready} names={agentNames} /></div>
        <div hidden={bottom !== 'logs'}><EventsView events={state.events} ready={ready} listTestId="logs" initialSeverity="warning" names={agentNames} /></div>
        <div hidden={bottom !== 'terminal'}><TerminalView ready={ready} visible={bottom === 'terminal'} focusAgent={terminalAgent} /></div>
      </section>

      <OfflineReplies />
      <footer className="row-command"><CommandBar ready={ready} inputRef={goalRef} voice={core?.voice ?? null} /></footer>
      <StartMenu ready={ready} onOpenFolder={(path) => openKind('files', path, t('shell.win.files'))} onOpenSettings={() => openKind('settings')} onReport={() => setReportOpen(true)} onLegal={() => setLegalOpen(true)} onGuide={() => setGuideOpen(true)} onBrowser={() => openKind('browser')} onTraining={() => openKind('training')} />
      {guideOpen && <Guide onClose={closeGuide} />}
      {reportOpen && <ReportDialog onClose={() => setReportOpen(false)} />}
      {legalOpen && <LegalDialog onClose={() => setLegalOpen(false)} />}

      {drawer && (
        <aside className="drawer" aria-label={drawer === 'memory' ? t('shell.win.memory') : t('shell.win.settings')}>
          <header><h2>{drawer === 'memory' ? t('shell.win.memory') : t('shell.win.settings')}</h2><button type="button" onClick={() => setDrawer(null)} aria-label={t('shell.app.close')}>×</button></header>
          {drawer === 'memory' ? <MemoryDrawer ready={ready} /> : <SettingsDrawer edition={core?.version.edition ?? 'sviluppo'} ready={ready} reducedMotion={reducedMotion} onReducedMotion={changeMotion} onSceneChange={setSceneVariant} onNodeLingerChange={setNodeLingerSec} modelSuggestions={modelChoices} agents={agentViews} directorName={directorName} onDirectorRenamed={setDirectorName} onAgentsChanged={() => setDefsRevision((n) => n + 1)} onOpenAgentTerminal={(id) => { setDrawer(null); openAgentTerminal(id); }} onOpenDirectorWindow={() => { setDrawer(null); openKind('director'); }} onOpenSetup={() => { setDrawer(null); setSetupOpen(true); }} />}
        </aside>
      )}
      {palette && <Palette actions={actions} onClose={() => setPalette(false)} />}

      <WindowsLayer
        state={wins}
        dispatch={dispatchWin}
        ready={ready}
        core={core}
        events={state.events}
        agents={agentViews}
        scene={scene}
        pingMs={state.ping?.ok ? state.ping.rttMs : null}
        bus={bus}
        sysInfo={sysInfo}
        sysInfoError={sysInfoError}
        reducedMotion={reducedMotion}
        onReducedMotion={changeMotion}
        voiceLevel={voiceLevel}
        zoomedIds={new Set(zoomed.current.keys())}
        onToggleZoom={toggleZoom}
        onOpenBrowser={(url) => openKind('browser', url)}
      />

      {/* P-96: pannello a tutto schermo dentro VISIONE — nessuna finestra nativa, contenuto e dati
          identici a quelli del dock; si chiude con ×, «Ripristina» o Esc. */}
      {maximized !== null && (
        <PanelMax id={maximized} onRestore={() => setMaximized(null)}>{renderPanel(maximized)}</PanelMax>
      )}
    </div>
    </ExpertContext.Provider>
    </LanguageContext.Provider>
  );
}
