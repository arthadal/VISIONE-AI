// Procedura guidata, passo Voce — ascolto avanzato (P-106, richiesta del proprietario del 10/10/2026):
// filtro voce scaricato su consenso, parola d'avvio con prova dal vivo, misura del rumore della stanza
// e soglia, registrazione della voce del proprietario con prova «sei tu / non sei tu». Tutto passa dai
// comandi reali (config, voce); i testi sono nella lingua scelta.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VisioneEvent, VoiceFilters } from '../../shared/contracts/index.ts';
import { useLanguage, useT, type MessageKey } from '../lib/i18n/index.ts';
import { voiceAudio } from '../voice/audio.ts';
import { accuracyPercent, wordErrors } from './accuracy-logic.ts';
import { noiseGateFrom } from './setup-logic.ts';
import { restartVoice } from './voice-restart.ts';

type VoicePatch = Record<string, unknown>;
interface Settings { wakeEnabled: boolean; wakePhrase: string; denoise: boolean; ownerOnly: boolean; noiseGate: number }
const SENTENCES = ['wiz.owner.sentence1', 'wiz.owner.sentence2', 'wiz.owner.sentence3'] as const;
/** Prova di precisione (24/10/2026): frasi da comandi veri, diverse da quelle usate per mettere a punto l'ascolto. */
const ACCURACY_PHRASES = ['wiz.accuracy.p1', 'wiz.accuracy.p2', 'wiz.accuracy.p3', 'wiz.accuracy.p4', 'wiz.accuracy.p5', 'wiz.accuracy.p6', 'wiz.accuracy.p7', 'wiz.accuracy.p8'] as const;
interface AccuracyRun { index: number; results: Array<{ expected: string; heard: string; errors: number; words: number }>; retry: boolean }

