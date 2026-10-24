// Chiavi «vive» della configurazione (P-105): chi comanda e lo stato della procedura guidata si
// applicano subito (onApplied) e non chiedono il riavvio; le altre lo chiedono come prima.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditLog } from '../../src/core/audit/index.ts';
import type { CommandRouter } from '../../src/core/commands/index.ts';
import { registerConfigCommands } from '../../src/core/config/index.ts';
import type { EventEmitter } from '../../src/core/events/index.ts';
import { DEFAULT_CONFIG, loadConfig, writeConfigAtomic, type VisioneConfig } from '../../src/shared/node/config.ts';
import { tempHome } from '../helpers.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const { dir, cleanup } = tempHome('visione-config-');
  cleanups.push(cleanup);
  const file = join(dir, 'visione.json');
  writeConfigAtomic(file, DEFAULT_CONFIG);
  const handlers = new Map<string, (payload: unknown, ctx: unknown) => unknown>();
  const router = { register: (type: string, h: (payload: unknown, ctx: unknown) => unknown) => handlers.set(type, h) } as unknown as CommandRouter;
  const applied: VisioneConfig[] = [];
  const events: Array<{ type: string; payload: unknown }> = [];
  registerConfigCommands({
    router,
    events: { emit: (type: string, payload: unknown) => events.push({ type, payload }) } as unknown as EventEmitter,
    audit: { record: () => undefined } as unknown as AuditLog,
    file,
    bootFileConfig: loadConfig(file, { env: {} }).config,
    onApplied: (c) => applied.push(c)
  });
  const update = (patch: unknown) => handlers.get('config.update')!({ patch }, { command: { issuedBy: 'ui', correlationId: 'c1' } }) as { changed: string[]; restartRequired: boolean };
  return { update, applied, events };
}

describe('configurazione: chiavi applicate subito (P-105)', () => {
  it('chi comanda e lo stato della procedura: applicati subito, nessun riavvio richiesto', () => {
    const s = setup();
    const out = s.update({ director: { plannerAgentId: 'jarvis' }, setup: { completedVersion: 1 } });
    expect(out.changed.sort()).toEqual(['director.plannerAgentId', 'setup.completedVersion']);
    expect(out.restartRequired).toBe(false);
    expect(s.applied.at(-1)?.director.plannerAgentId).toBe('jarvis');
    expect(s.applied.at(-1)?.setup.completedVersion).toBe(1);
  });

  it('le altre chiavi chiedono ancora il riavvio; nessun cambiamento = onApplied non chiamato', () => {
    const s = setup();
    expect(s.update({ director: { maxConcurrentTasks: 2 } }).restartRequired).toBe(true);
    const before = s.applied.length;
    s.update({ director: { maxConcurrentTasks: 2 } });
    expect(s.applied.length).toBe(before);
  });
});

describe('configurazione: scena, nome del Director e durata dei nodi valgono subito (11/10/2026)', () => {
  it('le chiavi della scena non chiedono il riavvio; la durata dei nodi resta nei limiti 5…600 s', () => {
    const s = setup();
    const out = s.update({ ui: { scene: 'pixel-office', directorName: 'Jarvis', nodeLingerSec: 90 } });
    expect(out.changed.sort()).toEqual(['ui.directorName', 'ui.nodeLingerSec', 'ui.scene']);
    expect(out.restartRequired).toBe(false);
    expect(() => s.update({ ui: { nodeLingerSec: 2 } })).toThrow();
    expect(() => s.update({ ui: { nodeLingerSec: 601 } })).toThrow();
    expect(DEFAULT_CONFIG.ui.nodeLingerSec).toBe(30);
  });
});
