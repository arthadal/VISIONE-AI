// Vista Neural 3D (VISIONE_ARCHITECTURE §27, DECISIONI P-47): all'apertura carica gli ultimi eventi del
// journal senza animazioni, poi anima solo gli eventi reali che arrivano dal bus; replay dal journal.
// P-90: la scena ha movimento ambientale CONTINUO mentre è visibile (a vista nascosta il ciclo si
// mette in pausa) e si accende col parlato/ascolto reale, dal livello vero dell'audio; gli impulsi
// restano solo quelli degli eventi reali.
// Gli effetti mostrati (ultimi eventi proiettati) collegano ogni segno sulla scena al suo evento.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentView, CoreStateSnapshot, VisioneEvent } from '../../shared/contracts/index.ts';
import { createNeuralClient, type NeuralClient } from './client.ts';
import type { FromEngine, NodeView } from './engine.ts';
import type { Effect } from './graph.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { clearDismissed, dismissPopover, labelVisible, NO_INSETS, nodeDisplayName, nodeFieldLabel, nodeInfoFields, nodeRoleLabel, resolveLabelCollisions, type LabelInsets } from './labels.ts';
import { NodePanel } from './NodePanel.tsx';
import { createNeuralRenderer, type Label, type NeuralRenderer, type SceneStats, type SceneVariant } from './renderer3d.ts';
import { reactorState, type ReactorState } from '../reactor/shader.ts';
import { voiceAudio } from '../voice/audio.ts';

export interface NeuralStats extends SceneStats {
  mode: 'worker' | 'inline';
  domainEvents: number;
}

const LIVE_FLUSH_MS = 50;
const INITIAL_EVENTS = 500;
const REPLAY_EVENTS = 1_000;
/** Tetto del buffer live in attesa del journal: se il caricamento non arriva, non cresce all'infinito. */
const MAX_PENDING_EVENTS = 2_000;
/** Tetto di pagine del journal: `lastSeq` reale non supera mai questo; evita un ciclo infinito. */
const MAX_JOURNAL_PAGES = 20;

/**
 * P-100 — quanto le sovrastrutture (colonne del dock, topbar, barra inferiore e riga comandi)
 * coprono il riquadro della scena. Le etichette si piazzano solo nell'area libera: il popover e il
 * suo × restano cliccabili anche quando il globo è vicino al bordo (prima potevano finire sotto).
 */
function labelInsetsOf(box: HTMLElement | null): LabelInsets {
  if (!box) return NO_INSETS;
  const r = box.getBoundingClientRect();
  const rect = (sel: string): DOMRect | null => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 ? b : null;
  };
  const colLeft = rect('.col-left');
  const colRight = rect('.col-right');
  const topbar = rect('.topbar');
  const bottoms = [rect('.row-bottom'), rect('.row-command')].filter((b): b is DOMRect => b !== null);
  const raw: LabelInsets = {
    left: colLeft ? Math.max(0, colLeft.right - r.left) : 0,
    right: colRight ? Math.max(0, r.right - colRight.left) : 0,
    top: topbar ? Math.max(0, topbar.bottom - r.top) : 0,
    bottom: bottoms.length > 0 ? Math.max(0, r.bottom - Math.min(...bottoms.map((b) => b.top))) : 0
  };
  // Tetti di sicurezza: una misura anomala non deve svuotare la scena di etichette.
  return {
    left: Math.min(raw.left, r.width * 0.4),
    right: Math.min(raw.right, r.width * 0.4),
    top: Math.min(raw.top, r.height * 0.3),
    bottom: Math.min(raw.bottom, r.height * 0.6)
  };
}

async function journalTail(limit: number): Promise<VisioneEvent[]> {
  const last = await window.visione.events.list({ limit: 1 });
  const lastSeq = last.ok ? last.data.lastSeq : 0;
  const out: VisioneEvent[] = [];
  let after = Math.max(0, lastSeq - limit);
  for (let page = 0; page < MAX_JOURNAL_PAGES && out.length < limit; page++) {
    const res = await window.visione.events.list({ afterSeq: after, limit: 500 });
    if (!res.ok || res.data.events.length === 0) break;
    out.push(...res.data.events);
    after = res.data.events.at(-1)?.seq ?? after;
    if (after >= res.data.lastSeq) break;
  }
  return out;
}