export function SetupListening({ hearingReady }: { hearingReady: boolean }) {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [filters, setFilters] = useState<VoiceFilters | null>(null);
  const [models, setModels] = useState<{ complete: boolean; missing: Array<{ id: string; size: number; license: string }> } | null>(null);
  const [download, setDownload] = useState<{ id: string; phase: string; received: number; total: number; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ section: 'wake' | 'noise' | 'owner' | 'filters'; text: string; ok?: boolean } | null>(null);
  const [enroll, setEnroll] = useState<{ active: boolean; count: number }>({ active: false, count: 0 });
  const [holding, setHolding] = useState(false);
  const probing = useRef(false);
  const filterIds = useRef(new Set<string>());
  const lang = useLanguage();
  const [accuracy, setAccuracy] = useState<AccuracyRun | null>(null);
  // La frase attesa, letta dal gestore degli eventi (sottoscritto una volta sola).
  const expected = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [cfg, st, ms] = await Promise.all([window.visione.config.get(), window.visione.voice.status(), window.visione.voice.modelsStatus('filters')]);
    if (cfg.ok) {
      const v = (cfg.data.config.voice ?? {}) as { wake?: { enabled?: boolean; phrase?: string }; denoise?: boolean; ownerOnly?: { enabled?: boolean }; noiseGate?: number };
      setSettings({ wakeEnabled: v.wake?.enabled ?? false, wakePhrase: v.wake?.phrase ?? 'hey visione', denoise: v.denoise ?? true, ownerOnly: v.ownerOnly?.enabled ?? false, noiseGate: v.noiseGate ?? 0.004 });
    }
    if (st.ok) setFilters(st.data.filters);
    if (ms.ok) {
      setModels({ complete: ms.data.complete, missing: ms.data.missing });
      for (const m of ms.data.missing) filterIds.current.add(m.id);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.type === 'voice.process.changed' && (e.payload as { to?: string }).to === 'ready') void refresh();
      if (e.type === 'voice.models.progress') {
        const p = e.payload as { id: string; phase: string; received: number; total: number; error: string | null };
        if (filterIds.current.has(p.id) || p.id === 'tutti') setDownload(p);
      }
      if (e.type === 'voice.enroll.progress') {
        const p = e.payload as { phase: string; count: number; quality: number | null; reason: string | null };
        if (p.phase === 'started') setEnroll({ active: true, count: 0 });
        else if (p.phase === 'sample') setEnroll({ active: true, count: p.count });
        else if (p.phase === 'saved') {
          setEnroll({ active: false, count: 0 });
          setNote({ section: 'owner', text: t('wiz.owner.saved', { q: (p.quality ?? 0).toFixed(2) }), ok: true });
          void refresh();
        } else if (p.phase === 'cleared') {
          setNote({ section: 'owner', text: t('wiz.owner.cleared'), ok: true });
          void refresh();
        } else if (p.phase === 'error') {
          if (p.reason === 'quality') setEnroll({ active: true, count: 0 });
          setNote({ section: 'owner', text: t(`wiz.owner.err.${p.reason ?? 'failed'}` as MessageKey), ok: false });
        }
      }
      if (e.type === 'voice.accuracy.heard' && expected.current !== null) {
        const want = expected.current;
        const heard = (e.payload as { text: string }).text.trim();
        // Niente sentito (troppo piano o filtrato): si ripete la stessa frase, non conta come errore.
        if (heard === '') setAccuracy((run) => (run ? { ...run, retry: true } : run));
        else {
          expected.current = null;
          setAccuracy((run) => (run ? { index: run.index + 1, results: [...run.results, { expected: want, heard, ...wordErrors(want, heard, lang) }], retry: false } : run));
        }
      }
      if (e.type === 'voice.heard' && probing.current) {
        probing.current = false;
        const p = e.payload as { outcome: string; score: number | null };
        const score = p.score === null ? '' : p.score.toFixed(2);
        setNote({ section: 'owner', ok: p.outcome === 'owner', text: p.outcome === 'owner' ? t('wiz.owner.isYou', { score }) : p.outcome === 'stranger' ? t('wiz.owner.notYou', { score }) : t('wiz.owner.tooShort') });
      }
    });
  }, [refresh, t, lang]);

  /** Salva le impostazioni della voce e riavvia il processo voce (valgono dal riavvio). */
  const apply = async (patch: VoicePatch, section: 'wake' | 'noise' | 'owner' | 'filters'): Promise<boolean> => {
    setBusy(true);
    setNote({ section, text: t('wiz.listen.applying') });
    const res = await window.visione.config.update({ voice: patch });
    if (!res.ok) {
      setBusy(false);
      setNote({ section, text: t('wiz.listen.notApplied', { error: res.error.message || res.error.code }), ok: false });
      return false;
    }
    const ok = await restartVoice();
    setBusy(false);
    await refresh();
    if (!ok) setNote({ section, text: t('wiz.voice.notStarted'), ok: false });
    else setNote(null);
    return ok;
  };

  const tryWake = async (): Promise<void> => {
    if (!settings) return;
    const phrase = settings.wakePhrase.trim() || 'hey visione';
    if (!(await apply({ wake: { enabled: settings.wakeEnabled, phrase } }, 'wake'))) return;
    if (!settings.wakeEnabled) return setNote({ section: 'wake', text: t('wiz.wake.off') });
    setNote({ section: 'wake', text: t('wiz.wake.say', { phrase }) });
    const heard = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, 20_000);
      const off = window.visione.events.subscribe((e: VisioneEvent) => {
        if (e.type !== 'voice.wake.detected') return;
        clearTimeout(timer);
        off();
        resolve((e.payload as { text: string }).text);
      });
    });
    setNote(heard === null ? { section: 'wake', text: t('wiz.wake.notHeard'), ok: false } : { section: 'wake', text: t('wiz.wake.heard', { text: heard }), ok: true });
  };

  const measure = async (): Promise<void> => {
    setBusy(true);
    setNote({ section: 'noise', text: t('wiz.noise.measuring') });
    try {
      const levels = await voiceAudio.measureNoise(3_000);
      const gate = noiseGateFrom(levels);
      const sorted = [...levels].sort((a, b) => a - b);
      const level = (sorted[Math.floor(sorted.length * 0.9)] ?? 0).toFixed(4);
      setBusy(false);
      if (await apply({ noiseGate: gate }, 'noise')) setNote({ section: 'noise', text: t('wiz.noise.result', { level, gate: gate.toFixed(4) }), ok: true });
    } catch (err) {
      setBusy(false);
      setNote({ section: 'noise', text: t('wiz.noise.failed', { error: err instanceof Error ? err.message : String(err) }), ok: false });
    }
  };

  const startDownload = async (): Promise<void> => {
    setDownload({ id: '', phase: 'download', received: 0, total: 0, error: null });
    const res = await window.visione.voice.modelsDownload('filters');
    if (!res.ok) setDownload({ id: '', phase: 'errore', received: 0, total: 0, error: res.error.message || res.error.code });
    else if (res.data.alreadyComplete) void refresh();
  };

  // Tenere premuto: microfono aperto e push-to-talk, come il pulsante «Parla» della barra.
  const hold = (down: boolean): void => {
    if (down === holding) return;
    setHolding(down);
    if (down) void voiceAudio.ensureCapture().catch((err: unknown) => setNote({ section: 'owner', text: String(err instanceof Error ? err.message : err), ok: false }));
    void window.visione.voice.ptt(down ? 'press' : 'release');
  };
  const holdProps = (label: string, testId: string, onDown?: () => void) => (
    <button type="button" className={`setup-primary${holding ? ' listening' : ''}`} data-testid={testId}
      onPointerDown={(e) => { e.preventDefault(); onDown?.(); hold(true); }} onPointerUp={() => hold(false)} onPointerLeave={() => holding && hold(false)}>
      {holding ? t('wiz.owner.recording') : label}
    </button>
  );

  const mb = (n: number): string => (n / 1_048_576).toFixed(0);
  const filtersReady = models?.complete ?? false;
  const noteFor = (section: 'wake' | 'noise' | 'owner' | 'filters') => note?.section === section && <p className={`small ${note.ok === true ? 'ok' : note.ok === false ? 'bad' : 'muted'}`} data-testid={`setup-listen-note-${section}`}>{note.text}</p>;

  return (
    <div className="setup-listen" data-testid="setup-listen">
      <h3>{t('wiz.listen.title')}</h3>
      {!hearingReady && <p className="muted small">{t('wiz.listen.needHearing')}</p>}

      <div className={`setup-models ${filtersReady ? 'pronto' : ''}`} data-testid="setup-filters">
        <b>{t('wiz.filters.title')}</b>
        {filtersReady && <span className="ok">{t('wiz.filters.ready')}</span>}
        {models && !filtersReady && (
          <>
            <span className="muted">{t('wiz.filters.need', { list: models.missing.map((m) => t('wiz.hearing.license', { id: m.id, license: m.license })).join('; '), mb: mb(models.missing.reduce((n, m) => n + m.size, 0)) })}</span>
            {download && download.phase !== 'errore' && download.phase !== 'completato'
              ? <span>{download.id ? t('wiz.hearing.downloading', { id: download.id, received: mb(download.received), total: mb(download.total) }) : t('wiz.hearing.starting')}{download.total > 0 && <progress value={download.received} max={download.total} />}</span>
              : <button type="button" className="setup-primary" onClick={() => void startDownload()} disabled={!hearingReady} data-testid="setup-filters-download">{t('wiz.filters.download')}</button>}
            {download?.phase === 'errore' && <span className="bad small">{download.error}</span>}
          </>
        )}
      </div>

      {settings && (
        <fieldset className="setup-listen-part" disabled={!hearingReady || busy} data-testid="setup-wake">
          <legend>{t('wiz.wake.title')}</legend>
          <label><input type="checkbox" checked={settings.wakeEnabled} onChange={(e) => setSettings({ ...settings, wakeEnabled: e.target.checked })} data-testid="setup-wake-enabled" /> {t('wiz.wake.enable')}</label>
          <label>{t('wiz.wake.phrase')} <input value={settings.wakePhrase} maxLength={60} onChange={(e) => setSettings({ ...settings, wakePhrase: e.target.value })} data-testid="setup-wake-phrase" /></label>
          <button type="button" onClick={() => void tryWake()} data-testid="setup-wake-try">{t('wiz.wake.saveTry')}</button>
          {noteFor('wake')}
        </fieldset>
      )}

      {settings && (
        <fieldset className="setup-listen-part" disabled={!hearingReady || busy} data-testid="setup-noise">
          <legend>{t('wiz.noise.title')}</legend>
          <button type="button" onClick={() => void measure()} data-testid="setup-noise-measure">{t('wiz.noise.measure')}</button>
          <label><input type="checkbox" checked={settings.denoise} disabled={!filtersReady} onChange={(e) => void apply({ denoise: e.target.checked }, 'noise')} data-testid="setup-denoise" /> {t('wiz.noise.denoise')}</label>
          {noteFor('noise')}
        </fieldset>
      )}

      {settings && (
        <fieldset className="setup-listen-part" disabled={!hearingReady || (busy && !holding)} data-testid="setup-owner">
          <legend>{t('wiz.owner.title')}</legend>
          {!filtersReady ? <p className="muted small">{t('wiz.owner.needFilters')}</p> : (
            <>
              <p className="muted small">{t('wiz.owner.lead')}</p>
              {filters?.owner && !enroll.active && <p className="ok small">{t('wiz.owner.present')}</p>}
              {!enroll.active && <button type="button" onClick={() => void window.visione.voice.enroll('start')} data-testid="setup-owner-start">{filters?.owner ? t('wiz.owner.restart') : t('wiz.owner.start')}</button>}
              {enroll.active && (
                <>
                  <ol className="setup-guide">
                    {SENTENCES.map((k, i) => <li key={k} className={i < enroll.count ? 'ok' : i === enroll.count ? '' : 'muted'}>{i < enroll.count ? '✓ ' : ''}«{t(k)}»</li>)}
                  </ol>
                  {enroll.count < SENTENCES.length
                    ? holdProps(t('wiz.owner.hold', { n: enroll.count + 1 }), 'setup-owner-hold')
                    : <button type="button" className="setup-primary" onClick={() => void window.visione.voice.enroll('save')} data-testid="setup-owner-save">{t('wiz.owner.save')}</button>}
                </>
              )}
              {filters?.owner && !enroll.active && (
                <>
                  <label><input type="checkbox" checked={settings.ownerOnly} onChange={(e) => void apply({ ownerOnly: { enabled: e.target.checked } }, 'owner')} data-testid="setup-owner-only" /> {t('wiz.owner.enable')}</label>
                  {holdProps(t('wiz.owner.try'), 'setup-owner-try', () => { probing.current = true; void window.visione.voice.enroll('probe'); })}
                  <button type="button" onClick={async () => { await window.visione.voice.enroll('clear'); await apply({ ownerOnly: { enabled: false } }, 'owner'); }} data-testid="setup-owner-clear">{t('wiz.owner.clear')}</button>
                </>
              )}
            </>
          )}
          {noteFor('owner')}
        </fieldset>
      )}

      {settings && (
        <fieldset className="setup-listen-part" disabled={!hearingReady || (busy && !holding)} data-testid="setup-accuracy">
          <legend>{t('wiz.accuracy.title')}</legend>
          <p className="muted small">{t('wiz.accuracy.lead', { n: ACCURACY_PHRASES.length })}</p>
          {accuracy === null && (
            <button type="button" onClick={() => setAccuracy({ index: 0, results: [], retry: false })} data-testid="setup-accuracy-start">{t('wiz.accuracy.start')}</button>
          )}
          {accuracy !== null && accuracy.index < ACCURACY_PHRASES.length && (
            <>
              <p data-testid="setup-accuracy-phrase">{t('wiz.accuracy.read', { i: accuracy.index + 1, n: ACCURACY_PHRASES.length })} <strong>«{t(ACCURACY_PHRASES[accuracy.index]!)}»</strong></p>
              {accuracy.retry && <p className="bad small">{t('wiz.accuracy.retry')}</p>}
              {accuracy.results.length > 0 && <p className="muted small">{t('wiz.accuracy.last', { text: accuracy.results.at(-1)!.heard })}</p>}
              {holdProps(t('wiz.accuracy.hold'), 'setup-accuracy-hold', () => {
                expected.current = t(ACCURACY_PHRASES[accuracy.index]!);
                void window.visione.voice.accuracy('arm');
              })}
              <button type="button" onClick={() => { expected.current = null; void window.visione.voice.accuracy('cancel'); setAccuracy(null); }}>{t('wiz.accuracy.stop')}</button>
            </>
          )}
          {accuracy !== null && accuracy.index >= ACCURACY_PHRASES.length && (
            <>
              <p className={accuracyPercent(accuracy.results) >= 98 ? 'ok' : 'bad'} data-testid="setup-accuracy-result">
                {t('wiz.accuracy.result', { pct: accuracyPercent(accuracy.results).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT'), n: accuracy.results.length })}
              </p>
              <ul className="small">
                {accuracy.results.filter((r) => r.errors > 0).map((r) => <li key={r.expected}>«{r.expected}» → «{r.heard}»</li>)}
              </ul>
              <button type="button" onClick={() => setAccuracy({ index: 0, results: [], retry: false })} data-testid="setup-accuracy-again">{t('wiz.accuracy.again')}</button>
            </>
          )}
        </fieldset>
      )}
    </div>
  );
}
