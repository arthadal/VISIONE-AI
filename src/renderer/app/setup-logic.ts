// Procedura guidata del primo avvio (P-105), logica pura: ruoli, squadra consigliata ricavata dai
// dati dei motori (il renderer non nomina motori: nomi e consigli arrivano da `setup.catalog`),
// identificativi dai nomi scelti dall'utente, controlli della squadra, esito della verifica finale.
// I testi passano da `t` (lingua in uso, 10/10/2026); senza `t` restano in italiano.
import type { CatalogEntry, InstalledVoice, Language, SetupEngine, SetupItem, TeamMember } from '../../shared/contracts/index.ts';
import { translate, type Translate } from '../lib/i18n/index.ts';

/** Versione della procedura: alzarla la fa ricomparire alle installazioni che l'avevano completata. */
export const SETUP_VERSION = 1;

/** Il passo della verifica finale (dopo il passo facoltativo «Offline», 17/10/2026): l'ultimo della procedura. */
export const VERIFY_STEP = 5;

/**
 * Il passo da cui riprendere dopo un riavvio del core (18/10/2026): lo stesso, se ciò che gli serve c'è
 * ancora; se no il passo valido più vicino all'indietro, mai il primo per forza. Voce, Offline e Verifica
 * (3-5) lavorano sulla squadra applicata; la Squadra (2) chiede almeno un motore pronto, come «Avanti».
 * `anyReady` null = rilevamento non riuscito: su un dato che manca non si sposta niente.
 */
export function resumeStep(step: number, facts: { anyReady: boolean | null; teamApplied: boolean }): number {
  let s = Number.isInteger(step) ? Math.min(Math.max(step, 0), VERIFY_STEP) : 0;
  if (s >= 3 && !facts.teamApplied) s = 2;
  if (s === 2 && facts.anyReady === false) s = 1;
  return s;
}

/** Testi in italiano: la lingua di partenza quando il chiamante non ne indica una. */
const IT: Translate = (key, vars) => translate('it', key, vars);

export type RoleKey = 'director' | 'code' | 'review' | 'research' | 'general';
type Competence = TeamMember['competences'] extends readonly (infer C)[] | undefined ? C : never;

export const ROLE_COMPETENCES: Readonly<Record<RoleKey, readonly Competence[]>> = {
  director: ['reasoning', 'general'],
  code: ['code'],
  review: ['review'],
  research: ['research'],
  general: ['general']
};
export const ROLE_ORDER: readonly RoleKey[] = ['director', 'code', 'review', 'research', 'general'];

/** Etichetta del menu, nome proposto e descrizione del ruolo, nella lingua in uso. */
export function roleText(key: RoleKey, t: Translate = IT): { label: string; defaultName: string; role: string } {
  return { label: t(`role.${key}.label`), defaultName: t(`role.${key}.name`), role: t(`role.${key}.role`) };
}

export interface EngineCatalog {
  readonly adapter: string;
  readonly label: string;
  readonly models: readonly CatalogEntry[];
}

export interface TeamRow {
  /** Chiave locale della riga (React): non è l'identificativo dell'agente. */
  readonly key: string;
  name: string;
  roleKey: RoleKey;
  adapter: string;
  model: string;
  endpointProfile?: string;
}

let rowSeq = 0;
export const newRowKey = (): string => `riga-${++rowSeq}`;

