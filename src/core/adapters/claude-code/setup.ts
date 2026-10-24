// Requisiti di Claude Code per la procedura guidata (P-105): la CLI installata e l'accesso fatto con
// l'account Claude dell'utente. L'accesso si legge da `claude auth status --json` (campo `loggedIn`,
// misurato il 07/10/2026 con Claude Code 2.1.293): di quell'uscita si tengono solo `loggedIn`,
// `authMethod` e `subscriptionType`; email e organizzazione non vengono né salvate né mostrate.
// VISIONE non vede mai le credenziali: il login lo fa l'utente nel browser.
import type { AdapterSetupItem } from '../index.ts';
import { versionNumber } from '../probe-command.ts';

export interface ClaudeAuthState {
  readonly loggedIn: boolean;
  readonly method: string | null;
  readonly plan: string | null;
}

/** Solo i tre campi che servono; tutto il resto dell'uscita si scarta. Null = uscita illeggibile. */
export function parseAuthStatus(stdout: string): ClaudeAuthState | null {
  try {
    const raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof raw.loggedIn !== 'boolean') return null;
    const text = (v: unknown): string | null => (typeof v === 'string' && /^[\w .:-]{1,40}$/.test(v) ? v : null);
    return { loggedIn: raw.loggedIn, method: text(raw.authMethod), plan: text(raw.subscriptionType) };
  } catch {
    return null;
  }
}

export interface ClaudeSetupInput {
  readonly cli: { readonly found: true; readonly version: string | null; readonly exe?: string } | { readonly found: false; readonly problem: string };
  /** Null = non verificabile (CLI assente o uscita illeggibile). */
  readonly auth: ClaudeAuthState | null;
}

// Claude Code interattivo, non `auth login` (18/10/2026): anche la prima configurazione (tema, note di sicurezza),
// che `auth login` non segna e che altrimenti ferma ogni agente sulla scelta del tema.
const LOGIN_STEPS = [
  'Premi «Accedi»: nel terminale di VISIONE si apre Claude Code.',
  'Scegli il tema con le frecce e premi Invio. Poi scegli «Claude account with subscription» (piano Pro o Max) e premi Invio: si apre il browser.',
  'Accedi nel browser. Se il terminale chiede un codice («Paste code here»), copialo dalla pagina e incollalo nel terminale con Ctrl+V, poi Invio.',
  'Premi Invio a «Login successful» e alle note di sicurezza; se chiede di fidarti della cartella, scegli «Yes».',
  'Quando compare il campo per scrivere, chiudi il terminale e premi «Ricontrolla».'
];

/** Installatore ufficiale di Claude Code (nessun permesso di amministratore: si installa nell'utente). */
// Apostrofo raddoppiato: dentro le virgolette semplici di PowerShell `''` è un apostrofo (prima «l installatore»).
export const CLAUDE_INSTALL = "Step 'Scarico e avvio l''installatore ufficiale di Claude Code (claude.ai)' { irm https://claude.ai/install.ps1 | iex }";

export function claudeSetupItems(input: ClaudeSetupInput): AdapterSetupItem[] {
  if (!input.cli.found) {
    return [
      {
        id: 'installato',
        label: 'Claude Code installato',
        ok: false,
        optional: false,
        detail: `non trovato (${input.cli.problem})`,
        steps: [
          'Apri PowerShell (tasto Windows, scrivi «PowerShell», Invio).',
          'Incolla il comando qui sotto e premi Invio: è l\'installatore ufficiale di Anthropic.',
          'Al termine chiudi PowerShell, torna qui e premi «Ricontrolla».'
        ],
        commands: ['irm https://claude.ai/install.ps1 | iex'],
        link: 'https://code.claude.com/docs/en/setup',
        // «Installa» (17/10/2026): lo stesso installatore ufficiale, nel terminale di VISIONE.
        action: { kind: 'install', source: "l'installatore ufficiale di Anthropic (claude.ai)", admin: false, script: CLAUDE_INSTALL }
      },
      // Senza Claude Code l'accesso non si può ancora fare: niente passi da leggere, solo cosa viene prima.
      { id: 'accesso', label: 'Accesso a Claude', ok: false, optional: false, detail: 'prima installa Claude Code (tasto «Installa» qui sopra)', steps: [], commands: [] }
    ];
  }
  const installed: AdapterSetupItem = { id: 'installato', label: 'Claude Code installato', ok: true, optional: false, detail: `installato, versione ${versionNumber(input.cli.version)}`, steps: [], commands: [] };
  const auth = input.auth;
  const access: AdapterSetupItem = auth?.loggedIn
    ? { id: 'accesso', label: 'Accesso a Claude', ok: true, optional: false, detail: `accesso fatto${auth.method ? ` (${auth.method}` : ''}${auth.plan ? `, piano ${auth.plan}` : ''}${auth.method ? ')' : ''}`, steps: [], commands: [] }
    : {
        id: 'accesso',
        label: 'Accesso a Claude',
        ok: false,
        optional: false,
        detail: auth ? 'accesso non fatto' : 'stato dell\'accesso non leggibile: fai l\'accesso per sicurezza',
        steps: LOGIN_STEPS,
        // Il percorso vero: su un PC nuovo l'installatore non mette Claude Code nel PATH (lo dice lui stesso).
        commands: [input.cli.found && input.cli.exe ? `& "${input.cli.exe}"` : 'claude'],
        action: { kind: 'login-terminal', args: [] }
      };
  return [installed, access];
}
