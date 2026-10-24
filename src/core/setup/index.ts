// Procedura guidata del primo avvio, lato core (P-105): raccoglie i requisiti dichiarati dai motori
// (senza sapere quali siano), fa verificare le chiavi al motore che le dichiara e le salva solo se
// valide, nelle variabili dell'utente Windows. Il valore di una chiave non entra mai in risultati,
// eventi, log o errori; dopo il salvataggio è nell'ambiente del core, così i processi dei motori
// avviati da adesso la vedono senza riavviare VISIONE.
import { defaultPersona, type AgentDefinition, type AgentDefinitionInput, type CatalogEntry, type Language, type SetupEngine, type TerminalSession } from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import { setUserEnv } from '../../shared/node/user-env.ts';
import { refreshPath } from '../../shared/node/fresh-path.ts';
import type { AdapterKeyCheck, AdapterRegistry, AdapterSetupItem, AgentAdapter } from '../adapters/index.ts';
import type { AgentManager } from '../agents/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import { toItem } from './item.ts';
import { SYSTEM_SETUP, systemSetupItems } from './system.ts';

export { toItem } from './item.ts';
export { SYSTEM_SETUP, VC_RUNTIME_DLLS, missingVcRuntime, systemSetupItems } from './system.ts';

export interface SetupDeps {
  readonly router: CommandRouter;
  readonly adapters: AdapterRegistry;
  readonly log: Logger;
  /** Salvataggio nelle variabili dell'utente; nei test è finto. */
  readonly saveUserEnv?: (name: string, value: string) => Promise<void>;
  /** Ambiente del core, ereditato dai processi dei motori (`process.env` nel prodotto). */
  readonly processEnv?: Record<string, string | undefined>;
  /** Agenti (late binding come per i motori): servono a `setup.apply`. */
  readonly agents?: () => AgentManager | null;
  /** Lingua di VISIONE (P-108): la persona degli agenti nuovi risponde in quella lingua. */
  readonly language?: () => Language;
  /**
   * PowerShell per «Installa» (late binding): quella del terminale, trovata dalla discovery e quindi consentita
   * dalla policy del runtime. Un percorso scritto a mano verrebbe rifiutato (collaudo del 17/10/2026).
   */
  readonly shell?: () => Promise<{ exe: string; args: readonly string[] } | null>;
  /** Rilettura del PATH dal registro prima di `setup.detect` (nei test finta). */
  readonly refreshPath?: () => Promise<void>;
  /** Terminale di VISIONE con un programma preciso (late binding): serve a `setup.login` e `setup.install`. */
  readonly openTerminal?: (opts: { cols: number; rows: number; by: string; correlationId: string; command: { exe: string; args: readonly string[] } }) => Promise<TerminalSession>;
  /** Requisiti di VISIONE stessa (runtime di Visual C++); nei test finti. */
  readonly systemItems?: () => AdapterSetupItem[];
}

/**
 * Argomenti di PowerShell per uno script d'installazione: codificato (UTF-16LE in base64) così virgolette,
 * `$` e `|` arrivano intatti. Prima si rilegge il PATH (quello di VISIONE può essere vecchio); `Step` esegue
 * un programma e si ferma se fallisce (PowerShell 5.1 non lo fa da solo); alla fine si dice com'è andata.
 */
