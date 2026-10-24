// Chat di gruppo locale (22/10/2026, richiesta del proprietario: «stile WhatsApp», lui e gli agenti, e la chat deve
// sembrare una conversazione fra persone). Tutto in visione.db, niente rete: un gruppo ha un nome e dei membri (agenti,
// ognuno con un ruolo); il proprietario scrive, chi è chiamato con @nome risponde (senza @ risponde il primo membro, il
// «capo» del gruppo). Ogni agente chiamato riceve il filo recente della conversazione e risponde come in una chat; se
// nella risposta chiama un altro membro con @nome, quello risponde a sua volta, con un tetto contro i giri infiniti.
// Una risposta è un obiettivo con un passo solo assegnato a quell'agente (come la chat diretta, P-67): niente Director
// in mezzo; la risposta è l'esito del passo, senza le righe MEMORIA.
//
// La squadra come un ufficio (24/10/2026, il proprietario: «gli agenti si vedano quando parlano o lavorano per i fatti
// loro… come fossero persone che lavorano nel mio pc… sono tutti autorizzati a creare gruppi e parlare»). Per ogni
// lavoro del proprietario il capo (chi fa il piano, di solito il Director) apre un gruppo con chi ci lavora: il lavoro
// ricevuto, come lo dividono, «@Esecutore, tocca a te», il risultato di ognuno, la fine. Nasce dallo stato dei task, non
// da un modello: nessuna chiamata in più, e dopo un riavvio i messaggi mancanti si ricostruiscono (id fissi). Un agente
// che scrive @nome nel risultato chiama quel collega nel gruppo; con una riga «GRUPPO: nome con @a @b» apre un gruppo.
import {
  isTerminalTaskStatus,
  type AgentDefinition,
  type Language,
  type Task
} from '../../shared/contracts/index.ts';
import { describeAttachments, splitAttachments, withAttachments, type AttachedFile } from '../../shared/lib/attachments.ts';
import { humanReason } from '../../shared/lib/human-reason.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { AgentManager } from '../agents/index.ts';
import type { EventBus, Subscription } from '../bus/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { Db, Row } from '../db/index.ts';
import { isOwnerRequest } from '../director/index.ts';
import type { EventEmitter } from '../events/index.ts';
import { withoutFacts } from '../memory/index.ts';
import type { TaskEngine } from '../tasks/index.ts';

export const GROUP_LIMITS = {
  nameChars: 60,
  roleChars: 80,
  members: 8,
  textChars: 4_000,
  /** Messaggi del filo dati all'agente chiamato. */
  threadForAgent: 14,
  /** Agenti chiamati da un solo messaggio. */
  callsPerMessage: 3,
  /** Rimbalzi agente → agente dopo un messaggio del proprietario. */
  hops: 2,
  /** Messaggi restituiti alla UI. */
  page: 200,
  /** Gruppi di lavoro aperti dal Director lasciati nella lista: i più vecchi si archiviano (restano nel database). */
  workGroups: 12,
  /** Gruppi aperti dagli agenti lasciati nella lista. */
  agentGroups: 10,
  /** Il risultato di un passo come messaggio nel gruppo di lavoro. */
  resultChars: 1_500
} as const;

/** Chi scrive: il proprietario, un agente (il suo id) o VISIONE per gli avvisi («X non è riuscito a rispondere»). */
export type GroupAuthor = 'owner' | 'visione' | string;

export interface GroupMember {
  readonly agentId: string;
  readonly role: string;
}

export interface GroupView {
  readonly id: string;
  readonly name: string;
  readonly members: (GroupMember & { readonly name: string })[];
  readonly last: { readonly author: string; readonly authorName: string; readonly text: string; readonly at: number } | null;
  /** «owner», «visione» o l'id dell'agente che l'ha aperto. */
  readonly createdBy: string;
  readonly createdByName: string;
  /** Il lavoro del proprietario per cui il Director l'ha aperto. */
  readonly workRootId: string | null;
}

export interface GroupMessage {
  readonly id: string;
  readonly groupId: string;
  readonly author: GroupAuthor;
  readonly authorName: string;
  readonly text: string;
  readonly files: AttachedFile[];
  readonly at: number;
}

