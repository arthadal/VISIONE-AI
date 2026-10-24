// NVIDIA NIM: chiave, verifica, catalogo pubblico e modelli consigliati. Condivisi fra OpenCode e il
// motore integrato (piano MOTORE_INTEGRATO_PIANO §6): spostati da `opencode/setup.ts`, che li riesporta.
// La chiave si verifica con una chiamata che non consuma crediti (elenco delle funzioni NVCF: 200 con
// chiave valida, 401 senza, 403 con chiave rifiutata — misurato il 07/10/2026).
import { createHash } from 'node:crypto';
import type { AdapterKeyCheck } from '../index.ts';

export const NVIDIA_KEY_ENV = 'NVIDIA_API_KEY';
export const NVIDIA_KEY_CHECK_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/functions';

/** Una chiave con la forma di quelle NVIDIA: senza, nessuna richiesta parte (i test usano valori fittizi). */
export const isNvidiaKey = (key: string): boolean => /^nvapi-[A-Za-z0-9_-]{20,}$/.test(key.trim());

/** Verifica della chiave presso NVIDIA. Il valore passa solo nell'intestazione della richiesta. */
export async function checkNvidiaKey(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<AdapterKeyCheck> {
  if (!isNvidiaKey(key)) return { ok: false, detail: 'la chiave non ha la forma di una chiave NVIDIA (deve iniziare con «nvapi-»)' };
  try {
    const res = await fetchImpl(NVIDIA_KEY_CHECK_URL, { headers: { Authorization: `Bearer ${key.trim()}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 200) return { ok: true, detail: 'chiave valida: NVIDIA l\'ha accettata' };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `chiave rifiutata da NVIDIA (HTTP ${res.status}): ricopiala da build.nvidia.com` };
    return { ok: false, detail: `NVIDIA ha risposto HTTP ${res.status}: riprova tra poco` };
  } catch (err) {
    return { ok: false, detail: `NVIDIA non raggiungibile (${err instanceof Error ? err.message : String(err)}): controlla la connessione` };
  }
}

export const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';
/**
 * Candidati per la squadra, in ordine di preferenza per ruolo: in cima al menu e unico elenco se il catalogo
 * non risponde. Una lista fissa di «consigliati» non regge: lo stesso modello risponde per un account e dà 404
 * per un altro, e cambia nel tempo (17/10/2026 Ultra 550B muto per 90 s, Super 120B in 0,6 s; 21/10/2026 con la
 * chiave del proprietario Super 120B «Function not found for account», GPT-OSS 20B muto per 30 s, Ultra 550B in
 * 1,6 s, Lightning 30B in 0,8 s). Per questo con la chiave si provano tutti (`probeNvidiaModel`) e si consigliano
 * solo quelli che rispondono. I primi due per ruolo sono passati dal percorso vero di VISIONE (turno, ripresa
 * della sessione, strumento di lettura); gli altri seguono nell'ordine e servono quando quelli non rispondono.
 */
export const NVIDIA_CANDIDATES: ReadonlyArray<{ readonly id: string; readonly name: string; readonly role: 'code' | 'research' }> = [
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', role: 'code' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', role: 'code' },
  { id: 'stepfun-ai/step-5-preview', name: 'Step 5 Preview', role: 'code' },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', role: 'code' },
  { id: 'z-ai/glm-5.3', name: 'GLM 5.3', role: 'code' },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B', role: 'research' },
  { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', role: 'research' },
  { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', role: 'research' },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', role: 'research' }
];

export const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
/** Esito della prova di un modello: `ms` è il tempo della risposta, `detail` il motivo se non risponde. */
export interface NvidiaProbe { readonly ok: boolean; readonly ms: number; readonly detail: string }

const PROBE_TTL_MS = 10 * 60_000;
const probes = new Map<string, { readonly at: number; readonly result: Promise<NvidiaProbe> }>();
const fingerprint = (key: string): string => createHash('sha256').update(key.trim()).digest('hex').slice(0, 16);

/**
 * Prova vera di un modello con la chiave dell'utente: una domanda di due parole, al massimo 16 token di risposta
 * (pochi centesimi di credito). Per chiave e modello l'esito vale 10 minuti; un rifiuto per troppe richieste o un
 * errore di rete non resta in memoria. Il valore della chiave passa solo nell'intestazione e non è conservato.
 */
export function probeNvidiaModel(key: string, id: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000, now = Date.now()): Promise<NvidiaProbe> {
  const cacheKey = `${fingerprint(key)}|${id}`;
  const hit = probes.get(cacheKey);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.result;
  const result = probeOnce(key, id, fetchImpl, timeoutMs);
  probes.set(cacheKey, { at: now, result });
  void result.then((r) => { if (!r.ok && /HTTP 429|non raggiungibile/.test(r.detail)) probes.delete(cacheKey); });
  return result;
}

/** Tutti i candidati insieme: il tempo è quello del più lento, al massimo `timeoutMs`. */
export async function probeNvidiaCandidates(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<Map<string, NvidiaProbe>> {
  const results = await Promise.all(NVIDIA_CANDIDATES.map(async (c) => [c.id, await probeNvidiaModel(key, c.id, fetchImpl, timeoutMs)] as const));
  return new Map(results);
}

/** Solo per i test: dimentica gli esiti delle prove. */
export function forgetNvidiaProbes(): void {
  probes.clear();
}

/**
 * Modelli per i testi brevi fuori dai turni (la battuta del saluto), dal più rapido. Misurati il 22/10/2026 con
 * `enable_thinking: false`: Lightning 30B dice la prima frase in 0,4-0,7 s, Ultra 550B in 0,9-2,4 s. Step 5 no:
 * col ragionamento spento lo scrive nella risposta.
 */
export const NVIDIA_QUICK_MODELS: readonly string[] = ['nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3-ultra-550b-a55b'];

/**
 * Un testo breve senza ragionamento (senza, questi modelli spendono tutti i token a «pensare» e non rispondono):
 * il primo modello che risponde entro il tempo, altrimenti null. La chiave passa solo nell'intestazione.
 */
export async function nvidiaQuickText(key: string, ask: { system: string; user: string; maxTokens: number; prefer?: 'speed' | 'quality' }, fetchImpl: typeof fetch = fetch, timeoutMs = 4_000): Promise<string | null> {
  if (!isNvidiaKey(key)) return null;
  const deadline = Date.now() + timeoutMs;
  // «quality»: prima il modello grande (la battuta del saluto, che aspetta comunque la voce), poi il rapido.
  const order = ask.prefer === 'quality' ? [...NVIDIA_QUICK_MODELS].reverse() : NVIDIA_QUICK_MODELS;
  for (const model of order) {
    const left = deadline - Date.now();
    if (left < 300) return null;
    try {
      const res = await fetchImpl(NVIDIA_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model, stream: false, max_tokens: ask.maxTokens, temperature: 0.9, top_p: 0.95,
          chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: 'system', content: ask.system }, { role: 'user', content: ask.user }]
        }),
        signal: AbortSignal.timeout(left)
      });
      const body = await res.text().catch(() => '');
      if (!res.ok) continue;
      const text = (JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch {
      // Tempo scaduto o rete assente: si prova il prossimo finché c'è tempo.
    }
  }
  return null;
}

async function probeOnce(key: string, id: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<NvidiaProbe> {
  if (!isNvidiaKey(key)) return { ok: false, ms: 0, detail: 'chiave NVIDIA assente o non valida' };
  const t0 = Date.now();
  try {
    const res = await fetchImpl(NVIDIA_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Rispondi: ok' }], max_tokens: 16, stream: false }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const ms = Date.now() - t0;
    // Il corpo si legge comunque: una risposta lasciata a metà tiene aperta la connessione.
    await res.text().catch(() => '');
    if (res.ok) return { ok: true, ms, detail: 'risponde' };
    if (res.status === 404) return { ok: false, ms, detail: 'non disponibile per il tuo account NVIDIA (HTTP 404)' };
    if (res.status === 401 || res.status === 403) return { ok: false, ms, detail: `chiave rifiutata da NVIDIA (HTTP ${res.status})` };
    if (res.status === 429) return { ok: false, ms, detail: 'NVIDIA rifiuta per troppe richieste (HTTP 429): riprova tra poco' };
    return { ok: false, ms, detail: `NVIDIA ha risposto HTTP ${res.status}` };
  } catch (err) {
    const ms = Date.now() - t0;
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, ms, detail: `nessuna risposta in ${Math.round(timeoutMs / 1000)} s` };
    return { ok: false, ms, detail: `NVIDIA non raggiungibile (${err instanceof Error ? err.message : String(err)})`.slice(0, 200) };
  }
}
/** Modelli del catalogo che non sono assistenti di chat (embedding, filtri, visione, voce…). */
export const NOT_CHAT = /embed|rerank|safety|guard|clip|retriever|parse|ocr|reward|translat|asr|tts|riva|bge|vila|deplot|kosmos|paligemma|neva|fuyu|grounding|detect|pii|topic-control|jailbreak|content|vision|-vl\b|cosmos|flux|stable|sdxl|audio|whisper/i;

/** Identificativi del catalogo pubblico NVIDIA (nessuna chiave); null se non risponde. */
export async function readNvidiaCatalog(fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): Promise<string[] | null> {
  try {
    const res = await fetchImpl(NVIDIA_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length <= 160);
  } catch {
    return null;
  }
}
