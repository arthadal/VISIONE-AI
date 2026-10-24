// Procedura guidata del primo avvio (P-105): rilevamento dei motori con guida passo passo, chiave
// verificata e salvata, accesso nel terminale di VISIONE, squadra scelta con menu a tendina e nomi,
// chi comanda, voce, verifica finale con turni veri. Nessun dato finto: tutto passa dai comandi
// `setup.*` e da quelli già esistenti (agenti, config, voce, terminale). Il renderer non nomina
// motori: nomi, guide, modelli e consigli arrivano dal core. Testi in italiano e inglese (10/10/2026):
// la lingua si sceglie al primo passo e vale subito per tutta VISIONE.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandError, Edition, InstalledVoice, Language, SetupEngine, SetupItem, TerminalSession, VisioneEvent, VoiceProfile } from '../../shared/contracts/index.ts';
import { LANGUAGE_NAMES, useT, type Translate } from '../lib/i18n/index.ts';
import { IT_VOICES } from './settings-meta.ts';
import { TerminalPane } from './TerminalView.tsx';
import { OfflineModelBox } from './OfflineControls.tsx';
import { useOfflineState } from './offline-store.ts';
import { restartVoice, waitVoiceReady } from './voice-restart.ts';
import { SetupListening } from './SetupListening.tsx';
import {
  ROLE_ORDER,
  SETUP_VERSION,
  VERIFY_STEP,
  approvalText,
  engineReady,
  entryOf,
  missingFor,
  profilesMissing,
  roleText,
  sameRequest,
  uniqueRequests,
  newRowKey,
  resumeStep,
  suggestedTeam,
  usableCatalogs,
  verifyGroups,
  teamFromAgents,
  teamLabel,
  teamPayload,
  teamProblems,
  verifyOutcome,
  verifyStatus,
  voiceChoices,
  type CheckState,
  type EngineCatalog,
  type PendingApproval,
  type RoleKey,
  type TeamRow
} from './setup-logic.ts';
import { PROFILE_SETTINGS, VOICE_PROFILES, profileAvailable, profileOf, profilePatch, speedTimes } from './voice-profile.ts';

/** Prova del PC per il profilo della voce (16/10/2026). */
type BenchState =
  | { phase: 'running' }
  | { phase: 'done'; rtf: number | null; reason: string | null; recommended: VoiceProfile; runtime: SetupItem | null }
  | { phase: 'failed'; reason: string };

/** Ciò che un profilo scrive davvero: la voce di Windows conta solo per i profili che la usano. */
const profileKey = (p: VoiceProfile, voice: string): string => `${p}|${PROFILE_SETTINGS[p].provider === 'windows' ? voice : ''}`;

const STEP_KEYS = ['wiz.step.welcome', 'wiz.step.engines', 'wiz.step.team', 'wiz.step.voice', 'wiz.step.offline', 'wiz.step.verify'] as const;
const VERIFY_TIMEOUT_MS = 240_000;
const errText = (e: CommandError): string => e.message || e.code;

