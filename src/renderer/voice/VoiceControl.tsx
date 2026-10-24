// Push-to-talk della barra comandi (Fase 9, VISIONE_ARCHITECTURE §28): tenere premuto per parlare.
// Il microfono si apre solo mentre si ascolta o VISIONE parla (barge-in), poi si rilascia. Lo stato
// viene dal core; qui non si decide nulla.
import { useCallback, useEffect, useState } from 'react';
import type { VoiceState } from '../../shared/contracts/index.ts';
import { useT, type MessageKey } from '../lib/i18n/index.ts';
import { voiceAudio } from './audio.ts';
import { MicSelect } from './MicSelect.tsx';
import { TalkToSelect } from './TalkToSelect.tsx';

const STATUS_LABEL: Record<VoiceState['status'], MessageKey> = {
  off: 'widgets.voice.status.off',
  starting: 'widgets.voice.status.starting',
  ready: 'widgets.voice.status.ready',
  unavailable: 'widgets.voice.status.unavailable',
  failed: 'widgets.voice.status.failed'
};

export function VoiceControl({ voice, ready }: { voice: VoiceState | null; ready: boolean }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const status = voice?.status ?? 'off';
  const available = ready && status === 'ready';
  const listening = voice?.listening ?? false;
  const speaking = voice?.speaking != null;
  const wakeOn = voice?.wake.enabled ?? false;

  // La cattura serve per l'enunciato (PTT), per il barge-in (mentre VISIONE parla) e per la wake
  // word (P-81): con la wake attiva il microfono resta in ascolto anche a voce ferma.
  useEffect(() => {
    if (!available || (!listening && !speaking && !wakeOn)) {
      if (voiceAudio.capturing) voiceAudio.releaseCapture();
      return;
    }
    void voiceAudio.ensureCapture().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [available, listening, speaking, wakeOn]);

  useEffect(() => () => voiceAudio.releaseCapture(), []);

  const ptt = useCallback((action: 'press' | 'release') => {
    setError(null);
    if (action === 'press') void voiceAudio.ensureCapture().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    void window.visione.voice.ptt(action).then((res) => {
      if (!res.ok) setError(`${res.error.code}: ${res.error.message}`);
    });
  }, []);

  const stop = useCallback(() => {
    setError(null);
    void window.visione.voice.stop();
  }, []);

  return (
    <span className="voice" data-testid="voice">
      <button
        type="button"
        data-testid="voice-button"
        className={`voice-button${listening ? ' listening' : speaking ? ' speaking' : ''}`}
        disabled={!available}
        aria-pressed={listening}
        title={voice?.reason ?? t('widgets.voice.title', { status: t(STATUS_LABEL[status]) })}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          ptt('press');
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          ptt('release');
        }}
        onPointerCancel={() => ptt('release')}
      >
        {t('widgets.voice.talk')}
      </button>
      {speaking && (
        <button type="button" data-testid="voice-stop" onClick={stop} title={t('widgets.voice.stopTitle')}>
          Stop
        </button>
      )}
      <span className={`mono small voice-${status}`} data-testid="voice-status">
        {speaking ? t('widgets.voice.speaking') : listening ? t('widgets.voice.listening') : wakeOn && available ? t('widgets.voice.wakeOn') : t(STATUS_LABEL[status])}
      </span>
      <TalkToSelect available={available} talkTo={voice?.talkTo ?? null} />
      <MicSelect available={available} />
      {error && <span className="error small" data-testid="voice-error">{error}</span>}
    </span>
  );
}
