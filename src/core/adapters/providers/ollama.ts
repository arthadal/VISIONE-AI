// Ollama (modelli locali, facoltativo): indirizzo, stato e installazione guidata. Condivisi fra OpenCode
// e il motore integrato (piano MOTORE_INTEGRATO_PIANO §6): spostati da `opencode/setup.ts`, che li riesporta.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const OLLAMA_URL = 'http://127.0.0.1:11434';

export interface OllamaState {
  readonly running: boolean;
  readonly models: readonly string[];
}

/**
 * Ollama (facoltativo): installato con winget se manca, acceso se spento, poi il modello consigliato.
 * `Step` e `Update-VisionePath` li dà il core.
 */
export const OLLAMA_INSTALL = [
  "if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {",
  "  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'manca winget (Programma di installazione app di Microsoft): scarica Ollama dal sito ufficiale, poi premi Ricontrolla' }",
  "  Step 'Installo Ollama (winget). Se Windows chiede il permesso, premi Si.' { winget install --id Ollama.Ollama -e --source winget --accept-source-agreements --accept-package-agreements }",
  "  Update-VisionePath",
  "}",
  "$up = $false",
  "for ($i = 0; $i -lt 30 -and -not $up; $i++) {",
  "  try { Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; $up = $true }",
  "  catch { if ($i -eq 3) { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden }; Start-Sleep -Seconds 1 }",
  "}",
  "if (-not $up) { throw 'Ollama non si accende: avvialo dal menu Start, poi premi di nuovo Installa' }",
  "Step 'Scarico il modello qwen2.5-coder:7b (circa 5 GB, qualche minuto)' { ollama pull qwen2.5-coder:7b }"
].join('\n');

/**
 * Grafica integrata (22/10/2026). Ollama scarta le schede integrate se non trova `OLLAMA_IGPU_ENABLE` («dropping
 * integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1») e lavora solo col processore. Sul PC del proprietario (Intel
 * Arc) la stessa domanda da 4.683 token: 147-155 s col processore, 40 s con la grafica (lettura 140 contro 33,6 token/s).
 * Si propone, facoltativa: decide chi usa il PC, con un clic.
 */
export const OLLAMA_IGPU_ENV = 'OLLAMA_IGPU_ENABLE';

/** Il nome della scheda integrata che Ollama ha scartato all'ultimo avvio, e quella che usa; dal suo registro. */
export function ollamaIgpuFromLog(log: string): { readonly dropped: string | null; readonly inUse: string | null } {
  const start = log.lastIndexOf('msg="Listening on');
  const tail = start >= 0 ? log.slice(start) : log;
  const dropped = /dropping integrated GPU[^\n]*?description="([^"]+)"/.exec(tail)?.[1] ?? null;
  const inUse = /msg="inference compute"[^\n]*?description="([^"]+)"[^\n]*?type=iGPU/.exec(tail)?.[1] ?? null;
  return { dropped, inUse };
}

/**
 * L'inizio del registro di Ollama (`%LOCALAPPDATA%\Ollama\server.log`); vuoto se non c'è. Ollama ne apre uno nuovo a
 * ogni avvio e la scelta delle schede sta nelle prime righe: in coda, dopo giorni di lavoro, non c'è più (326 KB il
 * 22/10/2026 sul PC del proprietario, acceso dal 17/10).
 */
