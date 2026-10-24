// Modulo `system`: comandi di diagnostica, lettura del journal e dello stato (sola lettura) e
// launcher delle applicazioni installate (Fase 24, P-71).
import type { AppCatalog } from './apps.ts';
import type { SystemControl } from './control.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { Journal } from '../journal/index.ts';
import type { StateReader } from '../state/index.ts';

export { createAppCatalog } from './apps.ts';
export type { AppCatalog, OsApp } from './apps.ts';
export { createSystemControl } from './control.ts';
export type { SystemControl, SystemInfoSnapshot, ControlAction } from './control.ts';

export interface SystemInfo {
  coreVersion: string;
  pid: number;
  startedAt: number;
  schemaVersion: number;
}

export function registerSystemCommands(deps: {
  router: CommandRouter;
  journal: Journal;
  state: StateReader;
  info: SystemInfo;
  /** Catalogo delle applicazioni installate; assente = launcher non disponibile. */
  apps?: AppCatalog;
  /** Controllo di sistema (Fase 24b); assente = comandi di controllo non disponibili. */
  control?: SystemControl;
  now?: () => number;
}): void {
  const now = deps.now ?? Date.now;
  const { router, journal, info, state, apps, control } = deps;

  // Comando system.ping → evento system.pong (correlato) → risposta.
  router.register('system.ping', (payload, ctx) => {
    const t = now();
    ctx.emit('system.pong', { echo: payload.echo ?? null, pid: info.pid });
    return { pong: true, echo: payload.echo ?? null, coreTs: t, pid: info.pid, uptimeMs: t - info.startedAt };
  });

  router.register('system.status', () => {
    const db = state.snapshot().database;
    return {
      coreVersion: info.coreVersion,
      pid: info.pid,
      startedAt: info.startedAt,
      uptimeMs: now() - info.startedAt,
      schemaVersion: info.schemaVersion,
      journal: { lastSeq: db.journalLastSeq, count: db.journalCount }
    };
  });

  router.register('events.list', (payload) => ({
    events: journal.read(payload),
    lastSeq: state.snapshot().database.journalLastSeq
  }));

  router.register('events.get', (payload) => ({ event: journal.get(payload.id) }));

  // Lo snapshot è congelato: va al main per copia strutturata, nessun riferimento interno esce.
  router.register('state.get', () => state.snapshot());

  // Launcher (Fase 24, P-71): elenco reale (Start Menu) e avvio via `shell:AppsFolder`.
  if (apps) {
    router.register('system.apps.list', async () => ({ apps: await apps.list(), source: 'get-startapps' as const }));
    router.register('system.apps.launch', async (payload) => {
      const out = await apps.launch(payload.id);
      if (!out.launched) throw new CommandFailure('operation_failed', `avvio non riuscito: ${payload.id}`);
      return { id: payload.id, launched: true as const };
    });
  }
  // System Control (Fase 24b, P-72): metriche reali e azioni di controllo con conferma.
  if (control) {
    router.register('system.control.info', () => control.info());
    router.register('system.control.exec', async (payload, ctx) =>
      control.exec(payload.action, payload.confirm, `owner:${ctx.command.issuedBy}`)
    );
  }
}
