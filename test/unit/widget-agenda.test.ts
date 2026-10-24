// Widget Agenda (beta.5, P-109): sezioni, etichette dell'ora e giorni segnati sul Calendario.
import { describe, expect, it } from 'vitest';
import { dayKey, groupReminders, reminderDays, timeLabel } from '../../src/renderer/app/widgets/agenda-logic.ts';
import type { Reminder } from '../../src/shared/contracts/index.ts';

const NOW = new Date(2026, 9, 11, 10, 0).getTime();
const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime();

function rem(id: string, dueAt: number, status: Reminder['status'] = 'pending', kind: Reminder['kind'] = 'reminder'): Reminder {
  return { id, text: id, kind, dueAt, notifyAt: dueAt, status, source: 'ui', createdAt: NOW, updatedAt: NOW, firedAt: status === 'fired' ? NOW : null, repeat: null };
}

describe('agenda-logic', () => {
  it('scattati prima, poi oggi, domani, più avanti; chiusi fuori; ordine per ora', () => {
    const list = [rem('dopo', at(15, 9)), rem('oggi2', at(11, 18)), rem('oggi1', at(11, 11)), rem('dom', at(12, 9)), rem('ora', at(11, 9, 50), 'fired'), rem('fatto', at(11, 12), 'done')];
    const sections = groupReminders(list, NOW);
    expect(sections.map((s) => [s.id, s.items.map((r) => r.id)])).toEqual([
      ['fired', ['ora']], ['today', ['oggi1', 'oggi2']], ['tomorrow', ['dom']], ['later', ['dopo']]
    ]);
    expect(groupReminders([], NOW)).toEqual([]);
  });

  it('etichette: solo l\'ora per oggi e domani, il giorno più avanti', () => {
    expect(timeLabel(rem('a', at(11, 15, 5)), NOW, 'it-IT')).toBe('15:05');
    expect(timeLabel(rem('b', at(12, 9)), NOW, 'it-IT')).toBe('9:00');
    expect(timeLabel(rem('c', at(15, 10)), NOW, 'it-IT')).toMatch(/15 ott.*10:00/);
  });

  it('giorni segnati sul Calendario: solo promemoria aperti, chiave come le celle', () => {
    const days = reminderDays([rem('a', at(12, 9)), rem('b', at(15, 9), 'cancelled'), rem('c', at(11, 9), 'fired')]);
    expect([...days].sort()).toEqual(['2026-10-11', '2026-10-12']);
    expect(dayKey(at(3, 0))).toBe('2026-10-03');
  });
});
