// Policy delle azioni (VISIONE_SECURITY_MODEL §2, DECISIONI P-39): classifica in modo deterministico
// ogni azione di un agente o del Director come consentita, con approvazione del proprietario o
// bloccata. Le regole sono una tabella ordinata e pura: nessun I/O, nessuna dipendenza dal motore
// (gli adapter traducono i propri strumenti in `ActionDescriptor`). Il contenuto prodotto da un
// agente non diventa mai un'autorizzazione: le autorizzazioni sono le approvazioni registrate.
import { isAbsolute, relative, resolve } from 'node:path';
import type { ActionClass, ActionDescriptorInput } from '../../shared/contracts/index.ts';

export type ActionDescriptor = ActionDescriptorInput;

export interface PolicyContext {
  readonly actor: 'owner' | 'director' | 'agent' | 'system';
  /** Radici in cui l'attore può leggere e scrivere senza conferma (workspace, cartella agente). */
  readonly roots: readonly string[];
  /**
   * Modalità fiducia (P-102): l'agente è stato messo in fiducia dal proprietario. Le azioni «con
   * approvazione» non critiche diventano consentite; i blocchi e i percorsi custoditi restano.
   */
  readonly trusted?: boolean;
}

export interface PolicyDecision {
  readonly class: ActionClass;
  readonly reason: string;
  /** Regola applicata, per l'audit e i test. */
  readonly rule: string;
}

export interface ActionPolicy {
  classify(action: ActionDescriptor, ctx: PolicyContext): PolicyDecision;
}

export interface ActionPolicyOptions {
  /** Cartelle mai scrivibili dall'interno di VISIONE (progetti di riferimento, sistema). */
  readonly protectedRoots?: readonly string[];
  /** Comandi shell consentiti senza conferma (build/test/lint del progetto). */
  readonly shellAllowlist?: readonly RegExp[];
  /** Host raggiungibili senza conferma. */
  readonly hostAllowlist?: readonly string[];
  /**
   * Percorsi custoditi (P-102): ciò che governa la policy stessa — configurazione, dati e shim di
   * VISIONE, impostazioni dei motori che caricano gli hook. Scriverli o cancellarli chiede SEMPRE
   * l'approvazione del proprietario (anche dentro le radici, anche in modalità fiducia), e in
   * fiducia un comando che li nomina non passa da solo.
   */
  readonly guardedRoots?: readonly string[];
  /** Forme di percorsi custoditi dichiarate dagli adapter (es. file di impostazioni di un motore). */
  readonly guardedPatterns?: readonly RegExp[];
  readonly platform?: NodeJS.Platform;
}

/** Bloccate sempre, qualunque approvazione (§2 "Bloccate sempre"). */
const BLOCKED_KINDS: ReadonlyMap<string, string> = new Map([
  ['credentials.read', 'lettura di archivi di credenziali'],
  ['credentials.write', 'scrittura di segreti'],
  ['purchase', 'acquisti'],
  ['subscription', 'iscrizione a servizi'],
  ['provider.activate', 'attivazione di provider a pagamento'],
  ['publish', 'pubblicazione'],
  ['system.settings', 'impostazioni di sistema o di sicurezza'],
  ['policy.disable', 'disattivazione della policy'],
  ['audit.disable', 'disattivazione dell\'audit']
]);

/** Con approvazione del proprietario (§2 "Con approvazione"). */
const APPROVAL_KINDS: ReadonlyMap<string, string> = new Map([
  ['agent.define', 'nuova definizione di agente'],
  ['engine.workspace.trust', 'fiducia del motore nella cartella di lavoro'],
  ['engine.transport.headless', 'trasporto headless del motore (fatturazione diversa)'],
  ['config.change', 'modifica della configurazione di VISIONE'],
  ['user.config.change', 'modifica di configurazioni globali dell\'utente'],
  ['package.install', 'installazione di pacchetti'],
  ['net.download', 'download'],
  ['instances.exceed', 'più istanze concorrenti del limite']
]);

