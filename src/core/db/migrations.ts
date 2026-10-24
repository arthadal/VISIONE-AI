// Migrazioni append-only: mai modificare una migrazione rilasciata, aggiungerne una nuova.
// La migrazione 1 contiene solo ciò che la Fase 3 usa (DECISIONI P-21); le altre tabelle di
// VISIONE_DATA_MODEL.md arrivano con le fasi che le usano. La migrazione 2 (Fase 4, P-28) aggiunge
// solo gli indici per il recupero dello stato all'avvio (ultimo evento di un tipo, ultimo errore).

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'journal degli eventi e idempotenza dei comandi',
    up: `
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        severity TEXT NOT NULL,
        schema INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX events_corr ON events(correlation_id);
      CREATE INDEX events_type_ts ON events(type, ts);
      CREATE INDEX events_target ON events(target_kind, target_id, ts);

      CREATE TABLE idempotency (
        command_id TEXT PRIMARY KEY,
        result TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'indici per il recupero dello stato',
    up: `
      CREATE INDEX events_type_seq ON events(type, seq);
      CREATE INDEX events_errors ON events(seq) WHERE severity IN ('error', 'critical');
    `
  },
  {
    // Fase 5 (P-30): registro dei processi del CLI Runtime (riconciliazione dopo una caduta del
    // core) e installazioni delle CLI trovate. Mai argomenti né ambiente: possono contenere testo
    // dell'utente o riferimenti a credenziali.
    version: 3,
    name: 'registro dei processi e installazioni delle CLI',
    up: `
      CREATE TABLE processes (
        id TEXT PRIMARY KEY,
        pid INTEGER,
        kind TEXT NOT NULL,
        io TEXT NOT NULL,
        status TEXT NOT NULL,
        exe TEXT NOT NULL,
        cwd TEXT NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        task_id TEXT,
        adapter TEXT,
        correlation_id TEXT NOT NULL,
        restart_of TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        exit_code INTEGER,
        signal TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX processes_live ON processes(created_at) WHERE ended_at IS NULL;
      CREATE INDEX processes_agent ON processes(agent_id, created_at);
      CREATE INDEX processes_session ON processes(session_id, created_at);

      CREATE TABLE cli_installations (
        name TEXT PRIMARY KEY,
        path TEXT,
        exe TEXT,
        kind TEXT,
        version TEXT,
        status TEXT NOT NULL,
        problem TEXT,
        checked_at INTEGER NOT NULL
      );
    `
  },
  {
    // Fase 6 (P-37…P-41): un proprietario per tabella (VISIONE_AGENT_ARCHITECTURE §3). Agent
    // Manager → agent_definitions, agent_sessions, agent_instances; Task Engine → tasks,
    // task_dependencies, task_results; canale a file → messages; coda delle approvazioni →
    // approvals; audit → audit_log (append-only, catena di hash). Le righe sono il registro delle
    // entità; lo State Store ne tiene solo i riepiloghi, aggiornati dagli eventi.
    version: 4,
    name: 'agenti, task, messaggi, approvazioni e audit log',
    up: `
      CREATE TABLE agent_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapter TEXT NOT NULL,
        definition TEXT NOT NULL,
        version INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agent_definitions(id),
        adapter TEXT NOT NULL,
        engine_session_id TEXT NOT NULL,
        model TEXT,
        resumable INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        last_turn_at INTEGER,
        usage TEXT
      );
      CREATE INDEX agent_sessions_agent ON agent_sessions(agent_id, started_at);

      CREATE TABLE agent_instances (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agent_definitions(id),
        status TEXT NOT NULL,
        status_reason TEXT,
        session_id TEXT REFERENCES agent_sessions(id),
        current_task_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        last_event_at INTEGER,
        ended_at INTEGER
      );
      CREATE UNIQUE INDEX one_live_instance ON agent_instances(agent_id) WHERE status NOT IN ('stopped', 'crashed');

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        parent_id TEXT REFERENCES tasks(id),
        root_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        title TEXT NOT NULL,
        spec TEXT NOT NULL,
        acceptance TEXT,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        assignee_agent_id TEXT,
        competence TEXT,
        actions TEXT NOT NULL,
        budget TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        waiting_on TEXT,
        error TEXT,
        spec_hash TEXT NOT NULL,
        session_id TEXT,
        process_ids TEXT NOT NULL DEFAULT '[]',
        turn_id TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );
      CREATE INDEX tasks_root ON tasks(root_id);
      CREATE INDEX tasks_active ON tasks(status) WHERE status IN ('created', 'queued', 'running', 'waiting');
      -- Task duplicati (stessa specifica sotto lo stesso genitore): rifiutati (anti-loop).
      CREATE UNIQUE INDEX tasks_dedup ON tasks(parent_id, spec_hash) WHERE parent_id IS NOT NULL;

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        depends_on TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on)
      );
      CREATE INDEX task_dependents ON task_dependencies(depends_on);

      CREATE TABLE task_results (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        outcome TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        produced_by TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        in_reply_to TEXT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        act TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        task_id TEXT,
        hops INTEGER NOT NULL,
        requires_reply INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        processed_at INTEGER
      );
      CREATE INDEX messages_conversation ON messages(conversation_id, created_at);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        task_id TEXT,
        agent_id TEXT,
        correlation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_by TEXT,
        note TEXT,
        requested_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      -- Una sola richiesta in attesa per azione e task: una richiesta ripetuta riusa quella aperta.
      CREATE UNIQUE INDEX approvals_pending ON approvals(kind, target, IFNULL(task_id, '')) WHERE status = 'pending';
      CREATE INDEX approvals_granted ON approvals(kind, target) WHERE status = 'granted';

      CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT,
        decision TEXT NOT NULL,
        detail TEXT NOT NULL,
        correlation_id TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `
  },
  {
    // Fase 7 (P-42…P-44): turni dell'Agent Manager (traccia del brief e dell'esito, recupero) e
    // memoria con indice FTS5 a contenuto esterno, tenuto allineato dai trigger.
    version: 5,
    name: 'turni, memoria e indice FTS5',
    up: `
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        correlation_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        input_ref TEXT NOT NULL,
        output_text TEXT,
        outcome TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX turns_task ON turns(task_id, started_at);
      CREATE INDEX turns_open ON turns(ended_at) WHERE ended_at IS NULL;

      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        origin TEXT NOT NULL,
        origin_ref TEXT,
        content_hash TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT REFERENCES memory_items(id),
        retired_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Un solo elemento attivo per contenuto e ambito (deduplicazione).
      CREATE UNIQUE INDEX memory_active ON memory_items(scope, IFNULL(scope_id, ''), content_hash)
        WHERE superseded_by IS NULL AND retired_at IS NULL;
      CREATE INDEX memory_origin ON memory_items(origin, origin_ref);
      CREATE INDEX memory_pinned ON memory_items(scope, scope_id) WHERE pinned = 1;

      CREATE VIRTUAL TABLE memory_fts USING fts5(title, content, content='memory_items', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
      CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      END;
      CREATE TRIGGER memory_fts_au AFTER UPDATE OF title, content ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        INSERT INTO memory_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
      END;
    `
  },
  {
    // Fase 14 (P-59): aggregati al minuto della telemetria di sistema (VISIONE_DATA_MODEL §1).
    // Conservati 7 giorni dal manutentore; `subject` distingue eventuali futuri campioni per soggetto.
    version: 6,
    name: 'aggregati di telemetria al minuto',
    up: `
      CREATE TABLE telemetry_minutes (
        minute INTEGER NOT NULL,
        metric TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        min REAL,
        max REAL,
        avg REAL,
        samples INTEGER NOT NULL,
        unknown_samples INTEGER NOT NULL,
        PRIMARY KEY (minute, metric, subject)
      );
      CREATE INDEX telemetry_minutes_metric ON telemetry_minutes(metric, minute);
    `
  },
  {
    // Fase 19 (P-63): identità VISIONE — il coordinatore non si chiama più "michael".
    // Tocca SOLO le tabelle di stato; `events` (journal storico) e `audit_log` (catena di hash)
    // restano intatti. I foreign key sono deferiti fino al commit della transazione della
    // migrazione (db/index.ts), quindi l'ordine degli UPDATE non conta.
    version: 7,
    name: 'identità: il direttore sostituisce michael',
    up: `
      PRAGMA defer_foreign_keys = ON;
      UPDATE agent_definitions SET definition = REPLACE(definition, '"id":"michael"', '"id":"director"') WHERE id = 'michael';
      UPDATE agent_definitions SET definition = REPLACE(definition, '"id": "michael"', '"id": "director"') WHERE id = 'michael';
      UPDATE agent_definitions SET definition = REPLACE(definition, '"name":"Michael"', '"name":"Director"') WHERE id = 'michael';
      UPDATE agent_definitions SET name = 'Director' WHERE id = 'michael';
      UPDATE agent_definitions SET id = 'director' WHERE id = 'michael';
      UPDATE agent_sessions SET agent_id = 'director' WHERE agent_id = 'michael';
      UPDATE agent_instances SET agent_id = 'director' WHERE agent_id = 'michael';
      UPDATE turns SET agent_id = 'director' WHERE agent_id = 'michael';
      UPDATE tasks SET assignee_agent_id = 'director' WHERE assignee_agent_id = 'michael';
      UPDATE tasks SET created_by = 'director' WHERE created_by = 'michael';
      UPDATE processes SET agent_id = 'director' WHERE agent_id = 'michael';
      UPDATE messages SET from_id = 'director' WHERE from_id = 'michael';
      UPDATE messages SET to_id = 'director' WHERE to_id = 'michael';
      UPDATE approvals SET requested_by = 'director' WHERE requested_by = 'michael';
      UPDATE approvals SET agent_id = 'director' WHERE agent_id = 'michael';
      UPDATE memory_items SET scope_id = 'director' WHERE scope = 'agent' AND scope_id = 'michael';
    `
  },
  {
    // P-95: le istanze rimaste aperte quando l'app/il core si chiudeva erano marcate `crashed`
    // («core riavviato: processo non più controllato»), un'etichetta falsa: il processo è terminato
    // con l'app, non è precipitato. Il registro si riconcilia a `stopped` (terminale, sessione
    // riprendibile) con il motivo vero. Solo le righe con quel motivo sono toccate: i crash reali
    // (uscita anomala col core vivo) restano `crashed` con la loro causa.
    version: 8,
    name: 'istanze chiuse con l\'app: da crashed a stopped',
    up: `
      UPDATE agent_instances
         SET status = 'stopped',
             status_reason = 'sessione chiusa con l''app precedente (processo non più controllato)'
       WHERE status = 'crashed'
         AND status_reason = 'core riavviato: processo non più controllato';
    `
  },
  {
    // Beta.5 (P-109): promemoria e appuntamenti dell'Assistente personale, solo locali.
    version: 9,
    name: 'assistente: promemoria',
    up: `
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('reminder', 'appointment')),
        due_at INTEGER NOT NULL,
        notify_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'done', 'cancelled')),
        source TEXT NOT NULL CHECK (source IN ('voice', 'ui')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        fired_at INTEGER
      );
      CREATE INDEX reminders_status_notify ON reminders(status, notify_at);
    `
  },
  {
    // P-107k: Addestramento. Del catalogo solo stato e uso (il testo è nel codice, nella lingua di
    // VISIONE); delle regole dell'utente anche titolo, testo e parole chiave (JSON).
    version: 10,
    name: 'addestramento: regole di lavoro',
    up: `
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL CHECK (origin IN ('catalog', 'custom')),
        title TEXT NOT NULL DEFAULT '',
        rule TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '[]',
        always INTEGER NOT NULL DEFAULT 0 CHECK (always IN (0, 1)),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        uses INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    // P-107l: mappa del codice delle cartelle di lavoro degli agenti (file, simboli, import).
    version: 11,
    name: 'mappa del codice',
    up: `
      CREATE TABLE code_roots (
        root TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        files INTEGER NOT NULL DEFAULT 0,
        symbols INTEGER NOT NULL DEFAULT 0,
        scanned_at INTEGER,
        duration_ms INTEGER,
        truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE TABLE code_files (
        id INTEGER PRIMARY KEY,
        root TEXT NOT NULL REFERENCES code_roots(root) ON DELETE CASCADE,
        path TEXT NOT NULL,
        lang TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        UNIQUE (root, path)
      );
      CREATE TABLE code_symbols (
        file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX code_symbols_file ON code_symbols(file_id);
      CREATE TABLE code_edges (
        file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
        target TEXT NOT NULL
      );
      CREATE INDEX code_edges_file ON code_edges(file_id);
    `
  },
  {
    // P-109b: timer (nuovo tipo di promemoria) e ricorrenze; liste dell'Assistente. SQLite non cambia un
    // CHECK: la tabella dei promemoria si ricostruisce con gli stessi dati.
    version: 12,
    name: 'assistente: timer, ricorrenze e liste',
    up: `
      ALTER TABLE reminders RENAME TO reminders_v11;
      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('reminder', 'appointment', 'timer')),
        due_at INTEGER NOT NULL,
        notify_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'done', 'cancelled')),
        source TEXT NOT NULL CHECK (source IN ('voice', 'ui')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        fired_at INTEGER,
        repeat TEXT CHECK (repeat IS NULL OR repeat IN ('daily', 'weekdays', 'weekly'))
      );
      INSERT INTO reminders (id, text, kind, due_at, notify_at, status, source, created_at, updated_at, fired_at, repeat)
        SELECT id, text, kind, due_at, notify_at, status, source, created_at, updated_at, fired_at, NULL FROM reminders_v11;
      DROP TABLE reminders_v11;
      CREATE INDEX reminders_status_notify ON reminders(status, notify_at);
      CREATE TABLE list_items (
        id TEXT PRIMARY KEY,
        list TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX list_items_list ON list_items(list, created_at);
    `
  },
  {
    // 22/10/2026: battute che autoapprendono. «Bella» e «questa no» dopo una battuta; si vedono e si cancellano a voce.
    version: 13,
    name: 'assistente: gusti sulle battute',
    up: `
      CREATE TABLE quip_feedback (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL UNIQUE,
        verdict TEXT NOT NULL CHECK (verdict IN ('liked', 'disliked')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX quip_feedback_verdict ON quip_feedback(verdict, created_at);
    `
  },
  {
    // 22/10/2026: chat di gruppo locale («stile WhatsApp»): gruppi di agenti con un ruolo, messaggi, risposte in attesa.
    version: 14,
    name: 'chat di gruppo locale',
    up: `
      CREATE TABLE chat_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        members TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE chat_group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES chat_groups(id),
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX chat_group_messages_group ON chat_group_messages(group_id, created_at);
      CREATE TABLE chat_group_jobs (
        task_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES chat_groups(id),
        agent_id TEXT NOT NULL,
        hops INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `
  },
  {
    // 24/10/2026: la squadra come un ufficio. Chi ha aperto il gruppo (il proprietario o un agente) e, per il gruppo
    // che il Director apre per un lavoro del proprietario, la radice di quel lavoro.
    version: 15,
    name: 'gruppi aperti dagli agenti e gruppi di lavoro',
    up: `
      ALTER TABLE chat_groups ADD COLUMN created_by TEXT NOT NULL DEFAULT 'owner';
      ALTER TABLE chat_groups ADD COLUMN work_root_id TEXT;
      CREATE UNIQUE INDEX chat_groups_work ON chat_groups(work_root_id) WHERE work_root_id IS NOT NULL;
    `
  },
  {
    // 24/10/2026: «Svuota chat» come su WhatsApp. Non cancella niente: da quando una conversazione si mostra
    // («main» per la chat con VISIONE, l'id del gruppo per un gruppo).
    version: 16,
    name: 'chat svuotate',
    up: `
      CREATE TABLE chat_cleared (
        conversation TEXT PRIMARY KEY,
        cleared_at INTEGER NOT NULL
      );
    `
  }
];
