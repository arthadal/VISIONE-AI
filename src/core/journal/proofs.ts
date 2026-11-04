// Prove registrate da VISIONE (issue #1 su GitHub, idea 6 «prima la prova, poi il fatto», 04/11/2026): gli
// strumenti eseguiti in un turno, letti dal registro (`tool.call.finished`). Le scrive il ponte del motore con
// ciò che consegnano gli hook, non l'agente: sono la differenza fra «i test passano» e l'uscita dei test.
import type { Task } from '../../shared/contracts/index.ts';
import type { Journal } from './index.ts';

export interface RecordedProof {
  readonly agentId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly input: string | null;
  readonly output: string | null;
}

/** Eventi letti per obiettivo: di un obiettivo con più strumenti di così restano i più recenti. */
const SCAN = 1_000;

/** Strumenti del turno `turnId` (di norma quello che ha chiuso il task), nell'ordine in cui sono finiti. */
export function recordedProofs(journal: Pick<Journal, 'read'>, task: Pick<Task, 'correlationId'>, turnId: string | null): RecordedProof[] {
  if (!turnId) return [];
  const out: RecordedProof[] = [];
  for (const e of journal.read({ types: ['tool.call.finished'], correlationId: task.correlationId, limit: SCAN })) {
    const p = e.payload as { agentId?: unknown; turnId?: unknown; tool?: unknown; ok?: unknown; input?: unknown; output?: unknown };
    if (p.turnId !== turnId) continue;
    out.push({
      agentId: String(p.agentId ?? ''), tool: String(p.tool ?? ''), ok: p.ok === true,
      input: typeof p.input === 'string' ? p.input : null, output: typeof p.output === 'string' ? p.output : null
    });
  }
  return out;
}

/**
 * Il riassunto dice di aver fatto qualcosa che lascia tracce (file, comandi, test)? Solo allora una revisione
 * deve avere una prova: la revisione di un testo non ha comandi da vedere.
 */
const CLAIMS_WORK = /\b(?:(?:eseguit|lanciat|compilat|creat|scritt|modificat|salvat|installat|aggiornat|cancellat|rimoss)[oaie]|i test|build|ran|executed|compiled|created|wrote|written|modified|saved|installed|updated|deleted|removed)\b|\btests?\s+pass/i;

export function claimsWork(summary: string): boolean {
  return CLAIMS_WORK.test(summary);
}

/** Il task è una revisione? Competenza del passo, o (passo senza competenza) un agente che fa solo revisione. */
export function isReviewTask(task: Pick<Task, 'competence'>, agentCompetences: readonly string[]): boolean {
  if (task.competence !== null) return task.competence === 'review';
  return agentCompetences.includes('review') && !agentCompetences.includes('code');
}
