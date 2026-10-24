// P-99 — logica PURA del pannello MOTORI: righe del debug di una verifica, obiettivo di riparazione
// per il Director e verdetti onesti dell'esito. Nessun DOM, nessun React: i test coprono i casi
// (disponibile/non disponibile, comando assente, task fallito, motore che resta non disponibile)
// senza toccare processi o rete. Qui non si inventa nulla: si formattano solo dati reali.
// Inglese (11/10/2026): ogni funzione che produce testo prende una lingua facoltativa (default `it`):
// chi la chiama senza ottiene esattamente il testo italiano di prima.
import type { EngineProbe, Language } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

export interface EngineDebugRow {
  k: string;
  v: string;
}

/** Righe del debug di UN motore: comando eseguito, esito, output/versione, percorso, problemi. */
export function engineDebugRows(p: EngineProbe, lang: Language = 'it'): EngineDebugRow[] {
  return [
    { k: translate(lang, 'settings.engine.rowEngine'), v: p.adapter },
    { k: translate(lang, 'settings.engine.rowCommand'), v: p.command ?? translate(lang, 'settings.engine.noCli') },
    { k: translate(lang, 'settings.engine.rowResult'), v: p.available ? translate(lang, 'settings.engine.available') : translate(lang, 'settings.engine.unavailable') },
    { k: translate(lang, 'settings.engine.rowOutput'), v: p.version ?? '—' },
    { k: translate(lang, 'settings.engine.rowPath'), v: p.path ?? '—' },
    { k: translate(lang, 'settings.engine.rowProblems'), v: p.problems.length > 0 ? p.problems.join(' · ') : translate(lang, 'settings.engine.none') }
  ];
}

/**
 * Obiettivo REALE di riparazione da sottoporre al Director: contiene la verifica eseguita e l'esito,
 * chiede di correggere e ritestare il motore, e impone di dichiarare «errore fisso» se non è
 * riparabile. Nessun risultato preconfezionato.
 */
export function engineFixGoal(p: EngineProbe, lang: Language = 'it'): string {
  return [
    translate(lang, 'settings.engine.goalRepair', { adapter: p.adapter }),
    translate(lang, 'settings.engine.goalCheck', {
      command: p.command ?? translate(lang, 'settings.engine.goalProbe'),
      result: p.available ? translate(lang, 'settings.engine.goalAvailable') : translate(lang, 'settings.engine.goalNotAvailable'),
      output: p.version ? translate(lang, 'settings.engine.goalOutput', { version: p.version }) : ''
    }),
    translate(lang, 'settings.engine.goalProblems', { list: p.problems.length > 0 ? p.problems.join(' | ') : translate(lang, 'settings.engine.none') }),
    translate(lang, 'settings.engine.goalInstructions'),
    translate(lang, 'settings.engine.goalFixed')
  ].join('\n');
}

export interface RestartOutcome {
  probes: readonly EngineProbe[];
  restarted: ReadonlyArray<{ agentId: string; ok: boolean; reason: string }>;
  failed: number;
}

/** Vista minima di un agente che serve al pannello MOTORI (solo dati reali già letti). */
export interface EngineAgentView {
  readonly definition: { readonly id: string; readonly engine: { readonly adapter: string } };
  readonly instance?: { readonly status: string; readonly statusReason?: string | null } | null;
}

/**
 * P-99: problemi REALI di un motore visti dagli agenti che lo usano — ultima istanza in `error` o
 * `crashed`. Un motore può rispondere alla verifica ed essere comunque inutilizzabile dai suoi
 * agenti: il pannello lo dichiara e abilita la riparazione.
 */
export function agentProblemsFor(adapterId: string, agents: readonly EngineAgentView[], lang: Language = 'it'): string[] {
  return agents
    .filter((a) => a.definition.engine.adapter === adapterId && (a.instance?.status === 'error' || a.instance?.status === 'crashed'))
    .map((a) => translate(lang, 'settings.engine.agentProblem', {
      id: a.definition.id, status: a.instance?.status ?? '', reason: a.instance?.statusReason ? ` (${a.instance.statusReason})` : ''
    }));
}

