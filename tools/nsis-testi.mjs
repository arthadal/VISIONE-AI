// Testi italiani dell'installatore (22/10/2026). Nella VM da «vergine», su un PC dove VISIONE non c'era mai stato, la
// scelta del tipo d'installazione diceva «Re-installa solo per l'utente attuale»: è la traduzione italiana di «New
// installation» nei messaggi di electron-builder, non un'installazione trovata. Un `build/installer.nsh` non basta
// (viene letto prima di quei messaggi, che quindi vincono): si correggono le due righe nel modello prima di costruire.
// Idempotente; dopo un `npm install` che riporta il modello originale, la costruzione lo corregge di nuovo.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const FIXES = [
  ["it_IT: Re-installa per tutti gli utenti. (Richiede le credenziali di amministratore)", "it_IT: Nuova installazione per tutti gli utenti. (Richiede le credenziali di amministratore)"],
  ["it_IT: Re-installa solo per l'utente attuale.", "it_IT: Nuova installazione solo per l'utente attuale."]
];

const require = createRequire(import.meta.url);
const file = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis', 'assistedMessages.yml');
let text = readFileSync(file, 'utf8');
let changed = 0;
for (const [wrong, right] of FIXES) {
  if (text.includes(wrong)) {
    text = text.replace(wrong, right);
    changed += 1;
  } else if (!text.includes(right)) {
    // Il modello è cambiato con una versione nuova di electron-builder: meglio fermarsi che costruire col testo sbagliato.
    console.error(`nsis-testi: riga non trovata nel modello di electron-builder: ${right}`);
    process.exit(1);
  }
}
if (changed > 0) writeFileSync(file, text, 'utf8');
console.log(`nsis-testi: ${changed > 0 ? `${changed} righe corrette` : 'già corretto'} (${file})`);
