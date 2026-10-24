// Modelli voce scaricati dall'app su consenso (P-105): stesso procedimento di `tools/voice-models.mjs`
// (dimensione e SHA-256 contro il manifest, archivi estratti con il tar.exe di Windows), ma come
// libreria con avanzamento e annullamento, per la procedura guidata dell'app installata. Il file si
// scrive in `.part` e diventa definitivo solo dopo la verifica: un download interrotto non lascia un
// modello rotto al posto giusto.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import manifest from '../voice-models.json' with { type: 'json' };

export type VoiceModelRole = 'vad' | 'stt' | 'tts' | 'speaker' | 'denoise';

export interface VoiceModel {
  readonly id: string;
  readonly role: VoiceModelRole;
  readonly url: string;
  readonly archive: boolean;
  readonly dir: string;
  readonly size: number;
  readonly sha256: string;
  readonly license: string;
  readonly files: readonly string[];
  /**
   * Dall'archivio si estraggono solo `files` (VM beta.30, 23/10/2026: whisper-small porta anche i modelli a 32 bit e i
   * wav di prova, ~1,6 GB di disco in più e minuti di scrittura su un PC lento). Non per Kokoro, che usa cartelle intere.
   */
  readonly extractOnly?: boolean;
  /**
   * Riserva: si usa se c'è, ma non si scarica (24/10/2026: whisper-small dopo Parakeet, che lo supera — misurato qui su
   * 100 frasi, 97,2% di parole giuste contro 91,5%, in 0,37 s invece di 1,8).
   */
  readonly optional?: boolean;
  /** Architettura del modello STT: Whisper (predefinita) o transducer NeMo (Parakeet). */
  readonly kind?: 'whisper' | 'nemo-transducer';
}

export const VOICE_MODELS: readonly VoiceModel[] = manifest.models as VoiceModel[];

/** Modelli dei ruoli indicati con almeno un file assente nella cartella. */
export function missingVoiceModels(modelsDir: string, roles: readonly VoiceModelRole[], models: readonly VoiceModel[] = VOICE_MODELS): VoiceModel[] {
  return models.filter((m) => roles.includes(m.role) && !m.optional && !m.files.every((f) => existsSync(join(modelsDir, m.dir, f))));
}

export type DownloadPhase = 'download' | 'verifica' | 'estrazione' | 'fatto';

export interface DownloadDeps {
  readonly fetch?: typeof fetch;
  /** Estrae un .tar.bz2 nella cartella (solo `only`, se dati): codice d'uscita. Nel prodotto il tar.exe di Windows. */
  readonly extract?: (archive: string, intoDir: string, only: readonly string[] | null) => Promise<number>;
  readonly onProgress?: (phase: DownloadPhase, received: number, total: number) => void;
  readonly signal?: AbortSignal;
}

const windowsTar = (archive: string, intoDir: string, only: readonly string[] | null): Promise<number> =>
  new Promise((resolve) => {
    // Percorso esplicito: un altro tar nel PATH (es. quello GNU di Git) scambierebbe «C:» per un host.
    const exe = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    // `--include */nome`: il file nella cartella dell'archivio; uno assente fa uscire il tar con errore.
    const include = (only ?? []).flatMap((f) => ['--include', `*/${f}`]);
    const child = spawn(exe, ['-xjf', archive, '-C', intoDir, ...include], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Ciò che serve per scaricare e verificare un file: lo usa anche il modello offline (17/10/2026). */
export type DownloadableModel = Pick<VoiceModel, 'id' | 'url' | 'archive' | 'dir' | 'size' | 'sha256' | 'files' | 'extractOnly'>;

/** Scarica, verifica e installa un modello; lancia con un motivo in italiano se qualcosa non torna. */
export async function installVoiceModel(m: DownloadableModel, modelsDir: string, deps: DownloadDeps = {}): Promise<void> {
  const target = join(modelsDir, m.archive ? `${m.dir}.download` : join(m.dir, m.files[0]!));
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.part`;
  // Archivio completo rimasto da un tentativo precedente: si riverifica senza riscaricarlo.
  if (existsSync(target) && statSync(target).size === m.size) renameSync(target, part);
  let sha256: string;
  if (existsSync(part) && statSync(part).size === m.size) {
    deps.onProgress?.('verifica', m.size, m.size);
    sha256 = await hashFile(part);
  } else {
    const res = await (deps.fetch ?? fetch)(m.url, { redirect: 'follow', ...(deps.signal ? { signal: deps.signal } : {}) });
    if (!res.ok || !res.body) throw new Error(`${m.id}: download non riuscito (HTTP ${res.status})`);
    const hash = createHash('sha256');
    const out = createWriteStream(part);
    let bytes = 0;
    let shown = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        bytes += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (bytes - shown >= 2 * 1_048_576 || bytes === m.size) {
          shown = bytes;
          deps.onProgress?.('download', bytes, m.size);
        }
      }
    } finally {
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    }
    if (bytes !== m.size) {
      rmSync(part, { force: true });
      throw new Error(`${m.id}: scaricati ${bytes} byte invece di ${m.size}: riprova`);
    }
    deps.onProgress?.('verifica', bytes, m.size);
    sha256 = hash.digest('hex');
  }
  if (sha256 !== m.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${m.id}: impronta SHA-256 diversa da quella attesa (file scartato): riprova`);
  }
  renameSync(part, target);
  if (m.archive) {
    deps.onProgress?.('estrazione', m.size, m.size);
    const code = await (deps.extract ?? windowsTar)(target, modelsDir, m.extractOnly ? m.files : null);
    if (code !== 0) throw new Error(`${m.id}: estrazione non riuscita (tar ${code})`);
    rmSync(target, { force: true });
    const absent = m.files.filter((f) => !existsSync(join(modelsDir, m.dir, f)));
    if (absent.length > 0) throw new Error(`${m.id}: dopo l'estrazione mancano ${absent.join(', ')}`);
  }
  deps.onProgress?.('fatto', m.size, m.size);
}
