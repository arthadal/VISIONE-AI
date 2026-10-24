// Preload (sandbox): espone al renderer soltanto `window.visione`, tipizzato da `VisioneApi`.
// Niente Node, filesystem, processi, shell o segreti; nessun comando arbitrario: solo i metodi qui.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { CommandResponse, CoreStateSnapshot, VisioneApi, VisioneEvent, SupervisorSnapshot } from '../shared/contracts/index.ts';
import { IPC_CHANNELS } from '../shared/contracts/api.ts';
import { ulid } from '../shared/lib/ulid.ts';

function command<T>(type: string, payload: Record<string, unknown>): Promise<CommandResponse<T>> {
  const ts = Date.now();
  const id = ulid(ts);
  return ipcRenderer.invoke(IPC_CHANNELS.command, { id, type, ts, correlationId: id, payload }) as Promise<CommandResponse<T>>;
}

/**
 * Un solo ascoltatore IPC per canale, che distribuisce a chi si è iscritto: con una registrazione per vista, a undici
 * viste iscritte agli eventi Electron segnalava una possibile perdita di memoria (VM, 22/10/2026). Un iscritto che
 * sbaglia non toglie i messaggi agli altri.
 */
const subscribers = new Map<string, Set<(value: unknown) => void>>();
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  let set = subscribers.get(channel);
  if (!set) {
    const created = new Set<(value: unknown) => void>();
    subscribers.set(channel, created);
    ipcRenderer.on(channel, (_event: IpcRendererEvent, value: unknown) => {
      for (const deliver of [...created]) {
        try {
          deliver(value);
        } catch (err) {
          console.error(`errore di un iscritto a ${channel}`, err);
        }
      }
    });
    set = created;
  }
  const deliver = (value: unknown): void => listener(value as T);
  set.add(deliver);
  return () => {
    set.delete(deliver);
  };
}

