// Cassetti Memory e Settings (VISIONE_ARCHITECTURE §26). Solo comandi al core; il testo scritto dagli
// agenti si mostra come testo (mai HTML). P-94: Impostazioni comprensibili — etichette in italiano,
// spiegazione breve e tooltip per ogni campo, sezioni chiare; la mappatura etichette→config è pura
// (`settings-meta.ts`) e i campi mappano solo la configurazione reale (`config.get`/`config.update`).
import { useEffect, useId, useRef, useState } from 'react';
import type { AgentView, CommandError, CommandResult, Edition, MemoryItem, MemoryScope, VoiceProfile } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { expertOf, settingVisible } from '../lib/mode.ts';
import { sceneOf, type SceneVariant } from '../neural/renderer3d.ts';
import { profileAvailable, profileOf, profilePatch, speedTimes, VOICE_PROFILES } from './voice-profile.ts';
import { restartVoice } from './voice-restart.ts';
import { OfflineSettings } from './OfflineControls.tsx';
import { ExpertConfirm } from './ExpertConfirm.tsx';
import { clampLinger, leaves, MODEL_PATHS, modelSuggestions, nodeLingerOf, NODE_LINGER_MAX_SEC, NODE_LINGER_MIN_SEC, optionsFor, settingMeta, settingsBySection, trustedAgentsOf, withTrust, type SettingLeaf } from './settings-meta.ts';

export function MemoryDrawer({ ready }: { ready: boolean }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  const [form, setForm] = useState<{ scope: MemoryScope; scopeId: string; title: string; content: string; pinned: boolean }>({ scope: 'global', scopeId: '', title: '', content: '', pinned: false });
  const [reflectId, setReflectId] = useState('');
  const [note, setNote] = useState('');
  const search = (): void => {
    void window.visione.memory.search({ query, limit: 50 }).then((res) => {
      if (res.ok) setItems(res.data.items);
      setError(res.ok ? null : res.error);
    });
  };
  useEffect(() => {
    if (ready) search();
  }, [ready]);
  const write = (): void => {
    void window.visione.memory.write({ scope: form.scope, scopeId: form.scope === 'global' ? null : form.scopeId.trim(), title: form.title, content: form.content, pinned: form.pinned }).then((res) => {
      setError(res.ok ? null : res.error);
      if (res.ok) {
        setForm({ ...form, title: '', content: '' });
        setNote(res.data.created ? t('settings.memory.written') : t('settings.memory.exists'));
        search();
      }
    });
  };
  const promote = (id: string): void => {
    void window.visione.memory.promote(id).then((res) => {
      setError(res.ok ? null : res.error);
      if (res.ok) search();
    });
  };
  const reflect = (): void => {
    void window.visione.memory.reflect(reflectId.trim(), true).then((res) => {
      setError(res.ok ? null : res.error);
      if (res.ok) setNote(t(res.data.applied ? 'settings.memory.reflectApplied' : 'settings.memory.reflectNotApplied', { reason: res.data.reason }));
    });
  };
  return (
    <section className="drawer-body" aria-label={t('settings.memory.aria')} data-testid="memory-drawer">
      <form className="form" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <input aria-label={t('settings.memory.searchAria')} placeholder={t('settings.memory.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="memory-query" />
        <button type="submit" disabled={!ready}>{t('settings.memory.search')}</button>
      </form>
      <ul className="rows" data-testid="memory-items">
        {items.map((m) => (
          <li key={m.id}>
            <span className="type">{m.scope}{m.scopeId ? `:${m.scopeId.slice(-8)}` : ''}</span>
            <span className="muted small">{m.kind}{m.pinned ? t('settings.memory.pinnedMark') : ''} · {m.source}</span>
            <span className="small memory-text">{m.title ? `${m.title}: ` : ''}{m.content}</span>
            {m.scope !== 'global' && <button type="button" onClick={() => promote(m.id)} disabled={!ready}>{t('settings.memory.makeGlobal')}</button>}
          </li>
        ))}
      </ul>
      <h3>{t('settings.memory.write')}</h3>
      <div className="form">
        <select aria-label={t('settings.memory.scopeAria')} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as MemoryScope })}>
          <option value="global">{t('settings.memory.scopeGlobal')}</option><option value="agent">{t('settings.memory.scopeAgent')}</option><option value="task">{t('settings.memory.scopeTask')}</option>
        </select>
        {form.scope !== 'global' && <input aria-label={t('settings.memory.scopeIdAria')} placeholder={form.scope === 'agent' ? t('settings.memory.agentId') : t('settings.memory.taskId')} value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} />}
        <input aria-label={t('settings.memory.titleField')} placeholder={t('settings.memory.titleField')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea aria-label={t('settings.memory.contentField')} placeholder={t('settings.memory.contentField')} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} data-testid="memory-content" />
        <label className="small"><input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} /> {t('settings.memory.pinned')}</label>
        <button type="button" onClick={write} disabled={!ready || form.content.trim() === ''} data-testid="memory-write">{t('settings.memory.write')}</button>
      </div>
      <h3>{t('settings.memory.reflectTitle')}</h3>
      <div className="form">
        <input aria-label={t('settings.memory.reflectAgentAria')} placeholder={t('settings.memory.agentId')} value={reflectId} onChange={(e) => setReflectId(e.target.value)} />
        <button type="button" onClick={reflect} disabled={!ready || reflectId.trim() === ''}>{t('settings.memory.reflectNow')}</button>
      </div>
      {note && <p className="muted small" data-testid="memory-note">{note}</p>}
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </section>
  );
}

