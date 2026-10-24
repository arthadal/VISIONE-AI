// Redazione delle forme note di segreto prima di ogni scrittura (log, journal, eventi).
// Funzioni pure, senza dipendenze: usate da main e core.

export const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bnvapi-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi
];

// NOME_KEY=valore, NOME_TOKEN: valore, … → il nome resta, il valore sparisce.
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD))(\s*[=:]\s*)(["']?)[^\s"']{4,}\3/gi;

// Chiavi di oggetto il cui valore non va mai scritto, qualunque forma abbia.
const SENSITIVE_KEY = /(?:api[-_]?key|secret|password|passwd|token|authorization|credential|cookie)/i;

export function redactString(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
}

export function containsSecret(text: string): boolean {
  return redactString(text) !== text;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Copia profonda con i segreti redatti. Gestisce cicli, Error e profondità eccessive;
 * non modifica l'input.
 */
export function redactValue(value: unknown, maxDepth = 8): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    if (depth >= maxDepth) return '[MaxDepth]';
    seen.add(v);
    if (v instanceof Error) {
      return { name: v.name, message: redactString(v.message), stack: v.stack ? redactString(v.stack) : undefined };
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) {
      // Solo i valori testuali: un conteggio (`inputTokens: 8838`) non è una credenziale.
      out[k] = isSensitiveKey(k) && typeof item === 'string' ? REDACTED : walk(item, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
