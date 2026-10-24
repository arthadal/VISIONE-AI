// Finestre di VISIONE chiamate per nome (17/10/2026): «apri le impostazioni», «aprimi l'addestramento»,
// «open settings». Prima «apri X» cercava solo un agente chiamato X: «apri le impostazioni» rispondeva
// «nessun agente corrisponde». Lo usano la voce (renderer) e la modalità offline (core).
export type NamedWindow = 'settings' | 'training' | 'files' | 'apps' | 'browser' | 'system' | 'errors' | 'approvals' | 'memory' | 'director';

const NAMES: ReadonlyMap<string, NamedWindow> = new Map<string, NamedWindow>([
  ['impostazioni', 'settings'], ['settings', 'settings'], ['preferenze', 'settings'], ['opzioni', 'settings'],
  ['addestramento', 'training'], ['training', 'training'],
  ['esplora', 'files'], ['esplora risorse', 'files'], ['explorer', 'files'], ['file', 'files'], ['files', 'files'], ['documenti', 'files'], ['cartelle', 'files'],
  ['app', 'apps'], ['applicazioni', 'apps'], ['apps', 'apps'], ['applications', 'apps'], ['programmi', 'apps'], ['programs', 'apps'],
  ['browser', 'browser'], ['navigatore', 'browser'],
  ['sistema', 'system'], ['system', 'system'], ['controllo del pc', 'system'], ['pc', 'system'],
  ['errori', 'errors'], ['errors', 'errors'],
  ['approvazioni', 'approvals'], ['approvals', 'approvals'],
  ['memoria', 'memory'], ['memory', 'memory'],
  ['director', 'director'], ['direttore', 'director']
]);

/** Minuscole, senza accenti né punteggiatura, senza articoli e possessivi in testa. */
export function normalizeTarget(text: string): string {
  let t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    // Gli articoli vogliono lo spazio dopo («i» non deve mangiare la «i» di «impostazioni»); «l'» no.
    const next = t.replace(/^(?:(?:il|lo|la|i|gli|le|un|una|the|my|a|mio|mia|miei|mie)\s+|l'\s*)/, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

const LABELS: Readonly<Record<NamedWindow, readonly [it: string, en: string]>> = {
  settings: ['le Impostazioni', 'Settings'], training: ["l'Addestramento", 'Training'], files: ['Esplora', 'Files'],
  apps: ['le App', 'Apps'], browser: ['il Browser', 'the Browser'], system: ['il Sistema', 'System'],
  errors: ['gli Errori', 'Errors'], approvals: ['le Approvazioni', 'Approvals'], memory: ['la Memoria', 'Memory'],
  director: ['il Director', 'the Director']
};

/** Come si chiama la finestra in una frase («Apro le Impostazioni.»). */
export function windowLabel(kind: NamedWindow, language: 'it' | 'en'): string {
  return LABELS[kind][language === 'en' ? 1 : 0];
}

/** Il tipo di finestra, se il testo lo è già (bersaglio di `open-window`), o null. */
export function asNamedWindow(value: string | null): NamedWindow | null {
  return value !== null && Object.hasOwn(LABELS, value) ? (value as NamedWindow) : null;
}

/** La finestra di VISIONE con quel nome, o null. */
export function windowByName(target: string | null): NamedWindow | null {
  if (!target) return null;
  return NAMES.get(normalizeTarget(target)) ?? null;
}
