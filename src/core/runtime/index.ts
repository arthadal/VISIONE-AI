// CLI Runtime (Fase 5, VISIONE_AGENT_ARCHITECTURE §4, MUNDER_CLI_RUNTIME.md). Unica porta di
// creazione dei processi: nessun altro modulo usa `child_process` o PTY direttamente.
// Non conosce alcun motore: ogni motore sta nel suo adapter (`core/adapters/<motore>/`).
export { buildEnv, envNames, ALWAYS_STRIPPED, type EnvLayers } from './env.ts';
export { LineSplitter, TailBuffer, MAX_LINE, type Line } from './buffers.ts';
export { createRuntimePolicy, MAX_COMMAND_LINE, type RuntimePolicy } from './policy.ts';
export {
  createCliDiscovery,
  decodeNpmShim,
  resolveCliFile,
  searchPath,
  type CliDiscovery,
  type DiscoverOptions,
  type DiscoveryResult,
  type ResolvedCli
} from './discovery.ts';
export {
  isCrashExit,
  type ManagedProcess,
  type OpResult,
  type OutputStream,
  type ProcessResult,
  type ProcessSpec,
  type PtyModule,
  type StopOutcome
} from './process.ts';
export { createProcessRegistry, type ProcessRecord, type ProcessRegistry } from './registry.ts';
export { createProcessTools, type OsProcessInfo, type ProcessTools } from './tree.ts';
export {
  createHookServer,
  ensureHookShim,
  hookPipeAddress,
  HOOK_FRAME_MAX,
  HOOK_SHIM_SOURCE,
  type HookHandler,
  type HookRequest,
  type HookServer
} from './hookpipe.ts';
export {
  createCliRuntime,
  PROCESS_END_EVENT_TYPES,
  type CliRuntime,
  type ProcessEndEvent,
  type ReconcileReport,
  type RestartPolicy,
  type RunOutput,
  type RuntimeDeps,
  type StartResult,
  type Supervision
} from './runtime.ts';

/** Timeout del runtime (VISIONE_SECURITY_MODEL §5). */
export interface RuntimeTimeouts {
  readonly discoveryMs: number;
  readonly startMs: number;
  readonly hookResponseMs: number;
  readonly stopGraceMs: number;
}