/** Valore reale della wake nella configurazione caricata (nessuna stima). */
function wakeEnabledOf(config: Record<string, unknown>): boolean {
  const voice = config.voice;
  if (voice === null || typeof voice !== 'object' || Array.isArray(voice)) return false;
  const wake = (voice as Record<string, unknown>).wake;
  if (wake === null || typeof wake !== 'object' || Array.isArray(wake)) return false;
  return (wake as Record<string, unknown>).enabled === true;
}

/** Valore reale della modalità sfondo desktop nella configurazione caricata (nessuna stima). */
function desktopModeOf(config: Record<string, unknown>): boolean {
  const ui = config.ui;
  if (ui === null || typeof ui !== 'object' || Array.isArray(ui)) return false;
  return (ui as Record<string, unknown>).desktop === true;
}

/** `offline.auto` reale (default acceso, come nello schema). */
function offlineAutoOf(config: Record<string, unknown>): boolean {
  const offline = config.offline;
  if (offline === null || typeof offline !== 'object' || Array.isArray(offline)) return true;
  return (offline as Record<string, unknown>).auto !== false;
}

function patchOf(path: string, value: unknown): Record<string, unknown> {
  return path.split('.').reverse().reduce<unknown>((acc, key) => ({ [key]: acc }), value) as Record<string, unknown>;
}

