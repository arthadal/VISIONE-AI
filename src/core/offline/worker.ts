// Filo di lavoro del modello offline (17/10/2026). onnxruntime-node carica i pesi (3 GB) in modo sincrono:
// nel filo principale del core bloccava tutto per oltre 10 s, il supervisore non riceveva il battito e
// riavviava il core (visto nel collaudo dell'app). Qui il carico e la generazione non fermano il core.
// Messaggi: { id, op: 'load' | 'rewrite' | 'release', text?, lang? } → { id, ok, value? | error? }.
import { parentPort, workerData } from 'node:worker_threads';
import type { Language } from '../../shared/contracts/index.ts';
import { createLocalModel } from './llm.ts';

interface Request { id: number; op: 'load' | 'rewrite' | 'release'; text?: string; lang?: Language }

const port = parentPort;
if (!port) throw new Error('il modello offline va avviato come filo di lavoro');
let lang: Language = 'it';
const model = createLocalModel({ dir: (workerData as { dir: string }).dir, language: () => lang });

port.on('message', (msg: Request) => {
  if (msg.lang) lang = msg.lang;
  const run = msg.op === 'load' ? model.load().then(() => null) : msg.op === 'rewrite' ? model.rewrite(msg.text ?? '') : model.release().then(() => null);
  run.then(
    (value) => port.postMessage({ id: msg.id, ok: true, value }),
    (err: unknown) => port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  );
});
