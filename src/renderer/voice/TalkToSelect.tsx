// Con chi parla la voce (decisione del proprietario, 15/10/2026): quello che dice va all'agente scelto
// qui, o al Director se non ne sceglie uno; la risposta dell'agente torna a voce. Si cambia anche a
// voce («parla con Esecutore», «passami il Director»): lo stato viene dal core, qui non si decide nulla.
import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n/index.ts';

interface Choice {
  readonly id: string;
  readonly name: string;
}

export function TalkToSelect({ available, talkTo }: { available: boolean; talkTo: string | null }) {
  const t = useT();
  const [agents, setAgents] = useState<readonly Choice[]>([]);
  const [error, setError] = useState<string | null>(null);

  // L'elenco si rilegge quando la voce diventa disponibile o cambia l'interlocutore (anche detto a voce).
  useEffect(() => {
    if (!available) return;
    let alive = true;
    void window.visione.agents.list(false).then((res) => {
      if (alive && res.ok) setAgents(res.data.agents.map((a) => ({ id: a.definition.id, name: a.definition.name })));
    });
    return () => {
      alive = false;
    };
  }, [available, talkTo]);

  const change = (value: string): void => {
    setError(null);
    void window.visione.voice.talkTo(value === '' ? null : value).then((res) => {
      if (!res.ok) setError(`${res.error.code}: ${res.error.message}`);
    });
  };

  // Un interlocutore non più fra gli agenti resta visibile finché il core non lo cambia.
  const known = talkTo === null || agents.some((a) => a.id === talkTo);
  return (
    <label className="mic-select talk-to small" title={t('widgets.voice.talkTo.aria')}>
      <select data-testid="voice-talk-to" value={talkTo ?? ''} disabled={!available} onChange={(e) => change(e.target.value)} aria-label={t('widgets.voice.talkTo.aria')}>
        <option value="">{t('widgets.voice.talkTo.director')}</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
        {!known && <option value={talkTo}>{talkTo}</option>}
      </select>
      {error && <span className="error small" data-testid="voice-talk-to-error">{error}</span>}
    </label>
  );
}