const api: VisioneApi = {
  system: {
    ping: (echo) => command('system.ping', echo === undefined ? {} : { echo }),
    status: () => command('system.status', {}),
    fullscreen: (enabled) =>
      ipcRenderer.invoke(IPC_CHANNELS.windowFullscreen, enabled === undefined ? null : enabled) as Promise<{ fullscreen: boolean }>,
    relaunch: () => ipcRenderer.invoke(IPC_CHANNELS.appRelaunch) as Promise<{ ok: boolean }>,
    quit: (options) => ipcRenderer.invoke(IPC_CHANNELS.appQuit, options?.shutdown === true) as Promise<{ ok: boolean }>,
    openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, String(url)) as Promise<{ ok: boolean }>,
    apps: {
      list: () => command('system.apps.list', {}),
      launch: (id) => command('system.apps.launch', { id })
    },
    control: {
      info: () => command('system.control.info', {}),
      exec: (action) => command('system.control.exec', { ...action })
    }
  },
  support: {
    report: (note) => command('support.report', { note })
  },
  files: {
    roots: () => command('files.roots', {}),
    list: (path, hidden = false) => command('files.list', hidden ? { path, hidden: true } : { path }),
    mkdir: (path, name) => command('files.mkdir', { path, name }),
    rename: (path, newName) => command('files.rename', { path, newName }),
    remove: (path, recursive = false) => command('files.delete', { path, confirm: true, recursive }),
    open: (path) => command('files.open', { path }),
    search: (root, query) => command('files.search', { root, query }),
    trash: (paths) => command('files.trash', { paths: [...paths] }),
    copy: (paths, toDir) => command('files.copy', { paths: [...paths], toDir }),
    move: (paths, toDir) => command('files.move', { paths: [...paths], toDir }),
    read: (path) => command('files.read', { path }),
    pathOf: (file) => {
      try { return webUtils.getPathForFile(file); } catch { return ''; }
    },
    pick: (kind) => ipcRenderer.invoke(IPC_CHANNELS.attachPick, kind === 'folder' ? 'folder' : 'files') as Promise<string[]>,
    fromClipboard: () => ipcRenderer.invoke(IPC_CHANNELS.attachClipboard) as Promise<string[]>
  },
  state: {
    get: () => command('state.get', {}),
    subscribe: (listener) => listen<CoreStateSnapshot>(IPC_CHANNELS.statePush, listener)
  },
  events: {
    list: (query = {}) => command('events.list', { ...query }),
    get: (id) => command('events.get', { id }),
    subscribe: (listener) => listen<VisioneEvent>(IPC_CHANNELS.event, listener)
  },
  runtime: {
    processes: (query = {}) => command('runtime.processes', { ...query }),
    stop: (processId, mode = 'graceful') => command('runtime.stop', { processId, mode })
  },
  engines: {
    probe: (refresh = false, adapter) => command('engines.probe', adapter === undefined ? { refresh } : { refresh, adapter }),
    restart: () => command('engines.restart', {})
  },
  setup: {
    detect: () => command('setup.detect', {}),
    verifyKey: (adapter, envName, value) => command('setup.verifyKey', value === undefined ? { adapter, envName } : { adapter, envName, value }),
    saveKey: (adapter, envName, value) => command('setup.saveKey', { adapter, envName, value }),
    catalog: () => command('setup.catalog', {}),
    login: (adapter, cols, rows) => command('setup.login', { adapter, ...(cols !== undefined ? { cols } : {}), ...(rows !== undefined ? { rows } : {}) }),
    install: (adapter, item, cols, rows) => command('setup.install', { adapter, item, ...(cols !== undefined ? { cols } : {}), ...(rows !== undefined ? { rows } : {}) }),
    apply: (input) => command('setup.apply', { ...input })
  },
  agents: {
    list: (includeArchived = false) => command('agents.list', { includeArchived }),
    define: (definition) => command('agents.define', { definition }),
    archive: (agentId) => command('agents.archive', { agentId }),
    rename: (agentId, name) => command('agents.rename', { agentId, name }),
    stop: (agentId, mode = 'graceful') => command('agents.stop', { agentId, mode }),
    start: (agentId) => command('agents.start', { agentId }),
    models: (agentId, refresh = false) => command('agents.models', { agentId, refresh }),
    tuning: (input) => command('agents.tuning', { ...input }),
    tell: (input) => command('agents.tell', { ...input }),
    interrupt: (agentId, reason) => command('agents.interrupt', reason ? { agentId, reason } : { agentId })
  },
  director: {
    submit: (input) => command('director.submit', { ...input }),
    interrupt: (reason) => command('director.interrupt', reason ? { reason } : {})
  },
  tasks: {
    list: (query = {}) => command('tasks.list', { ...query }),
    get: (taskId) => command('tasks.get', { taskId }),
    cancel: (taskId, reason) => command('tasks.cancel', reason === undefined ? { taskId } : { taskId, reason })
  },
  approvals: {
    list: (query = {}) => command('approvals.list', { ...query }),
    decide: (approvalId, decision, note) => command('approvals.decide', note === undefined ? { approvalId, decision } : { approvalId, decision, note })
  },
  audit: {
    list: (limit = 100) => command('audit.list', { limit })
  },
  memory: {
    search: (query = {}) => command('memory.search', { ...query }),
    write: (input) => command('memory.write', { ...input }),
    promote: (itemId) => command('memory.promote', { itemId }),
    reflect: (agentId, force = false) => command('memory.reflect', { agentId, force })
  },
  terminal: {
    list: () => command('terminal.list', {}),
    open: (cols = 100, rows = 30) => command('terminal.open', { cols, rows }),
    input: (processId, data) => command('terminal.input', { processId, data }),
    resize: (processId, cols, rows) => command('terminal.resize', { processId, cols, rows }),
    snapshot: (processId) => command('terminal.snapshot', { processId }),
    close: (processId) => command('terminal.close', { processId })
  },
  config: {
    get: () => command('config.get', {}),
    update: (patch) => command('config.update', { patch })
  },
  widgets: {
    weather: (city, language) => command('widgets.weather', { city, language })
  },
  assistant: {
    parse: (text) => command('assistant.parse', { text }),
    list: (status = 'open') => command('assistant.reminders.list', { status, limit: 100 }),
    add: (text, at) => command('assistant.reminder.add', at === undefined ? { text } : { text, at }),
    update: (id, action, minutes) => command('assistant.reminder.update', minutes === undefined ? { id, action } : { id, action, minutes }),
    ask: (text) => command('assistant.ask', { text }),
    lists: () => command('assistant.lists.get', {}),
    removeItem: (id) => command('assistant.list.remove', { id })
  },
  chat: {
    history: () => command('chat.history', {}),
    clear: (conversation) => command('chat.clear', { conversation })
  },
  groups: {
    list: () => command('groups.list', {}),
    create: (name, members) => command('groups.create', { name, members: members.map((m) => ({ agentId: m.agentId, role: m.role })) }),
    remove: (groupId) => command('groups.remove', { groupId }),
    messages: (groupId) => command('groups.messages', { groupId }),
    post: (groupId, text) => command('groups.post', { groupId, text })
  },
  offline: {
    status: () => command('offline.status', {}),
    set: (active) => command('offline.set', { active }),
    ask: (text) => command('offline.ask', { text }),
    download: () => command('offline.model.download', {}),
    cancelDownload: () => command('offline.model.cancel', {})
  },
  training: {
    list: () => command('training.list', {}),
    set: (id, active) => command('training.set', { id, active }),
    add: (input) => command('training.add', input),
    remove: (id) => command('training.remove', { id })
  },
  codemap: {
    status: () => command('codemap.status', {}),
    scan: (root) => command('codemap.scan', { root }),
    set: (root, enabled) => command('codemap.set', { root, enabled }),
    preview: (root, text) => command('codemap.preview', { root, text })
  },
  vision: {
    face: (width, height, gray) => command('vision.face', { width, height, gray })
  },
  voice: {
    status: () => command('voice.status', {}),
    ptt: (action, source = 'ui') => command('voice.ptt', { action, source }),
    speak: (text) => command('voice.speak', { text }),
    stop: () => command('voice.stop', {}),
    restart: () => command('voice.restart', {}),
    benchmark: () => command('voice.benchmark', {}),
    modelsStatus: (set) => command('voice.models.status', set ? { set } : {}),
    modelsDownload: (set) => command('voice.models.download', set ? { set } : {}),
    enroll: (action) => command('voice.enroll', { action }),
    accuracy: (action) => command('voice.accuracy', { action }),
    wake: (enabled) => command('voice.wake', { enabled }),
    talkTo: (agentId) => command('voice.talkTo', { agentId })
  },
  supervisor: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.supervisorGet) as Promise<SupervisorSnapshot>,
    subscribe: (listener) => listen<SupervisorSnapshot>(IPC_CHANNELS.supervisorPush, listener)
  }
};

// La porta audio (renderer ↔ processo voce) è trasferita dal main: dal mondo isolato del preload
// va passata al main world, che la riceve da `window.addEventListener('message')`.
ipcRenderer.on(IPC_CHANNELS.voicePort, (event) => {
  if (event.ports.length > 0) window.postMessage(IPC_CHANNELS.voicePort, window.location.origin, event.ports);
});

contextBridge.exposeInMainWorld('visione', api);