/** File di credenziali, in forma generica (nessun motore citato). */
const CREDENTIAL_PATH = /(^|[\\/])(\.ssh|\.gnupg)([\\/]|$)|\.credentials|(^|[\\/])auth\.json$|(^|[\\/])\.env(\.[^\\/]*)?$|\.(pem|key|p12|pfx)$|(^|[\\/])id_(rsa|ed25519|ecdsa)/i;
const GIT_BLOCKED = /^\s*(push|remote\s+(add|set-url)|fetch|pull|clone)\b/i;
const GIT_ALLOWED = /^\s*(status|diff|log|add|commit|branch|stash|show|rev-parse|ls-files)\b/i;
const SHELL_BLOCKED = /\bgit\s+(push|remote\s+(add|set-url)|fetch|pull)\b|\brm\s+-[a-z]*r[a-z]*f?\s+[\\/](\s|$)|\bformat\s+[a-z]:|\breg(\.exe)?\s+(add|delete)\b|\bshutdown\b|\bRemove-Item\b[^|;]*-Recurse[^|;]*\s[a-z]:\\?(\s|$)|\bSet-MpPreference\b|\bbcdedit\b/i;
const SHELL_DOWNLOAD = /\b(curl|wget|Invoke-WebRequest|iwr|Start-BitsTransfer)\b/i;
const SHELL_INSTALL = /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip\d*\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b/i;
/**
 * Comandi composti (P-102): l'elenco dei consentiti guarda l'inizio di un comando, quindi una catena
 * (`a && b`, `a; b`, `a | b`) vale solo se OGNI pezzo è consentito da solo. Le redirezioni verso un
 * file sono scritture (approvazione); quelle innocue verso il nulla o tra canali si ignorano. I filtri
 * di sola lettura in coda a una pipe (`| tail`, `| grep`) non cambiano il verdetto.
 */
