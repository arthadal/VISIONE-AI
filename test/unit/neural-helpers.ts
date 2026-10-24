// Motore della scena senza worker, con i messaggi raccolti (test).
import { createNeuralEngine, type FromEngine, type PulseView } from '../../src/renderer/neural/engine.ts';

export function createEngine(opts: Parameters<typeof createNeuralEngine>[1] = {}): { engine: ReturnType<typeof createNeuralEngine>; messages: FromEngine[]; pulses(): PulseView[] } {
  const messages: FromEngine[] = [];
  const engine = createNeuralEngine((m) => messages.push(m), opts);
  return { engine, messages, pulses: () => messages.flatMap((m) => (m.type === 'pulses' ? m.pulses : [])) };
}
