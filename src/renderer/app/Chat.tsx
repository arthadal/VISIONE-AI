// Chat (Fase 11; rifatta il 22/10/2026 su richiesta del proprietario: «la chat deve sembrare una conversazione umana»,
// «stile WhatsApp»). A sinistra le conversazioni: VISIONE (le richieste del proprietario e le risposte) e i gruppi locali
// di agenti; a destra i fumetti. Niente codici, eventi di protocollo o righe tecniche: chi parla, cosa dice, quando.
// Nessun contenuto inventato: ogni fumetto nasce da una richiesta o da un messaggio salvato in visione.db.
// Offline (17/10/2026) la frase a VISIONE va al modello locale e la risposta compare sopra la barra comandi.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentView, AttachedFileDto, ChatRequestDto, GroupMessageDto, GroupViewDto, Language, VisioneEvent } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { AttachButton, pasteHandler, useAttachDrop } from './Attach.tsx';
import { ATTACH_MAX, composeMessage, fileName, nameColor, requestTurns } from './chat-logic.ts';
import { clockText } from '../windows/locale.ts';
import { sendGoal } from './offline-store.ts';

function Bubble({ mine, who, whoId, text, files, at, lang, showName }: { mine: boolean; who: string; whoId: string; text: string; files?: readonly AttachedFileDto[] | undefined; at: number; lang: Language; showName: boolean }) {
  return (
    <div className={`chat-row ${mine ? 'mine' : 'theirs'}`} data-testid="chat-turn">
      <div className="chat-bubble">
        {showName && !mine && <div className="chat-bubble-name" style={{ color: nameColor(whoId) }}>{who}</div>}
        {/* Allegati come su WhatsApp (24/10/2026): un clic apre il file. */}
        {files && files.length > 0 && (
          <div className="chat-files">
            {files.map((f) => (
              <button key={f.path} type="button" className="chat-file" title={f.path} onClick={() => { void window.visione.files.open(f.path); }} data-testid="chat-file">📎 {f.name}</button>
            ))}
          </div>
        )}
        {text !== '' && <p className="chat-text">{text}</p>}
        <div className="chat-bubble-time mono">{clockText(at, lang)}</div>
      </div>
    </div>
  );
}

/** Un messaggio di gruppo, con gli allegati come etichette da aprire. */
function GroupBubble({ m, lang }: { m: GroupMessageDto; lang: Language }) {
  return <Bubble mine={m.author === 'owner'} who={m.authorName} whoId={m.author} text={m.text} files={m.files} at={m.at} lang={lang} showName />;
}

type Selected = { kind: 'main' } | { kind: 'group'; id: string } | { kind: 'new' };

