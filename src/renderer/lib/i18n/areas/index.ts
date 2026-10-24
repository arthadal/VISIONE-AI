// Dizionari per area (P-108, 11/10/2026): le aree dell'interfaccia hanno ciascuna il proprio file, così
// la traduzione di parti diverse non tocca mai lo stesso file; qui si uniscono a `it.ts`/`en.ts`.
import * as settings from './settings.ts';
import * as shell from './shell.ts';
import * as offline from './offline.ts';
import * as widgets from './widgets.ts';
import * as windows from './windows.ts';

export const AREA_IT = { ...shell.it, ...settings.it, ...windows.it, ...widgets.it, ...offline.it } as const;
export const AREA_EN: Record<keyof typeof AREA_IT, string> = { ...shell.en, ...settings.en, ...windows.en, ...widgets.en, ...offline.en };
