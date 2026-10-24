// Catalogo degli adapter inclusi in VISIONE: l'unico punto, fuori dalle cartelle dei motori, che li
// elenca per nome. Il kernel riceve solo `AgentAdapter` generici.
import type { CliRuntime } from '../../runtime/index.ts';
import type { ActionGate, AgentAdapter } from '../index.ts';
import { createClaudeCodeAdapter } from '../claude-code/index.ts';
import { createOpencodeAdapter } from '../opencode/index.ts';
import { createPtyGenericAdapter } from '../pty-generic/index.ts';

export interface BuiltinAdapterDeps {
  readonly runtime: CliRuntime;
  /** Cartella dove il core scrive gli shim degli hook. */
  readonly shimDir: string;
  /** Policy e approvazioni di VISIONE sulle azioni degli strumenti (motori con `control.deny`). */
  readonly decideAction?: ActionGate;
  /** Agenti in modalità fiducia (P-102): per i motori senza controllo delle azioni valgono permessi pieni. */
  readonly isTrusted?: (agentId: string) => boolean;
}

export function createBuiltinAdapters(deps: BuiltinAdapterDeps): AgentAdapter[] {
  const opencode = createOpencodeAdapter(deps.isTrusted ? { isTrusted: deps.isTrusted } : {});
  opencode.attach(deps.runtime);
  const claude = createClaudeCodeAdapter({ shimDir: deps.shimDir, ...(deps.decideAction ? { decideAction: deps.decideAction } : {}) });
  claude.attach(deps.runtime);
  // Fase 8 (P-45): qualsiasi CLI locale scelta dal proprietario, come terminale dedicato.
  return [opencode, claude, createPtyGenericAdapter()];
}
