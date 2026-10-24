// Spool degli eventi del main non ancora registrati dal core: `<home>\runtime\main-events.jsonl`.
// Scritture solo agli eventi del ciclo di vita (rari). Limite di dimensione: oltre, i più vecchi
// vengono scartati e registrati nel log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEvent, type VisioneEvent } from '../shared/contracts/index.ts';
import type { Logger } from '../shared/node/logging.ts';

export interface Spool {
  add(event: VisioneEvent): void;
  remove(ids: readonly string[]): void;
  list(): VisioneEvent[];
}

export const SPOOL_LIMIT = 1_000;

export function createSpool(file: string, log: Logger, limit = SPOOL_LIMIT): Spool {
  mkdirSync(dirname(file), { recursive: true });
  let events: VisioneEvent[] = [];

  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        log.warn('spool: riga non leggibile scartata');
        continue;
      }
      const parsed = parseEvent(raw, 'main');
      if (parsed.ok) events.push(parsed.event);
      else log.warn('spool: evento non valido scartato', { problem: parsed.problem });
    }
  }

  const rewrite = (): void => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, events.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    renameSync(tmp, file);
  };

  const trim = (): boolean => {
    if (events.length <= limit) return false;
    const dropped = events.length - limit;
    events = events.slice(dropped);
    log.warn('spool pieno: eventi più vecchi scartati', { dropped });
    return true;
  };
  if (trim()) rewrite();

  return {
    add(event) {
      events.push(event);
      if (trim()) rewrite();
      else appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    },
    remove(ids) {
      if (ids.length === 0) return;
      const drop = new Set(ids);
      const before = events.length;
      events = events.filter((e) => !drop.has(e.id));
      if (events.length !== before) rewrite();
    },
    list() {
      return events.slice();
    }
  };
}