export function installArgs(script: string): string[] {
  const wrapped = [
    "$ErrorActionPreference = 'Stop'",
    "function Update-VisionePath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }",
    'function Step([string]$what, [scriptblock]$run) { Write-Host ""; Write-Host ("> " + $what) -ForegroundColor Cyan; & $run; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw ($what + ": codice " + $LASTEXITCODE) } }',
    'Update-VisionePath',
    'try {',
    script,
    "  Write-Host ''; Write-Host 'Installazione finita. VISIONE ricontrolla da sola.' -ForegroundColor Green",
    '} catch {',
    "  Write-Host ''; Write-Host ('Installazione non riuscita: ' + $_.Exception.Message) -ForegroundColor Red",
    '  exit 1',
    '}'
  ].join('\n');
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Requisiti di ogni motore che ne dichiara; un motore che fallisce il rilevamento lo dice, non sparisce. */
export async function detectSetup(adapters: readonly AgentAdapter[]): Promise<SetupEngine[]> {
  const withSetup = adapters.filter((a) => typeof a.setup === 'function');
  return Promise.all(
    withSetup.map(async (a): Promise<SetupEngine> => {
      try {
        const items = await a.setup!();
        return { adapter: a.id, items: items.map(toItem) };
      } catch (err) {
        return { adapter: a.id, items: [{ id: 'rilevamento', label: 'Rilevamento', ok: false, optional: false, detail: `rilevamento non riuscito: ${errorText(err)}`, steps: ['Premi «Ricontrolla»; se si ripete, riavvia VISIONE.'], commands: [] }] };
      }
    })
  );
}

export function registerSetupCommands(deps: SetupDeps): void {
  const { router, adapters, log } = deps;
  const env = deps.processEnv ?? process.env;
  const save = deps.saveUserEnv ?? ((name: string, value: string) => setUserEnv(name, value));

  const keyAdapter = (id: string): AgentAdapter & { verifyKey: NonNullable<AgentAdapter['verifyKey']> } => {
    const adapter = adapters.get(id);
    if (!adapter) throw new CommandFailure('not_found', `motore sconosciuto: ${id}`);
    if (!adapter.verifyKey) throw new CommandFailure('invalid_payload', `il motore ${id} non verifica chiavi`);
    return adapter as AgentAdapter & { verifyKey: NonNullable<AgentAdapter['verifyKey']> };
  };
  const safeCheck = async (adapter: AgentAdapter & { verifyKey: NonNullable<AgentAdapter['verifyKey']> }, envName: string, value: string | null): Promise<AdapterKeyCheck> => {
    try {
      const check = await adapter.verifyKey(envName, value);
      // Il motore non deve restituire la chiave: se capitasse, il dettaglio si scarta.
      return value && check.detail.includes(value) ? { ok: check.ok, detail: 'verifica completata' } : { ok: check.ok, detail: check.detail.slice(0, 500) };
    } catch (err) {
      const text = errorText(err);
      return { ok: false, detail: value && text.includes(value) ? 'verifica non riuscita' : `verifica non riuscita: ${text}` };
    }
  };

  // Prima di ogni controllo si rilegge il PATH dal registro: un programma appena installato (anche dal tasto
  // «Installa») si trova senza riavviare VISIONE, e i motori avviati da adesso lo ereditano.
  const freshPath = deps.refreshPath ?? (() => refreshPath(env).then(() => undefined, () => undefined));
  router.register('setup.detect', async () => {
    await freshPath();
    return { engines: await detectSetup(adapters.list()), checkedAt: Date.now() };
  });

  router.register('setup.catalog', async () => {
    const withCatalog = adapters.list().filter((a) => typeof a.catalog === 'function');
    const engines = await Promise.all(withCatalog.map(async (a) => {
      try {
        const models = (await a.catalog!()).slice(0, 300).map((m): CatalogEntry => {
          const entry: CatalogEntry = { model: m.model, label: m.label, group: m.group };
          if (m.endpointProfile) entry.endpointProfile = m.endpointProfile;
          if (m.recommended) entry.recommended = true;
          if (m.suggestedFor) entry.suggestedFor = m.suggestedFor;
          return entry;
        });
        return { adapter: a.id, label: a.label ?? a.id, models };
      } catch (err) {
        log.warn('catalogo del motore non disponibile', { adapter: a.id, err: errorText(err) });
        return { adapter: a.id, label: a.label ?? a.id, models: [] };
      }
    }));
    return { engines };
  });

  router.register('setup.apply', async (payload, ctx) => {
    const manager = deps.agents?.() ?? null;
    if (!manager) throw new CommandFailure('operation_failed', 'gli agenti non sono ancora pronti: riprova tra un momento');
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const m of payload.agents) {
      if (ids.has(m.id)) throw new CommandFailure('invalid_payload', `due agenti con lo stesso identificativo: ${m.id}`);
      const key = m.name.toLocaleLowerCase('it');
      if (names.has(key)) throw new CommandFailure('invalid_payload', `due agenti con lo stesso nome: «${m.name}»`);
      ids.add(m.id);
      names.add(key);
    }
    // Persona, cartella, permessi e limiti di un agente esistente restano i suoi: cambiano nome, motore e modello.
    const definitions: AgentDefinitionInput[] = payload.agents.map((m) => {
      const existing = manager.get(m.id);
      return {
        id: m.id,
        name: m.name,
        role: m.role || existing?.role || 'agente VISIONE',
        competences: m.competences,
        engine: { adapter: m.adapter, model: m.model, ...(m.endpointProfile ? { endpointProfile: m.endpointProfile } : {}) },
        persona: existing?.persona ?? defaultPersona(deps.language?.() ?? 'it'),
        workspace: existing?.workspace ?? { root: m.id, isolation: 'shared' },
        permissions: existing?.permissions ?? 'read-only',
        limits: existing?.limits ?? { maxTurnMinutes: 10, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
      };
    });
    // Prima si validano TUTTE: una squadra sbagliata non resta mai scritta a metà.
    for (const def of definitions) {
      const adapter = adapters.get(def.engine.adapter);
      if (!adapter) throw new CommandFailure('invalid_payload', `«${def.name}»: motore sconosciuto ${def.engine.adapter}`);
      const check = adapter.validate({ ...def, createdBy: 'setup', createdAt: 0, version: 1 } as AgentDefinition);
      if (!check.ok) throw new CommandFailure('invalid_payload', `«${def.name}»: ${check.problems.join('; ')}`.slice(0, 1_000));
    }
    const by = `owner:${ctx.command.issuedBy}`;
    const defined: string[] = [];
    for (const def of definitions) defined.push(manager.define(def, by, ctx.command.correlationId).agentId);
    const archived: string[] = [];
    if (payload.archiveOthers) {
      for (const other of manager.active()) {
        if (ids.has(other.id)) continue;
        await manager.archive(other.id, by, ctx.command.correlationId);
        archived.push(other.id);
      }
    }
    log.info('squadra applicata dalla procedura guidata', { defined, archived });
    return { defined, archived };
  });

  router.register('setup.login', async (payload, ctx) => {
    const adapter = adapters.get(payload.adapter);
    if (!adapter) throw new CommandFailure('not_found', `motore sconosciuto: ${payload.adapter}`);
    if (!adapter.loginCommand || !deps.openTerminal) throw new CommandFailure('invalid_payload', `il motore ${payload.adapter} non ha un accesso da fare`);
    const command = await adapter.loginCommand();
    if (!command) throw new CommandFailure('operation_failed', 'programma del motore non trovato: installalo e premi «Ricontrolla»');
    const session = await deps.openTerminal({ cols: payload.cols, rows: payload.rows, by: `owner:${ctx.command.issuedBy}`, correlationId: ctx.command.correlationId, command });
    log.info('accesso al motore aperto nel terminale', { adapter: payload.adapter, processId: session.processId });
    return { session };
  });

  router.register('setup.install', async (payload, ctx) => {
    // I requisiti di VISIONE stessa (runtime di Visual C++, 18/10/2026) stanno accanto a quelli dei motori.
    const system = payload.adapter === SYSTEM_SETUP;
    const adapter = system ? null : adapters.get(payload.adapter);
    if (!system && !adapter?.setup) throw new CommandFailure('not_found', `motore sconosciuto: ${payload.adapter}`);
    if (!deps.openTerminal) throw new CommandFailure('invalid_payload', 'terminale non disponibile');
    // Lo script si rilegge dal motore adesso: la UI sceglie solo quale requisito, mai cosa eseguire.
    const items = system ? (deps.systemItems ?? systemSetupItems)() : await adapter!.setup!();
    const item = items.find((i) => i.id === payload.item);
    if (!item || item.action?.kind !== 'install') throw new CommandFailure('invalid_payload', `niente da installare per ${payload.adapter} · ${payload.item}`);
    if (item.ok) throw new CommandFailure('invalid_payload', `${item.label}: già a posto, premi «Ricontrolla»`);
    const shell = await deps.shell?.();
    if (!shell) throw new CommandFailure('operation_failed', 'PowerShell non trovata su questo PC: usa i passi a mano qui sotto');
    const command = { exe: shell.exe, args: [...shell.args, ...installArgs(item.action.script)] };
    const session = await deps.openTerminal({ cols: payload.cols, rows: payload.rows, by: `owner:${ctx.command.issuedBy}`, correlationId: ctx.command.correlationId, command });
    log.info('installatore avviato nel terminale', { adapter: payload.adapter, item: payload.item, source: item.action.source, processId: session.processId });
    return { session };
  });

  router.register('setup.verifyKey', async (payload) => safeCheck(keyAdapter(payload.adapter), payload.envName, payload.value ?? null));

  router.register('setup.saveKey', async (payload) => {
    const adapter = keyAdapter(payload.adapter);
    // Si salva solo ciò che il motore ha appena riconosciuto come chiave valida per quel nome: la UI
    // non può scrivere variabili qualsiasi (PATH e simili).
    const check = await safeCheck(adapter, payload.envName, payload.value);
    if (!check.ok) return { saved: false, check };
    try {
      await save(payload.envName, payload.value);
    } catch (err) {
      const text = errorText(err);
      throw new CommandFailure('operation_failed', text.includes(payload.value) ? 'salvataggio della chiave non riuscito' : text);
    }
    env[payload.envName] = payload.value;
    log.info('chiave verificata e salvata nelle variabili dell\'utente', { adapter: payload.adapter, envName: payload.envName });
    return { saved: true, check };
  });
}
