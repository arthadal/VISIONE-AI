# sherpa-onnx 1.13.8, Windows x64, build senza sintesi vocale (`no-tts`)

DLL ufficiali del progetto sherpa-onnx (k2-fsa), licenza **Apache-2.0**, usate **solo
nell'installer** al posto di quelle del pacchetto npm `sherpa-onnx-win-x64`, che contengono
espeak-ng (GPL-3.0-or-later). La sostituzione la fa `tools/after-pack.cjs` durante `npm run dist`;
lo sviluppo da sorgente continua a usare le DLL di `node_modules` (con Kokoro funzionante). DECISIONI P-104.

- **Rilascio:** https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8 (pubblicato il 10/09/2026)
- **Archivio:** `sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts-lib.tar.bz2`, 7.536.080 byte,
  SHA-256 `a1253e665c4f236119c443c8932a8acfca32a546c78c05962d483c9a0eae21b7` (uguale a quello
  pubblicato da GitHub per l'asset; scaricato il 07/10/2026 con il via del proprietario).
- **Variante MT:** come le DLL del pacchetto npm, che non importano il runtime di Visual C++.
- **File presi dalla cartella `lib/`** (gli altri sono identici a quelli del pacchetto npm:
  `onnxruntime.dll` uguale byte per byte):

| File | Byte | SHA-256 |
|---|---|---|
| `sherpa-onnx-c-api.dll` | 3.249.664 | `86c7807d12982aa31c5cae57c686f30df9e5d5db4309b314d1efd5c873a8333c` |
| `sherpa-onnx-cxx-api.dll` | 259.584 | `b09238f19f35b568a524b907536917f8aafb7ba515d862c44fb352ed12facaa5` |

## Verifiche fatte qui (07/10/2026)
- Nessun simbolo di espeak-ng: `espeak_Initialize`, `phontab` e `phondata` assenti (presenti nella
  DLL del pacchetto npm).
- Esporta **tutti i 139 simboli** che `sherpa-onnx.node` importa da `sherpa-onnx-c-api.dll`, comprese
  le 6 funzioni di sintesi, che qui rispondono «TTS is not enabled» e restituiscono un errore pulito.
- Con l'addon del pacchetto npm: VAD Silero e Whisper caricano e trascrivono come con la DLL
  originale (stessa trascrizione della stessa frase).
