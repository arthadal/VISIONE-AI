// Impostazioni a runtime (VISIONE_ARCHITECTURE §24, DECISIONI P-46): il core è l'unico che scrive
// `config\visione.json`. Lettura del file (senza gli override dell'ambiente), scrittura validata e
// atomica, audit, evento `system.config.changed`. Il core usa la configurazione letta all'avvio:
// le modifiche valgono dal prossimo avvio (lo dice `restartRequired`).
import { applyConfigPatch, DEFAULT_CONFIG, loadConfig, writeConfigAtomic, type VisioneConfig } from '../../shared/node/config.ts';
import type { AuditLog } from '../audit/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';

export interface ConfigCommandsDeps {
  router: CommandRouter;
  events: EventEmitter;
  audit: AuditLog;
  file: string;
  /** Configurazione del file letta all'avvio (senza override dell'ambiente). */
  bootFileConfig: VisioneConfig;
  /** Dopo un salvataggio: il core applica subito le chiavi «vive» (P-105). */
  onApplied?: (config: VisioneConfig) => void;
}

/**
 * Chiavi applicate subito, senza riavvio: chi è il Director e lo stato della procedura guidata
 * (P-105), la lingua (la applica l'interfaccia, 10/10/2026); scena, nome del Director e durata dei
 * nodi li applica la scena a caldo (11/10/2026). Cambiarle non rende necessario il riavvio.
 */
const LIVE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['director', 'plannerAgentId'], ['setup', 'completedVersion'], ['ui', 'language'],
  ['ui', 'scene'], ['ui', 'directorName'], ['ui', 'nodeLingerSec'], ['ui', 'expert'], ['ui', 'guideSeen'], ['ui', 'light'],
  // 11/10/2026: valgono subito (il renderer, il main o il core le rileggono), nessun riavvio.
  ['ui', 'startWithWindows'], ['voice', 'volume'], ['voice', 'startupBriefing'], ['voice', 'startupPhrase'], ['voice', 'announceStartup'],
  // 17/10/2026: l'ascolto dopo una risposta lo legge il core a ogni risposta.
  ['voice', 'followUpMs'],
  // 17/10/2026: la modalità offline rilegge l'impostazione a ogni cambio di rete.
  ['offline', 'auto']
];
const withoutLive = (config: VisioneConfig): string => {
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, Record<string, unknown> | undefined>;
  for (const [section, key] of LIVE_KEYS) delete copy[section]?.[key];
  return JSON.stringify(copy);
};

export function registerConfigCommands(deps: ConfigCommandsDeps): void {
  const { router, events, audit, file } = deps;
  // Senza ambiente: gli override (es. VISIONE_LOG_LEVEL) non finiscono mai nel file.
  const readFile = () => loadConfig(file, { env: {} });
  const restartRequired = (config: VisioneConfig): boolean => withoutLive(config) !== withoutLive(deps.bootFileConfig);

  router.register('config.get', () => {
    const loaded = readFile();
    return { config: loaded.config as unknown as Record<string, unknown>, file, source: loaded.source, problems: loaded.problems, restartRequired: restartRequired(loaded.config) };
  });

  router.register('config.update', (payload, ctx) => {
    const loaded = readFile();
    const base = loaded.source === 'file' ? loaded.config : DEFAULT_CONFIG;
    const out = applyConfigPatch(base, payload.patch);
    if (!out.ok) throw new CommandFailure('invalid_payload', out.problem.slice(0, 2_000));
    const by = `owner:${ctx.command.issuedBy}`;
    if (out.changed.length > 0) {
      writeConfigAtomic(file, out.config);
      deps.onApplied?.(out.config);
      audit.record({ actor: by, action: 'config.update', subject: 'visione.json', decision: 'done', detail: out.changed.join(', ').slice(0, 1_000), correlationId: ctx.command.correlationId });
      events.emit('system.config.changed', { changed: out.changed.slice(0, 50).map((k) => k.slice(0, 120)), by, restartRequired: restartRequired(out.config) }, {
        correlationId: ctx.command.correlationId
      });
    }
    return { config: out.config as unknown as Record<string, unknown>, changed: out.changed, restartRequired: restartRequired(out.config) };
  });
}
