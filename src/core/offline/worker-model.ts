// Il modello offline visto dal core (17/10/2026): stessa interfaccia di `createLocalModel`, ma il lavoro lo fa
// un filo di lavoro separato (`worker.ts`, compilato in `out/main/offline-worker.js`). Il filo nasce al primo
// uso e si chiude del tutto quando si torna online, così la memoria (~4 GB) torna al sistema. Se il filo
// cade, le richieste in corso falliscono con un motivo e il prossimo uso ne avvia uno nuovo.
import { Worker } from 'node:worker_threads';
import type { Language } from '../../shared/contracts/index.ts';
import type { LocalModel } from './llm.ts';

type Reply = { id: number; ok: true; value: string | null } | { id: number; ok: false; error: string };

export function createWorkerModel(opts: { dir: string; language: () => Language; entry: () => string }): LocalModel {
  let worker: Worker | null = null;
  let ready = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: string | null) => void; reject: (e: Error) => void }>();

  const fail = (reason: string): void => {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
    worker = null;
    ready = false;
  };

  const spawn = (): Worker => {
    if (worker) return worker;
    const w = new Worker(opts.entry(), { workerData: { dir: opts.dir } });
    w.on('message', (msg: Reply) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    });
    w.on('error', (err) => { if (worker === w) fail(`modello offline: ${err.message}`); });
    w.on('exit', (code) => { if (worker === w) fail(`modello offline: il filo di lavoro è uscito (${code})`); });
    worker = w;
    return w;
  };

  const call = (op: 'load' | 'rewrite' | 'release', text?: string): Promise<string | null> => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    spawn().postMessage({ id, op, lang: opts.language(), ...(text !== undefined ? { text } : {}) });
  });

  return {
    async load() {
      await call('load');
      ready = true;
    },
    loaded: () => ready,
    async rewrite(text) {
      const out = await call('rewrite', text);
      ready = true;
      return out ?? '';
    },
    async release() {
      const w = worker;
      if (!w) return;
      worker = null;
      ready = false;
      // Si chiude il filo: la memoria nativa del modello torna al sistema anche se il rilascio non risponde.
      await w.terminate().catch(() => undefined);
      for (const p of pending.values()) p.reject(new Error('modello offline chiuso'));
      pending.clear();
    }
  };
}
