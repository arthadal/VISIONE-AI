// Barra comandi sempre visibile (VISIONE_ARCHITECTURE §26): un obiettivo al Director e il
// push-to-talk della voce (Fase 9). Offline (17/10/2026) la frase va al modello locale.
import { useState } from 'react';
import type { CommandError, VoiceState } from '../../shared/contracts/index.ts';
import { useT } from '../lib/i18n/index.ts';
import { VoiceControl } from '../voice/VoiceControl.tsx';
import { sendGoal, useOfflineState } from './offline-store.ts';

export function CommandBar({ ready, inputRef, voice }: { ready: boolean; inputRef: React.RefObject<HTMLTextAreaElement | null>; voice: VoiceState | null }) {
  const t = useT();
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<CommandError | null>(null);
  const [thinking, setThinking] = useState(false);
  const offline = useOfflineState()?.active ?? false;
  const submit = (): void => {
    if (goal.trim() === '' || thinking) return;
    if (offline) setThinking(true);
    void sendGoal(goal.trim()).then((res) => {
      setThinking(false);
      setError(res.ok ? null : res.error);
      if (res.ok) setGoal('');
    });
  };
  return (
    <form className="commandbar" aria-label={t('shell.commandbar.aria')} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        ref={inputRef}
        aria-label={t('shell.commandbar.goalAria')}
        data-testid="goal-input"
        rows={1}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={offline ? t('offline.placeholder') : t('shell.commandbar.placeholder')}
        title={t('shell.commandbar.hint')}
      />
      <button type="submit" className="cmd-tasto cmd-primario" data-testid="goal-submit" disabled={!ready || goal.trim() === '' || thinking}>{t('shell.commandbar.send')}</button>
      {thinking && <span className="muted small" role="status" data-testid="offline-thinking">{t('offline.reply.thinking')}</span>}
      <VoiceControl voice={voice} ready={ready} />
      <span className="muted small cmd-hint">{t('shell.commandbar.palette')}</span>
      {error && <span className="error small">{error.code}: {error.message}</span>}
    </form>
  );
}