/** Identificativo dell'agente dal nome scelto («Alessia 2» → `alessia-2`), unico nella squadra. */
export function slugId(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  if (!/^[a-z]/.test(base)) base = `agente-${base}`.replace(/-+$/, '');
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Il modello consigliato per un ruolo, cercato in tutti i motori; null se nessuno lo consiglia. */
/** Se nessun modello è consigliato per un ruolo, il ruolo vicino: revisione → codice (17/10/2026). */
const ROLE_FALLBACK: Partial<Record<Exclude<RoleKey, 'general'>, Exclude<RoleKey, 'general'>>> = { review: 'code' };

function suggested(catalogs: readonly EngineCatalog[], role: Exclude<RoleKey, 'general'>): { adapter: string; entry: CatalogEntry } | null {
  for (const c of catalogs) {
    const entry = c.models.find((m) => m.suggestedFor === role);
    if (entry) return { adapter: c.adapter, entry };
  }
  const near = ROLE_FALLBACK[role];
  return near ? suggested(catalogs, near) : null;
}

/** Nessun modello consigliato per il ruolo (un motore solo, senza consigli per ruolo): il primo consigliato, se no il primo. */
function anyModel(catalogs: readonly EngineCatalog[]): { adapter: string; entry: CatalogEntry } | null {
  for (const c of catalogs) {
    const entry = c.models.find((m) => m.recommended);
    if (entry) return { adapter: c.adapter, entry };
  }
  const c = catalogs.find((x) => x.models.length > 0);
  return c?.models[0] ? { adapter: c.adapter, entry: c.models[0] } : null;
}

/**
 * Squadra pronta: Director e agenti con i modelli che i motori consigliano per ciascun ruolo; un ruolo senza
 * consigli prende il modello consigliato di un motore che c'è, così anche con un motore solo la squadra è intera.
 */
export function suggestedTeam(catalogs: readonly EngineCatalog[], t: Translate = IT): TeamRow[] {
  const rows: TeamRow[] = [];
  for (const role of ['director', 'code', 'review', 'research'] as const) {
    const pick = suggested(catalogs, role) ?? anyModel(catalogs);
    if (!pick) continue;
    rows.push({ key: newRowKey(), name: roleText(role, t).defaultName, roleKey: role, adapter: pick.adapter, model: pick.entry.model, ...(pick.entry.endpointProfile ? { endpointProfile: pick.entry.endpointProfile } : {}) });
  }
  return rows;
}

/** Ciò che serve di un agente esistente per rimetterlo nella tabella della squadra. */
export interface ExistingAgent {
  readonly id: string;
  readonly name: string;
  readonly competences: readonly string[];
  readonly engine: { readonly adapter: string; readonly model?: string | null; readonly endpointProfile?: string };
}

/** Il ruolo dalle competenze che la guidata stessa scrive (`ROLE_COMPETENCES`); altrimenti il più vicino. */
export function roleOf(competences: readonly string[]): RoleKey {
  const same = ROLE_ORDER.find((k) => ROLE_COMPETENCES[k].length === competences.length && ROLE_COMPETENCES[k].every((c) => competences.includes(c)));
  if (same) return same;
  if (competences.includes('reasoning')) return 'director';
  return (['code', 'review', 'research'] as const).find((k) => competences.includes(k)) ?? 'general';
}

/**
 * La squadra che c'è (22/10/2026, VM: riaprendo la guidata dopo averla completata si vedeva la squadra consigliata
 * invece di quella applicata). Chi comanda è l'agente del `director.plannerAgentId`, se è fra questi.
 */
export function teamFromAgents(agents: readonly ExistingAgent[], plannerId: string | null): { rows: TeamRow[]; commander: string | null } {
  const rows = agents.map((a): TeamRow => ({
    key: newRowKey(), name: a.name, roleKey: roleOf(a.competences), adapter: a.engine.adapter, model: a.engine.model ?? '',
    ...(a.engine.endpointProfile ? { endpointProfile: a.engine.endpointProfile } : {})
  }));
  const boss = agents.findIndex((a) => a.id === plannerId);
  return { rows, commander: rows[boss >= 0 ? boss : 0]?.key ?? null };
}

/** Descrizione della squadra pronta in parole, dai nomi dei motori e dei gruppi dei modelli. */
export function teamLabel(catalogs: readonly EngineCatalog[], rows: readonly TeamRow[], t: Translate = IT): string {
  const director = rows.find((r) => r.roleKey === 'director');
  const others = rows.filter((r) => r !== director);
  const groups = [...new Set(others.map((r) => entryOf(catalogs, r)?.group ?? r.adapter))];
  const head = director ? t('wiz.team.labelAs', { engine: catalogs.find((c) => c.adapter === director.adapter)?.label ?? director.adapter }) : t('wiz.team.labelNone');
  return others.length > 0 ? t('wiz.team.labelOthers', { head, n: others.length, groups: groups.join(', ') }) : head;
}

export function entryOf(catalogs: readonly EngineCatalog[], row: Pick<TeamRow, 'adapter' | 'model'>): CatalogEntry | undefined {
  return catalogs.find((c) => c.adapter === row.adapter)?.models.find((m) => m.model === row.model);
}

/** Problemi della squadra in parole semplici; vuoto = si può applicare. */
export function teamProblems(rows: readonly TeamRow[], commanderKey: string | null, t: Translate = IT): string[] {
  const out: string[] = [];
  if (rows.length === 0) out.push(t('wiz.team.problem.none'));
  if (rows.length > 10) out.push(t('wiz.team.problem.tooMany'));
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const who = r.name.trim() || t('wiz.team.agentFallback', { n: i + 1 });
    if (!r.name.trim()) out.push(t('wiz.team.problem.unnamed', { n: i + 1 }));
    else if (r.name.trim().length > 40) out.push(t('wiz.team.problem.tooLong', { name: who }));
    const k = r.name.trim().toLocaleLowerCase();
    if (k && seen.has(k)) out.push(t('wiz.team.problem.duplicate', { name: who }));
    seen.add(k);
    if (!r.adapter) out.push(t('wiz.team.problem.engine', { name: who }));
    if (!r.model) out.push(t('wiz.team.problem.model', { name: who }));
  }
  if (!commanderKey || !rows.some((r) => r.key === commanderKey)) out.push(t('wiz.team.problem.commander'));
  return out;
}

