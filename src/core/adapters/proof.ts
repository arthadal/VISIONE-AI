// Prova di uno strumento (issue #1 su GitHub, idea 6 «prima la prova, poi il fatto», 04/11/2026): cosa ha
// eseguito un agente e cosa è uscito davvero, come lo consegna il motore (i suoi hook o i suoi eventi),
// non come l'agente lo racconta. Finisce nell'evento `tool.call.finished` (redatto come ogni
// evento) e da lì nel brief del Revisore. Funzioni pure.

export const PROOF_LIMITS = { input: 300, output: 1_200 } as const;

/** Della lunga uscita si tiene l'inizio (il primo errore) e soprattutto la fine (esito e riepilogo). */
const OUTPUT_HEAD = 300;

export interface ToolProof {
  /** Il comando, il file o il bersaglio dello strumento; null se il motore non lo dice. */
  readonly input: string | null;
  /** Uscita vera (stdout e stderr, o l'errore); null se vuota. */
  readonly output: string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null);

const asText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
};

/** I campi che dicono cosa ha fatto lo strumento, in ordine: Bash, file, ricerca, rete. */
const INPUT_KEYS = ['command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query'] as const;

export function proofInput(input: unknown): string | null {
  const o = obj(input);
  const key = o ? INPUT_KEYS.find((k) => typeof o[k] === 'string' && o[k] !== '') : undefined;
  const text = (key && o ? String(o[key]) : asText(input))?.trim();
  if (!text) return null;
  return text.length <= PROOF_LIMITS.input ? text : `${text.slice(0, PROOF_LIMITS.input - 1)}…`;
}

export function proofOutput(output: unknown): string | null {
  const o = obj(output);
  const streams = o && (typeof o.stdout === 'string' || typeof o.stderr === 'string')
    ? [typeof o.stdout === 'string' ? o.stdout.trim() : '', typeof o.stderr === 'string' && o.stderr.trim() ? `[stderr] ${o.stderr.trim()}` : ''].filter(Boolean).join('\n')
    : null;
  const text = (streams ?? asText(output))?.trim();
  if (!text) return null;
  const max = PROOF_LIMITS.output;
  return text.length <= max ? text : `${text.slice(0, OUTPUT_HEAD)}\n…\n${text.slice(-(max - OUTPUT_HEAD - 3))}`;
}

export function toolProof(input: unknown, output: unknown): ToolProof {
  return { input: proofInput(input), output: proofOutput(output) };
}
