// Collegamento al motore della proiezione: Web Worker se disponibile, altrimenti lo stesso motore nel
// thread della UI (la scena funziona comunque, più lenta con molti eventi).
import { createNeuralEngine, type FromEngine, type ToEngine } from './engine.ts';

export interface NeuralClient {
  readonly mode: 'worker' | 'inline';
  post(m: ToEngine): void;
  dispose(): void;
}

export function createNeuralClient(onMessage: (m: FromEngine) => void, onFallback: () => void): NeuralClient {
  const inline = (): NeuralClient => {
    const engine = createNeuralEngine((m) => queueMicrotask(() => onMessage(m)));
    return { mode: 'inline', post: (m) => engine.handle(m), dispose: () => undefined };
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL('./neural.worker.ts', import.meta.url), { type: 'module', name: 'visione-neural' });
  } catch {
    return inline();
  }
  let current: NeuralClient | null = null;
  const client: NeuralClient = {
    get mode() {
      return current?.mode ?? 'worker';
    },
    post: (m) => (current ? current.post(m) : worker.postMessage(m)),
    dispose: () => {
      worker.terminate();
      current?.dispose();
    }
  };
  worker.onmessage = (ev: MessageEvent<FromEngine>) => onMessage(ev.data);
  // Worker non caricabile (es. politica dei contenuti): stesso motore nel thread della UI.
  worker.onerror = (ev) => {
    ev.preventDefault();
    worker.terminate();
    if (!current) {
      current = inline();
      onFallback();
    }
  };
  return client;
}
