// Requisiti di VISIONE stessa, non di un motore (18/10/2026). Collaudo da PC vergine (VM, Windows 11 Home
// appena installato, beta.23): mancava il runtime Microsoft Visual C++ (vcruntime140.dll, msvcp140.dll e
// compagnia, assenti tutti in System32). onnxruntime-node ne ha bisogno, quindi la voce VISIONE e il modello
// offline non partivano e parlava Windows; sul PC di sviluppo c'era perché l'aveva installato altro software.
// Il runtime lo installa l'utente con il pacchetto ufficiale di Microsoft (winget, «Installa» nella guidata):
// VISIONE non copre né ridistribuisce file di Microsoft.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterSetupItem } from '../adapters/index.ts';

/** Il «motore» dei requisiti di sistema in `setup.install`: non è un adattatore. */
export const SYSTEM_SETUP = 'visione';

/** Le DLL che `onnxruntime.dll` importa dal runtime di Visual C++ 2015-2022 (lette dalla sua tabella di import). */
export const VC_RUNTIME_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll'] as const;

/** Le DLL del runtime che mancano in System32 (vuoto = a posto, o non Windows). */
export function missingVcRuntime(opts: { platform?: NodeJS.Platform; systemRoot?: string; exists?: (path: string) => boolean } = {}): string[] {
  if ((opts.platform ?? process.platform) !== 'win32') return [];
  const root = opts.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const exists = opts.exists ?? existsSync;
  return VC_RUNTIME_DLLS.filter((dll) => !exists(join(root, 'System32', dll)));
}

/** Il pacchetto ufficiale di Microsoft con winget (Windows chiede il permesso). `Step` lo dà il core. */
export const VC_RUNTIME_INSTALL = [
  "if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'manca winget (Programma di installazione app di Microsoft): installa «Microsoft Visual C++ Redistributable» x64 dal sito Microsoft, poi premi «Rifai la prova»' }",
  "Step 'Installo il runtime Microsoft Visual C++ (winget). Se Windows chiede il permesso, premi Si.' { winget install --id Microsoft.VCRedist.2015+.x64 -e --source winget --accept-source-agreements --accept-package-agreements }"
].join('\n');

/** I requisiti di sistema non a posto, con «Installa»: oggi solo il runtime di Visual C++. */
export function systemSetupItems(missing: readonly string[] = missingVcRuntime()): AdapterSetupItem[] {
  if (missing.length === 0) return [];
  return [
    {
      id: 'runtime-vc',
      label: 'Runtime Microsoft Visual C++',
      ok: false,
      optional: false,
      // In parole per chi prova VISIONE (VM, 22/10/2026: i nomi delle DLL non dicevano niente); i file mancanti vanno nel registro.
      detail: 'manca un componente gratuito di Microsoft che Windows non ha di serie: senza, la voce VISIONE e il modello offline non partono e parla Windows. Premi «Installa»',
      steps: [
        'Apri PowerShell (tasto Windows, scrivi «PowerShell», Invio).',
        'Incolla il comando qui sotto e premi Invio: è il pacchetto ufficiale di Microsoft, gratuito.',
        'Quando ha finito, torna qui e premi «Rifai la prova».'
      ],
      commands: ['winget install --id Microsoft.VCRedist.2015+.x64 -e'],
      link: 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist',
      action: { kind: 'install', source: 'il pacchetto ufficiale di Microsoft (winget, Microsoft.VCRedist.2015+.x64)', admin: true, script: VC_RUNTIME_INSTALL }
    }
  ];
}