export interface Groups {
  /** I gruppi attivi; se non ce n'è nessuno nasce «Squadra» con tutti gli agenti attivi. */
  list(): GroupView[];
  create(input: { name: string; members: readonly GroupMember[] }): GroupView;
  remove(groupId: string): boolean;
  messages(groupId: string, limit?: number): { messages: GroupMessage[]; typing: { agentId: string; name: string }[] };
  /** Messaggio del proprietario: lo salva e chiama chi deve rispondere. */
  post(groupId: string, text: string): { message: GroupMessage; called: string[] };
  /** «Svuota chat»: la conversazione («main» o un gruppo) si mostra da adesso; niente si cancella. */
  clear(conversation: string): number;
  /** Da quando si mostra la conversazione (0 = da sempre). */
  clearedAt(conversation: string): number;
  /** Righe «Squadra» per il brief di un passo di un lavoro del proprietario: con chi lavora e come parlargli. */
  teamBrief(taskId: string): string[];
  start(): void;
  stop(): void;
}

export interface GroupsDeps {
  readonly db: Db;
  readonly events: EventEmitter;
  readonly bus: EventBus;
  readonly engine: TaskEngine;
  readonly agents: AgentManager;
  readonly log: Logger;
  readonly now: () => number;
  readonly language: () => Language;
  /** Il capo della squadra predefinita (il Director, se c'è). */
  readonly leadAgent?: () => string | null;
}

/** «Mario Rossi» → «mariorossi»: confronto delle menzioni senza maiuscole, accenti e spazi. */
export function mentionKey(raw: string): string {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Gli agenti chiamati con @nome (o @id) fra i membri, nell'ordine del testo, senza doppioni. */
export function mentionedMembers(text: string, members: readonly { agentId: string; name: string }[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/@([\p{L}\p{N}_.-]+)/gu)) {
    const key = mentionKey(m[1] ?? '');
    if (!key) continue;
    // Il nome più lungo che combacia vince («@Ricercatore» non diventa «@Ricerca»).
    const hit = [...members]
      .filter((x) => key.startsWith(mentionKey(x.name)) || key.startsWith(mentionKey(x.agentId)))
      .sort((a, b) => mentionKey(b.name).length - mentionKey(a.name).length)[0];
    if (hit && !out.includes(hit.agentId)) out.push(hit.agentId);
  }
  return out;
}

/**
 * La risposta di un agente senza un nome in testa (VM, 23/10/2026: un modello piccolo continuava il filo e scriveva
 * «Tu: Ciao tutti…»). Toglie «Nome:» se il nome è di chi sta nel filo.
 */
export function cleanGroupReply(text: string, names: readonly string[]): string {
  const known = new Set(names.map((n) => mentionKey(n)).filter((k) => k !== ''));
  let out = text.trim();
  for (let i = 0; i < 2; i++) {
    const m = /^\**([^\s:*][^:\n*]{0,40}?)\**\s*:\**\s*/.exec(out);
    if (!m || !known.has(mentionKey(m[1]!))) break;
    out = out.slice(m[0].length).trim();
  }
  return out;
}

const GROUP_LINE = /^[ \t>*_-]*(?:GRUPPO|GROUP)[ \t]*:[ \t]*(.+)$/gim;
const GROUP_LINE_START = /^[ \t>*_-]*(?:GRUPPO|GROUP)[ \t]*:/i;

/**
 * Un gruppo nuovo chiesto da un agente con una riga «GRUPPO: nome del gruppo con @a @b»: il nome è ciò che viene prima
 * della prima menzione, i membri sono gli agenti menzionati. Null se la riga non c'è o non nomina nessun agente.
 */