export function readOllamaLog(env: Readonly<Record<string, string | undefined>> = process.env, maxBytes = 64 * 1024): string {
  if (!env.LOCALAPPDATA) return '';
  try {
    const file = join(env.LOCALAPPDATA, 'Ollama', 'server.log');
    const fd = openSync(file, 'r');
    try {
      const length = Math.min(statSync(file).size, maxBytes);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, 0);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Attiva la grafica integrata per Ollama (variabile dell'utente) e lo riavvia. `Step` lo dà il core. */
export const OLLAMA_IGPU_SCRIPT = [
  `Step 'Attivo la grafica integrata per Ollama (${OLLAMA_IGPU_ENV}=1 nel tuo utente)' { [Environment]::SetEnvironmentVariable('${OLLAMA_IGPU_ENV}', '1', 'User') }`,
  `$env:${OLLAMA_IGPU_ENV} = '1'`,
  "Step 'Riavvio Ollama' {",
  "  Get-Process -Name 'ollama app', 'ollama' -ErrorAction SilentlyContinue | Stop-Process -Force",
  '  Start-Sleep -Seconds 2',
  "  $app = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama app.exe'",
  "  if (Test-Path $app) { Start-Process $app } else { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden }",
  '}',
  '$up = $false',
  'for ($i = 0; $i -lt 30 -and -not $up; $i++) {',
  "  try { Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; $up = $true } catch { Start-Sleep -Seconds 1 }",
  '}',
  "if (-not $up) { throw 'Ollama non si riaccende: avvialo dal menu Start, poi premi Ricontrolla' }"
].join('\n');

/** Prefisso dei modelli che VISIONE deriva per gli agenti (`ollamaAgentModel`): non si mostrano nei menu. */
export const OLLAMA_DERIVED_PREFIX = 'visione/';

/**
 * Ollama acceso e i suoi modelli di chat (`/api/tags`, solo loopback), dal più leggero: su un PC senza scheda video
 * il primo è quello che la squadra prende quando nessun modello è consigliato (21/10/2026 prendeva un 16b da 8,9 GB
 * prima del 7b). Fuori i modelli d'appoggio (embedding) e quelli derivati da VISIONE.
 */
export async function readOllama(fetchImpl: typeof fetch = fetch, timeoutMs = 1_500): Promise<OllamaState> {
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { running: true, models: [] };
    const body = (await res.json()) as { models?: Array<{ name?: unknown; size?: unknown }> };
    const models = (body.models ?? [])
      .filter((m): m is { name: string; size?: unknown } => typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 120)
      .filter((m) => !m.name.startsWith(OLLAMA_DERIVED_PREFIX) && !/embed|rerank/i.test(m.name))
      .sort((a, b) => (typeof a.size === 'number' ? a.size : Infinity) - (typeof b.size === 'number' ? b.size : Infinity))
      .map((m) => m.name);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

/** Contesto per gli agenti locali: il prompt di OpenCode è ~4.300 token già ridotto, ~8.000 intero (22/10/2026). */
export const OLLAMA_AGENT_CONTEXT = 16_384;

export function derivedModelName(base: string): string {
  const i = base.lastIndexOf(':');
  const name = i > 0 ? base.slice(0, i) : base;
  const tag = i > 0 ? base.slice(i + 1) : 'latest';
  return `${OLLAMA_DERIVED_PREFIX}${name.replace(/\//g, '-')}:${tag}-ctx${OLLAMA_AGENT_CONTEXT / 1024}k`;
}

const derived = new Map<string, { readonly at: number; readonly name: Promise<string> }>();
// Breve: se l'utente cancella il modello derivato da Ollama, al turno dopo si ricrea (0,36 s, nessun download).
const DERIVED_TTL_MS = 60_000;

/**
 * Il modello Ollama da dare a un agente. L'API compatibile OpenAI di Ollama, quella che usa OpenCode, ignora
 * `num_ctx` (misurato il 22/10/2026 con Ollama 0.40.5: 4096 con e senza `options`, 16384 solo dall'API nativa) e
 * taglia il prompt di OpenCode: il modello perde le istruzioni e risponde vuoto o a caso. Si crea quindi una volta
 * un modello derivato con il contesto giusto (`/api/create` con `from` e `parameters`: 0,36 s, nessun download, gli
 * stessi file del modello scelto). Se il modello ha già abbastanza contesto, o Ollama non sa crearlo, si usa
 * quello scelto: l'agente funziona come prima.
 */
export function ollamaAgentModel(base: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const hit = derived.get(base);
  if (hit && now - hit.at < DERIVED_TTL_MS) return hit.name;
  const name = makeDerived(base, fetchImpl);
  derived.set(base, { at: now, name });
  // Un errore (Ollama spento, versione vecchia) non resta in memoria: al turno dopo si riprova.
  void name.then((n) => { if (n === base) derived.delete(base); });
  return name;
}

/** Solo per i test: dimentica i modelli derivati già pronti. */
export function forgetOllamaDerived(): void {
  derived.clear();
}

async function makeDerived(base: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const show = await fetchImpl(`${OLLAMA_URL}/api/show`, { method: 'POST', body: JSON.stringify({ model: base }), signal: AbortSignal.timeout(10_000) });
    if (!show.ok) return base;
    const info = (await show.json()) as { parameters?: unknown; model_info?: Record<string, unknown> };
    const current = typeof info.parameters === 'string' ? Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(info.parameters)?.[1] ?? 0) : 0;
    if (current >= OLLAMA_AGENT_CONTEXT) return base;
    // Mai oltre il contesto con cui il modello è stato addestrato.
    const trained = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1];
    const ctx = typeof trained === 'number' && trained > 0 ? Math.min(OLLAMA_AGENT_CONTEXT, trained) : OLLAMA_AGENT_CONTEXT;
    if (ctx <= Math.max(current, 4_096)) return base;
    const name = derivedModelName(base);
    const res = await fetchImpl(`${OLLAMA_URL}/api/create`, { method: 'POST', body: JSON.stringify({ model: name, from: base, parameters: { num_ctx: ctx }, stream: false }), signal: AbortSignal.timeout(60_000) });
    const body = (await res.json().catch(() => ({}))) as { status?: unknown };
    return res.ok && body.status === 'success' ? name : base;
  } catch {
    return base;
  }
}