export function ChatView({ events, ready }: { events: readonly VisioneEvent[]; ready: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const [requests, setRequests] = useState<ChatRequestDto[]>([]);
  const turns = useMemo(() => requestTurns(requests, lang), [requests, lang]);
  const [selected, setSelected] = useState<Selected>({ kind: 'main' });
  const [text, setText] = useState('');
  // File scelti col 📎, trascinati o incollati, in attesa dell'invio.
  const [files, setFiles] = useState<string[]>([]);
  const addFiles = useCallback((paths: string[]) => setFiles((cur) => [...new Set([...cur, ...paths])].slice(0, ATTACH_MAX)), []);
  const drop = useAttachDrop(addFiles, ready);
  const [error, setError] = useState<string | null>(null);
  // «Svuota chat» chiede conferma con un secondo clic, come WhatsApp chiede «Svuota?».
  const [confirmClear, setConfirmClear] = useState(false);
  const [groups, setGroups] = useState<GroupViewDto[]>([]);
  const [thread, setThread] = useState<{ messages: GroupMessageDto[]; typing: { agentId: string; name: string }[] }>({ messages: [], typing: [] });
  const endRef = useRef<HTMLDivElement | null>(null);
  const groupId = selected.kind === 'group' ? selected.id : null;
  const group = groups.find((g) => g.id === groupId) ?? null;

  const loadGroups = useCallback(async () => {
    if (!ready) return;
    const res = await window.visione.groups.list();
    if (res.ok) setGroups(res.data.groups);
  }, [ready]);
  const loadThread = useCallback(async (id: string) => {
    const res = await window.visione.groups.messages(id);
    if (res.ok) setThread({ messages: res.data.messages, typing: res.data.typing });
  }, []);

  // Un gruppo è cambiato (messaggio nuovo, qualcuno scrive): si rilegge. L'evento più recente basta.
  const lastGroupEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === 'group.changed') return events[i]!.id;
    return null;
  }, [events]);
  useEffect(() => { void loadGroups(); }, [loadGroups, lastGroupEvent]);
  useEffect(() => {
    if (groupId) void loadThread(groupId);
  }, [groupId, loadThread, lastGroupEvent]);

  // La chat con VISIONE si rilegge dal database quando una richiesta nasce o cambia stato (23/10/2026).
  const loadMain = useCallback(async () => {
    if (!ready) return;
    const res = await window.visione.chat.history();
    if (res.ok) setRequests(res.data.requests);
  }, [ready]);
  const lastTaskEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const type = events[i]!.type;
      if (type === 'task.created' || type === 'task.status.changed' || type === 'director.summary') return events[i]!.id;
    }
    return null;
  }, [events]);
  useEffect(() => { void loadMain(); }, [loadMain, lastTaskEvent]);

  // «VISIONE sta scrivendo»: l'ultima richiesta non ha ancora una risposta.
  const mainWorking = requests.at(-1)?.status === 'open';
  // Il gruppo che il Director ha aperto per l'ultima richiesta (24/10/2026): da qui si va a vedere la squadra al lavoro.
  const lastRequestId = requests.at(-1)?.id ?? null;
  const workGroup = lastRequestId ? groups.find((g) => g.workRootId === lastRequestId) ?? null : null;
  const shown = selected.kind === 'group' ? thread.messages.length + thread.typing.length : turns.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [shown, selected.kind, groupId]);

  const send = (): void => {
    const typed = text.trim();
    if (typed === '' && files.length === 0) return;
    // Solo allegati: una frase di accompagnamento, come «guarda questi file».
    const value = composeMessage(typed || t('windows.chat.attachOnly'), files);
    setError(null);
    if (selected.kind === 'group') {
      const id = selected.id;
      void window.visione.groups.post(id, value).then((res) => {
        if (res.ok) {
          setText('');
          setFiles([]);
          void loadThread(id);
        } else setError(res.error.message);
      });
      return;
    }
    void sendGoal(value).then((res) => {
      if (res.ok) {
        setText('');
        setFiles([]);
        void loadMain();
      } else setError(res.error.message);
    });
  };

  useEffect(() => { setConfirmClear(false); }, [selected.kind, groupId]);
  const clearChat = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    void window.visione.chat.clear(groupId ?? 'main').then((res) => {
      if (!res.ok) setError(res.error.message);
      else if (groupId) { void loadThread(groupId); void loadGroups(); } else void loadMain();
    });
  };
  const clearButton = (
    <button type="button" className={`chat-remove small${confirmClear ? ' danger' : ''}`} onClick={clearChat} data-testid="chat-clear">
      {t(confirmClear ? 'windows.chat.clearConfirm' : 'windows.chat.clear')}
    </button>
  );

  const typingLine = thread.typing.length === 0 ? null
    : thread.typing.length === 1
      ? t('windows.chat.typing', { name: thread.typing[0]!.name })
      : t('windows.chat.typingMany', { names: thread.typing.map((x) => x.name).join(', ') });

  return (
    <section className="chat chat-layout" aria-label="Chat" data-testid="chat">
      <nav className="chat-list" aria-label={t('windows.chat.groupsTitle')}>
        <button type="button" className={`chat-conv${selected.kind === 'main' ? ' selected' : ''}`} onClick={() => setSelected({ kind: 'main' })} data-testid="chat-conv-main">
          <span className="chat-conv-name">VISIONE</span>
          <span className="chat-conv-last">{turns.at(-1)?.text ?? t('windows.chat.mainHint')}</span>
        </button>
        <div className="chat-list-title muted small">{t('windows.chat.groupsTitle')}</div>
        {groups.map((g) => (
          <button key={g.id} type="button" className={`chat-conv${groupId === g.id ? ' selected' : ''}`} onClick={() => setSelected({ kind: 'group', id: g.id })} data-testid="chat-conv-group">
            <span className="chat-conv-name">{g.name}</span>
            <span className="chat-conv-last">{g.last ? `${g.last.authorName}: ${g.last.text}` : g.members.map((m) => m.name).join(', ')}</span>
          </button>
        ))}
        <button type="button" className={`chat-conv chat-conv-new${selected.kind === 'new' ? ' selected' : ''}`} onClick={() => setSelected({ kind: 'new' })} disabled={!ready} data-testid="chat-new-group">
          + {t('windows.chat.newGroup')}
        </button>
      </nav>

      {selected.kind === 'new' ? (
        <NewGroup
          onCancel={() => setSelected({ kind: 'main' })}
          onCreated={(g) => { setGroups((all) => [g, ...all.filter((x) => x.id !== g.id)]); setSelected({ kind: 'group', id: g.id }); }}
        />
      ) : (
        <div className={`chat-pane${drop.over ? ' drop-over' : ''}`} {...drop.handlers}>
          {selected.kind === 'main' && turns.length > 0 && (
            <header className="chat-pane-head">
              <strong>VISIONE</strong>
              <span className="muted small chat-pane-members" />
              {clearButton}
            </header>
          )}
          {group && (
            <header className="chat-pane-head">
              <strong>{group.name}</strong>
              {/* Solo i nomi, come in una chat; i ruoli al passaggio del mouse (VM, 23/10/2026: a 1024 px andavano a capo su sei righe). */}
              <span className="muted small chat-pane-members" title={group.members.map((m) => (m.role ? `${m.name}: ${m.role}` : m.name)).join('\n')}>{group.members.map((m) => m.name).join(', ')}</span>
              {clearButton}
              <button type="button" className="chat-remove small" onClick={() => {
                void window.visione.groups.remove(group.id).then(() => { setSelected({ kind: 'main' }); void loadGroups(); });
              }}>{t('windows.chat.removeGroup')}</button>
            </header>
          )}
          <div className="chat-messages" data-testid="chat-messages">
            {selected.kind === 'main' && turns.length === 0 && <p className="muted" data-testid="chat-empty">{t('windows.chat.empty')}</p>}
            {selected.kind === 'main' && turns.map((turn) => (
              <Bubble key={turn.id} mine={turn.role === 'owner'} who={turn.who} whoId="visione" text={turn.text} files={turn.files} at={turn.at} lang={lang} showName={false} />
            ))}
            {selected.kind === 'main' && mainWorking && <div className="chat-typing">{t('windows.chat.typing', { name: 'VISIONE' })}</div>}
            {selected.kind === 'main' && workGroup && (
              <button type="button" className="chat-team-link small" onClick={() => setSelected({ kind: 'group', id: workGroup.id })} data-testid="chat-team-link">
                {t(mainWorking ? 'windows.chat.watchTeam' : 'windows.chat.watchTeamDone')} →
              </button>
            )}
            {group && group.createdBy !== 'owner' && <div className="chat-note">{t('windows.chat.openedBy', { name: group.createdByName })}</div>}
            {group && thread.messages.length === 0 && (
              <p className="muted">{t('windows.chat.groupEmpty', { lead: group.members[0]?.name ?? '—' })}</p>
            )}
            {group && thread.messages.map((m) => m.author === 'visione'
              ? <div key={m.id} className="chat-note">{m.text}</div>
              : <GroupBubble key={m.id} m={m} lang={lang} />)}
            {group && typingLine && <div className="chat-typing">{typingLine}</div>}
            <div ref={endRef} />
          </div>
          {group && group.members.length > 0 && (
            <div className="chat-mentions">
              {group.members.map((m) => (
                <button key={m.agentId} type="button" className="chat-mention small" onClick={() => setText((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@${m.name.replace(/\s+/g, '')} `)}>
                  @{m.name}
                </button>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="chat-files chat-files-pending" data-testid="chat-pending-files">
              {files.map((p) => (
                <span key={p} className="chat-file" title={p}>
                  📎 {fileName(p)}
                  <button type="button" className="chat-file-remove" aria-label={t('windows.chat.attachRemove', { name: fileName(p) })} onClick={() => setFiles((cur) => cur.filter((x) => x !== p))}>×</button>
                </span>
              ))}
            </div>
          )}
          <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <AttachButton onPaths={addFiles} disabled={!ready} filesOnly label="📎" testId="chat-attach" />
            <input
              aria-label={t('windows.chat.inputAria')}
              data-testid="chat-input"
              placeholder={group ? t('windows.chat.groupPlaceholder') : t('windows.chat.placeholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={pasteHandler(addFiles)}
            />
            <button type="submit" data-testid="chat-send" disabled={!ready || (text.trim() === '' && files.length === 0)}>{t('windows.common.send')}</button>
          </form>
          {error && <div className="error small">{error}</div>}
        </div>
      )}
    </section>
  );
}

/** Nuovo gruppo: un nome, chi c'è e che ruolo ha (il primo scelto risponde quando nessuno è chiamato con @). */
function NewGroup({ onCancel, onCreated }: { onCancel: () => void; onCreated: (g: GroupViewDto) => void }) {
  const t = useT();
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<{ agentId: string; role: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.visione.agents.list().then((res) => {
      if (res.ok) setAgents(res.data.agents.filter((a) => !a.archived));
    });
  }, []);
  const toggle = (a: AgentView): void => setChosen((list) => list.some((x) => x.agentId === a.definition.id)
    ? list.filter((x) => x.agentId !== a.definition.id)
    : [...list, { agentId: a.definition.id, role: a.definition.role ?? '' }]);
  const create = (): void => {
    setError(null);
    void window.visione.groups.create(name.trim(), chosen).then((res) => {
      if (res.ok) onCreated(res.data.group);
      else setError(res.error.message);
    });
  };
  return (
    <div className="chat-pane chat-newgroup">
      <label className="small">{t('windows.chat.groupName')}
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="chat-group-name" />
      </label>
      <div className="small">{t('windows.chat.members')}</div>
      {agents.length === 0 && <p className="muted">{t('windows.chat.noAgents')}</p>}
      {agents.map((a) => {
        const pick = chosen.find((x) => x.agentId === a.definition.id);
        return (
          <div key={a.definition.id} className="chat-newgroup-row">
            <label>
              <input type="checkbox" checked={Boolean(pick)} onChange={() => toggle(a)} /> {a.definition.name}
            </label>
            {pick && (
              <input
                className="small"
                value={pick.role}
                maxLength={80}
                placeholder={t('windows.chat.rolePlaceholder')}
                onChange={(e) => setChosen((list) => list.map((x) => (x.agentId === pick.agentId ? { ...x, role: e.target.value } : x)))}
              />
            )}
          </div>
        );
      })}
      <div className="chat-compose">
        <button type="button" onClick={create} disabled={name.trim() === '' || chosen.length === 0} data-testid="chat-group-create">{t('windows.chat.create')}</button>
        <button type="button" onClick={onCancel}>{t('windows.chat.cancel')}</button>
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
