// Canale a file dei messaggi tra agenti (VISIONE_AGENT_ARCHITECTURE §4 `filechannel`, §8; DECISIONI
// P-41). Gli agenti scrivono un JSON per messaggio in `agents\<id>\outbox\`; il core lo legge (dati
// non fidati: validazione zod, mittente = cartella, passaggi ≤ 12, destinatario noto), lo registra
// in `messages` (id già visto = ignorato: idempotenza) e lo consegna: nella `inbox\` del
// destinatario (scrittura atomica temp + rename) o al Director. Il file letto finisce in
// `outbox\processed\` o `outbox\rejected\`: mai cancellato, mai eseguito.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import {
  agentMessageSchema,
  DIRECTOR_ADDRESS,
  MESSAGE_MAX_HOPS,
  type AgentMessage
} from '../../shared/contracts/index.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { Db } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;

export interface MessageChannel {
  start(): void;
  /** Legge tutti i file in attesa, in ordine di agente e di nome (deterministico). */
  scan(): { accepted: number; rejected: number; duplicates: number };
  /** Scrive un messaggio del core (es. risposta del Director) nella `inbox\` del destinatario. */
  send(message: Omit<AgentMessage, 'id' | 'createdAt'> & { id?: string }): AgentMessage;
  close(): void;
}

export interface MessageChannelDeps {
  db: Db;
  events: EventEmitter;
  log: Logger;
  agentsDir: string;
  /** Destinatario valido (agente definito e non archiviato). */
  isAgent(agentId: string): boolean;
  onDirectorMessage(message: AgentMessage): void;
  scanMs?: number;
  now?: () => number;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

export function createMessageChannel(deps: MessageChannelDeps): MessageChannel {
  const { db, events, log } = deps;
  const now = deps.now ?? Date.now;
  const insert = db.prepare(`INSERT OR IGNORE INTO messages (id, conversation_id, in_reply_to, from_id, to_id, act, subject, body, task_id, hops, requires_reply, created_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const processed = db.prepare('UPDATE messages SET processed_at = ? WHERE id = ?');
  let watcher: FSWatcher | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const moveTo = (file: string, folder: 'processed' | 'rejected'): void => {
    const dir = join(file, '..', folder);
    mkdirSync(dir, { recursive: true });
    try {
      renameSync(file, join(dir, basename(file)));
    } catch (err) {
      log.warn('file di outbox non spostato', { file, err });
    }
  };

  const reject = (agentId: string, file: string, problem: string): void => {
    events.emit('agent.message.rejected', { agentId: agentId.slice(0, 64), file: basename(file).slice(0, 260), problem: problem.slice(0, 500) }, {
      source: { kind: 'agent', id: agentId.slice(0, 64) }, target: { kind: 'visione', id: 'messages' }
    });
    moveTo(file, 'rejected');
  };

  const deliver = (message: AgentMessage): void => {
    if (message.to === DIRECTOR_ADDRESS) return;
    const inbox = join(deps.agentsDir, message.to, 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeAtomic(join(inbox, `${message.id}.json`), JSON.stringify(message, null, 2));
  };

  /** Ritorna l'esito per un file di `outbox\` di `agentId`. */
  const handle = (agentId: string, file: string): 'accepted' | 'rejected' | 'duplicate' => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return 'duplicate'; // già spostato da un'altra scansione
    }
    if (size > MAX_MESSAGE_BYTES) {
      reject(agentId, file, `file troppo grande (${size} byte, massimo ${MAX_MESSAGE_BYTES})`);
      return 'rejected';
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      reject(agentId, file, `JSON non valido: ${err instanceof Error ? err.message : String(err)}`);
      return 'rejected';
    }
    const parsed = agentMessageSchema.safeParse(raw);
    if (!parsed.success) {
      reject(agentId, file, `messaggio non conforme: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return 'rejected';
    }
    const m = parsed.data;
    if (m.from !== agentId) {
      reject(agentId, file, `mittente dichiarato (${m.from}) diverso dalla cartella (${agentId})`);
      return 'rejected';
    }
    if (m.to === m.from) {
      reject(agentId, file, 'messaggio a sé stesso');
      return 'rejected';
    }
    if (m.to !== DIRECTOR_ADDRESS && !deps.isAgent(m.to)) {
      reject(agentId, file, `destinatario sconosciuto: ${m.to}`);
      return 'rejected';
    }
    if (m.hops >= MESSAGE_MAX_HOPS) {
      reject(agentId, file, `troppi passaggi (${m.hops}): la conversazione ${m.conversationId} si ferma`);
      return 'rejected';
    }
    const t = now();
    const inserted = db.transaction(() => {
      const r = insert.run(m.id, m.conversationId, m.inReplyTo, m.from, m.to, m.act, m.subject, m.body, m.taskId, m.hops, m.requiresReply ? 1 : 0, m.createdAt, t);
      if (r.changes === 0) return false;
      events.emit('agent.message.sent', {
        messageId: m.id, conversationId: m.conversationId, from: m.from, to: m.to, act: m.act, subject: m.subject, hops: m.hops, taskId: m.taskId
      }, { source: { kind: 'agent', id: m.from }, target: m.to === DIRECTOR_ADDRESS ? { kind: 'director', id: DIRECTOR_ADDRESS } : { kind: 'agent', id: m.to } });
      return true;
    });
    if (!inserted) {
      moveTo(file, 'processed');
      return 'duplicate';
    }
    try {
      if (m.to === DIRECTOR_ADDRESS) deps.onDirectorMessage(m);
      else deliver(m);
      processed.run(now(), m.id);
    } catch (err) {
      log.error('consegna del messaggio non riuscita', { messageId: m.id, err });
    }
    moveTo(file, 'processed');
    return 'accepted';
  };

