// Preferenze del widget Umanoide (11/10/2026), per chi guarda: webcam accesa e «quando parla si apre e
// si ingrandisce». Sono comodità di questo PC (localStorage): se l'archivio manca valgono i default
// (webcam spenta, ingrandimento acceso). Il widget e l'App le leggono insieme: un evento le tiene allineate.
import { useCallback, useEffect, useState } from 'react';

const KEY = 'visione.widget.umanoide.v1';
const SYNC = 'visione:humanoid-prefs';

export interface HumanoidPrefs {
  camera: boolean;
  /** Quando VISIONE parla l'umanoide si apre (anche se spento o piegato) e si ingrandisce a sinistra. */
  grow: boolean;
}
export const DEFAULT_HUMANOID_PREFS: HumanoidPrefs = { camera: false, grow: true };

export function readHumanoidPrefs(): HumanoidPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    return {
      camera: typeof raw.camera === 'boolean' ? raw.camera : DEFAULT_HUMANOID_PREFS.camera,
      grow: typeof raw.grow === 'boolean' ? raw.grow : DEFAULT_HUMANOID_PREFS.grow
    };
  } catch {
    return { ...DEFAULT_HUMANOID_PREFS };
  }
}

function writeHumanoidPrefs(p: HumanoidPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Solo una comodità: senza archivio al prossimo avvio tornano i default.
  }
  window.dispatchEvent(new CustomEvent(SYNC));
}

export function useHumanoidPrefs(): [HumanoidPrefs, (patch: Partial<HumanoidPrefs>) => void] {
  const [prefs, setPrefs] = useState(readHumanoidPrefs);
  useEffect(() => {
    const sync = (): void => setPrefs(readHumanoidPrefs());
    window.addEventListener(SYNC, sync);
    return () => window.removeEventListener(SYNC, sync);
  }, []);
  const update = useCallback((patch: Partial<HumanoidPrefs>) => {
    writeHumanoidPrefs({ ...readHumanoidPrefs(), ...patch });
  }, []);
  return [prefs, update];
}