/** La squadra per `setup.apply`, con gli identificativi ricavati dai nomi; `ids` per chiave di riga. */
export function teamPayload(rows: readonly TeamRow[], t: Translate = IT): { agents: TeamMember[]; ids: Map<string, string> } {
  const taken = new Set<string>();
  const ids = new Map<string, string>();
  const agents = rows.map((r): TeamMember => {
    const id = slugId(r.name.trim(), taken);
    taken.add(id);
    ids.set(r.key, id);
    return { id, name: r.name.trim(), role: roleText(r.roleKey, t).role, competences: [...ROLE_COMPETENCES[r.roleKey]], adapter: r.adapter, model: r.model, ...(r.endpointProfile ? { endpointProfile: r.endpointProfile } : {}) };
  });
  return { agents, ids };
}

/**
 * Chi fa davvero il turno della verifica: uno per motore e modello, chi comanda per primo (rappresentante → gli altri
 * dello stesso motore e modello, che ne prendono l'esito). VM 21/10/2026: quattro agenti sullo stesso modello locale
 * in coda su un processore superavano i 4 minuti, mentre un turno solo bastava a provare che il modello risponde.
 */
export function verifyGroups(rows: readonly TeamRow[], ids: ReadonlyMap<string, string>, commanderKey: string | null): Map<string, string[]> {
  const ordered = [...rows].sort((a, b) => Number(b.key === commanderKey) - Number(a.key === commanderKey));
  const repByEngine = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const r of ordered) {
    const id = ids.get(r.key);
    if (!id) continue;
    const engine = `${r.adapter}|${r.model}|${r.endpointProfile ?? ''}`;
    const rep = repByEngine.get(engine);
    if (rep) groups.get(rep)?.push(id);
    else {
      repByEngine.set(engine, id);
      groups.set(id, []);
    }
  }
  return groups;
}

/**
 * I requisiti non ancora a posto di un motore (vuoto = pronto): gli obbligatori e, per un modello di un profilo,
 * anche quelli indispensabili a quel profilo (18/10/2026: un agente su un modello del cloud senza la sua chiave non era segnalato).
 */
export function missingFor(engines: readonly SetupEngine[] | null, adapter: string, profile?: string): SetupItem[] {
  return (engines?.find((e) => e.adapter === adapter)?.items ?? []).filter((i) => !i.ok && (!i.optional || (profile !== undefined && i.forProfile === profile)));
}

/**
 * I profili di un motore (la chiave di un fornitore, i modelli locali…) sono facoltativi uno per uno, ma senza nessuno il
 * motore non ha modelli da usare: allora li restituisce tutti, da proporre in alternativa. Vuoto = almeno uno c'è.
 */
export function profilesMissing(engines: readonly SetupEngine[] | null, adapter: string): SetupItem[] {
  const profiles = (engines?.find((e) => e.adapter === adapter)?.items ?? []).filter((i) => i.forProfile !== undefined);
  return profiles.some((i) => i.ok) ? [] : profiles;
}

/** Un motore è utilizzabile se i requisiti obbligatori sono a posto e, se ha profili, almeno uno lo è. */
export const engineReady = (engines: readonly SetupEngine[] | null, adapter: string): boolean =>
  engines !== null && engines.some((e) => e.adapter === adapter) && missingFor(engines, adapter).length === 0 && profilesMissing(engines, adapter).length === 0;

/**
 * I modelli che si possono usare adesso: motore pronto e, per un modello di un profilo, profilo a posto. Da qui nasce
 * la squadra consigliata (21/10/2026: un tester con un solo motore si ritrovava agenti su motori che non aveva).
 */
export function usableCatalogs(catalogs: readonly EngineCatalog[], engines: readonly SetupEngine[] | null): EngineCatalog[] {
  if (engines === null) return [];
  return catalogs
    .filter((c) => engineReady(engines, c.adapter))
    .map((c) => ({ ...c, models: c.models.filter((m) => missingFor(engines, c.adapter, m.endpointProfile).length === 0) }))
    .filter((c) => c.models.length > 0);
}

export type CheckState = { readonly state: 'attesa' | 'in-corso' | 'ok' | 'errore'; readonly detail: string };