const CHAIN_SPLIT = /&&|\|\||[;|\n]/;
const HARMLESS_REDIRECT = /\d?>&\d|\d?>>?\s*(?:\/dev\/null|nul|\$null)(?=\s|$)/gi;
const SUBSHELL = /`|\$\(/;
const PIPE_FILTER = /^\s*(head|tail|grep|wc|sort|uniq|cut|findstr|more|Select-Object|Select-String|Measure-Object|Format-List|Format-Table|Out-String)\b/i;
const DEFAULT_SHELL_ALLOW: readonly RegExp[] = [
  /^\s*(npm|pnpm|yarn)\s+(test|run\s+[\w:-]+|run-script\s+[\w:-]+)(\s|$)/i,
  /^\s*npx\s+(tsc|vitest)\b/i,
  /^\s*git\s+(status|diff|log|add|commit|branch|stash|show)\b/i,
  /^\s*(dir|ls|type|cat|echo|pwd|cd)\b/i
];

/**
 * Regole «con approvazione» che la modalità fiducia (P-102) consente da sola: lavoro ordinario di uno
 * sviluppatore (comandi, rete, pacchetti, file fuori dalla propria cartella). Restano con
 * approvazione: definizioni di agente, configurazione, trasporti con fatturazione diversa, fiducia
 * del motore in una cartella, istanze oltre il limite, cancellazioni di massa, azioni sconosciute.
 */
const TRUST_PROMOTABLE: ReadonlySet<string> = new Set([
  'fs.read:outside', 'fs.write:outside', 'fs.delete:outside',
  'git:merge', 'git:other',
  'shell:install', 'shell:download', 'shell:other', 'shell:redirect', 'shell:subshell',
  'net:other',
  'kind:package.install', 'kind:net.download'
]);

export function createActionPolicy(opts: ActionPolicyOptions = {}): ActionPolicy {
  const win = (opts.platform ?? process.platform) === 'win32';
  const norm = (p: string): string => (win ? resolve(p).toLowerCase() : resolve(p));
  const inside = (path: string, roots: readonly string[]): boolean => {
    if (!isAbsolute(path)) return false;
    const target = norm(path);
    return roots.some((root) => {
      const rel = relative(norm(root), target);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
  };
  const systemRoots = win ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData\\Microsoft'] : ['/bin', '/sbin', '/usr', '/etc', '/boot', '/System'];
  const protectedRoots = [...systemRoots, ...(opts.protectedRoots ?? [])];
  const shellAllow = opts.shellAllowlist ?? DEFAULT_SHELL_ALLOW;
  const hosts = new Set((opts.hostAllowlist ?? []).map((h) => h.toLowerCase()));
  const guardedRoots = opts.guardedRoots ?? [];
  const guardedPatterns = opts.guardedPatterns ?? [];
  const isGuardedPath = (path: string): boolean => (isAbsolute(path) && inside(path, guardedRoots)) || guardedPatterns.some((re) => re.test(path));
  // Un comando che nomina un percorso custodito (in qualunque forma di separatore) non passa in fiducia.
  const slashes = (s: string): string => s.replaceAll('\\', '/').toLowerCase();
  const guardedText = guardedRoots.map(slashes);
  const mentionsGuarded = (text: string): boolean => {
    const t = slashes(text);
    return guardedText.some((root) => t.includes(root)) || guardedPatterns.some((re) => re.test(text) || re.test(t));
  };

  const decide = (cls: ActionClass, rule: string, reason: string): PolicyDecision => ({ class: cls, rule, reason: reason.slice(0, 500) });

  const classify = (action: ActionDescriptor, ctx: PolicyContext): PolicyDecision => {
    const verdict = classifyBase(action, ctx);
    if (!ctx.trusted || verdict.class !== 'approval' || !TRUST_PROMOTABLE.has(verdict.rule)) return verdict;
    const kind = action.kind;
    if ((kind === 'shell.exec' || kind === 'git') && mentionsGuarded(action.target)) {
      return decide('approval', `${verdict.rule}:guarded`, `modalità fiducia: il comando tocca dati, configurazione o hook di VISIONE: ${action.target}`);
    }
    return decide('allow', `${verdict.rule}:trusted`, `modalità fiducia: ${verdict.reason}`);
  };

  const gitVerdict = (target: string): PolicyDecision => {
    if (GIT_BLOCKED.test(target)) return decide('block', 'git:remote', `git verso remoti vietato: git ${target}`);
    if (/^\s*merge\b/i.test(target)) return decide('approval', 'git:merge', `merge: git ${target}`);
    return GIT_ALLOWED.test(target)
      ? decide('allow', 'git:local', 'git locale consentito')
      : decide('approval', 'git:other', `comando git non in elenco: git ${target}`);
  };
  const RANK: Record<ActionClass, number> = { allow: 0, approval: 1, block: 2 };
  const shellVerdict = (target: string): PolicyDecision => {
    if (SHELL_BLOCKED.test(target)) return decide('block', 'shell:blocked', `comando vietato: ${target}`);
    if (CREDENTIAL_PATH.test(target)) return decide('block', 'shell:credentials', `comando su file di credenziali: ${target}`);
    if (SHELL_INSTALL.test(target)) return decide('approval', 'shell:install', `installazione di pacchetti: ${target}`);
    if (SHELL_DOWNLOAD.test(target)) return decide('approval', 'shell:download', `download: ${target}`);
    if (SUBSHELL.test(target)) return decide('approval', 'shell:subshell', `comando con sottocomandi: ${target}`);
    const text = target.replace(HARMLESS_REDIRECT, '');
    if (/>/.test(text)) return decide('approval', 'shell:redirect', `redirezione verso un file (scrittura): ${target}`);
    const parts = text.split(CHAIN_SPLIT).map((p) => p.trim()).filter((p) => p !== '');
    let worst: PolicyDecision = decide('allow', 'shell:allowlist', 'comando in elenco');
    parts.forEach((part, i) => {
      const git = /^git\s+(.*)$/is.exec(part);
      const v = git ? gitVerdict(git[1] ?? '')
        : (i > 0 && PIPE_FILTER.test(part)) || shellAllow.some((re) => re.test(part))
          ? decide('allow', 'shell:allowlist', 'comando in elenco')
          : decide('approval', 'shell:other', `comando fuori elenco: ${target}`);
      if (RANK[v.class] > RANK[worst.class]) worst = v;
    });
    return worst;
  };

  // Classificazione di base (P-39): tabella ordinata, senza la modalità fiducia.
  const classifyBase = (action: ActionDescriptor, ctx: PolicyContext): PolicyDecision => {
    {
      const kind = action.kind;
      const target = action.target;
      const blocked = BLOCKED_KINDS.get(kind);
      if (blocked) return decide('block', `kind:${kind}`, `bloccata sempre: ${blocked}`);

      switch (kind) {
        case 'fs.read':
          if (CREDENTIAL_PATH.test(target)) return decide('block', 'fs.read:credentials', `lettura di un archivio di credenziali: ${target}`);
          return inside(target, ctx.roots)
            ? decide('allow', 'fs.read:roots', 'lettura nelle radici consentite')
            : decide('approval', 'fs.read:outside', `lettura fuori dalle radici dell'agente: ${target}`);
        case 'fs.write':
        case 'fs.delete': {
          if (!isAbsolute(target)) return decide('approval', `${kind}:relative`, `percorso non assoluto: ${target}`);
          if (/^[a-z]:\\?$|^\/$/i.test(target)) return decide('block', `${kind}:root`, `operazione sulla radice di un disco: ${target}`);
          if (inside(target, protectedRoots)) return decide('block', `${kind}:protected`, `cartella protetta: ${target}`);
          if (CREDENTIAL_PATH.test(target)) return decide('block', `${kind}:credentials`, `file di credenziali: ${target}`);
          // P-102: ciò che governa la policy (config, dati, shim, impostazioni degli hook dei motori)
          // non si cambia mai senza il proprietario, nemmeno dentro le radici dell'agente.
          if (isGuardedPath(target)) return decide('approval', `${kind}:guarded`, `percorso custodito da VISIONE (configurazione, dati o hook): ${target}`);
          if (kind === 'fs.delete') {
            const count = typeof action.detail?.count === 'number' ? action.detail.count : 1;
            if (action.detail?.recursive === true || count >= 5) return decide('approval', 'fs.delete:bulk', `cancellazione di ${action.detail?.recursive === true ? 'una cartella' : `${count} file`}`);
          }
          return inside(target, ctx.roots)
            ? decide('allow', `${kind}:roots`, 'nelle radici dell\'agente')
            : decide('approval', `${kind}:outside`, `fuori dalle radici dell'agente: ${target}`);
        }
        case 'git':
          // Un `git …` seguito da altri comandi è un comando composto: si valuta pezzo per pezzo.
          if (CHAIN_SPLIT.test(target) || SUBSHELL.test(target) || />/.test(target.replace(HARMLESS_REDIRECT, ''))) return shellVerdict(`git ${target}`);
          return gitVerdict(target);
        case 'shell.exec':
          return shellVerdict(target);
        case 'net.connect':
          return hosts.has(target.toLowerCase())
            ? decide('allow', 'net:allowlist', 'host in elenco')
            : decide('approval', 'net:other', `rete verso host non in elenco: ${target}`);
        case 'message.send': {
          const hops = typeof action.detail?.hops === 'number' ? action.detail.hops : 0;
          return hops > 12 ? decide('block', 'message:hops', `troppi passaggi (${hops})`) : decide('allow', 'message:hops', 'messaggio entro i limiti');
        }
        default: {
          const approval = APPROVAL_KINDS.get(kind);
          if (approval) {
            // Il proprietario decide da sé: le sue azioni non chiedono a sé stesso, tranne le
            // conferme che il motore stesso pretende (fiducia nella cartella).
            if (ctx.actor === 'owner' && kind !== 'engine.workspace.trust') return decide('allow', `kind:${kind}:owner`, 'azione del proprietario');
            return decide('approval', `kind:${kind}`, `richiede approvazione: ${approval}`);
          }
          // Sconosciuta: si chiede al proprietario (mai consentita in silenzio).
          return decide('approval', 'kind:unknown', `azione non classificata: ${kind}`);
        }
      }
    }
  };

  return { classify };
}