/** Problemi del motore + quelli degli agenti che lo usano (uniti, senza duplicati). */
export function withAgentProblems(probe: EngineProbe, agents: readonly EngineAgentView[], lang: Language = 'it'): EngineProbe {
  const problems = [...probe.problems, ...agentProblemsFor(probe.adapter, agents, lang)];
  return { ...probe, problems: problems.slice(0, 20) };
}

/** Riga d'esito di «Riavvia motori»: conteggi reali, mai un «tutto ok» senza numeri. */
export function restartSummary(r: RestartOutcome, lang: Language = 'it'): string {
  const available = r.probes.filter((p) => p.available).length;
  const ok = r.restarted.filter((d) => d.ok).length;
  return translate(lang, 'settings.engine.restartSummary', { probes: r.probes.length, available, ok, total: r.restarted.length, failed: r.failed });
}

/** Dettaglio per-agente del riavvio (una riga per agente toccato), con il motivo reale. */
export function restartDetail(r: RestartOutcome, lang: Language = 'it'): string {
  if (r.restarted.length === 0) return translate(lang, 'settings.engine.restartNone');
  return r.restarted.map((d) => translate(lang, d.ok ? 'settings.engine.restartedOk' : 'settings.engine.restartedNo', { id: d.agentId, reason: d.reason })).join(' · ');
}

export interface FixVerdictInput {
  /** Stato terminale reale del task di riparazione. */
  taskStatus: string;
  /** Riepilogo reale del task (se presente). */
  summary?: string | null;
  /** Errore reale del task (se fallito). */
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Nuova verifica reale del motore, fatta DOPO il task (null se non eseguibile). */
  probeAfter?: EngineProbe | null;
}

/**
 * Verdetto onesto della riparazione: «riparato» SOLO se il task è riuscito E la nuova verifica reale
 * dice che il motore è disponibile. Altrimenti il motivo vero; se non c'è nulla da riparare e il
 * motore resta KO si dichiara **errore fisso**.
 */
export function fixVerdict(i: FixVerdictInput, lang: Language = 'it'): string {
  const adapter = i.probeAfter?.adapter ?? translate(lang, 'settings.engine.engineWord');
  if (i.taskStatus === 'waiting') {
    return translate(lang, 'settings.engine.verdictWaiting');
  }
  if (i.taskStatus !== 'succeeded' && i.taskStatus !== 'failed' && i.taskStatus !== 'cancelled') {
    return translate(lang, 'settings.engine.verdictRunning', { status: i.taskStatus });
  }
  if (i.taskStatus !== 'succeeded') {
    const why = i.errorCode ? `${i.errorCode}: ${i.errorMessage ?? ''}`.trim() : (i.summary ?? i.taskStatus);
    return translate(lang, 'settings.engine.verdictTaskFailed', { why: why || translate(lang, 'settings.engine.verdictNoReason') });
  }
  // «Riparato» SOLO con verifica positiva E nessun problema residuo (motore o agenti che lo usano).
  if (i.probeAfter?.available === true && i.probeAfter.problems.length === 0) {
    return translate(lang, 'settings.engine.verdictRepaired', { adapter, version: i.probeAfter.version ?? translate(lang, 'settings.engine.verdictNoVersion') });
  }
  if (i.probeAfter != null) {
    const why = i.probeAfter.problems.length > 0 ? i.probeAfter.problems.join(' · ') : translate(lang, 'settings.engine.verdictStillNegative');
    return translate(lang, 'settings.engine.verdictStillBad', { adapter, why });
  }
  return translate(lang, 'settings.engine.verdictDone', { summary: i.summary ? `: ${i.summary}` : '' });
}

/**
 * Vero se il verdetto dichiara un errore fisso: inizia con «ERRORE FISSO» (italiano) o «PERMANENT
 * ERROR» (inglese). Serve alla vista per colorarlo come errore in qualunque lingua.
 */
export function isPermanentErrorVerdict(text: string): boolean {
  return text.startsWith('ERRORE FISSO') || text.startsWith('PERMANENT ERROR');
}
