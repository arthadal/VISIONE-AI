// Dopo il pacchetto, prima dell'installer (electron-builder `afterPack`, DECISIONI P-104).
// 1. Sostituisce le DLL di sherpa-onnx (che contengono espeak-ng, GPL-3.0-or-later) con quelle
//    ufficiali senza sintesi vocale di `vendor/sherpa-onnx-no-tts`, controllandone l'impronta.
// 2. Ferma la build se un binario distribuito contiene ancora espeak-ng o se nel pacchetto c'è un
//    file di espeak-ng: meglio nessun installer che un installer non vendibile.
// Lo sviluppo da sorgente non passa di qui: usa le DLL di node_modules (con Kokoro funzionante).
const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');

const VENDOR = join(__dirname, '..', 'vendor', 'sherpa-onnx-no-tts', '1.13.8-win-x64');
/** Impronte registrate in `vendor/sherpa-onnx-no-tts/1.13.8-win-x64/PROVENIENZA.md`. */
const NO_TTS = {
  'sherpa-onnx-c-api.dll': '86c7807d12982aa31c5cae57c686f30df9e5d5db4309b314d1efd5c873a8333c',
  'sherpa-onnx-cxx-api.dll': 'b09238f19f35b568a524b907536917f8aafb7ba515d862c44fb352ed12facaa5'
};
/** Simboli di espeak-ng: presenti nella DLL con la sintesi, assenti in quella `no-tts` (verificato). */
const GPL_MARKERS = ['espeak_Initialize', 'phontab', 'phondata'].map((m) => Buffer.from(m, 'latin1'));
const BINARY = /\.(dll|node|exe)$/i;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Binari con espeak-ng e file di espeak-ng nel pacchetto: vuoto = pacchetto pulito. */
function gplFindings(appOutDir) {
  const found = [];
  for (const file of walk(appOutDir)) {
    const rel = relative(appOutDir, file);
    if (/espeak/i.test(rel)) found.push(`${rel} (file di espeak-ng)`);
    if (!BINARY.test(file)) continue;
    const bytes = readFileSync(file);
    const hit = GPL_MARKERS.find((m) => bytes.includes(m));
    if (hit) found.push(`${rel} (contiene «${hit.toString('latin1')}»)`);
  }
  return found;
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') throw new Error(`after-pack: piattaforma ${context.electronPlatformName} non prevista (le DLL senza sintesi sono solo per Windows x64)`);
  const target = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64');
  if (!existsSync(target)) throw new Error(`after-pack: cartella di sherpa-onnx assente nel pacchetto: ${target}`);
  for (const [name, hash] of Object.entries(NO_TTS)) {
    const source = join(VENDOR, name);
    if (sha256(source) !== hash) throw new Error(`after-pack: ${name} in vendor non corrisponde all'impronta registrata`);
    copyFileSync(source, join(target, name));
    if (sha256(join(target, name)) !== hash) throw new Error(`after-pack: copia di ${name} non riuscita`);
  }
  const findings = gplFindings(context.appOutDir);
  if (findings.length > 0) throw new Error(`after-pack: il pacchetto contiene ancora espeak-ng (GPL):\n- ${findings.join('\n- ')}`);
  const voice = voiceFindings(context.appOutDir);
  if (voice.length > 0) throw new Error(`after-pack: voce VISIONE incompleta nel pacchetto (P-110):\n- ${voice.join('\n- ')}`);
  console.log(`  • after-pack: DLL sherpa-onnx senza sintesi installate e verificate; nessun espeak-ng; voce VISIONE e onnxruntime-node presenti e verificati (${context.appOutDir})`);
}

/**
 * Voce VISIONE (P-110): ogni file dell'impronta registrata (`vendor/voce-visione/it/impronte.json`) deve
 * esserci nel pacchetto, identico; e il binding Windows x64 di onnxruntime-node fuori dall'asar. Vuoto = ok.
 */
function voiceFindings(appOutDir) {
  const found = [];
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'vendor', 'voce-visione', 'it', 'impronte.json'), 'utf8'));
  const dir = join(appOutDir, 'resources', 'voce-visione', 'it');
  for (const [name, { sha256: hash }] of Object.entries(manifest)) {
    const file = join(dir, name);
    if (!existsSync(file)) found.push(`${name} assente`);
    else if (sha256(file) !== hash) found.push(`${name} diverso dall'impronta registrata`);
  }
  const binding = join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node');
  if (!existsSync(binding)) found.push('onnxruntime_binding.node (win32/x64) assente fuori dall\'asar');
  return found;
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.gplFindings = gplFindings;
module.exports.voiceFindings = voiceFindings;
