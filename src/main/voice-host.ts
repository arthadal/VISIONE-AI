// Processo voce nel main (VISIONE_ARCHITECTURE §28, Fase 9): avvio, arresto e riavvio del
// utilityProcess `voice`, inoltro dei suoi fatti al core e degli ordini del core a lui, e trasferimento
// della porta audio dedicata al renderer. Il main non interpreta la voce: è un relay senza logica,
// come per il core. Se il processo voce cade, il core continua senza.
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { IPC_CHANNELS, effectiveTtsProvider, formatIssues, voiceToMainSchema, type CoreToVoice, type Edition, type Language, type VoiceToCore } from '../shared/contracts/index.ts';
import type { VisioneConfig } from '../shared/node/config.ts';
import type { Logger } from '../shared/node/logging.ts';
import { keepFullSpeed, logQos } from '../shared/node/qos.ts';
import { join } from 'node:path';

export interface VoiceHostDeps {
  /** Punto d'ingresso compilato del processo voce (`out/main/voice.js`). */
  entry: string;
  env: Record<string, string>;
  config: VisioneConfig['voice'];
  /** Lingua di VISIONE all'avvio (`ui.language` o quella di Windows). */
  language: Language;
  /**
   * Configurazione e lingua attuali, rilette a ogni avvio del processo voce: senza, un riavvio chiesto
   * dalla procedura guidata ripartiva con la voce dell'avvio dell'app (10/10/2026).
   */
  current?: () => { voice: VisioneConfig['voice']; language: Language };
  /** Edizione (P-104): nella `tester` il parlato è sempre la voce di Windows. */
  edition: Edition;
  /** Cartella dei modelli risolta (già assoluta). */
  modelsDir: string;
  /** Voce VISIONE inclusa (P-110); assente = cartella inesistente, e il processo voce ripiega su Windows. */
  voiceDir?: string;
  /** File dell'impronta del proprietario (P-106), nella home di VISIONE. */
  profilePath?: string;
  log: Logger;
  /** Verso il core: fatti del processo voce e suo ciclo di vita. */
  toCore(msg: VoiceToCore): void;
}

export interface VoiceHost {
  /** Avvia il processo voce se abilitato (idempotente). */
  start(): void;
  /** Collega la finestra e le trasferisce la porta audio; da richiamare a ogni caricamento. */
  attach(wc: WebContents): void;
  /** Ordine di ciclo di vita dal core (`control`): avvio, arresto, riavvio. */
  control(action: 'start' | 'stop' | 'restart'): void;
  /** Ordine del core al processo voce (push-to-talk, frase, stop). */
  send(msg: CoreToVoice): boolean;
  /** Spegnimento dell'app. */
  stop(): void;
}

export function createVoiceHost(deps: VoiceHostDeps): VoiceHost {
  let child: UtilityProcess | null = null;
  let window: WebContents | null = null;
  let stopping = false;
  let restartAfterExit = false;

  const sendPort = (process: UtilityProcess, wc: WebContents): void => {
    const channel = new MessageChannelMain();
    process.postMessage({ kind: 'port' }, [channel.port1]);
    if (!wc.isDestroyed()) wc.postMessage(IPC_CHANNELS.voicePort, null, [channel.port2]);
  };

  const spawn = (): void => {
    if (child || stopping || !deps.config.enabled) return;
    const c = utilityProcess.fork(deps.entry, [], { serviceName: 'VISIONE Voce', stdio: 'pipe', env: deps.env });
    child = c;
    c.once('spawn', () => {
      deps.toCore({ type: 'process', phase: 'starting', pid: c.pid ?? null, code: null, reason: '' });
      // Riconoscimento e sintesi girano qui, senza finestra: Windows non deve rallentarli (issue #1, idea 8).
      if (c.pid) keepFullSpeed([c.pid], logQos(deps.log, 'voce'));
      let now: { voice: VisioneConfig['voice']; language: Language } = { voice: deps.config, language: deps.language };
      try {
        if (deps.current) now = deps.current();
      } catch (err) {
        deps.log.warn('configurazione della voce non riletta: uso quella dell\'avvio', { reason: err instanceof Error ? err.message : String(err) });
      }
      const v = now.voice;
      c.postMessage({
        kind: 'init',
        config: {
          modelsDir: deps.modelsDir,
          voiceDir: deps.voiceDir ?? join(deps.modelsDir, 'voce-visione'),
          language: now.language,
          threads: v.threads,
          speaker: v.speaker,
          bargeIn: v.bargeIn,
          tts: { ...v.tts, provider: effectiveTtsProvider(v.tts.provider, deps.edition) },
          vad: { threshold: v.vadThreshold, minSpeechMs: v.minSpeechMs, minSilenceMs: v.minSilenceMs },
          wake: { enabled: v.wake.enabled, phrase: v.wake.phrase, sensitivity: v.wake.sensitivity },
          filter: {
            noiseGate: v.noiseGate,
            denoise: v.denoise,
            ownerOnly: { enabled: v.ownerOnly.enabled, minScore: v.ownerOnly.minScore, margin: v.ownerOnly.margin },
            profilePath: deps.profilePath ?? join(deps.modelsDir, '..', 'owner-voice.json')
          }
        }
      });
      if (window && !window.isDestroyed()) sendPort(c, window);
    });
    c.on('message', (raw: unknown) => {
      const parsed = voiceToMainSchema.safeParse(raw);
      if (parsed.success) deps.toCore(parsed.data.msg);
      else deps.log.warn('messaggio del processo voce non valido', { issues: formatIssues(parsed.error) });
    });
    c.stderr?.setEncoding('utf8');
    c.stderr?.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line.length > 0) deps.log.debug('voce', { line: line.slice(0, 500) });
    });
    c.once('exit', (code: number) => {
      child = null;
      deps.toCore({ type: 'process', phase: 'exited', pid: null, code: code ?? null, reason: restartAfterExit ? 'riavvio richiesto' : stopping ? 'arresto richiesto' : 'uscita del processo voce' });
      const again = restartAfterExit;
      restartAfterExit = false;
      if (again) spawn();
    });
  };

  return {
    start() {
      spawn();
    },
    attach(wc) {
      window = wc;
      if (child) sendPort(child, wc);
    },
    control(action) {
      if (action === 'start') {
        stopping = false;
        spawn();
        return;
      }
      if (action === 'stop') {
        stopping = true;
        restartAfterExit = false;
        child?.kill();
        return;
      }
      // restart: si riavvia solo dopo l'uscita, per non avere due processi voce insieme.
      restartAfterExit = true;
      if (child) child.kill();
      else {
        stopping = false;
        spawn();
      }
    },
    send(msg) {
      if (!child) return false;
      child.postMessage({ kind: 'core', msg });
      return true;
    },
    stop() {
      stopping = true;
      restartAfterExit = false;
      child?.kill();
      child = null;
      window = null;
    }
  };
}