export function SetupWizard({ edition, coreReady, language, onLanguage, onClose, onDirectorName }: {
  edition: Edition;
  /** Core pronto. Mentre riparte la procedura resta montata ma nascosta, e al ritorno riprende da dov'era. */
  coreReady: boolean;
  language: Language;
  onLanguage: (language: Language) => void;
  onClose: (completed: boolean) => void;
  onDirectorName: (name: string) => void;
}) {
  const t = useT();
  const [step, setStep] = useState(0);
  // Passo «Offline»: «Salta» finché il modello manca, «Avanti» se c'è o si sta scaricando.
  const offlineModel = useOfflineState()?.model.status ?? null;
  const [engines, setEngines] = useState<SetupEngine[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [catalogs, setCatalogs] = useState<EngineCatalog[]>([]);
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [commander, setCommander] = useState<string | null>(null);
  // Primo avvio più semplice (14/10/2026): di partenza si vede la squadra consigliata in parole; la tabella
  // con motore e modello di ogni agente si apre solo a chi vuole cambiarla.
  const [customTeam, setCustomTeam] = useState(false);
  const existingLoaded = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [terminal, setTerminal] = useState<TerminalSession | null>(null);
  // Il terminale serve all'accesso o a un'installazione: il testo sopra cambia (17/10/2026).
  // «runtime» = l'installazione di un requisito di VISIONE dal passo Voce (18/10/2026): il terminale si vede lì.
  const [terminalFor, setTerminalFor] = useState<'login' | 'install' | 'runtime'>('login');
  const [applied, setApplied] = useState<{ ids: Map<string, string>; names: Map<string, string> } | null>(null);
  const [voice, setVoice] = useState('Microsoft Cosimo');
  const [installedVoices, setInstalledVoices] = useState<InstalledVoice[]>([]);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  // Profilo della voce (16/10/2026): consigliato dalla prova del PC, scelto dal proprietario.
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [bench, setBench] = useState<BenchState | null>(null);
  /** Profilo e voce già scritti nella configurazione e attivi: si riavvia la voce solo se cambiano. */
  const [appliedVoice, setAppliedVoice] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  // Modelli d'ascolto: non sono nell'installer, si scaricano qui su consenso.
  const [models, setModels] = useState<{ complete: boolean; downloading: boolean; missing: Array<{ id: string; size: number; license: string }> } | null>(null);
  const [download, setDownload] = useState<{ id: string; phase: string; received: number; total: number; error: string | null } | null>(null);
  const loadModels = useCallback(async () => {
    const res = await window.visione.voice.modelsStatus();
    if (res.ok) setModels({ complete: res.data.complete, downloading: res.data.downloading, missing: res.data.missing });
  }, []);
  const loadVoices = useCallback(async () => {
    const res = await window.visione.voice.status();
    if (res.ok) setInstalledVoices(res.data.voices);
  }, []);
  useEffect(() => {
    void loadModels();
    void loadVoices();
    return window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.type === 'voice.process.changed' && (e.payload as { to?: string }).to === 'ready') void loadVoices();
      if (e.type !== 'voice.models.progress') return;
      const p = e.payload as { id: string; phase: string; received: number; total: number; error: string | null };
      setDownload(p);
      if (p.phase === 'completato' || p.phase === 'errore') void loadModels();
    });
  }, [loadModels, loadVoices]);
  const startDownload = async (): Promise<void> => {
    setDownload({ id: '', phase: 'download', received: 0, total: 0, error: null });
    const res = await window.visione.voice.modelsDownload();
    if (!res.ok) setDownload({ id: '', phase: 'errore', received: 0, total: 0, error: errText(res.error) });
    else if (res.data.alreadyComplete) void loadModels();
  };
  const mb = (n: number): string => (n / 1_048_576).toFixed(0);
  const downloading = download !== null && download.phase !== 'errore' && download.phase !== 'completato';
  /** A che punto è lo scaricamento dei modelli d'ascolto, con la barra (passo Voce e Verifica). */
  const downloadProgress = (d: NonNullable<typeof download>): ReactNode => (
    <>
      {!d.id ? t('wiz.hearing.starting') : d.phase === 'download' ? t('wiz.hearing.downloading', { id: d.id, received: mb(d.received), total: mb(d.total) }) : d.phase === 'verifica' ? t('wiz.hearing.verifying', { id: d.id }) : d.phase === 'estrazione' ? t('wiz.hearing.extracting', { id: d.id }) : t('wiz.hearing.modelReady', { id: d.id })}
      {/* Verifica ed estrazione non hanno avanzamento: barra in movimento, non piena e ferma per minuti (VM, 18/10/2026). */}
      {d.phase === 'verifica' || d.phase === 'estrazione' ? <progress /> : d.total > 0 && <progress value={d.received} max={d.total} />}
    </>
  );
  // Verifica in corso: tempo massimo per agente (fermo mentre aspetta un tuo permesso) e iscrizione agli eventi.
  const verifyRef = useRef<{ arm: (agentId: string) => void; pause: (agentId: string) => void; set: (agentId: string, c: CheckState) => void; off: () => void } | null>(null);
  useEffect(() => () => verifyRef.current?.off(), []);

  /** Rileva i motori; restituisce quelli rilevati, o null se il rilevamento non è riuscito. */
  const detect = useCallback(async (): Promise<SetupEngine[] | null> => {
    setDetecting(true);
    const res = await window.visione.setup.detect();
    setDetecting(false);
    if (res.ok) {
      setEngines(res.data.engines);
      return res.data.engines;
    }
    setError(t('wiz.err.detect', { error: errText(res.error) }));
    return null;
  }, [t]);

  // «Installa» (17/10/2026): l'installatore ufficiale nel terminale di VISIONE; quando il processo finisce
  // si ricontrolla da soli (il core rilegge il PATH), senza chiedere di premere «Ricontrolla».
  const [installing, setInstalling] = useState<{ processId: string; label: string; key: string; admin: boolean } | null>(null);
  const [installNote, setInstallNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Collaudo su un PC vergine (VM, 17/10/2026): la richiesta di permesso di Windows di un installatore
  // lanciato dal terminale nascosto NON viene in primo piano, lampeggia nella barra delle applicazioni; e a
  // schermo intero VISIONE copre la barra: il tester non la vede e crede che sia bloccato. Durante
  // un'installazione con permesso si esce dallo schermo intero (poi si torna) e lo si dice chiaramente.
  const leftFullscreen = useRef(false);
  const endInstall = useCallback((): void => {
    setInstalling(null);
    if (leftFullscreen.current) {
      leftFullscreen.current = false;
      void window.visione.system.fullscreen(true);
    }
  }, []);
  useEffect(() => {
    if (!installing) return;
    return window.visione.events.subscribe((e: VisioneEvent) => {
      if (!/^process\.(exited|failed|crashed|stopped|timeout)$/.test(e.type)) return;
      const p = e.payload as { processId: string; exitCode: number | null };
      if (p.processId !== installing.processId) return;
      const ok = e.type === 'process.exited' && (p.exitCode ?? 0) === 0;
      setInstallNote({ ok, text: t(ok ? 'wiz.install.done' : 'wiz.install.failed', { label: installing.label }) });
      endInstall();
      void detect();
      afterInstall.current?.();
      afterInstall.current = null;
    });
  }, [installing, detect, t, endInstall]);
  // Il terminale della guidata sa quando il suo processo è finito (VM, 22/10/2026: un clic nel terminale già chiuso
  // mandava input e il core rispondeva «operation_failed: sessione terminata (exited)»). Chiuso, è in sola lettura.
  const terminalId = terminal?.endedAt === null ? terminal.processId : null;
  useEffect(() => {
    if (!terminalId) return;
    return window.visione.events.subscribe((e: VisioneEvent) => {
      if (!/^process\.(exited|failed|crashed|stopped|timeout|cancelled)$/.test(e.type)) return;
      if ((e.payload as { processId?: string }).processId !== terminalId) return;
      setTerminal((cur) => (cur && cur.processId === terminalId ? { ...cur, endedAt: Date.now() } : cur));
    });
  }, [terminalId]);
  // Cosa fare quando l'installazione finisce, oltre a ricontrollare i motori (il runtime: riavviare la voce).
  const afterInstall = useRef<(() => void) | null>(null);
  const openInstall = async (adapter: string, item: SetupItem, after?: () => void): Promise<void> => {
    setError(null);
    setInstallNote(null);
    const admin = item.action?.kind === 'install' && item.action.admin === true;
    const res = await window.visione.setup.install(adapter, item.id, 110, 26);
    if (!res.ok) return setError(t('wiz.err.install', { error: errText(res.error) }));
    if (admin && window.innerHeight >= window.screen.height && window.innerWidth >= window.screen.width) {
      leftFullscreen.current = true;
      void window.visione.system.fullscreen(false);
    }
    setTerminal(res.data.session);
    setTerminalFor(after ? 'runtime' : 'install');
    afterInstall.current = after ?? null;
    setInstalling({ processId: res.data.session.processId, label: item.label, key: `${adapter}:${item.id}`, admin });
  };

  // Con la chiave di un fornitore il catalogo prova davvero i modelli (fino a 15 s): finché non torna, «Applica» aspetta.
  // Se nel frattempo ne parte un altro (motori cambiati), vale l'ultimo.
  const catalogSeq = useRef(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const loadCatalog = useCallback(async () => {
    const seq = ++catalogSeq.current;
    setCatalogLoading(true);
    const res = await window.visione.setup.catalog();
    if (seq !== catalogSeq.current) return;
    setCatalogLoading(false);
    if (!res.ok) return setError(t('wiz.err.catalog', { error: errText(res.error) }));
    setCatalogs(res.data.engines);
  }, [t]);

  useEffect(() => {
    void detect();
    void loadCatalog();
    void window.visione.config.get().then((res) => {
      if (!res.ok) return;
      const tts = (res.data.config.voice as Record<string, unknown> | undefined)?.tts as Record<string, unknown> | undefined;
      if (typeof tts?.voice === 'string') setVoice(tts.voice);
      const current = profileOf(res.data.config);
      if (current !== 'custom') setAppliedVoice(profileKey(current, typeof tts?.voice === 'string' ? tts.voice : ''));
    });
    // Solo all'apertura: cambiare lingua non deve ripetere il rilevamento né rifare la squadra.
  }, []);

  // Riaperta dopo averla completata: si parte dalla squadra che c'è, non da quella consigliata (VM, 22/10/2026).
  // Su un PC nuovo (procedura mai completata) gli agenti predefiniti non contano: vale la squadra consigliata.
  // Una volta per apertura, appena il core risponde.
  useEffect(() => {
    if (!coreReady || existingLoaded.current) return;
    existingLoaded.current = true;
    void (async () => {
      const [cfg, list] = await Promise.all([window.visione.config.get(), window.visione.agents.list(false)]);
      if (!cfg.ok || !list.ok || list.data.agents.length === 0) return;
      const conf = cfg.data.config as { setup?: { completedVersion?: number }; director?: { plannerAgentId?: string | null } };
      if ((conf.setup?.completedVersion ?? 0) <= 0) return;
      const existing = teamFromAgents(list.data.agents.map((a) => a.definition), conf.director?.plannerAgentId ?? null);
      setRows(existing.rows);
      setCommander(existing.commander);
      setCustomTeam(true);
    })();
  }, [coreReady]);

  // Riavvio del core (18/10/2026): App non smonta più la procedura quando il supervisore riavvia il core (la
  // nasconde finché non è di nuovo pronto), quindi passo e scelte restano. Ciò che viveva nel core caduto è
  // perso: terminale e installazione che si seguivano, scaricamento dei modelli d'ascolto. Al ritorno si rilegge
  // tutto e si controlla che il passo valga ancora (squadra ancora presente, almeno un motore pronto).
  const wasReady = useRef(coreReady);
  useEffect(() => {
    const back = coreReady && !wasReady.current;
    wasReady.current = coreReady;
    if (!back) return;
    setError(null);
    if (installing) {
      setInstallNote({ ok: false, text: t('wiz.install.lost', { label: installing.label }) });
      endInstall();
    }
    setTerminal(null);
    setDownload((d) => (d && d.phase !== 'errore' && d.phase !== 'completato' ? { ...d, phase: 'errore', error: t('wiz.hearing.lost') } : d));
    void loadModels();
    void loadVoices();
    void loadCatalog();
    void (async () => {
      const found = await detect();
      let teamApplied = applied !== null;
      if (applied) {
        const res = await window.visione.agents.list(false);
        if (res.ok) {
          const ids = new Set(res.data.agents.map((a) => a.definition.id));
          teamApplied = [...applied.ids.values()].every((id) => ids.has(id));
          if (!teamApplied) setApplied(null);
        }
      }
      const anyReady = found === null ? null : found.some((e) => engineReady(found, e.adapter));
      setStep((s) => resumeStep(s, { anyReady, teamApplied }));
    })();
    // Solo al ritorno del core: i valori letti sono quelli del momento in cui è tornato.
  }, [coreReady]);

  // Il catalogo dipende dai motori pronti (con la chiave di un fornitore i modelli si provano davvero): quando cambia la
  // prontezza (chiave salvata, Ollama acceso, programma installato) si rilegge. Il primo rilevamento corre insieme
  // al caricamento dell'apertura, che vede già lo stesso stato.
  const readyKey = useMemo(() => (engines === null ? null : engines.map((e) => `${e.adapter}:${e.items.map((i) => `${i.id}=${i.ok ? 1 : 0}`).join(',')}`).join('|')), [engines]);
  const catalogFor = useRef<string | null>(null);
  useEffect(() => {
    if (readyKey === null || catalogFor.current === readyKey) return;
    const first = catalogFor.current === null;
    catalogFor.current = readyKey;
    if (!first) void loadCatalog();
  }, [readyKey, loadCatalog]);

  const anyReady = useMemo(() => (engines ?? []).some((e) => engineReady(engines, e.adapter)), [engines]);
  const usable = useMemo(() => usableCatalogs(catalogs, engines), [catalogs, engines]);
  // La squadra consigliata segue i motori pronti finché l'utente non la personalizza e non la applica: con un
  // motore solo (o un solo fornitore di modelli) nessun agente finisce su un motore che non c'è.
  useEffect(() => {
    if (customTeam || applied !== null || engines === null) return;
    const team = suggestedTeam(usable, t);
    setRows(team);
    setCommander(team.find((r) => r.roleKey === 'director')?.key ?? team[0]?.key ?? null);
  }, [usable, customTeam, applied, engines, t]);
  const labelOf = (adapter: string): string => catalogs.find((c) => c.adapter === adapter)?.label ?? adapter;

  // --- Squadra -------------------------------------------------------------------------------
  const problems = teamProblems(rows, commander, t);
  const update = (key: string, patch: Partial<TeamRow>): void => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const chooseAdapter = (row: TeamRow, adapter: string): void => {
    const models = catalogs.find((c) => c.adapter === adapter)?.models ?? [];
    const pick = models.find((m) => m.recommended) ?? models[0];
    const next: TeamRow = { key: row.key, name: row.name, roleKey: row.roleKey, adapter, model: pick?.model ?? '' };
    if (pick?.endpointProfile) next.endpointProfile = pick.endpointProfile;
    setRows((rs) => rs.map((r) => (r.key === row.key ? next : r)));
  };
  const chooseModel = (row: TeamRow, model: string): void => {
    const entry = entryOf(catalogs, { adapter: row.adapter, model });
    const next: TeamRow = { key: row.key, name: row.name, roleKey: row.roleKey, adapter: row.adapter, model };
    if (entry?.endpointProfile) next.endpointProfile = entry.endpointProfile;
    setRows((rs) => rs.map((r) => (r.key === row.key ? next : r)));
  };
  const addRow = (): void => {
    const first = usable[0] ?? catalogs[0];
    const pick = first?.models.find((m) => m.recommended) ?? first?.models[0];
    const n = rows.length + 1;
    setRows((rs) => [...rs, { key: newRowKey(), name: t('wiz.team.agentN', { n }), roleKey: 'general', adapter: first?.adapter ?? '', model: pick?.model ?? '', ...(pick?.endpointProfile ? { endpointProfile: pick.endpointProfile } : {}) }]);
  };

  const applyTeam = async (): Promise<void> => {
    if (problems.length > 0) return;
    setBusy(true);
    setError(null);
    const { agents, ids } = teamPayload(rows, t);
    const res = await window.visione.setup.apply({ agents, archiveOthers: true });
    if (!res.ok) {
      setBusy(false);
      return setError(t('wiz.err.apply', { error: errText(res.error) }));
    }
    const boss = rows.find((r) => r.key === commander)!;
    const cfg = await window.visione.config.update({ director: { plannerAgentId: ids.get(boss.key) }, ui: { directorName: boss.name.trim() } });
    setBusy(false);
    if (!cfg.ok) return setError(t('wiz.err.commander', { error: errText(cfg.error) }));
    onDirectorName(boss.name.trim());
    setApplied({ ids, names: new Map(rows.map((r) => [ids.get(r.key)!, r.name.trim()])) });
    setStep(3);
  };

  // --- Voce ------------------------------------------------------------------------------------
  const voices = useMemo(() => {
    const windowsVoices = voiceChoices(installedVoices, language).map((v) => ({ value: v.name, label: `${v.name.replace(/^Microsoft /, '')} — Windows` }));
    // In sviluppo restano anche le voci di Edge (solo italiane, uso personale P-84).
    return edition === 'tester' || language !== 'it' ? windowsVoices : [...windowsVoices, ...IT_VOICES.filter((v) => !/Windows/.test(v.label))];
  }, [installedVoices, language, edition]);
  // Una voce di un'altra lingua non va bene: si propone la prima della lingua scelta.
  useEffect(() => {
    if (voices.length > 0 && !voices.some((v) => v.value === voice)) setVoice(voices[0]!.value);
  }, [voices, voice]);
  // Prova del PC all'ingresso nel passo (una volta; «Rifai la prova» la ripete). Il consiglio preseleziona il
  // profilo solo se il proprietario non ne ha già scelto uno.
  const runBench = useCallback(async () => {
    setBench({ phase: 'running' });
    const res = await window.visione.voice.benchmark();
    if (res.ok) {
      setBench({ phase: 'done', rtf: res.data.rtf, reason: res.data.reason, recommended: res.data.recommended, runtime: res.data.runtime });
      setProfile((p) => p ?? res.data.recommended);
    } else {
      setBench({ phase: 'failed', reason: errText(res.error) });
      setProfile((p) => p ?? 'light');
    }
  }, []);
  useEffect(() => {
    if (step === 3 && bench === null) void runBench();
  }, [step, bench, runBench]);
  // In inglese la voce VISIONE non c'è: una Completa già scelta diventa Leggera.
  useEffect(() => {
    if (profile !== null && !profileAvailable(profile, language)) setProfile('light');
  }, [profile, language]);
  const recommended: VoiceProfile | null = bench?.phase === 'done' ? bench.recommended : bench?.phase === 'failed' ? 'light' : null;
  const benchText = (): string => {
    if (bench === null || bench.phase === 'running') return t('wiz.voice.bench.running');
    if (bench.phase === 'failed' || bench.rtf === null) return t('wiz.voice.bench.failed', { reason: bench.reason ?? '?' });
    const x = speedTimes(bench.rtf, language);
    return x === null ? t('wiz.voice.bench.slow') : t('wiz.voice.bench.fast', { x });
  };

  /**
   * Scrive il profilo (motore del parlato e «hey visione») e riavvia la voce, che li legge all'avvio.
   * `not-saved` = configurazione rifiutata; `not-started` = salvata ma la voce non è ripartita in tempo.
   */
  const applyProfile = async (p: VoiceProfile): Promise<'ok' | 'not-saved' | 'not-started'> => {
    const key = profileKey(p, voice);
    if (appliedVoice === key) return 'ok';
    setVoiceNote(t('wiz.voice.preparing'));
    const cfg = await window.visione.config.update(profilePatch(p, voice));
    if (!cfg.ok) {
      setVoiceNote(t('wiz.voice.notSaved', { error: errText(cfg.error) }));
      return 'not-saved';
    }
    const ok = await restartVoice();
    if (!ok) {
      setVoiceNote(t('wiz.voice.notStarted'));
      return 'not-started';
    }
    setAppliedVoice(key);
    setVoiceNote(null);
    return 'ok';
  };
  const nextFromVoice = async (): Promise<void> => {
    if (profile === null) return;
    setBusy(true);
    const outcome = await applyProfile(profile);
    setBusy(false);
    // Salvato ma la voce non è ripartita: si va avanti lo stesso, la verifica finale lo mostra.
    if (outcome !== 'not-saved') setStep(4);
  };
  const listen = async (): Promise<void> => {
    if (profile === null) return;
    setBusy(true);
    if ((await applyProfile(profile)) !== 'ok') {
      setBusy(false);
      return;
    }
    const name = applied?.names.get(applied.ids.get(commander ?? '') ?? '') ?? 'VISIONE';
    const said = await window.visione.voice.speak(t('wiz.voice.sample', { name }));
    setBusy(false);
    setVoiceNote(said.ok ? t('wiz.voice.listenHint') : t('wiz.voice.notSpoken', { error: errText(said.error) }));
  };

  // --- Verifica finale -------------------------------------------------------------------------
  const verifying = Object.values(checks).some((c) => c.state === 'in-corso');
  const verify = async (): Promise<void> => {
    if (!applied) return;
    setError(null);
    verifyRef.current?.off();
    setPending([]);
    const agentIds = [...applied.ids.values()];
    const team = new Set(agentIds);
    const status = await window.visione.voice.modelsStatus();
    const hearing: CheckState = status.ok && status.data.complete ? { state: 'ok', detail: t('wiz.verify.hearingOk') } : { state: 'errore', detail: t('wiz.verify.hearingMissing') };
    const initial: Record<string, CheckState> = { voce: { state: 'in-corso', detail: t('wiz.verify.voiceTrying') }, ascolto: hearing };
    for (const id of agentIds) initial[id] = { state: 'in-corso', detail: t('wiz.verify.sending') };
    setChecks(initial);
    const byTask = new Map<string, string>();
    const settled = new Set<string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    // Un agente il cui requisito manca (es. la chiave per i suoi modelli) fallisce con un motivo tecnico
    // («uscito con codice 1», VM 18/10/2026): davanti si dice cosa manca e dove si sistema.
    const hints = new Map<string, string>();
    for (const r of rows) {
      const id = applied.ids.get(r.key);
      const miss = missingFor(engines, r.adapter, r.endpointProfile);
      if (id && miss.length > 0) hints.set(id, t('wiz.team.notReady', { list: miss.map((m) => m.label).join(', ') }));
    }
    // Un turno per motore e modello: gli altri agenti dello stesso motore e modello prendono l'esito di chi lo prova.
    const groups = verifyGroups(rows, applied.ids, commander);
    const followers = new Set([...groups.values()].flat());
    const nameOf = (id: string): string => applied.names.get(id) ?? id;
    const set = (id: string, given: CheckState): void => {
      if (settled.has(id)) return;
      const hint = given.state === 'errore' ? hints.get(id) : undefined;
      const c: CheckState = hint ? { state: 'errore', detail: `${hint} — ${given.detail}` } : given;
      if (c.state === 'ok' || c.state === 'errore') {
        settled.add(id);
        clearTimeout(timers.get(id));
      }
      setChecks((prev) => ({ ...prev, [id]: c }));
      if (c.state !== 'ok' && c.state !== 'errore') return;
      for (const m of groups.get(id) ?? []) {
        if (hints.has(m)) continue;
        set(m, c.state === 'ok'
          ? { state: 'ok', detail: t('wiz.verify.sameOk', { name: nameOf(id) }) }
          : { state: 'errore', detail: t('wiz.verify.sameFail', { name: nameOf(id), detail: c.detail }) });
      }
    };
    const pause = (id: string): void => clearTimeout(timers.get(id));
    const arm = (id: string): void => {
      pause(id);
      timers.set(id, setTimeout(() => set(id, { state: 'errore', detail: t('wiz.verify.timeout') }), VERIFY_TIMEOUT_MS));
    };
    const ask = (a: PendingApproval): void => {
      pause(a.agentId);
      setPending((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a]));
      set(a.agentId, { state: 'in-corso', detail: t('wiz.verify.waitingYou') });
    };
    const offEvents = window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.type === 'task.result.recorded') {
        const p = e.payload as { taskId: string; outcome: 'success' | 'partial' | 'failure'; summary: string; producedBy: string };
        const id = byTask.get(p.taskId);
        if (id) set(id, verifyOutcome(p.outcome, p.summary, p.producedBy, id, applied.names, t));
      } else if (e.type === 'task.status.changed') {
        const p = e.payload as { taskId: string; to: string; reason: string };
        const id = byTask.get(p.taskId);
        const c = id ? verifyStatus(p.to, p.reason, t) : null;
        if (id && c) set(id, c);
      } else if (e.type === 'approval.requested') {
        const p = e.payload as { approvalId: string; kind: string; target: string; reason: string; agentId: string | null };
        if (p.agentId && team.has(p.agentId)) ask({ id: p.approvalId, agentId: p.agentId, kind: p.kind, target: p.target, reason: p.reason });
      }
    });
    verifyRef.current = { arm, pause, set, off: () => { offEvents(); for (const x of timers.values()) clearTimeout(x); } };
    // Chi non è pronto non si prova (VM, 18/10/2026: il Director senza accesso al suo motore restava «sta rispondendo»
    // fino al tempo massimo di 4 minuti, con «Indietro» spento): si dice subito cosa manca.
    const tried = agentIds.filter((id) => !hints.has(id) && !followers.has(id));
    for (const id of agentIds) if (hints.has(id)) set(id, { state: 'errore', detail: t('wiz.verify.skipped') });
    for (const [rep, members] of groups) for (const m of members) if (!hints.has(m)) set(m, { state: 'in-corso', detail: t('wiz.verify.sameWaiting', { name: nameOf(rep) }) });
    for (const id of tried) arm(id);
    // Richieste fatte prima di questa verifica (es. un tentativo precedente) e ancora in attesa.
    const open = await window.visione.approvals.list({ status: 'pending', limit: 50 });
    if (open.ok) for (const a of open.data.approvals) if (a.agentId && team.has(a.agentId)) ask({ id: a.id, agentId: a.agentId, kind: a.kind, target: a.target, reason: a.reason });
    await Promise.all(tried.map(async (agentId) => {
      const res = await window.visione.agents.tell({ agentId, text: t('wiz.verify.question'), title: t('wiz.verify.taskTitle') });
      if (!res.ok) return set(agentId, { state: 'errore', detail: t('wiz.verify.notSent', { error: errText(res.error) }) });
      for (const x of res.data.taskIds) byTask.set(x, agentId);
      byTask.set(res.data.taskId, agentId);
      const waiting = t('wiz.verify.waitingYou');
      setChecks((prev) => (prev[agentId]?.detail === waiting ? prev : { ...prev, [agentId]: { state: 'in-corso', detail: t('wiz.verify.answering') } }));
    }));
    set('voce', { state: 'in-corso', detail: t('wiz.verify.voiceWaiting') });
    await waitVoiceReady();
    const said = await window.visione.voice.speak(t('wiz.verify.sayCheck'));
    set('voce', said.ok ? { state: 'ok', detail: t('wiz.verify.voiceOk') } : { state: 'errore', detail: t('wiz.voice.notSpoken', { error: errText(said.error) }) });
  };

  const decide = async (a: PendingApproval, decision: 'grant' | 'deny'): Promise<void> => {
    // La stessa decisione vale per le richieste uguali (stesso agente, tipo e oggetto).
    const same = pending.filter((x) => sameRequest(x, a));
    const results = await Promise.all(same.map((x) => window.visione.approvals.decide(x.id, decision, t('wiz.approval.decisionNote'))));
    setPending((prev) => prev.filter((x) => !sameRequest(x, a)));
    const v = verifyRef.current;
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) return setError(t('wiz.err.decision', { error: errText(failed.error) }));
    if (decision === 'grant') {
      v?.arm(a.agentId);
      v?.set(a.agentId, { state: 'in-corso', detail: t('wiz.verify.granted') });
    } else {
      v?.set(a.agentId, { state: 'errore', detail: t('wiz.verify.denied') });
    }
  };

  const allOk = applied !== null && ['voce', 'ascolto', ...applied.ids.values()].every((id) => checks[id]?.state === 'ok');
  useEffect(() => {
    if (!allOk || done) return;
    void window.visione.config.update({ setup: { completedVersion: SETUP_VERSION } }).then((res) => {
      if (res.ok) setDone(true);
      else setError(t('wiz.err.state', { error: errText(res.error) }));
    });
  }, [allOk, done, t]);
  // Finire lo stesso (17/10/2026, collaudo da tester): se chi comanda risponde VISIONE lavora già. Un modello fermo
  // presso il fornitore o i modelli d'ascolto non scaricati non devono bloccare la procedura, che si riapriva a ogni avvio.
  const commanderId = applied?.ids.get(commander ?? '') ?? null;
  const canFinishAnyway = !allOk && !done && !verifying && commanderId !== null && checks[commanderId]?.state === 'ok';
  const missing = applied === null ? [] : [
    ...[...applied.ids.values()].filter((id) => checks[id]?.state !== 'ok').map((id) => applied.names.get(id) ?? id),
    ...(checks.voce?.state === 'ok' ? [] : [t('wiz.verify.voice')]),
    ...(checks.ascolto?.state === 'ok' ? [] : [t('wiz.verify.hearing')])
  ];
  const finishAnyway = async (): Promise<void> => {
    const res = await window.visione.config.update({ setup: { completedVersion: SETUP_VERSION } });
    if (!res.ok) return setError(t('wiz.err.state', { error: errText(res.error) }));
    setDone(true);
  };
  // Modelli d'ascolto scaricati dalla Verifica (VM, 22/10/2026: il tester doveva tornare indietro di tre passi): la
  // riga diventa verde senza rifare la prova degli agenti.
  useEffect(() => {
    if (models?.complete && checks.ascolto?.state === 'errore') setChecks((prev) => ({ ...prev, ascolto: { state: 'ok', detail: t('wiz.verify.hearingOk') } }));
  }, [models?.complete, checks.ascolto?.state, t]);
  // «Qualcosa non risponde» riguarda gli agenti: voce e ascolto si sistemano sulla loro riga.
  const agentFailed = applied !== null && [...applied.ids.values()].some((id) => checks[id]?.state === 'errore');

  // --- Accesso nel terminale -------------------------------------------------------------------
  const openLogin = async (adapter: string): Promise<void> => {
    // Il programma di accesso parte direttamente (non da PowerShell, che blocca gli script di npm).
    const res = await window.visione.setup.login(adapter, 110, 26);
    if (!res.ok) return setError(t('wiz.err.login', { error: errText(res.error) }));
    setTerminal(res.data.session);
    setTerminalFor('login');
  };

  // Il terminale di VISIONE (accesso o «Installa»), nel passo da cui è partito.
  const terminalView = terminal && (
    <div className="setup-terminal" data-testid="setup-terminal">
      <p className="muted small">{t(terminalFor === 'login' ? 'wiz.engines.terminalNote' : 'wiz.install.terminalNote')}</p>
      <TerminalPane session={terminal} />
      <button type="button" onClick={() => { void window.visione.terminal.close(terminal.processId); setTerminal(null); endInstall(); void detect(); afterInstall.current?.(); afterInstall.current = null; }}>{t('wiz.engines.closeTerminal')}</button>
    </div>
  );

  const canNext = step === 0 || (step === 1 && anyReady) || step === 3;
  return (
    <div className="setup-backdrop" role="dialog" aria-modal="true" aria-label={t('wiz.aria')} data-testid="setup-wizard" hidden={!coreReady}>
      <section className="setup-box">
        <header className="setup-head">
          <h2>{t('wiz.title')}</h2>
          <ol className="setup-steps">
            {STEP_KEYS.map((k, i) => <li key={k} className={i === step ? 'attuale' : i < step ? 'fatto' : ''}>{i + 1}. {t(k)}</li>)}
          </ol>
          <button type="button" className="setup-close" onClick={() => onClose(done)} title={t('wiz.close')}>×</button>
        </header>

        {step === 0 && (
          <div className="setup-body" data-testid="setup-step-benvenuto">
            <label className="setup-voice">{t('wiz.language')}
              <select value={language} onChange={(ev) => onLanguage(ev.target.value as Language)} data-testid="setup-language">
                {(Object.keys(LANGUAGE_NAMES) as Language[]).map((l) => <option key={l} value={l}>{LANGUAGE_NAMES[l]}</option>)}
              </select>
            </label>
            <p className="setup-lead">{t('wiz.welcome.lead')}</p>
            {/* I passi del piano sono le schede 2-6 qui sopra: la numerazione deve coincidere. */}
            <ol className="setup-plan" start={2}>
              <li><b>{t('wiz.step.engines')}</b>: {t('wiz.welcome.engines')}</li>
              <li><b>{t('wiz.step.team')}</b>: {t('wiz.welcome.team')}</li>
              <li><b>{t('wiz.step.voice')}</b>: {t('wiz.welcome.voice')}</li>
              <li><b>{t('wiz.step.offline')}</b>: {t('wiz.welcome.offline')}</li>
              <li><b>{t('wiz.step.verify')}</b>: {t('wiz.welcome.verify')}</li>
            </ol>
            <p className="muted">{t('wiz.welcome.cost')}</p>
          </div>
        )}

        {step === 1 && (
          <div className="setup-body" data-testid="setup-step-motori">
            <p className="setup-lead">{t('wiz.engines.lead')}</p>
            {engines === null && <p className="muted">{detecting ? t('wiz.engines.checking') : t('wiz.engines.noData')}</p>}
            {(engines ?? []).map((e) => (
              <article key={e.adapter} className={`setup-engine ${engineReady(engines, e.adapter) ? 'pronto' : ''}`} data-testid={`setup-engine-${e.adapter}`}>
                <h3>{labelOf(e.adapter)} <span className={engineReady(engines, e.adapter) ? 'ok' : 'bad'}>{engineReady(engines, e.adapter) ? t('wiz.engines.ready') : t('wiz.engines.todo')}</span></h3>
                {e.items.map((item) => <SetupItemView key={item.id} t={t} adapter={e.adapter} item={item} onChanged={() => void detect()} onLogin={() => void openLogin(e.adapter)} installing={installing !== null} running={installing?.key === `${e.adapter}:${item.id}`} onInstall={() => void openInstall(e.adapter, item)} />)}
                {profilesMissing(engines, e.adapter).length > 0 && <p className="warn small" data-testid={`setup-profiles-${e.adapter}`}>{t('wiz.engines.needProfile', { list: profilesMissing(engines, e.adapter).map((i) => i.label).join(t('wiz.engines.or')) })}</p>}
              </article>
            ))}
            {installNote && <p className={installNote.ok ? 'ok small' : 'warn small'} role="status" data-testid="setup-install-note">{installNote.text}</p>}
            {installing?.admin && <p className="setup-uac" role="status" data-testid="setup-install-uac">{t('wiz.install.uac')}</p>}
            {terminalFor !== 'runtime' && terminalView}
            <button type="button" onClick={() => void detect()} disabled={detecting} data-testid="setup-redetect">{detecting ? t('wiz.engines.rechecking') : t('wiz.engines.recheck')}</button>
            {!anyReady && engines !== null && <p className="warn small">{t('wiz.engines.needOne')}</p>}
          </div>
        )}

        {step === 2 && (
          <div className="setup-body" data-testid="setup-step-squadra">
            <p className="setup-lead">{t(customTeam ? 'wiz.team.lead' : 'wiz.team.leadSimple')}</p>
            {catalogLoading && <p className="muted small" data-testid="setup-catalog-probing">{t('wiz.team.probing')}</p>}
            {!customTeam && (
              <>
                <ul className="setup-team-summary" data-testid="setup-team-summary">
                  {rows.map((r) => {
                    const missing = missingFor(engines, r.adapter, r.endpointProfile);
                    // «Esecutore — scrive ed esegue codice»: se il nome è già quello del ruolo, resta la descrizione.
                    const role = roleText(r.roleKey, t).label;
                    const what = role.startsWith(`${r.name.trim()} — `) ? role.slice(r.name.trim().length + 3) : role;
                    return (
                      <li key={r.key} data-testid="setup-summary-row">
                        <b>{r.name}</b>{commander === r.key ? <span className="setup-in-charge"> · {t('wiz.team.inCharge')}</span> : null}
                        <span> — {what}</span>
                        <span className="muted small"> · {catalogs.find((c) => c.adapter === r.adapter)?.label ?? r.adapter}, {entryOf(catalogs, r)?.label ?? r.model}</span>
                        {missing.length > 0 && <div className="warn small">{t('wiz.team.notReady', { list: missing.map((m) => m.label).join(', ') })}</div>}
                      </li>
                    );
                  })}
                </ul>
                <button type="button" onClick={() => setCustomTeam(true)} disabled={catalogs.length === 0} data-testid="setup-customize">{t('wiz.team.customize')}</button>
              </>
            )}
            {customTeam && catalogs.length > 0 && (
              <div className="setup-preset">
                <span>{t('wiz.team.suggested')} <b>{teamLabel(catalogs, suggestedTeam(usable, t), t)}</b></span>
                <button type="button" onClick={() => { const team = suggestedTeam(usable, t); setRows(team); setCommander(team.find((r) => r.roleKey === 'director')?.key ?? team[0]?.key ?? null); }} data-testid="setup-preset">{t('wiz.team.useIt')}</button>
              </div>
            )}
            {customTeam && <table className="setup-team">
              <thead><tr><th>{t('wiz.team.col.commands')}</th><th>{t('wiz.team.col.name')}</th><th>{t('wiz.team.col.role')}</th><th>{t('wiz.team.col.engine')}</th><th>{t('wiz.team.col.model')}</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const models = catalogs.find((c) => c.adapter === r.adapter)?.models ?? [];
                  const groups = [...new Set(models.map((m) => m.group))];
                  const missing = missingFor(engines, r.adapter, r.endpointProfile);
                  return (
                    <tr key={r.key} data-testid="setup-row">
                      <td><input type="radio" name="comanda" checked={commander === r.key} onChange={() => setCommander(r.key)} aria-label={t('wiz.team.commandsAria', { name: r.name })} /></td>
                      <td><input value={r.name} maxLength={40} onChange={(ev) => update(r.key, { name: ev.target.value })} aria-label={t('wiz.team.nameAria')} data-testid="setup-name" /></td>
                      <td>
                        <select value={r.roleKey} onChange={(ev) => update(r.key, { roleKey: ev.target.value as RoleKey })} aria-label={t('wiz.team.col.role')}>
                          {ROLE_ORDER.map((k) => <option key={k} value={k}>{roleText(k, t).label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={r.adapter} onChange={(ev) => chooseAdapter(r, ev.target.value)} aria-label={t('wiz.team.col.engine')} data-testid="setup-adapter">
                          {catalogs.map((c) => <option key={c.adapter} value={c.adapter}>{c.label}</option>)}
                        </select>
                        {missing.length > 0 && <div className="warn small">{t('wiz.team.notReady', { list: missing.map((m) => m.label).join(', ') })}</div>}
                      </td>
                      <td>
                        <select value={r.model} onChange={(ev) => chooseModel(r, ev.target.value)} aria-label={t('wiz.team.col.model')} data-testid="setup-model">
                          {models.length === 0 && <option value="">{t('wiz.team.noModels')}</option>}
                          {/* Il modello di un agente già applicato resta visibile anche se il catalogo non lo propone più. */}
                          {r.model && !models.some((m) => m.model === r.model) && <option value={r.model}>{r.model}</option>}
                          {groups.map((g) => (
                            <optgroup key={g} label={g}>
                              {models.filter((m) => m.group === g).map((m) => <option key={m.model} value={m.model}>{m.recommended ? '★ ' : ''}{m.label}</option>)}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td><button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} title={t('wiz.team.remove')} aria-label={t('wiz.team.remove')}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>}
            {customTeam && <button type="button" onClick={addRow} disabled={rows.length >= 10 || catalogs.length === 0}>{t('wiz.team.add')}</button>}
            {problems.length > 0 && <ul className="warn small setup-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            <p className="muted small">{t('wiz.team.note')}</p>
          </div>
        )}

        {step === 3 && (
          <div className="setup-body" data-testid="setup-step-voce">
            <p className="setup-lead">{t('wiz.voice.lead')}</p>
            <div className={`setup-bench ${bench?.phase ?? 'running'}`} role="status" data-testid="setup-bench">
              <span>{benchText()}</span>
              {bench !== null && bench.phase !== 'running' && (
                <button type="button" onClick={() => void runBench()} disabled={busy} data-testid="setup-bench-retry">{t('wiz.voice.bench.retry')}</button>
              )}
            </div>
            {bench?.phase === 'done' && bench.runtime && (
              <article className="setup-engine" data-testid="setup-runtime">
                <SetupItemView t={t} adapter="visione" item={bench.runtime} onChanged={() => void runBench()} onLogin={() => undefined} installing={installing !== null} running={installing?.key === `visione:${bench.runtime.id}`} onInstall={() => void openInstall('visione', bench.runtime!, () => { void restartVoice().then(() => runBench()); })} />
              </article>
            )}
            {terminalFor === 'runtime' && installNote && <p className={installNote.ok ? 'ok small' : 'warn small'} role="status">{installNote.text}</p>}
            {terminalFor === 'runtime' && installing?.admin && <p className="setup-uac" role="status">{t('wiz.install.uac')}</p>}
            {terminalFor === 'runtime' && terminalView}
            <div className="setup-profiles" role="radiogroup" aria-label={t('wiz.voice.profile.aria')}>
              {VOICE_PROFILES.map((p) => {
                const available = profileAvailable(p, language);
                return (
                  <label key={p} className={`setup-profile${profile === p ? ' scelto' : ''}${available ? '' : ' spento'}`} data-testid={`setup-profile-${p}`}>
                    <input type="radio" name="setup-voice-profile" value={p} checked={profile === p} disabled={!available || busy} onChange={() => setProfile(p)} />
                    <span className="setup-profile-name">
                      {t(`wiz.voice.profile.${p}.name` as const)}
                      {recommended === p && <em className="setup-profile-tag" data-testid="setup-profile-recommended">{t('wiz.voice.profile.recommended')}</em>}
                    </span>
                    <span className="setup-profile-what">{t(`wiz.voice.profile.${p}.what` as const)}</span>
                    <span className="muted small">{available ? t(`wiz.voice.profile.${p}.desc` as const) : t('wiz.voice.profile.itOnly')}</span>
                  </label>
                );
              })}
            </div>
            {profile !== null && PROFILE_SETTINGS[profile].provider === 'windows' && (
              <label className="setup-voice">{t('wiz.voice.voice')}
                <select value={voice} onChange={(ev) => setVoice(ev.target.value)} disabled={busy} data-testid="setup-voice">
                  {voices.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
              </label>
            )}
            <button type="button" onClick={() => void listen()} disabled={busy || profile === null} data-testid="setup-listen">{t('wiz.voice.listen')}</button>
            {voiceNote && <p className="muted" data-testid="setup-voice-note">{voiceNote}</p>}
            {profile !== null && PROFILE_SETTINGS[profile].provider === 'windows' && <p className="muted small">{t('wiz.voice.windowsNote')}</p>}
            {profile === 'full' && <p className="muted small">{t('wiz.voice.bench.battery')}</p>}
            <div className={`setup-models ${models?.complete ? 'pronto' : ''}`} data-testid="setup-models">
              <b>{t('wiz.hearing.title')}</b>
              {models === null && <span className="muted">{t('wiz.hearing.checking')}</span>}
              {models?.complete && <span className="ok" data-testid="setup-models-ok">{t('wiz.hearing.ready')}</span>}
              {models && !models.complete && (
                <>
                  <span className="muted">
                    {t('wiz.hearing.need', { list: models.missing.map((m) => t('wiz.hearing.license', { id: m.id, license: m.license })).join('; '), mb: mb(models.missing.reduce((n, m) => n + m.size, 0)) })}
                  </span>
                  {download && downloading ? (
                    <span data-testid="setup-models-progress">{downloadProgress(download)}</span>
                  ) : (
                    <button type="button" className="setup-primary" onClick={() => void startDownload()} data-testid="setup-models-download">{t('wiz.hearing.download')}</button>
                  )}
                  {download?.phase === 'errore' && <span className="bad small">{download.error}</span>}
                </>
              )}
            </div>
            <SetupListening hearingReady={models?.complete ?? false} />
          </div>
        )}

        {step === 4 && (
          <div className="setup-body" data-testid="setup-step-offline">
            <p className="setup-lead">{t('wiz.offline.lead')}</p>
            <p className="muted small">{t('offline.notice.not')} {t('offline.notice.slow')}</p>
            <OfflineModelBox />
            <p className="muted small">{t('wiz.offline.later')}</p>
          </div>
        )}

        {step === VERIFY_STEP && (
          <div className="setup-body" data-testid="setup-step-verifica">
            <p className="setup-lead">{t('wiz.verify.lead')}</p>
            {uniqueRequests(pending).map((a) => {
              const text = approvalText(a, applied?.names.get(a.agentId) ?? a.agentId, t);
              return (
                <div key={a.id} className="setup-approval" data-testid="setup-approval">
                  <b>{text.title}</b>
                  <span className="muted">{text.body}</span>
                  <div className="setup-key">
                    <button type="button" className="setup-primary" onClick={() => void decide(a, 'grant')} data-testid="setup-approval-grant">{t('wiz.verify.allow')}</button>
                    <button type="button" onClick={() => void decide(a, 'deny')}>{t('wiz.verify.deny')}</button>
                  </div>
                </div>
              );
            })}
            <ul className="setup-checks">
              {applied && [...applied.ids.values()].map((id) => <CheckRow key={id} label={applied.names.get(id) ?? id} check={checks[id]} t={t} />)}
              <CheckRow label={t('wiz.verify.voice')} check={checks.voce} t={t} />
              <CheckRow label={t('wiz.verify.hearing')} check={checks.ascolto} t={t}>
                {checks.ascolto?.state === 'errore' && models && !models.complete && (download && downloading
                  ? <span className="small" data-testid="setup-verify-hearing-progress">{downloadProgress(download)}</span>
                  : <button type="button" className="small" onClick={() => void startDownload()} data-testid="setup-verify-hearing-download">{t('wiz.verify.hearingDownload', { mb: mb(models.missing.reduce((n, m) => n + m.size, 0)) })}</button>)}
                {checks.ascolto?.state === 'errore' && download?.phase === 'errore' && <span className="bad small">{download.error}</span>}
              </CheckRow>
            </ul>
            {!verifying && !done && <button type="button" onClick={() => void verify()} data-testid="setup-verify">{Object.keys(checks).length > 0 ? t('wiz.verify.retry') : t('wiz.verify.start')}</button>}
            {done && <p className="ok setup-lead" data-testid="setup-done">{missing.length === 0 ? t('wiz.verify.done') : t('wiz.verify.donePartial', { list: missing.join(', ') })}</p>}
            {/* Solo a verifica finita (VM, 22/10/2026: con l'Ascolto rosso compariva mentre gli agenti rispondevano ancora). */}
            {!done && !verifying && agentFailed && (
              <p className="warn small">{t('wiz.verify.someFailed')}</p>
            )}
            {canFinishAnyway && (
              <div className="setup-partial">
                <p className="small">{t('wiz.verify.canFinish')}</p>
                <button type="button" className="setup-primary" onClick={() => void finishAnyway()} data-testid="setup-finish-anyway">{t('wiz.verify.finishAnyway')}</button>
              </div>
            )}
          </div>
        )}

        {error && <p className="error small" data-testid="setup-error">{error}</p>}

        <footer className="setup-actions">
          {step > 0 && !done && <button type="button" onClick={() => { setError(null); setStep(step === VERIFY_STEP ? 2 : step - 1); }} disabled={busy || verifying}>{t('wiz.back')}</button>}
          {step === 0 && <button type="button" onClick={() => onClose(false)}>{t('wiz.later')}</button>}
          {step < 2 && <button type="button" className="setup-primary" onClick={() => setStep(step + 1)} disabled={!canNext}>{step === 0 ? t('wiz.start') : t('wiz.next')}</button>}
          {step === 2 && <button type="button" className="setup-primary" onClick={() => void applyTeam()} disabled={busy || catalogLoading || problems.length > 0} data-testid="setup-apply">{busy ? t('wiz.applying') : t('wiz.apply')}</button>}
          {step === 3 && <button type="button" className="setup-primary" onClick={() => void nextFromVoice()} disabled={busy || profile === null} data-testid="setup-voice-next">{t('wiz.next')}</button>}
          {step === 4 && <button type="button" className="setup-primary" onClick={() => setStep(VERIFY_STEP)} data-testid="setup-offline-next">{offlineModel === 'missing' ? t('wiz.offline.skip') : t('wiz.next')}</button>}
          {step === VERIFY_STEP && done && <button type="button" className="setup-primary" onClick={() => onClose(true)} data-testid="setup-finish">{t('wiz.finish')}</button>}
        </footer>
      </section>
    </div>
  );
}

function CheckRow({ label, check, t, children }: { label: string; check: CheckState | undefined; t: Translate; children?: ReactNode }) {
  const state = check?.state ?? 'attesa';
  return (
    <li className={`setup-check ${state}`} data-testid="setup-check">
      <span className="setup-dot" aria-hidden="true" />
      <b>{label}</b> <span className="muted">{check?.detail ?? t('wiz.verify.pending')}</span>
      {children ? <span className="setup-check-action">{children}</span> : null}
    </li>
  );
}

function SetupItemView({ t, adapter, item, onChanged, onLogin, onInstall, installing, running }: { t: Translate; adapter: string; item: SetupItem; onChanged: () => void; onLogin: () => void; onInstall: () => void; installing: boolean; running: boolean }) {
  const [key, setKey] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const copy = (text: string): void => {
    // P-105: se gli appunti rifiutano, lo si dice (prima l'errore restava invisibile e il pulsante muto).
    void navigator.clipboard.writeText(text).then(() => {
      setCopyFailed(null);
      setCopied(text);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2_000);
    }, () => setCopyFailed(text));
  };
  const envName = item.action?.kind === 'env-key' ? item.action.envName : null;
  const manual = (
    <>
      {item.steps.length > 0 && <ol className="setup-guide">{item.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      {item.commands.map((c) => (
        <div key={c} className="setup-cmd"><code>{c}</code><button type="button" onClick={() => copy(c)}>{copied === c ? t('wiz.item.copied') : t('wiz.item.copy')}</button></div>
      ))}
      {item.link && <div className="setup-cmd"><code>{item.link}</code><button type="button" onClick={() => copy(item.link!)}>{copied === item.link ? t('wiz.item.copied') : t('wiz.item.copyLink')}</button></div>}
    </>
  );
  const save = async (): Promise<void> => {
    if (!envName || !key.trim()) return;
    setWorking(true);
    const res = await window.visione.setup.saveKey(adapter, envName, key.trim());
    setWorking(false);
    setKey('');
    if (!res.ok) return setNote({ ok: false, text: errText(res.error) });
    setNote({ ok: res.data.saved, text: res.data.saved ? t('wiz.item.keySaved', { detail: res.data.check.detail }) : res.data.check.detail });
    if (res.data.saved) onChanged();
  };
  const check = async (): Promise<void> => {
    if (!envName) return;
    setWorking(true);
    const res = await window.visione.setup.verifyKey(adapter, envName);
    setWorking(false);
    setNote(res.ok ? { ok: res.data.ok, text: res.data.detail } : { ok: false, text: errText(res.error) });
  };
  return (
    <div className={`setup-item ${item.ok ? 'ok' : item.optional ? 'facoltativo' : 'manca'}`} data-testid={`setup-item-${item.id}`}>
      <div className="setup-item-head">
        <span className="setup-dot" aria-hidden="true" />
        <b>{item.label}</b>{item.optional && !item.ok && <span className="muted small"> {t('wiz.item.optional')}</span>}
        <span className="muted"> — {item.detail}</span>
      </div>
      {!item.ok && item.action?.kind === 'install' && (
        <div className="setup-install">
          <button type="button" className="setup-primary" onClick={onInstall} disabled={installing} data-testid={`setup-install-${adapter}-${item.id}`}>{item.action.verb === 'enable' ? (running ? t('wiz.enable.running') : t('wiz.enable.button')) : (running ? t('wiz.install.running') : t('wiz.install.button'))}</button>
          <span className="muted small">{t(item.action.verb === 'enable' ? 'wiz.enable.source' : 'wiz.install.source', { source: item.action.source })}{item.action.admin ? ` ${t('wiz.install.admin')}` : ''}</span>
        </div>
      )}
      {/* Con «Installa» i passi a mano restano, piegati, per chi preferisce farlo da sé. */}
      {!item.ok && (item.action?.kind === 'install' ? (
        <details className="setup-manual"><summary className="small">{t('wiz.install.manual')}</summary>{manual}</details>
      ) : manual)}
      {copyFailed && <p className="error small">{t('wiz.item.copyFailed')}</p>}
      {item.action?.kind === 'login-terminal' && !item.ok && <button type="button" className="setup-primary" onClick={onLogin} data-testid="setup-login">{t('wiz.item.login')}</button>}
      {envName && (
        <div className="setup-key">
          {!item.ok && (
            <>
              <input type="password" value={key} onChange={(ev) => setKey(ev.target.value)} placeholder={t('wiz.item.keyPlaceholder')} autoComplete="off" spellCheck={false} aria-label={t('wiz.item.keyAria')} data-testid="setup-key-input" />
              <button type="button" className="setup-primary" onClick={() => void save()} disabled={working || !key.trim()} data-testid="setup-key-save">{working ? t('wiz.item.verifying') : t('wiz.item.saveKey')}</button>
            </>
          )}
          {item.ok && <button type="button" onClick={() => void check()} disabled={working} data-testid="setup-key-check">{working ? t('wiz.item.verifying') : t('wiz.item.checkKey')}</button>}
          {note && <span className={note.ok ? 'ok small' : 'bad small'} data-testid="setup-key-note">{note.text}</span>}
        </div>
      )}
    </div>
  );
}