  const channel: MessageChannel = {
    scan() {
      const out = { accepted: 0, rejected: 0, duplicates: 0 };
      if (!existsSync(deps.agentsDir)) return out;
      for (const agentId of readdirSync(deps.agentsDir).sort()) {
        const outbox = join(deps.agentsDir, agentId, 'outbox');
        let names: string[];
        try {
          names = readdirSync(outbox).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
        } catch {
          continue;
        }
        for (const name of names) {
          const file = join(outbox, name);
          try {
            if (!statSync(file).isFile()) continue;
          } catch {
            continue;
          }
          const r = handle(agentId, file);
          if (r === 'accepted') out.accepted++;
          else if (r === 'rejected') out.rejected++;
          else out.duplicates++;
        }
      }
      return out;
    },

    send(input) {
      const message: AgentMessage = agentMessageSchema.parse({ ...input, id: input.id ?? ulid(now()), createdAt: now() });
      db.transaction(() => {
        insert.run(message.id, message.conversationId, message.inReplyTo, message.from, message.to, message.act, message.subject, message.body, message.taskId,
          message.hops, message.requiresReply ? 1 : 0, message.createdAt, now());
        events.emit('agent.message.sent', {
          messageId: message.id, conversationId: message.conversationId, from: message.from, to: message.to, act: message.act, subject: message.subject,
          hops: message.hops, taskId: message.taskId
        }, { source: message.from === DIRECTOR_ADDRESS ? { kind: 'director', id: DIRECTOR_ADDRESS } : { kind: 'agent', id: message.from }, target: { kind: 'agent', id: message.to } });
      });
      deliver(message);
      return message;
    },

    start() {
      if (closed || watcher || interval) return;
      const trigger = (): void => {
        if (pending !== null || closed) return;
        pending = setTimeout(() => {
          pending = null;
          try {
            channel.scan();
          } catch (err) {
            log.error('scansione delle outbox non riuscita', { err });
          }
        }, 50);
      };
      try {
        mkdirSync(deps.agentsDir, { recursive: true });
        watcher = watch(deps.agentsDir, { recursive: true }, (_event, name) => {
          if (typeof name === 'string' && /[\\/]outbox[\\/][^\\/]+\.json$/i.test(name)) trigger();
        });
        watcher.on('error', (err) => log.warn('watcher delle outbox in errore: resta la scansione periodica', { err }));
      } catch (err) {
        log.warn('watcher delle outbox non disponibile: resta la scansione periodica', { err });
      }
      // Scansione di riserva: un evento del watcher può perdersi (P-41).
      interval = setInterval(trigger, deps.scanMs ?? 5_000);
      interval.unref?.();
      trigger();
    },

    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      if (interval !== null) clearInterval(interval);
      interval = null;
      if (pending !== null) clearTimeout(pending);
      pending = null;
    }
  };
  return channel;
}
