// Web Worker della scena Neural 3D: proiezione e layout fuori dal thread della UI (P-47).
import { createNeuralEngine, type FromEngine, type ToEngine } from './engine.ts';

const scope = self as unknown as { postMessage(m: FromEngine): void; onmessage: ((ev: MessageEvent<ToEngine>) => void) | null };
const engine = createNeuralEngine((m) => scope.postMessage(m));
scope.onmessage = (ev) => engine.handle(ev.data);
