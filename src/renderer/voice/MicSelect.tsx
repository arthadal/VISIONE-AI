// Selezione del microfono (Fase 18.3). Elenca i dispositivi audio di ingresso reali e applica la
// scelta alla cattura (`voiceAudio.setDeviceId`), conservata in localStorage. I nomi dei dispositivi
// compaiono solo dopo il permesso al microfono: fino ad allora si mostrano come "microfono N".
import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n/index.ts';
import { voiceAudio } from './audio.ts';

const KEY = 'visione.mic';

export function MicSelect({ available }: { available: boolean }) {
  const t = useT();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState<string>(() => {
    try {
      return localStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    voiceAudio.setDeviceId(selected || null);
    let cancelled = false;
    const load = (): void => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      void navigator.mediaDevices.enumerateDevices().then((list) => {
        if (!cancelled) setDevices(list.filter((d) => d.kind === 'audioinput'));
      });
    };
    load();
    try {
      navigator.mediaDevices?.addEventListener('devicechange', load);
    } catch {
      // alcuni ambienti non supportano devicechange
    }
    return () => {
      cancelled = true;
      try {
        navigator.mediaDevices?.removeEventListener('devicechange', load);
      } catch {
        // ignora
      }
    };
  }, [selected]);

  const change = (id: string): void => {
    setSelected(id);
    voiceAudio.setDeviceId(id || null);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // preferenza solo per questa sessione
    }
  };

  return (
    <label className="mic-select small" title={available ? t('widgets.mic.titleOn') : t('widgets.mic.titleOff')}>
      <span className="muted">Mic</span>
      <select data-testid="voice-device" value={selected} onChange={(e) => change(e.target.value)} aria-label={t('widgets.mic.aria')}>
        <option value="">{t('widgets.mic.default')}</option>
        {devices.map((d, i) => (
          <option key={d.deviceId || `mic-${i}`} value={d.deviceId}>{d.label || t('widgets.mic.numbered', { n: i + 1 })}</option>
        ))}
      </select>
    </label>
  );
}