export function groupRequest(text: string, agents: readonly { agentId: string; name: string }[]): { name: string; members: string[] } | null {
  for (const m of text.matchAll(GROUP_LINE)) {
    const body = (m[1] ?? '').trim();
    const at = body.indexOf('@');
    const name = (at >= 0 ? body.slice(0, at) : body)
      .replace(/[«»"*_]/g, '').replace(/\s+/g, ' ').trim()
      .replace(/\s*(?:\b(?:con|with|e|and|per|for)\b|[,:;-])\s*$/i, '').trim()
      .slice(0, GROUP_LIMITS.nameChars);
    const members = mentionedMembers(body, agents);
    if (name && members.length > 0) return { name, members };
  }
  return null;
}

/** Il messaggio senza le righe «GRUPPO:», che non sono per chi legge. */
export function withoutGroupLines(text: string): string {
  return text.split('\n').filter((l) => !GROUP_LINE_START.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Il testo che riceve l'agente chiamato: chi è, il gruppo, il filo recente, come rispondere. */
export function groupPrompt(input: {
  lang: Language;
  group: string;
  me: { name: string; role: string };
  others: readonly { name: string; role: string }[];
  thread: readonly { authorName: string; text: string }[];
}): string {
  const en = input.lang === 'en';
  const others = input.others.map((o) => `${o.name}${o.role ? ` (${o.role})` : ''}`).join(', ');
  const thread = input.thread.map((m) => `${m.authorName}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`).join('\n');
  if (en) {
    return [
      `You are ${input.me.name}${input.me.role ? `, ${input.me.role}` : ''}, in the group chat "${input.group}" with the owner${others ? ` and ${others}` : ''}.`,
      'Latest messages:',
      thread,
      '',
      'You were called: reply to the last message. Write as in a chat between people: short, natural, friendly, no technical ' +
        'lists unless needed. If you need another member, write @name in your message. If you are asked for a job, do it with ' +
        'your tools and then tell it in a few lines. To open a new group with colleagues, write a line "GROUP: group name with ' +
        '@name @name".'
    ].join('\n');
  }
  return [
    `Sei ${input.me.name}${input.me.role ? `, ${input.me.role}` : ''}, nella chat di gruppo «${input.group}» con il proprietario${others ? ` e ${others}` : ''}.`,
    'Ultimi messaggi:',
    thread,
    '',
    "Ti hanno chiamato: rispondi tu all'ultimo messaggio. Scrivi come in una chat fra persone: breve, naturale, cordiale, " +
      'niente elenchi tecnici se non servono. Se ti serve un altro membro del gruppo, scrivi @nome nel messaggio. Se ti ' +
      'chiedono un lavoro, fallo con i tuoi strumenti e poi raccontalo in poche righe. Per aprire un gruppo nuovo con dei ' +
      'colleghi scrivi una riga «GRUPPO: nome del gruppo con @nome @nome».'
  ].join('\n');
}

export function createGroups(deps: GroupsDeps): Groups {
  const { db, events, bus, engine, agents, log, now } = deps;
  const lang = deps.language;
  let subscription: Subscription | null = null;

  const insertGroup = db.prepare('INSERT INTO chat_groups (id, name, members, created_at, updated_at, archived_at, created_by, work_root_id) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)');
  const activeGroups = db.prepare('SELECT * FROM chat_groups WHERE archived_at IS NULL ORDER BY updated_at DESC');
  const ownerGroups = db.prepare("SELECT COUNT(*) AS n FROM chat_groups WHERE archived_at IS NULL AND work_root_id IS NULL AND created_by = 'owner'");
  const workGroupByRoot = db.prepare('SELECT * FROM chat_groups WHERE work_root_id = ?');
  const activeWorkGroups = db.prepare('SELECT * FROM chat_groups WHERE archived_at IS NULL AND work_root_id IS NOT NULL ORDER BY updated_at DESC');
  const activeAgentGroups = db.prepare("SELECT * FROM chat_groups WHERE archived_at IS NULL AND work_root_id IS NULL AND created_by <> 'owner' ORDER BY updated_at DESC");
  const setMembers = db.prepare('UPDATE chat_groups SET members = ? WHERE id = ?');
  const insertMessageOnce = db.prepare('INSERT OR IGNORE INTO chat_group_messages (id, group_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)');
  const clearedOf = db.prepare('SELECT cleared_at FROM chat_cleared WHERE conversation = ?');
  const setCleared = db.prepare('INSERT INTO chat_cleared (conversation, cleared_at) VALUES (?, ?) ON CONFLICT(conversation) DO UPDATE SET cleared_at = excluded.cleared_at');
  const groupById = db.prepare('SELECT * FROM chat_groups WHERE id = ? AND archived_at IS NULL');
  const touchGroup = db.prepare('UPDATE chat_groups SET updated_at = ? WHERE id = ?');
  const archiveGroup = db.prepare('UPDATE chat_groups SET archived_at = ? WHERE id = ? AND archived_at IS NULL');
  const insertMessage = db.prepare('INSERT INTO chat_group_messages (id, group_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)');
  const lastMessages = db.prepare('SELECT * FROM chat_group_messages WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
  const insertJob = db.prepare('INSERT INTO chat_group_jobs (task_id, group_id, agent_id, hops, created_at) VALUES (?, ?, ?, ?, ?)');
  const jobByTask = db.prepare('SELECT * FROM chat_group_jobs WHERE task_id = ?');
  const jobsOfGroup = db.prepare('SELECT * FROM chat_group_jobs WHERE group_id = ?');
  const allJobs = db.prepare('SELECT * FROM chat_group_jobs');
  const deleteJob = db.prepare('DELETE FROM chat_group_jobs WHERE task_id = ?');

  const ownerName = (): string => (lang() === 'en' ? 'You' : 'Tu');
  const ownerForAgents = (): string => (lang() === 'en' ? 'Owner' : 'Proprietario');
  const agentName = (agentId: string): string => agents.get(agentId)?.name ?? agentId;
  const authorName = (author: string): string => (author === 'owner' ? ownerName() : author === 'visione' ? 'VISIONE' : agentName(author));
  const membersOf = (row: Row): GroupMember[] => {
    try {
      const raw = JSON.parse(String(row.members)) as unknown;
      return Array.isArray(raw) ? raw.filter((m): m is GroupMember => typeof m?.agentId === 'string').map((m) => ({ agentId: m.agentId, role: typeof m.role === 'string' ? m.role : '' })) : [];
    } catch {
      return [];
    }
  };
  /** Solo i membri che esistono ancora (un agente archiviato non risponde più). */
  const liveMembers = (row: Row): (GroupMember & { name: string })[] =>
    membersOf(row).filter((m) => agents.get(m.agentId) !== null).map((m) => ({ ...m, name: agentName(m.agentId) }));
  // Le righe «📎» del testo diventano `files` (24/10/2026): la chat le mostra come etichette da aprire.
  const toMessage = (r: Row): GroupMessage => {
    const { text, files } = splitAttachments(String(r.text));
    return { id: String(r.id), groupId: String(r.group_id), author: String(r.author), authorName: authorName(String(r.author)), text, files, at: Number(r.created_at) };
  };
  const view = (row: Row): GroupView => {
    const found = lastMessages.all(String(row.id), 1)[0];
    // Dopo «Svuota chat» la lista non mostra più l'ultimo messaggio di prima.
    const last = found && Number(found.created_at) > Number(clearedOf.get(String(row.id))?.cleared_at ?? 0) ? found : undefined;
    const createdBy = String(row.created_by ?? 'owner');
    return {
      id: String(row.id),
      name: String(row.name),
      members: liveMembers(row),
      last: last ? { author: String(last.author), authorName: authorName(String(last.author)), text: describeAttachments(String(last.text), lang()).slice(0, 200), at: Number(last.created_at) } : null,
      createdBy,
      createdByName: authorName(createdBy),
      workRootId: row.work_root_id == null ? null : String(row.work_root_id)
    };
  };
  const changed = (groupId: string): void => {
    events.emit('group.changed', { groupId });
  };
  const addMessage = (groupId: string, author: string, text: string): GroupMessage => {
    const t = now();
    const id = ulid(t);
    insertMessage.run(id, groupId, author, text.slice(0, GROUP_LIMITS.textChars), t);
    touchGroup.run(t, groupId);
    changed(groupId);
    return toMessage({ id, group_id: groupId, author, text: text.slice(0, GROUP_LIMITS.textChars), created_at: t });
  };

  const createRow = (name: string, members: readonly GroupMember[], createdBy = 'owner', workRootId: string | null = null): Row => {
    const t = now();
    const id = ulid(t);
    insertGroup.run(id, name, JSON.stringify(members), t, t, createdBy, workRootId);
    return groupById.get(id)!;
  };

  /** Lascia nella lista solo i `keep` gruppi più recenti di un tipo: gli altri si archiviano, non si cancellano. */
  const archiveOld = (rows: Row[], keep: number): void => {
    for (const row of rows.slice(keep)) {
      if (Number(archiveGroup.run(now(), String(row.id)).changes) > 0) changed(String(row.id));
    }
  };

  const say = (it: string, en: string): string => (lang() === 'en' ? en : it);
  const oneLine = (text: string, max: number): string => {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  // Il motivo come lo direbbe una persona (24/10/2026: «tentativo oltre 900000 ms» nel gruppo di lavoro).
  const because = (t: Task): string => (t.error ? `: ${humanReason(t.error, lang())}.` : '.');
  const memberOf = (agentId: string): GroupMember => ({ agentId, role: (agents.get(agentId)?.role ?? '').slice(0, GROUP_LIMITS.roleChars) });

  /** Chiama un agente del gruppo: un obiettivo con un passo, il filo recente nel testo. */
  const call = (row: Row, agentId: string, hops: number, by: string): void => {
    const members = liveMembers(row);
    const me = members.find((m) => m.agentId === agentId);
    if (!me) return;
    const thread = lastMessages.all(String(row.id), GROUP_LIMITS.threadForAgent).reverse().map(toMessage)
      // Per l'agente «Tu» sarebbe lui stesso: il proprietario si chiama col suo ruolo (VM, 23/10/2026).
      .map((m) => (m.author === 'owner' ? { ...m, authorName: ownerForAgents() } : m));
    // Allegati (24/10/2026): nel filo «[allegati: nome]»; i file degli ultimi messaggi in righe «📎», che il motore copia.
    const named = (m: GroupMessage): string => describeAttachments(withAttachments(m.text, m.files.map((f) => f.path)), lang());
    const files = thread.slice(-3).flatMap((m) => m.files.map((f) => f.path));
    const spec = withAttachments(groupPrompt({
      lang: lang(),
      group: String(row.name),
      me: { name: me.name, role: me.role },
      others: members.filter((m) => m.agentId !== agentId).map((m) => ({ name: m.name, role: m.role })),
      thread: thread.map((m) => ({ ...m, text: named(m) }))
    }), files);
    const last = thread.at(-1);
    const lastText = (last ? named(last) : '').replace(/\s+/g, ' ').trim();
    const title = `${lang() === 'en' ? 'Chat' : 'Chat'} «${String(row.name)}»: ${lastText}`.slice(0, 200);
    const correlationId = ulid(now());
    try {
      const out = engine.createGoal({
        title, spec, createdBy: by,
        steps: [{ key: 'risposta', kind: 'work', title, spec, assigneeAgentId: agentId }]
      }, { correlationId, causationId: null });
      insertJob.run(out.root.id, String(row.id), agentId, hops, now());
      changed(String(row.id));
    } catch (err) {
      log.warn('chiamata di un agente nel gruppo non riuscita', { agentId, err });
      addMessage(String(row.id), 'visione', lang() === 'en' ? `${me.name} cannot answer right now.` : `${me.name} adesso non può rispondere.`);
    }
  };

  /** Un gruppo aperto da un agente con la riga «GRUPPO:»: il suo messaggio apre il filo e gli invitati rispondono. */
  const openAgentGroup = (author: string, request: { name: string; members: string[] }, text: string, hops: number): void => {
    if (!agents.get(author)) return;
    const ids = [author, ...request.members.filter((id) => id !== author)].slice(0, GROUP_LIMITS.members);
    if (ids.length < 2) return;
    const row = createRow(request.name, ids.map(memberOf), author);
    archiveOld(activeAgentGroups.all(), GROUP_LIMITS.agentGroups);
    addMessage(String(row.id), author, text || say('Ho aperto questo gruppo per lavorare insieme.', 'I opened this group so we can work together.'));
    if (hops >= GROUP_LIMITS.hops) return;
    for (const next of ids.slice(1, 1 + GROUP_LIMITS.callsPerMessage)) call(row, next, hops + 1, `agent:${author}`);
  };

  /**
   * Dopo il messaggio di un agente: chi ha chiamato con @nome risponde nel gruppo (un collega che non c'era entra, come
   * in un ufficio: si chiama chi serve); una riga «GRUPPO:» apre un gruppo nuovo.
   */
  const followUp = (row: Row, author: string, raw: string, hops: number): void => {
    const everyone = agents.active().map((a) => ({ agentId: a.id, name: a.name }));
    const request = groupRequest(raw, everyone);
    const text = withoutGroupLines(raw);
    if (request) openAgentGroup(author, request, text, hops);
    if (hops >= GROUP_LIMITS.hops) return;
    const called = mentionedMembers(text, everyone).filter((id) => id !== author).slice(0, GROUP_LIMITS.callsPerMessage);
    if (called.length === 0) return;
    const known = membersOf(row);
    const extra = called.filter((id) => !known.some((m) => m.agentId === id));
    if (extra.length > 0) setMembers.run(JSON.stringify([...known, ...extra.map(memberOf)].slice(0, GROUP_LIMITS.members)), String(row.id));
    const fresh = groupById.get(String(row.id)) ?? row;
    for (const next of called) call(fresh, next, hops + 1, `agent:${author}`);
  };

  /** Radici già viste che non sono lavori del proprietario: non si riguardano a ogni evento. */
  const notWork = new Set<string>();

  /**
   * Il gruppo di un lavoro del proprietario, ricostruito dallo stato dei task: lo apre il capo (chi fa il piano, se no
   * VISIONE) appena c'è chi ci lavora, e ogni passaggio diventa un messaggio con un id fisso (mai due volte).
   */
  const syncWork = (rootId: string): void => {
    if (notWork.has(rootId)) return;
    const root = engine.get(rootId);
    if (!root) return;
    if (root.kind !== 'goal' || !isOwnerRequest(root.createdBy, root.title)) {
      notWork.add(rootId);
      return;
    }
    const steps = engine.list({ rootId, limit: 200 }).filter((t) => t.kind !== 'goal').sort((a, b) => a.createdAt - b.createdAt);
    const plan = steps.find((t) => t.kind === 'plan' && t.assigneeAgentId) ?? null;
    const work = steps.filter((t) => t.kind === 'work' && t.assigneeAgentId);
    const lead = plan?.assigneeAgentId && agents.get(plan.assigneeAgentId) ? plan.assigneeAgentId : 'visione';
    const ids = [...new Set([...(lead === 'visione' ? [] : [lead]), ...work.map((t) => t.assigneeAgentId!)])]
      .filter((id) => agents.get(id) !== null).slice(0, GROUP_LIMITS.members);
    let row = workGroupByRoot.get(rootId);
    if (!row) {
      if (ids.length === 0) return;
      row = createRow(oneLine(root.title, GROUP_LIMITS.nameChars), ids.map(memberOf), lead, rootId);
      archiveOld(activeWorkGroups.all(), GROUP_LIMITS.workGroups);
    } else if (row.archived_at != null) {
      return;
    } else {
      const known = membersOf(row);
      const extra = ids.filter((id) => !known.some((m) => m.agentId === id));
      if (extra.length > 0) {
        setMembers.run(JSON.stringify([...known, ...extra.map(memberOf)].slice(0, GROUP_LIMITS.members)), String(row.id));
        row = groupById.get(String(row.id)) ?? row;
      }
    }
    const groupId = String(row.id);
    let added = 0;
    const post = (key: string, author: string, text: string, at: number): boolean => {
      const ok = Number(insertMessageOnce.run(`w-${key}`, groupId, author, text.slice(0, GROUP_LIMITS.textChars), at).changes) > 0;
      if (ok) added++;
      return ok;
    };
    const ask = oneLine(describeAttachments(root.spec || root.title, lang()), 300);
    post(`${rootId}-start`, lead, lead === 'visione'
      ? say(`Nuovo lavoro dal proprietario: «${ask}».`, `New job from the owner: "${ask}".`)
      : say(`Nuovo lavoro dal proprietario: «${ask}». Lo organizzo io.`, `New job from the owner: "${ask}". I'll organize it.`), root.createdAt);
    if (plan && isTerminalTaskStatus(plan.status)) {
      const at = plan.endedAt ?? plan.updatedAt;
      if (plan.status !== 'succeeded') post(`${plan.id}-end`, lead, say(`Non sono riuscito a preparare il piano${because(plan)}`, `I couldn't prepare the plan${because(plan)}`), at);
      // Il piano si scrive quando i passi esistono già: il loro evento arriva dopo la fine del passo di piano.
      else if (work.length > 0) {
        post(`${plan.id}-end`, lead, [say('Ecco come ci dividiamo il lavoro:', "Here's how we split the work:"), ...work.map((t) => `• @${agentName(t.assigneeAgentId!)}: ${t.title}`)].join('\n'), at);
      }
    }
    const names = [ownerName(), ownerForAgents(), 'VISIONE', ...liveMembers(row).map((m) => m.name)];
    const replies: { author: string; raw: string }[] = [];
    for (const t of work) {
      const who = t.assigneeAgentId!;
      if (t.startedAt !== null) {
        post(`${t.id}-start`, lead, who === lead
          ? say(`Me ne occupo io: ${t.title}`, `I'll take care of it: ${t.title}`)
          : say(`@${agentName(who)}, tocca a te: ${t.title}`, `@${agentName(who)}, over to you: ${t.title}`), t.startedAt);
      }
      if (!isTerminalTaskStatus(t.status)) continue;
      const at = t.endedAt ?? t.updatedAt;
      if (t.status === 'succeeded') {
        const raw = t.result ? withoutFacts(t.result.summary) : '';
        const text = cleanGroupReply(withoutGroupLines(raw), names);
        const shown = text.length > GROUP_LIMITS.resultChars ? `${text.slice(0, GROUP_LIMITS.resultChars - 1)}…` : text;
        if (post(`${t.id}-end`, who, shown || say('Fatto.', 'Done.'), at) && raw) replies.push({ author: who, raw });
      } else if (t.status === 'cancelled') {
        post(`${t.id}-end`, who, say('Mi fermo: il lavoro è stato annullato.', 'Stopping: the job was cancelled.'), at);
      } else {
        post(`${t.id}-end`, who, say(`Non ci sono riuscito${because(t)}`, `I couldn't do it${because(t)}`), at);
      }
    }
    if (isTerminalTaskStatus(root.status)) {
      post(`${rootId}-end`, lead, root.status === 'succeeded'
        ? say('Lavoro finito: ho portato la risposta al proprietario.', 'Job done: I gave the answer to the owner.')
        : root.status === 'cancelled'
          ? say('Il proprietario ha fermato il lavoro: ci fermiamo qui.', 'The owner stopped the job: we stop here.')
          : say("Non ce l'abbiamo fatta: l'ho detto al proprietario.", "We didn't make it: I told the owner."), (root.endedAt ?? root.updatedAt) + 1);
    }
    if (added === 0) return;
    touchGroup.run(now(), groupId);
    changed(groupId);
    for (const r of replies) followUp(row, r.author, r.raw, 0);
  };

  /** L'esito di un obiettivo della chat: la risposta dell'agente nel gruppo, ed eventuali rimbalzi. */
  const finish = (root: Task): void => {
    const job = jobByTask.get(root.id);
    if (!job) return;
    deleteJob.run(root.id);
    const groupId = String(job.group_id);
    const agentId = String(job.agent_id);
    const row = groupById.get(groupId);
    if (!row) return;
    const steps = engine.list({ rootId: root.id, limit: 50 }).filter((t) => t.kind !== 'goal' && t.kind !== 'plan');
    const ok = [...steps].reverse().find((t) => t.status === 'succeeded' && t.result);
    const names = [ownerName(), ownerForAgents(), 'VISIONE', ...liveMembers(row).map((m) => m.name)];
    const raw = ok?.result ? withoutFacts(ok.result.summary) : '';
    const answer = cleanGroupReply(withoutGroupLines(raw), names);
    if (root.status === 'succeeded' && raw) {
      // Solo una riga «GRUPPO:»: qui non si scrive niente, il messaggio va nel gruppo nuovo.
      if (answer) addMessage(groupId, agentId, answer);
      followUp(row, agentId, raw, Number(job.hops));
      return;
    }
    const name = agentName(agentId);
    const failed = steps.find((t) => t.error);
    const why = failed?.error ? humanReason(failed.error, lang()) : null;
    const en = lang() === 'en';
    const text = root.status === 'cancelled'
      ? (en ? `${name}'s reply was cancelled.` : `La risposta di ${name} è stata annullata.`)
      : (en ? `${name} could not answer${why ? `: ${why}` : '.'}` : `${name} non è riuscito a rispondere${why ? `: ${why}` : '.'}`);
    addMessage(groupId, 'visione', text);
  };

  const groups: Groups = {
    list() {
      // «Squadra» manca finché il proprietario non ha un gruppo suo: quelli del Director e degli agenti non contano.
      const active = agents.active();
      if (Number(ownerGroups.get()?.n ?? 0) === 0 && active.length > 0) {
        const lead = deps.leadAgent?.() ?? null;
        const ordered = [...active].sort((a, b) => (a.id === lead ? -1 : b.id === lead ? 1 : 0));
        createRow(lang() === 'en' ? 'Team' : 'Squadra', ordered.map((a: AgentDefinition) => ({ agentId: a.id, role: a.role ?? '' })));
      }
      return activeGroups.all().map(view);
    },
    create(input) {
      const name = input.name.replace(/\s+/g, ' ').trim().slice(0, GROUP_LIMITS.nameChars);
      if (!name) throw new CommandFailure('invalid_payload', lang() === 'en' ? 'the group needs a name' : 'il gruppo ha bisogno di un nome');
      const seen = new Set<string>();
      const members = input.members
        .filter((m) => agents.get(m.agentId) !== null && !seen.has(m.agentId) && (seen.add(m.agentId), true))
        .slice(0, GROUP_LIMITS.members)
        .map((m) => ({ agentId: m.agentId, role: m.role.replace(/\s+/g, ' ').trim().slice(0, GROUP_LIMITS.roleChars) }));
      if (members.length === 0) throw new CommandFailure('invalid_payload', lang() === 'en' ? 'choose at least one agent' : 'scegli almeno un agente');
      const row = createRow(name, members);
      changed(String(row.id));
      return view(row);
    },
    remove(groupId) {
      const done = Number(archiveGroup.run(now(), groupId).changes) > 0;
      if (done) changed(groupId);
      return done;
    },
    messages(groupId, limit = GROUP_LIMITS.page) {
      const row = groupById.get(groupId);
      if (!row) throw new CommandFailure('not_found', lang() === 'en' ? 'group not found' : 'gruppo non trovato');
      const from = groups.clearedAt(groupId);
      const messages = lastMessages.all(groupId, Math.min(Math.max(limit, 1), GROUP_LIMITS.page)).reverse().map(toMessage).filter((m) => m.at > from);
      // «Sta scrivendo…»: chi deve una risposta nel gruppo e, nel gruppo di un lavoro, chi ci sta lavorando adesso.
      const busy = jobsOfGroup.all(groupId).map((j) => String(j.agent_id));
      if (row.work_root_id != null) {
        for (const t of engine.list({ rootId: String(row.work_root_id), limit: 200 })) {
          if (t.kind !== 'goal' && t.status === 'running' && t.assigneeAgentId) busy.push(t.assigneeAgentId);
        }
      }
      const typing = busy.filter((id, i, a) => a.indexOf(id) === i).map((agentId) => ({ agentId, name: agentName(agentId) }));
      return { messages, typing };
    },
    post(groupId, raw) {
      const row = groupById.get(groupId);
      if (!row) throw new CommandFailure('not_found', lang() === 'en' ? 'group not found' : 'gruppo non trovato');
      const text = raw.trim().slice(0, GROUP_LIMITS.textChars);
      if (!text) throw new CommandFailure('invalid_payload', lang() === 'en' ? 'empty message' : 'messaggio vuoto');
      const message = addMessage(groupId, 'owner', text);
      const members = liveMembers(row);
      const named = mentionedMembers(text, members).slice(0, GROUP_LIMITS.callsPerMessage);
      // Senza @ risponde il capo del gruppo: il primo membro ancora attivo.
      const called = named.length > 0 ? named : members.slice(0, 1).map((m) => m.agentId);
      for (const agentId of called) call(row, agentId, 0, 'owner:group');
      return { message, called };
    },
    clear(conversation) {
      if (conversation !== 'main' && !groupById.get(conversation)) {
        throw new CommandFailure('not_found', lang() === 'en' ? 'conversation not found' : 'conversazione non trovata');
      }
      const at = now();
      setCleared.run(conversation, at);
      if (conversation !== 'main') changed(conversation);
      return at;
    },
    clearedAt(conversation) {
      return Number(clearedOf.get(conversation)?.cleared_at ?? 0);
    },
    teamBrief(taskId) {
      const task = engine.get(taskId);
      if (!task || task.kind !== 'work') return [];
      const row = workGroupByRoot.get(task.rootId);
      if (!row || row.archived_at != null) return [];
      // A voce la risposta è breve e il brief resta sotto i 1.000 caratteri.
      if (engine.get(task.rootId)?.createdBy === 'voice') return [];
      const others = liveMembers(row).filter((m) => m.agentId !== task.assigneeAgentId).map((m) => m.name);
      const name = String(row.name);
      return lang() === 'en'
        ? [
          `You work in a team${others.length > 0 ? ` with ${others.join(', ')}` : ''}: the owner sees the work in the group "${name}".`,
          'To ask a colleague something, write @name and the question in your result: they answer in the group.',
          'To open a new group with colleagues, write a line "GROUP: group name with @name @name".'
        ]
        : [
          `Lavori in squadra${others.length > 0 ? ` con ${others.join(', ')}` : ''}: il proprietario vede il lavoro nel gruppo «${name}».`,
          'Per chiedere qualcosa a un collega scrivi nel risultato @nome e la domanda: ti risponde nel gruppo.',
          'Per aprire un gruppo nuovo con dei colleghi scrivi una riga «GRUPPO: nome del gruppo con @nome @nome».'
        ];
    },
    start() {
      if (subscription) return;
      subscription = bus.subscribe((event) => {
        try {
          const p = event.payload as { taskId: string; rootId: string; kind: Task['kind']; to?: Task['status'] };
          if (event.type === 'task.status.changed' && p.kind === 'goal' && p.to && isTerminalTaskStatus(p.to)) {
            const root = engine.get(p.taskId);
            if (root) finish(root);
          }
          syncWork(p.rootId);
        } catch (err) {
          log.error('risposta di un agente nel gruppo non registrata', { err });
        }
      }, { name: 'groups', filter: { types: ['task.created', 'task.status.changed'] } });
      // Risposte arrivate mentre il core era fermo: si chiudono adesso.
      for (const job of allJobs.all()) {
        const root = engine.get(String(job.task_id));
        if (!root) deleteJob.run(String(job.task_id));
        else if (isTerminalTaskStatus(root.status)) finish(root);
      }
      // Lavori andati avanti mentre il core era fermo: i messaggi che mancano si scrivono adesso.
      for (const row of activeWorkGroups.all()) syncWork(String(row.work_root_id));
    },
    stop() {
      subscription?.unsubscribe();
      subscription = null;
    }
  };
  return groups;
}

export function registerGroupCommands(router: CommandRouter, groups: Groups): void {
  router.register('groups.list', () => ({ groups: groups.list() }));
  router.register('groups.create', (payload) => ({ group: groups.create(payload) }));
  router.register('groups.remove', (payload) => ({ removed: groups.remove(payload.groupId) }));
  router.register('groups.messages', (payload) => groups.messages(payload.groupId, payload.limit));
  router.register('groups.post', (payload) => groups.post(payload.groupId, payload.text));
  router.register('chat.clear', (payload) => ({ clearedAt: groups.clear(payload.conversation) }));
}