export function NeuralView({ visible, reducedMotion, light = false, onStats, core, agents = null, voiceLevel = 0, scene = 'jarvis', directorName = 'Director', nodeLingerSec = 30, onOpenTerminal, onOpenDirector, onOpenWindow }: { visible: boolean; reducedMotion: boolean; /** Modalità leggera (`ui.light`), a caldo. */ light?: boolean; onStats: (s: NeuralStats) => void; core: CoreStateSnapshot | null; /** Rubrica reale (P-98): provider/modello/sessione del popover di hover. */ agents?: AgentView[] | null; voiceLevel?: number; scene?: SceneVariant; /** P-99: nome mostrato del Director (`ui.directorName`), effetto immediato. */ directorName?: string; /** Secondi a schermo dei nodi conclusi (`ui.nodeLingerSec`), effetto immediato. */ nodeLingerSec?: number; onOpenTerminal?: (agentId: string) => void; onOpenDirector?: () => void; onOpenWindow?: (kind: 'director' | 'agent' | 'task', ref: string | null) => void }) {
  const t = useT();
  const lang = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<NeuralRenderer | null>(null);
  const clientRef = useRef<NeuralClient | null>(null);
  const lingerRef = useRef(nodeLingerSec);
  // G3: stato reale del reactor e livello voce letti dal renderer nel proprio loop (pattern «Drive»:
  // mutazione, mai stato React per fotogramma). Il componente li riallinea a ogni render.
  const reactorRef = useRef<{ state: ReactorState; level: number }>({ state: 'idle', level: 0 });
  const reactorNow = reactorState(core);
  reactorRef.current.state = reactorNow;
  reactorRef.current.level = voiceLevel;
  const [labels, setLabels] = useState<Label[]>([]);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [stats, setStats] = useState<NeuralStats | null>(null);
  const [replay, setReplay] = useState<{ state: string; done: number; total: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // P-100: popover chiuso con × — l'id resta chiuso finché il puntatore non lascia il nodo.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const statsRef = useRef<SceneStats | null>(null);
  const domainRef = useRef(0);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  /**
   * Snapshot della rubrica REALE (come `eventiDaElenco` della Rete di Munder): gli agenti definiti
   * sono nodi del globo anche se la loro definizione è più vecchia della coda del journal letta
   * all'apertura. Nessun evento inventato: ogni riga è un agente del registro, lo stato è quello
   * dell'istanza reale o `idle`; gli archiviati restano fuori.
   */
  const postSnapshot = async (): Promise<void> => {
    try {
      const res = await window.visione.agents.list(false);
      if (res.ok) {
        clientRef.current?.post({
          type: 'snapshot',
          // P-99: il nome del Director viaggia con la rubrica (non è un agente del registro).
          director: directorName,
          agents: res.data.agents.map((a) => ({
            id: a.definition.id,
            name: a.definition.name,
            // P-100: senza istanza l'agente è «created» (definito, mai avviato) → globo bianco.
            status: a.instance?.status ?? 'created',
            archived: a.archived
          }))
        });
      }
    } catch {
      // Rubrica non raggiungibile: la scena resta quella del journal, senza inventare nodi.
    }
  };

  const selectRef = useRef<(id: string | null) => void>(() => {});
  selectRef.current = (id) => {
    setSelected(id);
    rendererRef.current?.setSelection(id);
    if (id === 'director') {
      onOpenDirector?.();
      onOpenWindow?.('director', null);
    } else if (id?.startsWith('agent:')) {
      onOpenWindow?.('agent', id.slice('agent:'.length));
    } else if (id?.startsWith('task:')) {
      onOpenWindow?.('task', id.slice('task:'.length));
    }
  };
  /**
   * P-100 — chiusura del popover con ×: il nodo non è più «caldo» (via da selezione e hover), resta
   * chiuso finché il puntatore non lascia il nodo; l'etichetta al suo posto resta visibile.
   */
  const closePop = (id: string): void => {
    setClosed((prev) => dismissPopover(prev, id));
    setHovered((h) => (h === id ? null : h));
    if (selected === id) selectRef.current(null);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Statistiche alla UI al più 4 volte al secondo e solo se cambiate: il timer parte da un frame.
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    let lastJson = '';
    const publishStats = (): void => {
      statsTimer = null;
      const s = statsRef.current;
      if (!s) return;
      const full: NeuralStats = { ...s, mode: clientRef.current?.mode ?? 'worker', domainEvents: domainRef.current };
      const json = JSON.stringify(full);
      if (json === lastJson) return;
      lastJson = json;
      setStats(full);
      onStatsRef.current(full);
    };
    const renderer = createNeuralRenderer(canvas, {
      reducedMotion,
      scene,
      reactor: reactorRef.current,
      // P-90: livello REALE per fotogramma dall'uscita TTS (analizzatore); il microfono arriva dal
      // livello dello stato (mutabile). A voce ferma è 0: nessuna attivazione finta.
      level: () => voiceAudio.outputLevel(),
      onStats: (s) => {
        statsRef.current = s;
        statsTimer ??= setTimeout(publishStats, 250);
      },
      onHover: (id) => {
        setHovered(id);
        // P-100: lasciando il nodo (id null) o entrandoci da fuori la chiusura si dimentica.
        setClosed((prev) => clearDismissed(prev, id));
      },
      onSelect: (id) => selectRef.current(id),
      // Zoom sull'agente: le etichette seguono la camera in volo.
      onView: () => setLabels(rendererRef.current?.labels() ?? [])
    });
    rendererRef.current = renderer;
    let loadedSeq = 0;
    let loaded = false;
    let pending: VisioneEvent[] = [];
    // Diagnostica/test (Fase 13): registro degli impulsi realmente ricevuti dal bus (origine/destinazione).
    const pulseLog: Array<{ from: string; to: string; type: string }> = [];
    // Diagnostica/test (Fase 15): registro degli effetti ricevuti dal motore (event id → effetto).
    // Serve a dimostrare in modo deterministico che un evento di dominio ha un effetto tracciabile.
    const effectsLog: Effect[] = [];
    const seenEffects = new Set<string>();
    // G7 (P-78): gli aggiornamenti React dalla scena si coalizzano (al più uno ogni ~90 ms). Durante
    // il replay ×20 il motore manda un messaggio per evento (~230 in un secondo): senza coalescenza
    // erano ~230 render del pannello e delle etichette, con calo degli fps misurati. La scena
    // (`renderer.setGraph`) resta immediata: cambia solo la frequenza con cui la UI la insegue.
    let uiTimer: ReturnType<typeof setTimeout> | null = null;
    let uiPending: { nodes: NodeView[]; effects: Effect[] } | null = null;
    const flushUi = (): void => {
      if (uiTimer !== null) {
        clearTimeout(uiTimer);
        uiTimer = null;
      }
      const g = uiPending;
      uiPending = null;
      if (g === null) return;
      setNodes(g.nodes);
      setEffects(g.effects.slice(-4).reverse());
      setLabels(renderer.labels());
    };
    const scheduleUi = (nodes: NodeView[], effects: Effect[]): void => {
      uiPending = { nodes, effects };
      if (uiTimer !== null) return;
      uiTimer = setTimeout(() => {
        uiTimer = null;
        const g = uiPending;
        uiPending = null;
        if (g === null) return;
        setNodes(g.nodes);
        setEffects(g.effects.slice(-4).reverse());
        setLabels(renderer.labels());
      }, 90);
    };
    const onMessage = (m: FromEngine): void => {
      if (m.type === 'graph') {
        renderer.setGraph(m.nodes, m.edges, m.signals);
        domainRef.current = m.counts.domain;
        for (const eff of m.effects) {
          if (seenEffects.has(eff.eventId)) continue;
          seenEffects.add(eff.eventId);
          effectsLog.push(eff);
        }
        if (effectsLog.length > 300) {
          for (const dropped of effectsLog.splice(0, effectsLog.length - 300)) seenEffects.delete(dropped.eventId);
        }
        scheduleUi(m.nodes, m.effects);
      } else if (m.type === 'pulses') {
        for (const p of m.pulses) pulseLog.push({ from: p.from, to: p.to, type: p.type });
        if (pulseLog.length > 300) pulseLog.splice(0, pulseLog.length - 300);
        renderer.addPulses(m.pulses);
      } else {
        // Fine/inizio replay: si allinea subito la UI all'ultimo grafo reale.
        flushUi();
        setReplay(m.state === 'stopped' ? null : { state: m.state, done: m.done, total: m.total });
      }
    };
    const load = async (): Promise<void> => {
      loaded = false;
      const events = await journalTail(INITIAL_EVENTS);
      loadedSeq = events.at(-1)?.seq ?? 0;
      // La durata dei nodi prima del caricamento: anche un motore ripartito usa quella scelta.
      clientRef.current?.post({ type: 'linger', ms: lingerRef.current * 1000 });
      clientRef.current?.post({ type: 'load', events });
      await postSnapshot();
      loaded = true;
    };
    const client = createNeuralClient(onMessage, () => void load());
    clientRef.current = client;
    void load();
    // Live: a lotti (un invio ogni 50 ms al più, innescato dal primo evento), dopo il caricamento;
    // scartati quelli già compresi nel journal letto.
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      flushTimer = null;
      if (!loaded) {
        flushTimer = setTimeout(flush, LIVE_FLUSH_MS);
        return;
      }
      const batch = pending.filter((e) => e.seq === null || e.seq > loadedSeq);
      pending = [];
      if (batch.length > 0) client.post({ type: 'live', events: batch });
    };
    const off = window.visione.events.subscribe((e) => {
      pending.push(e);
      if (pending.length > MAX_PENDING_EVENTS) pending.splice(0, pending.length - MAX_PENDING_EVENTS);
      flushTimer ??= setTimeout(flush, LIVE_FLUSH_MS);
    });
    const box = boxRef.current;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0) return;
      renderer.resize(entry.contentRect.width, entry.contentRect.height);
      setLabels(renderer.labels());
    });
    if (box) ro.observe(box);
    (window as unknown as { __visioneNeural?: unknown }).__visioneNeural = {
      reload: load,
      replay: (speed: number) => startReplay(speed),
      labels: () => renderer.labels(),
      pickAt: (x: number, y: number) => renderer.pickAt(x, y),
      pulses: () => pulseLog.slice(),
      effects: () => effectsLog.slice(),
      stats: () => ({ ...renderer.stats(), mode: client.mode, domainEvents: domainRef.current })
    };
    return () => {
      off();
      if (flushTimer) clearTimeout(flushTimer);
      if (uiTimer) clearTimeout(uiTimer);
      if (statsTimer) clearTimeout(statsTimer);
      ro.disconnect();
      client.dispose();
      renderer.dispose();
      rendererRef.current = null;
      clientRef.current = null;
      // Diagnostica/test: non lasciare un riferimento a un renderer già smontato.
      delete (window as unknown as { __visioneNeural?: unknown }).__visioneNeural;
    };
    // La scena si costruisce una volta; la preferenza di movimento si applica alla prossima apertura.
  }, []);

  // La rubrica può non essere pronta al mount (core in avvio): lo snapshot si ripete quando il
  // core diventa disponibile, una volta per avvio. Un doppione è innocuo: il motore è idempotente.
  const bootKey = core?.bootId ?? '';
  useEffect(() => {
    if (!bootKey) return;
    void postSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootKey]);

  // Durata dei nodi conclusi a caldo (11/10/2026): il motore la applica subito, senza ricaricare.
  useEffect(() => {
    lingerRef.current = nodeLingerSec;
    clientRef.current?.post({ type: 'linger', ms: nodeLingerSec * 1000 });
  }, [nodeLingerSec]);

  // P-99: rinomina a caldo — rubrica e nome del Director si ripubblicano quando cambiano, senza
  // riavvio del renderer né ricarica del journal (il motore aggiorna solo le label).
  useEffect(() => {
    void postSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, directorName]);

  // P-90: la scena gira SEMPRE mentre la vista è visibile (movimento ambientale continuo); la vista
  // nascosta mette il ciclo in pausa e il ritorno lo riavvia. G3: lo stato reale del reactor e il
  // livello voce si riallineano qui sull'oggetto mutabile letto dal ciclo (nessuno stato React per
  // fotogramma). G7/P-79: il moto ridotto spegne deriva e pass di grana/aberrazione/vignetta.
  useEffect(() => {
    rendererRef.current?.setActive(visible);
    rendererRef.current?.setReducedMotion(reducedMotion);
    rendererRef.current?.setLight(light);
    if (visible) rendererRef.current?.wake();
  }, [visible, reducedMotion, light]);

  useEffect(() => {
    // Stato voce/parlato cambiato: un frame per applicarlo subito (il ciclo è già in corsa).
    rendererRef.current?.wake();
  }, [reactorNow, voiceLevel]);

  // P-89: cambio di variante di scena (`ui.scene`) a caldo; il journal e il motore non si ricaricano.
  useEffect(() => {
    rendererRef.current?.setScene(scene);
    setLabels(rendererRef.current?.labels() ?? []);
  }, [scene]);

  const startReplay = async (speed: number): Promise<void> => {
    const events = await journalTail(REPLAY_EVENTS);
    clientRef.current?.post({ type: 'replay', events, speed });
  };
  const backToLive = (): void => {
    clientRef.current?.post({ type: 'stop-replay' });
    // Un replay già finito non manda più notifiche: lo stato si azzera qui.
    setReplay(null);
    void (window as unknown as { __visioneNeural: { reload(): Promise<void> } }).__visioneNeural.reload();
  };

  // Percorso unico per label e canvas: il ref è aggiornato a ogni render (vedi `selectRef`).
  const selectNode = (id: string | null): void => selectRef.current(id);
  const selectedNode = selected !== null ? nodes.find((n) => n.id === selected) ?? null : null;
  // P-98: rubrica reale per il popover di hover (provider/modello/sessione dell'agente).
  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.definition.id, a])), [agents]);

  // P-95/P-100: anti-collisione delle etichette — si piazzano solo le label VISIBILI (direttore,
  // substrato, nodo sotto il puntatore/selezionato, stati attivi) e SOLO nell'area libera dalle
  // sovrastrutture (colonne, topbar, barra inferiore): così il popover e il suo × restano cliccabili.
  // Pura e testata in `labels.ts` (gli inset sono un'estensione opzionale).
  const focus = stats?.focus ?? null;
  const labelArea = { width: boxRef.current?.clientWidth ?? 0, height: boxRef.current?.clientHeight ?? 0 };
  const labelInsets = labelInsetsOf(boxRef.current);
  const placedLabels = useMemo(
    // Zoom sull'agente: in primo piano c'è solo lui, le altre etichette (fuori quadro) si tolgono.
    () => resolveLabelCollisions(labels.filter((l) => (focus ? l.id === focus : labelVisible(l, hovered, selected))), labelArea, labelInsets),
    [labels, hovered, selected, focus, labelArea.width, labelArea.height, labelInsets.left, labelInsets.top, labelInsets.right, labelInsets.bottom]
  );

  const unavailable = stats?.context === 'unavailable';
  return (
    <div
      className="neural"
      ref={boxRef}
      hidden={!visible}
      data-testid="neural"
      data-context={stats?.context ?? 'ok'}
      data-quality={stats?.quality ?? 2}
      data-fps={stats?.fps ?? ''}
      data-nodes={stats?.nodes ?? 0}
      data-edges={stats?.edges ?? 0}
      data-pulses-total={stats?.pulsesTotal ?? 0}
      data-pulses-active={stats?.pulsesActive ?? 0}
      data-frames={stats?.frames ?? 0}
      data-mode={stats?.mode ?? ''}
      data-animating={String(stats?.animating ?? false)}
      data-domain={stats?.domainEvents ?? 0}
      data-glow={stats?.glow ?? 0}
      data-director={stats?.director ?? 'idle'}
      data-core={stats?.core ?? 0}
      data-ambient={stats?.ambient ?? 0}
      data-dust={stats?.dust ?? 0}
      data-rings={stats?.rings ?? 0}
      data-stars={stats?.stars ?? 0}
      data-reactor={stats?.reactor ?? 'idle'}
      data-focus={stats?.focus ?? ''}
      data-focus-grow={(stats?.focusGrow ?? 0).toFixed(2)}
      data-reactor-open={stats ? stats.open.toFixed(2) : ''}
      data-post={String(stats?.post ?? false)}
      data-voice={stats ? stats.voice.toFixed(2) : ''}
      data-selected={selected ?? ''}
      data-scene={scene}
      data-replay={replay?.state ?? 'live'}
    >
      <canvas ref={canvasRef} className="neural-canvas" aria-label={t('widgets.neural.canvasAria')} />
      {!unavailable && placedLabels.map((l) => {
        // La label segue il concetto di `.rete-etichetta` di Munder: nome fisso, sempre visibile
        // (P-98); al passaggio del puntatore o con la selezione compare il popover con le info
        // REALI del nodo — nome, ruolo, stato, provider, modello, sessione, ultimo segnale.
        // P-100: il popover si chiude con × e torna alla sola etichetta; `closed` previene la
        // riapertura immediata finché il puntatore non lascia il nodo.
        const hot = (l.id === selected || l.id === hovered) && !closed.has(l.id);
        const cliccabile = l.kind === 'agent' || l.kind === 'director' || l.kind === 'task';
        const agent = l.id.startsWith('agent:') ? agentById.get(l.id.slice('agent:'.length)) ?? null : null;
        const shownName = nodeDisplayName(l.id, l.kind, l.text, lang);
        const fields = hot
          ? nodeInfoFields({
            role: nodeRoleLabel(l.kind, lang),
            kind: l.kind,
            text: shownName,
            status: l.status,
            statusReason: agent?.instance?.statusReason ?? null,
            adapter: agent?.definition.engine.adapter ?? null,
            model: agent ? (agent.definition.engine.model ?? agent.session?.model ?? null) : null,
            sessionId: agent ? (agent.session?.id ?? agent.instance?.sessionId ?? null) : null,
            lastEventAt: l.lastEventAt,
            now: Date.now(),
            lang
          })
          : [];
        // P-100: il popover è largo fino a 282 px: si specchia a sinistra con margine sufficiente
        // a NON finire sotto la colonna di destra (il × deve restare cliccabile).
        const popLeft = l.x + 292 > labelArea.width - labelInsets.right;
        const popUp = l.y + 220 > labelArea.height;
        return (
          <button
            key={l.id}
            type="button"
            data-label={l.id}
            className={`neural-label k-${l.kind} st-${l.status}${hot ? ' hot' : ''}`}
            style={{ left: `${Math.round(l.x)}px`, top: `${Math.round(l.y)}px` }}
            onClick={() => selectNode(l.id === selected ? null : l.id)}
            onPointerEnter={() => {
              setHovered(l.id);
              // P-100: entrare di nuovo nell'etichetta dimentica la chiusura col × (riappare).
              setClosed((prev) => clearDismissed(prev, l.id));
            }}
            onPointerLeave={() => setHovered((h) => (h === l.id ? null : h))}
          >
            <span className="neural-label-nome">{shownName}</span>
            {hot && (
              <span
                className={`neural-label-pop${popLeft ? ' pop-left' : ''}${popUp ? ' pop-up' : ''}`}
                data-testid="label-pop" role="tooltip"
              >
                {/* P-100: × chiude il popover e torna alla sola etichetta (niente finestre, niente dati). */}
                <span
                  className="nlf-close"
                  role="button"
                  tabIndex={0}
                  aria-label={t('widgets.neural.popClose', { name: shownName })}
                  title={t('widgets.neural.popCloseTitle')}
                  data-testid="label-pop-close"
                  onClick={(e) => { e.stopPropagation(); closePop(l.id); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      closePop(l.id);
                    }
                  }}
                >×</span>
                {fields.map((f) => (
                  f.k === 'spiegazione'
                    ? <span className="nlf-spieg" key={f.k} data-testid="label-pop-spieg">{f.v}</span>
                    : (
                      <span className="nlf-row" key={f.k}>
                        <span className="nlf-k">{nodeFieldLabel(f.k, lang)}</span>
                        <span className="nlf-v" title={f.v}>{f.v}</span>
                      </span>
                    )
                ))}
                <span className="nlf-hint">{cliccabile ? t('widgets.neural.hintWindow') : t('widgets.neural.hintPanel')}</span>
              </span>
            )}
          </button>
        );
      })}
      {unavailable && (
        <div className="neural-fallback" role="status">
          <p>{t('widgets.neural.noWebgl')}</p>
          <ul>{nodes.filter((n) => n.kind === 'agent').map((n) => <li key={n.id}>{n.label} · {n.status}</li>)}</ul>
        </div>
      )}
      <div className="neural-hud">
        <div className="neural-actions x-expert" data-replay-mode={replay === null ? 'live' : replay.state}>
          {replay === null ? (
            <>
              <span className="mono small muted" data-testid="neural-live-badge" title={t('widgets.neural.liveTitle')}>● live</span>
              <button
                type="button"
                onClick={() => void startReplay(20)}
                data-testid="neural-replay"
                title={t('widgets.neural.replay20Title')}
              >{t('widgets.neural.replay20')}</button>
              <button
                type="button"
                onClick={() => void startReplay(100)}
                data-testid="neural-replay-100"
                title={t('widgets.neural.replay100Title')}
              >×100</button>
            </>
          ) : (
            <>
              <span
                className="mono"
                data-testid="neural-replay-progress"
                title={t('widgets.neural.replayProgressTitle')}
              >
                {replay.state === 'done'
                  ? t('widgets.neural.replayDone', { done: replay.done, total: replay.total })
                  : t('widgets.neural.replayRunning', { done: replay.done, total: replay.total })}
              </span>
              <button type="button" onClick={backToLive} data-testid="neural-live" title={t('widgets.neural.backToLiveTitle')}>{t('widgets.neural.backToLive')}</button>
            </>
          )}
        </div>
        <ol className="neural-effects" aria-label={t('widgets.neural.effectsAria')} data-testid="neural-effects">
          {effects.map((e) => <li key={e.eventId} className="mono small" title={e.eventId}>{e.type} · {e.eventId.slice(-6)}</li>)}
        </ol>
        {/* P-100: legenda dei globi agente — semantica dichiarata e verificata con gli stati reali. */}
        <p className="mono small muted neural-legend" data-testid="neural-legend" title={t('widgets.neural.legendTitle')}>
          <span className="leg"><i className="leg-dot leg-alive" aria-hidden="true" />{t('widgets.neural.legendAlive')}</span>
          <span className="leg"><i className="leg-dot leg-problem" aria-hidden="true" />{t('widgets.neural.legendProblem')}</span>
          <span className="leg"><i className="leg-dot leg-off" aria-hidden="true" />{t('widgets.neural.legendOff')}</span>
        </p>
        <p className="mono small muted" data-testid="neural-stats">
          {stats ? t('widgets.neural.stats', { context: stats.context, quality: stats.quality, fps: stats.fps ?? '—', nodes: stats.nodes, pulses: stats.pulsesTotal, mode: stats.mode }) : '—'}
        </p>
      </div>
      {selectedNode && createPortal(<NodePanel node={selectedNode} core={core} onClose={() => selectNode(null)} onOpenTerminal={onOpenTerminal} />, document.body)}
    </div>
  );
}