export function SettingsDrawer({ edition = 'sviluppo', ready, reducedMotion, onReducedMotion, onSceneChange, onNodeLingerChange, modelSuggestions: models = [], agents = null, directorName = 'Director', onDirectorRenamed, onAgentsChanged, onOpenAgentTerminal, onOpenDirectorWindow, onOpenSetup }: { /** P-104: edizione dell'app (nella `tester` il motore del parlato è solo Windows). */ edition?: Edition; ready: boolean; reducedMotion: boolean; onReducedMotion: (v: boolean) => void; onSceneChange?: (scene: SceneVariant) => void; /** Durata dei nodi conclusi a schermo, applicata subito alla scena. */ onNodeLingerChange?: (sec: number) => void; /** P-95: modelli REALI configurati negli agenti, per i suggerimenti dei campi modello. */ modelSuggestions?: readonly string[]; /** P-99: rubrica reale per rinominare gli agenti (Director compreso). */ agents?: readonly AgentView[] | null; directorName?: string; onDirectorRenamed?: (name: string) => void; /** P-99/P-100: una modifica alla definizione (rinomina o modello/potenza) → la rubrica si rilegge. */ onAgentsChanged?: () => void; /** P-100: apre il terminale REALE dell'agente secondo le capacità del motore (PTY o flusso turni). */
  onOpenAgentTerminal?: (agentId: string) => void; /** P-100: apre la finestra reale del Director (console/shell già esistente). */ onOpenDirectorWindow?: () => void; /** P-105: riapre la procedura guidata (motori, squadra, voce, verifica). */ onOpenSetup?: () => void }) {
  const [data, setData] = useState<{ config: Record<string, unknown>; restartRequired: boolean; problems: string[]; file: string } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<CommandError | null>(null);
  const t = useT();
  const lang = useLanguage();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [wakeNote, setWakeNote] = useState<string | null>(null);
  const [askExpert, setAskExpert] = useState(false);
  const applyExpert = (on: boolean): void => {
    setData((d) => (d ? { ...d, config: mergeDeep(d.config, { ui: { expert: on } }) } : d));
    void window.visione.config.update({ ui: { expert: on } }).then((res) => { setError(res.ok ? null : res.error); load(); });
  };
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [desktopNote, setDesktopNote] = useState<string | null>(null);
  const [trustNote, setTrustNote] = useState<string | null>(null);
  const [sceneNote, setSceneNote] = useState<string | null>(null);
  // Durata dei nodi a schermo (11/10/2026): bozza mentre si trascina, salvataggio dopo una pausa.
  const [lingerDraft, setLingerDraft] = useState<number | null>(null);
  const [lingerNote, setLingerNote] = useState<string | null>(null);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
  }, []);
  // P-99: rinomina degli agenti — bozze, esiti e errori per riga. Il Director ha la sua riga.
  const [renameEdits, setRenameEdits] = useState<Record<string, string>>({});
  const [renameNotes, setRenameNotes] = useState<Record<string, string>>({});
  const [renameError, setRenameError] = useState<string | null>(null);
  const [directorDraft, setDirectorDraft] = useState<string | null>(null);
  const [directorNote, setDirectorNote] = useState<string | null>(null);
  // P-100: modello e potenza per agente — pannello aperto al click, dati reali da `agents.models`
  // (config + probe dell'adapter), applicazione con `agents.tuning` (validata, auditata).
  const [tuningOpen, setTuningOpen] = useState<Record<string, boolean>>({});
  const [tuning, setTuning] = useState<Record<string, CommandResult<'agents.models'>>>({});
  const [tuningNotes, setTuningNotes] = useState<Record<string, string>>({});
  const [tuningErrors, setTuningErrors] = useState<Record<string, string>>({});
  const load = (): void => {
    void window.visione.config.get().then((res) => {
      if (res.ok) setData(res.data);
      setError(res.ok ? null : res.error);
    });
  };
  useEffect(() => {
    if (ready) load();
  }, [ready]);
  /**
   * P-99 — rinomina un agente (Director compreso): `agents.rename` valida, aggiorna la definizione
   * (v+1) con evento/audit e l'id interno resta invariato. App rilegge la rubrica per l'effetto
   * immediato su topbar, striscia, pannello AGENTI e scena.
   */
  const renameAgent = (id: string): void => {
    const current = (agents ?? []).find((a) => a.definition.id === id);
    const name = (renameEdits[id] ?? current?.definition.name ?? '').trim();
    setRenameError(null);
    if (name === '') {
      setRenameError(t('settings.rename.empty'));
      return;
    }
    void window.visione.agents.rename(id, name).then((res) => {
      if (!res.ok) {
        setRenameError(`${res.error.code}: ${res.error.message}`);
        return;
      }
      setRenameNotes((n) => ({ ...n, [id]: res.data.changed ? t('settings.rename.updated', { name: res.data.name, version: res.data.version }) : t('settings.common.noChange') }));
      setRenameEdits((e) => {
        const copy = { ...e };
        delete copy[id];
        return copy;
      });
      if (res.data.changed) onAgentsChanged?.();
    });
  };
  /**
   * P-100 — modello e potenza di un agente dal pannello Impostazioni: si apre al click e si legge
   * UNA volta `agents.models` (modelli configurati + probe reale dell'adapter, potenza dichiarata).
   * Nessun modello inventato: la tendina mostra solo ciò che l'adapter accetta davvero.
   */
  const loadTuning = (agentId: string): void => {
    const opening = tuningOpen[agentId] !== true;
    setTuningOpen((o) => ({ ...o, [agentId]: opening }));
    if (!opening || tuning[agentId]) return;
    setTuningErrors((e) => {
      const copy = { ...e };
      delete copy[agentId];
      return copy;
    });
    void window.visione.agents.models(agentId, true).then((res) => {
      if (res.ok) setTuning((t) => ({ ...t, [agentId]: res.data }));
      else setTuningErrors((e) => ({ ...e, [agentId]: `${res.error.code}: ${res.error.message}` }));
    });
  };
  /**
   * P-100 — applica modello e/o potenza: `agents.tuning` valida con l'adapter, aggiorna la
   * definizione (v+1) con evento/audit. Si dichiara QUANDO vale davvero: per i motori a processo per
   * turno dal turno successivo, per i PTY dalla prossima sessione, per un agente fermo al prossimo
   * avvio. La rubrica della UI si rilegge subito.
   */
  const applyTuning = (agentId: string, change: { model?: string; effort?: string | null }): void => {
    setTuningErrors((e) => {
      const copy = { ...e };
      delete copy[agentId];
      return copy;
    });
    void window.visione.agents.tuning({ agentId, ...change }).then((res) => {
      if (!res.ok) {
        setTuningErrors((e) => ({ ...e, [agentId]: `${res.error.code}: ${res.error.message}` }));
        return;
      }
      const where = res.data.live ? (res.data.applies === 'next-session' ? t('settings.tuning.nextSession') : t('settings.tuning.nextTurn')) : t('settings.tuning.nextStart');
      setTuningNotes((n) => ({ ...n, [agentId]: `${res.data.model ?? t('settings.tuning.defaultModel')}${res.data.effort ? t('settings.agent.powerPart', { effort: res.data.effort }) : ''} → ${where}` }));
      setTuning((t) => {
        const current = t[agentId];
        if (!current) return t;
        return {
          ...t,
          [agentId]: {
            ...current,
            current: res.data.model,
            effort: current.effort ? { ...current.effort, current: res.data.effort } : null
          }
        };
      });
      onAgentsChanged?.();
    });
  };
  /**
   * P-99 — nome del Director (`ui.directorName` nella configurazione): il coordinatore non è un
   * agente del registro, quindi la rinomina passa da `config.update` (audit + evento
   * `system.config.changed`) e App lo applica SUBITO alla scena. Persistente al riavvio.
   */
  const renameDirector = (): void => {
    const name = (directorDraft ?? directorName).trim();
    setRenameError(null);
    if (name === '') {
      setRenameError(t('settings.rename.empty'));
      return;
    }
    void window.visione.config.update({ ui: { directorName: name } }).then((res) => {
      if (!res.ok) {
        setRenameError(`${res.error.code}: ${res.error.message}`);
        return;
      }
      setDirectorNote(t('settings.director.renamed', { name }));
      setDirectorDraft(null);
      onDirectorRenamed?.(name);
      load();
    });
  };
  /**
   * Profilo della voce (16/10/2026): motore del parlato e «hey visione» insieme, poi la voce si riavvia
   * (li legge all'avvio). La voce di Windows già scelta resta quella.
   */
  const changeProfile = (p: VoiceProfile): void => {
    const name = t(`wiz.voice.profile.${p}.name` as const);
    setError(null);
    setSaved(null);
    setProfileBusy(true);
    setProfileNote(t('settings.profile.applying'));
    void window.visione.config.update(profilePatch(p, null)).then(async (res) => {
      if (!res.ok) {
        setError(res.error);
        setProfileNote(null);
      } else {
        load();
        setProfileNote((await restartVoice()) ? t('settings.profile.applied', { name }) : t('settings.profile.notStarted', { name }));
      }
      setProfileBusy(false);
    });
  };
  /** La prova del PC anche da qui: dice cosa consiglierebbe VISIONE, senza cambiare niente. */
  const testProfile = (): void => {
    setProfileBusy(true);
    setProfileNote(t('wiz.voice.bench.running'));
    void window.visione.voice.benchmark().then((res) => {
      setProfileBusy(false);
      if (!res.ok) return setProfileNote(t('wiz.voice.bench.failed', { reason: res.error.message || res.error.code }));
      const r = res.data;
      if (r.rtf === null) return setProfileNote(t('wiz.voice.bench.failed', { reason: r.reason ?? '?' }));
      const x = speedTimes(r.rtf, lang);
      const result = x === null ? t('wiz.voice.bench.slow') : t('wiz.voice.bench.fast', { x });
      setProfileNote(t('settings.profile.recommended', { result, name: t(`wiz.voice.profile.${r.recommended}.name` as const) }));
    });
  };
  /**
   * Wake word (P-81): il toggle salva la configurazione E la applica subito al processo voce.
   * Se la voce non è pronta, la config resta salvata e la nota lo dice (nessun effetto finto).
   */
  const toggleWake = (enabled: boolean): void => {
    setError(null);
    setWakeNote(null);
    void window.visione.config.update({ voice: { wake: { enabled } } }).then((res) => {
      if (!res.ok) setError(res.error);
      else {
        setSaved(res.data.changed);
        load();
      }
    });
    void window.visione.voice.wake(enabled).then((res) => {
      setWakeNote(res.ok ? (enabled ? t('settings.wake.on') : t('settings.wake.off')) : t('settings.wake.notApplied', { error: res.error.message }));
    });
  };
  /**
   * Sfondo desktop (P-86): VISIONE parte DIETRO icone e barra; da lì non riceve i click (limite di
   * Windows), ma si richiama con **Ctrl+Alt+V** o con la wake word: la finestra viene staccata dal
   * desktop, portata in primo piano e resa cliccabile; al blur torna a riposo. Si salva la
   * configurazione; l'effetto vale dal prossimo avvio DELL'APP (il main legge `ui.*` solo
   * all'avvio), mai a caldo.
   */
  // Modalità offline (17/10/2026): passaggio automatico quando cade la rete; vale subito.
  const toggleOfflineAuto = (auto: boolean): void => {
    setError(null);
    setSaved(null);
    void window.visione.config.update({ offline: { auto } }).then((res) => {
      if (!res.ok) setError(res.error);
      else load();
    });
  };
  const toggleDesktop = (desktop: boolean): void => {
    setError(null);
    setSaved(null);
    setDesktopNote(null);
    void window.visione.config.update({ ui: { desktop } }).then((res) => {
      if (!res.ok) setError(res.error);
      else {
        setDesktopNote(desktop ? t('settings.desktop.savedOn') : t('settings.desktop.savedOff'));
        load();
      }
    });
  };
  /**
   * Variante di scena (P-89): `jarvis` (sorgenti JARVIS, P-88) o `pixel-office` (globo dell'ufficio
   * pixel di Munder). Si salva in `ui.scene` e il renderer la applica SUBITO (`setScene` a caldo):
   * non serve riavviare. La scena JARVIS resta intatta e si riattiva da qui.
   */
  const changeScene = (scene: SceneVariant): void => {
    setError(null);
    setSaved(null);
    setSceneNote(null);
    void window.visione.config.update({ ui: { scene } }).then((res) => {
      if (!res.ok) setError(res.error);
      else {
        setSceneNote(scene === 'pixel-office' ? t('settings.scene.globeOn') : t('settings.scene.neuralOn'));
        onSceneChange?.(scene);
        load();
      }
    });
  };
  /**
   * Durata dei nodi conclusi a schermo (`ui.nodeLingerSec`): si salva 400 ms dopo l'ultimo
   * movimento e la scena la applica SUBITO (anche dal riavvio del core arriva dal file).
   */
  const changeLinger = (raw: number): void => {
    if (!Number.isFinite(raw)) return;
    const sec = clampLinger(raw);
    setLingerDraft(sec);
    setLingerNote(null);
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    lingerTimer.current = setTimeout(() => {
      lingerTimer.current = null;
      void window.visione.config.update({ ui: { nodeLingerSec: sec } }).then((res) => {
        if (!res.ok) setError(res.error);
        else {
          setLingerNote(t('settings.linger.note', { sec }));
          onNodeLingerChange?.(sec);
          setLingerDraft(null);
          load();
        }
      });
    }, 400);
  };
  /**
   * Modalità fiducia (P-102): solo il proprietario la cambia, da qui, con `config.update` (audit +
   * evento). Il core la legge all'avvio: vale dal prossimo avvio di VISIONE (lo dice la nota).
   */
  const toggleTrust = (agentId: string, trusted: boolean): void => {
    if (!data) return;
    setError(null);
    const next = withTrust(trustedAgentsOf(data.config), agentId, trusted);
    void window.visione.config.update({ policy: { trustedAgents: next } }).then((res) => {
      if (!res.ok) setError(res.error);
      else {
        setTrustNote(t(trusted ? 'settings.trust.on' : 'settings.trust.off', { id: agentId }));
        load();
      }
    });
  };
  const save = (): void => {
    if (!data) return;
    let patch: Record<string, unknown> = {};
    for (const leaf of leaves(data.config)) {
      const raw = edits[leaf.path];
      if (raw === undefined || raw === String(leaf.value)) continue;
      const value = typeof leaf.value === 'number' ? Number(raw) : typeof leaf.value === 'boolean' ? raw === 'true' : raw;
      patch = mergeDeep(patch, patchOf(leaf.path, value));
    }
    void window.visione.config.update(patch).then((res) => {
      setError(res.ok ? null : res.error);
      if (res.ok) {
        setSaved(res.data.changed);
        setEdits({});
        load();
      }
    });
  };
  return (
    <section className="drawer-body" aria-label={t('settings.aria')} data-testid="settings-drawer">
      {data && (
        <label className="small setting-expert" title={t('mode.expert.help')}>
          <input
            type="checkbox" checked={expertOf(data.config)} data-testid="setting-expert"
            onChange={(e) => {
              // Accenderla chiede conferma (17/10/2026); spegnerla no.
              if (e.target.checked) setAskExpert(true);
              else applyExpert(false);
            }}
          /> <strong>{t('mode.expert.label')}</strong>
          <span className="muted small"> — {t('mode.expert.help')}</span>
        </label>
      )}
      {askExpert && <ExpertConfirm onConfirm={() => { setAskExpert(false); applyExpert(true); }} onCancel={() => setAskExpert(false)} />}
      {onOpenSetup && (
        <button type="button" className="setup-primary" onClick={onOpenSetup} data-testid="settings-open-setup" title={t('settings.setup.title')}>
          {t('settings.setup.button')}
        </button>
      )}
      <label className="small" title={t('settings.reducedMotion.title')}>
        <input type="checkbox" checked={reducedMotion} onChange={(e) => onReducedMotion(e.target.checked)} data-testid="reduced-motion" /> {t('settings.reducedMotion.label')}
      </label>
      {data && (
        <>
          <p className="muted small x-expert">{data.file} · {data.restartRequired ? t('settings.file.restart') : t('settings.file.inUse')}</p>
          {data.problems.map((p) => <p key={p} className="error small">{p}</p>)}
          {/* P-99: nomi degli agenti (display name), Director incluso — effetto immediato al salvataggio.
              P-100: per ogni agente, al click, modello e potenza REALI (menu dal probe/config) e il
              terminale giusto secondo le capacità del motore (PTY interattivo o flusso dei turni);
              il Director ha la sua finestra con la console reale. */}
          <section className="settings-section x-expert" data-testid="settings-renames">
            <h3>{t('settings.agents.title')}</h3>
            <p className="muted small settings-aiuto-sezione">
              {t('settings.agents.help')}
            </p>
            <div className="settings-grid">
              {/* P-99: riga dedicata del Director (non è un agente del registro). */}
              <label className="small settings-voce">
                <span className="settings-etichetta">
                  <span className="settings-nome">{directorName}</span>
                  <span className="mono settings-percorso" title={t('settings.common.idTitle')}>director</span>
                </span>
                <span className="settings-controllo">
                  <input
                    data-testid="director-rename-input"
                    aria-label={t('settings.director.renameAria')}
                    value={directorDraft ?? directorName}
                    onChange={(e) => setDirectorDraft(e.target.value)}
                  />
                  <button
                    type="button" className="small" data-testid="director-rename-save"
                    disabled={!ready || (directorDraft ?? directorName).trim() === '' || (directorDraft ?? directorName).trim() === directorName}
                    onClick={renameDirector}
                  >{t('settings.common.saveName')}</button>
                  {/* P-100: il Director coordina senza un modello proprio (N/D dichiarato); la sua
                      console/shell reale vive nella finestra Director (nessun duplicato: WM dedup). */}
                  <button
                    type="button" className="small" data-testid="director-terminal"
                    disabled={!ready}
                    title={t('settings.director.consoleTitle')}
                    onClick={() => onOpenDirectorWindow?.()}
                  >{t('settings.director.console')}</button>
                </span>
                <span className="muted settings-aiuto">{t('settings.director.note')}</span>
                {directorNote && <span className="muted small" data-testid="director-rename-note">{directorNote}</span>}
              </label>
              {(agents ?? []).map((a) => {
                const draft = renameEdits[a.definition.id] ?? a.definition.name;
                const id = a.definition.id;
                const open = tuningOpen[id] === true;
                const tun = tuning[id] ?? null;
                const adapter = a.definition.engine.adapter;
                const interactive = a.capabilities.includes('turns.interactive');
                const effortNow = typeof a.definition.engine.options?.effort === 'string' ? a.definition.engine.options.effort : null;
                // Le capacità dichiarate dall'adapter decidono cosa si apre davvero: PTY reale per i
                // motori interattivi (avviato se serve), flusso reale dei turni per quelli headless.
                const terminalTitle = t(interactive ? 'settings.agent.terminalInteractive' : 'settings.agent.terminalHeadless', { adapter });
                return (
                  <div className="small settings-voce" key={id} data-testid={`agent-settings-${id}`}>
                    <span className="settings-etichetta">
                      <span className="settings-nome">{a.definition.name}</span>
                      <span className="mono settings-percorso" title={t('settings.common.idTitle')}>
                        {id} · {adapter}{a.definition.engine.model ? ` · ${a.definition.engine.model}` : t('settings.agent.defaultModelPart')}{effortNow ? t('settings.agent.effortPart', { effort: effortNow }) : ''}
                      </span>
                    </span>
                    <span className="settings-controllo">
                      <input
                        data-testid={`agent-rename-input-${id}`}
                        aria-label={t('settings.agent.renameAria', { id })}
                        value={draft}
                        onChange={(e) => setRenameEdits({ ...renameEdits, [id]: e.target.value })}
                      />
                      <button
                        type="button" className="small" data-testid={`agent-rename-save-${id}`}
                        disabled={!ready || draft.trim() === '' || draft.trim() === a.definition.name}
                        onClick={() => renameAgent(id)}
                      >{t('settings.common.saveName')}</button>
                      <span className="settings-azioni">
                        <button
                          type="button" className="small" data-testid={`agent-tuning-open-${id}`}
                          aria-expanded={open} disabled={!ready}
                          title={t('settings.agent.tuningOpenTitle')}
                          onClick={() => loadTuning(id)}
                        >{t('settings.agent.tuningOpen')}</button>
                        <button
                          type="button" className="small" data-testid={`agent-terminal-${id}`}
                          disabled={!ready} title={terminalTitle}
                          onClick={() => onOpenAgentTerminal?.(id)}
                        >{t('settings.common.terminal')}</button>
                        {data && (
                          <label
                            className="small"
                            title={t('settings.agent.trustTitle')}
                          >
                            <input
                              type="checkbox" data-testid={`agent-trust-${id}`}
                              checked
                              disabled
                              onChange={(e) => toggleTrust(id, e.target.checked)}
                            /> {t('settings.agent.trust')}
                          </label>
                        )}
                      </span>
                    </span>
                    <span className="settings-aiuto muted" title={terminalTitle}>
                      {t('settings.agent.engine', { adapter })}{a.definition.engine.model ? t('settings.agent.modelPart', { model: a.definition.engine.model }) : t('settings.agent.defaultModelPart')}{effortNow ? t('settings.agent.powerPart', { effort: effortNow }) : ''}
                    </span>
                    {open && (
                      <span className="settings-tuning" data-testid={`agent-tuning-${id}`}>
                        {tun === null ? (
                          <span className="muted small" data-testid={`agent-tuning-loading-${id}`}>{t('settings.tuning.loading')}</span>
                        ) : tun.selectable ? (
                          <span className="settings-tuning-riga">
                            <label className="small mono">{t('settings.tuning.model')}{' '}
                              <select
                                data-testid={`agent-model-${id}`}
                                value={tun.current ?? ''}
                                disabled={!ready}
                                onChange={(e) => applyTuning(id, { model: e.target.value })}
                              >
                                <option value="">{t('settings.tuning.defaultModel')}</option>
                                {tun.models.map((m) => (
                                  <option key={m.id} value={m.id}>{m.id}{m.detail ? ` · ${m.detail}` : ''}</option>
                                ))}
                              </select>
                            </label>
                            {tun.effort ? (
                              <label className="small mono">{t('settings.tuning.power')}{' '}
                                <select
                                  data-testid={`agent-effort-${id}`}
                                  value={tun.effort.current ?? ''}
                                  disabled={!ready}
                                  onChange={(e) => applyTuning(id, { effort: e.target.value === '' ? null : e.target.value })}
                                >
                                  <option value="">{t('settings.tuning.defaultPower')}</option>
                                  {tun.effort.options.map((o) => <option key={o} value={o}>{o}</option>)}
                                </select>
                              </label>
                            ) : (
                              <span className="muted small" data-testid={`agent-effort-nd-${id}`}>{t('settings.tuning.powerNa')}</span>
                            )}
                          </span>
                        ) : (
                          <span className="muted small" data-testid={`agent-model-nd-${id}`}>{t('settings.tuning.modelNa')}</span>
                        )}
                        <span className="muted small" title={t('settings.tuning.whenTitle')}>
                          {tun === null ? '' : tun.live ? (tun.applies === 'next-session' ? t('settings.tuning.whenNextSession') : t('settings.tuning.whenNextTurn')) : t('settings.tuning.whenNextStart')}
                        </span>
                        {tuningNotes[id] && <span className="small" data-testid={`agent-tuning-msg-${id}`}>{tuningNotes[id]}</span>}
                        {tuningErrors[id] && <span className="error small" data-testid={`agent-tuning-error-${id}`}>{tuningErrors[id]}</span>}
                      </span>
                    )}
                    {renameNotes[id] && <span className="muted small" data-testid={`agent-rename-note-${id}`}>{renameNotes[id]}</span>}
                    {tuningNotes[id] && !open && <span className="muted small" data-testid={`agent-tuning-msg-${id}`}>{tuningNotes[id]}</span>}
                  </div>
                );
              })}
              {(agents ?? []).length === 0 && <p className="muted small">{t('settings.agents.none')}</p>}
            </div>
            {renameError && <p className="error small" data-testid="agent-rename-error">{renameError}</p>}
            {trustNote && <p className="muted small" data-testid="agent-trust-note">{trustNote}</p>}
          </section>
          <label className="small" title={t('settings.wake.title')}>
            <input
              type="checkbox"
              checked={wakeEnabledOf(data.config)}
              onChange={(e) => toggleWake(e.target.checked)}
              data-testid="setting-wake-enabled"
            /> {t('settings.wake.label')}
          </label>
          {wakeNote && <p className="muted small" data-testid="wake-note">{wakeNote}</p>}
          <div className="small setting-profile">
            <label title={t('settings.profile.title')}>
              {t('settings.profile.label')}{' '}
              <select
                value={profileOf(data.config)}
                onChange={(e) => changeProfile(e.target.value as VoiceProfile)}
                disabled={profileBusy}
                data-testid="setting-voice-profile"
              >
                {VOICE_PROFILES.map((p) => (
                  <option key={p} value={p} disabled={!profileAvailable(p, lang)}>
                    {t(`wiz.voice.profile.${p}.name` as const)} — {t(`wiz.voice.profile.${p}.what` as const)}
                  </option>
                ))}
                {profileOf(data.config) === 'custom' && <option value="custom" disabled>{t('settings.profile.custom')}</option>}
              </select>
            </label>{' '}
            <button type="button" onClick={testProfile} disabled={profileBusy} data-testid="setting-voice-profile-test">{t('settings.profile.test')}</button>
          </div>
          {profileNote && <p className="muted small" role="status" data-testid="voice-profile-note">{profileNote}</p>}
          <label className="small" title={t('settings.desktop.title')}>
            <input
              type="checkbox"
              checked={desktopModeOf(data.config)}
              onChange={(e) => toggleDesktop(e.target.checked)}
              data-testid="setting-desktop-mode"
            /> {t('settings.desktop.label')}
          </label>
          {desktopNote && <p className="muted small" data-testid="desktop-note">{desktopNote}</p>}
          <OfflineSettings auto={offlineAutoOf(data.config)} onAuto={toggleOfflineAuto} />
          <label className="small" title={t('settings.scene.title')}>
            {t('settings.scene.label')}{' '}
            <select
              value={sceneOf(data.config)}
              onChange={(e) => changeScene(e.target.value as SceneVariant)}
              data-testid="setting-scene"
            >
              <option value="jarvis">{t('settings.scene.neural')}</option>
              <option value="pixel-office">{t('settings.scene.globe')}</option>
            </select>{' '}
            {t('settings.scene.immediate')}
          </label>
          {sceneNote && <p className="muted small" data-testid="scene-note">{sceneNote}</p>}
          <label className="small setting-linger x-expert" title={t('settings.linger.title')}>
            {t('settings.linger.label')}{' '}
            <input
              type="range" min={NODE_LINGER_MIN_SEC} max={NODE_LINGER_MAX_SEC} step={5}
              value={lingerDraft ?? nodeLingerOf(data.config)}
              onChange={(e) => changeLinger(Number(e.target.value))}
              data-testid="setting-node-linger"
            />{' '}
            <input
              type="number" min={NODE_LINGER_MIN_SEC} max={NODE_LINGER_MAX_SEC} step={1}
              value={lingerDraft ?? nodeLingerOf(data.config)}
              onChange={(e) => changeLinger(Number(e.target.value))}
              aria-label={t('settings.linger.aria')}
              data-testid="setting-node-linger-sec"
            /> {t('settings.linger.unit')}
          </label>
          {lingerNote && <p className="muted small" data-testid="node-linger-note">{lingerNote}</p>}
          {!expertOf(data.config) && <p className="muted small">{t('mode.simpleHint')}</p>}
          {settingsBySection(data.config, lang)
            .map(({ section, items }) => ({ section, items: items.filter((leaf) => settingVisible(leaf.path, expertOf(data.config))) }))
            .filter(({ items }) => items.length > 0)
            .map(({ section, items }) => (
            <section className="settings-section" key={section.id} data-testid={`settings-section-${section.id}`}>
              <h3 title={section.help}>{section.label}</h3>
              <p className="muted small settings-aiuto-sezione">{section.help}</p>
              <div className="settings-grid">
                {items.map((leaf) => <SettingField
                  key={leaf.path}
                  leaf={leaf}
                  value={edits[leaf.path] ?? String(leaf.value)}
                  onChange={(raw) => setEdits({ ...edits, [leaf.path]: raw })}
                  models={models}
                  edition={edition}
                />)}
              </div>
            </section>
          ))}
          <button type="button" onClick={save} disabled={!ready || Object.keys(edits).length === 0} data-testid="settings-save">{t('settings.save')}</button>
          {saved && (
            <p className="muted small" data-testid="settings-saved">
              {saved.length === 0 ? t('settings.common.noChange') : t('settings.saved', { list: saved.join(', ') })}
            </p>
          )}
        </>
      )}
      {error && <p className="error small">{error.code}: {error.message}</p>}
    </section>
  );
}