/** Esito di un agente nella verifica finale dal risultato del suo task. */
export function verifyOutcome(outcome: 'success' | 'partial' | 'failure', summary: string, producedBy?: string, expected?: string, names?: ReadonlyMap<string, string>, t: Translate = IT): CheckState {
  // Se l'agente non parte, VISIONE può passare il compito a un altro: la risposta allora non vale.
  if (producedBy && expected && producedBy !== expected) {
    return { state: 'errore', detail: t('wiz.verify.rerouted', { name: names?.get(producedBy) ?? producedBy }) };
  }
  const word = t('wiz.verify.answerWord');
  // Risposta vuota (VM 21/10/2026, 7b locale): il motore risponde, ma «ha risposto: «»» sembrava un guasto.
  if (outcome === 'success' && summary.trim() === '') return { state: 'ok', detail: t('wiz.verify.answeredEmpty') };
  if (outcome === 'success') return { state: 'ok', detail: summary.toLocaleLowerCase().includes(word.toLocaleLowerCase()) ? t('wiz.verify.answeredWord', { word }) : t('wiz.verify.answered', { text: summary.trim().slice(0, 80) }) };
  return { state: 'errore', detail: t('wiz.verify.incomplete', { why: t(outcome === 'partial' ? 'wiz.verify.partial' : 'wiz.verify.error'), detail: summary.trim().slice(0, 160) || t('wiz.verify.noDetail') }) };
}

/** Stati del task che chiudono la verifica senza risultato registrato. */
export function verifyStatus(status: string, reason: string, t: Translate = IT): CheckState | null {
  if (status === 'failed' || status === 'cancelled' || status === 'timed_out' || status === 'blocked') {
    const why = t(({ failed: 'wiz.verify.turnFailed', cancelled: 'wiz.verify.turnCancelled', timed_out: 'wiz.verify.turnTimeout', blocked: 'wiz.verify.blocked' } as const)[status]);
    return { state: 'errore', detail: `${why}${reason ? ` (${reason.slice(0, 120)})` : ''}` };
  }
  if (status === 'waiting') return { state: 'in-corso', detail: t('wiz.verify.waitingApproval') };
  return null;
}

/** Una richiesta di permesso di un agente della squadra, mostrata nella verifica (P-105). */
export interface PendingApproval {
  readonly id: string;
  readonly agentId: string;
  readonly kind: string;
  readonly target: string;
  readonly reason: string;
}

/** La richiesta in parole semplici: cosa chiede l'agente e perché di solito si consente. */
export function approvalText(a: Pick<PendingApproval, 'kind' | 'target' | 'reason'>, agentName: string, t: Translate = IT): { title: string; body: string } {
  if (a.kind === 'engine.workspace.trust') {
    return { title: t('wiz.approval.trustTitle', { name: agentName }), body: t('wiz.approval.trustBody', { target: a.target }) };
  }
  return { title: t('wiz.approval.title', { name: agentName, kind: a.kind }), body: `${a.reason}${a.target ? ` — ${a.target}` : ''}` };
}

/** Richieste uguali (stesso agente, tipo e oggetto, es. una rimasta da un tentativo prima): una scheda sola. */
export function sameRequest(a: PendingApproval, b: PendingApproval): boolean {
  return a.agentId === b.agentId && a.kind === b.kind && a.target === b.target;
}
export function uniqueRequests(list: readonly PendingApproval[]): PendingApproval[] {
  return list.filter((a, i) => list.findIndex((b) => sameRequest(a, b)) === i);
}

/** Voci di Windows note per lingua, mostrate finché la voce non dice quali sono installate davvero. */
const KNOWN_WINDOWS_VOICES: Readonly<Record<Language, readonly InstalledVoice[]>> = {
  it: [{ name: 'Microsoft Cosimo', language: 'it-IT', gender: 'Male' }, { name: 'Microsoft Elsa', language: 'it-IT', gender: 'Female' }],
  en: [{ name: 'Microsoft David', language: 'en-US', gender: 'Male' }, { name: 'Microsoft Zira', language: 'en-US', gender: 'Female' }, { name: 'Microsoft Mark', language: 'en-US', gender: 'Male' }]
};

/** Voci da offrire nella lingua: quelle installate di quella lingua; se nessuna, tutte le installate; se non note, quelle tipiche. */
export function voiceChoices(installed: readonly InstalledVoice[], language: Language): InstalledVoice[] {
  const inLanguage = installed.filter((v) => v.language.toLowerCase().startsWith(language));
  if (inLanguage.length > 0) return inLanguage;
  if (installed.length > 0) return [...installed];
  return [...KNOWN_WINDOWS_VOICES[language]];
}

/**
 * Soglia del rumore dalla misura della stanza (P-106): il doppio del 90° percentile dei livelli in
 * silenzio, tra 0,003 e 0,05 (sotto è inutile, sopra si rischia di non sentire chi parla piano).
 */
export function noiseGateFrom(levels: readonly number[]): number {
  const ok = levels.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (ok.length === 0) return 0.004;
  const p90 = ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.9))]!;
  return Math.round(Math.min(0.05, Math.max(0.003, p90 * 2)) * 10_000) / 10_000;
}
