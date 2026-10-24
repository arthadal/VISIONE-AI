// Harness del CLI Runtime per i test: database migrato, journal, bus ed emitter reali della
// Fase 4, policy che consente solo node (la CLI finta) e cartelle temporanee.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createEventBus, type EventBus } from '../src/core/bus/index.ts';
import { migrate, openDb, type Db } from '../src/core/db/index.ts';
import { createEventEmitter, type EventEmitter } from '../src/core/events/index.ts';
import { createJournal, type Journal } from '../src/core/journal/index.ts';
import {
  createCliRuntime,
  createRuntimePolicy,
  type CliRuntime,
  type ProcessSpec,
  type ProcessTools,
  type RuntimeDeps
} from '../src/core/runtime/index.ts';
import type { VisioneEvent } from '../src/shared/contracts/index.ts';
import { ulid } from '../src/shared/lib/ulid.ts';
import { memoryLogger, tempHome } from './helpers.ts';

export const FAKE_CLI = resolve('test/fixtures/fake-cli.mjs');
export const NODE = process.execPath;

export interface RuntimeHarness {
  dir: string;
  workspace: string;
  db: Db;
  journal: Journal;
  bus: EventBus;
  emitter: EventEmitter;
  runtime: CliRuntime;
  events: VisioneEvent[];
  spec(args: string[], extra?: Partial<ProcessSpec>): ProcessSpec;
  idle(): Promise<void>;
  cleanup(): Promise<void>;
}

export function createRuntimeHarness(extra: Partial<RuntimeDeps> & { tools?: ProcessTools } = {}): RuntimeHarness {
  const h = tempHome('visione-rt-');
  const workspace = join(h.dir, 'workspace', 'agente-1');
  const system = join(h.dir, 'runtime');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(system, { recursive: true });
  const db = openDb(join(h.dir, 'visione.db'));
  migrate(db);
  const journal = createJournal(db);
  const bus = createEventBus();
  const events: VisioneEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const emitter = createEventEmitter({ db, journal, bus });
  const policy = createRuntimePolicy({ executables: [NODE], roots: [join(h.dir, 'workspace'), system] });
  const runtime = createCliRuntime({
    db, events: emitter, log: memoryLogger('error').log, policy, inheritedEnv: process.env, systemCwd: system,
    stopGraceMs: 1_000, ...extra
  });
  return {
    dir: h.dir,
    workspace,
    db,
    journal,
    bus,
    emitter,
    runtime,
    events,
    spec(args, more = {}) {
      return {
        exe: NODE,
        args: [FAKE_CLI, ...args],
        cwd: workspace,
        env: runtime.env(more.cwd ?? workspace),
        io: 'pipes',
        kind: 'system',
        correlationId: ulid(),
        ...more
      };
    },
    idle: () => bus.idle(),
    async cleanup() {
      await runtime.stopAll('fine test', 3_000);
      emitter.close();
      db.close();
      h.cleanup();
    }
  };
}