/**
 * Un campo delle Impostazioni (P-94/P-95): etichetta in italiano, percorso tecnico in piccolo,
 * controllo reale e spiegazione breve visibile E nel tooltip. I campi con valori CONSIGLIATI
 * (voce Edge, velocità, tono, livelli di log, modelli) sono combobox nativi `<input list>` +
 * `<datalist>`: si sceglie un suggerimento o si scrive un valore personalizzato, che è quello
 * salvato. I booleani restano select (un booleano scritto a mano non è un valore reale) e le
 * scelte esatte senza alternative restano select. `data-testid` = `setting-<percorso>`, come e2e.
 */
function SettingField({ leaf, value, onChange, models, edition }: { leaf: SettingLeaf; value: string; onChange: (raw: string) => void; models: readonly string[]; edition: Edition }) {
  const t = useT();
  const lang = useLanguage();
  const meta = settingMeta(leaf.path, lang);
  const options = optionsFor(leaf.path, edition, value, lang);
  const help = `${meta.label} — ${meta.help}`;
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const listId = `suggerimenti-${id}-${leaf.path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const suggestions = meta.suggestions ?? (MODEL_PATHS.has(leaf.path) ? modelSuggestions(models) : null);
  const combo = typeof leaf.value !== 'boolean' && suggestions !== null && suggestions.length > 0;
  return (
    <label className="small settings-voce" title={t('settings.field.title', { help, path: leaf.path })}>
      <span className="settings-etichetta">
        <span className="settings-nome">{meta.label}</span>
        <span className="mono settings-percorso x-expert" title={t('settings.field.pathTitle', { path: leaf.path })}>{leaf.path}</span>
      </span>
      <span className="settings-controllo">
        {typeof leaf.value === 'boolean' ? (
          <select data-testid={`setting-${leaf.path}`} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="true">{t('settings.field.yes')}</option>
            <option value="false">{t('settings.field.no')}</option>
          </select>
        ) : combo && suggestions ? (
          <>
            <input
              data-testid={`setting-${leaf.path}`}
              list={listId}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            <datalist id={listId}>
              {suggestions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </datalist>
            <span className="settings-suggeriti muted small" title={t('settings.field.suggestedTitle')}>{t('settings.field.suggested')}</span>
          </>
        ) : options ? (
          <select data-testid={`setting-${leaf.path}`} value={value} onChange={(e) => onChange(e.target.value)}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input data-testid={`setting-${leaf.path}`} value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </span>
      <span className="settings-aiuto muted" title={help}>{meta.help}</span>
    </label>
  );
}

function mergeDeep(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = prev && typeof prev === 'object' && v && typeof v === 'object' ? mergeDeep(prev as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}
