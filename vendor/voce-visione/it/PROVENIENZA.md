# Voce VISIONE (italiano): modelli, impronta della voce e tokenizer

La voce che VISIONE usa di serie **dal 22/10/2026** è **«Nicola»**, scelta dal proprietario fra 5 campioni (n.3).
È una voce **sintetica**: nessuna persona reale. Il timbro viene dalla voce libera `im_nicola` di Kokoro (pesi
Apache-2.0), letta qui una volta per ricavarne l'impronta; nel programma entra solo l'impronta che Pocket TTS ricava
da quell'audio, non Kokoro né espeak-ng (GPL, P-103/P-104). Con l'effetto «stile JARVIS» (P-110).
È inclusa nell'installer come risorsa (`resources/voce-visione/it`): niente download a parte, niente rete.
La voce precedente (registrazioni del proprietario, 18/10/2026, `vprocmix`) resta nella storia di git (commit 459d934);
quella prima ancora (il baritono progettato n.3, 15/10/2026) è in `.backup/voce-baritono/` (DECISIONI P-107x).

## Da dove viene ogni file

| File | Cosa è | Fonte e licenza |
|---|---|---|
| `flow_lm_main_int8.onnx`, `flow_lm_flow_int8.onnx`, `mimi_decoder_int8.onnx`, `text_conditioner.onnx`, `bundle.json` | Pocket TTS, pacchetto italiano, esportato in ONNX e quantizzato int8 | **Kyutai**, modello [kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts), licenza **CC-BY-4.0**; esportazione ONNX [KevinAHM/pocket-tts-onnx](https://huggingface.co/KevinAHM/pocket-tts-onnx) (cartella `onnx/italian/`), stessa licenza. Scaricati il 10/10/2026 con il via del proprietario. Non modificati. |
| `tokenizer.json` | Il `tokenizer.model` (SentencePiece) dello stesso pacchetto, riscritto in JSON per il tokenizer TypeScript (`src/voice/pocket/tokenizer.ts`) | Derivato da Pocket TTS (CC-BY-4.0). Generato con `.backup/voce-lavoro/esporta-tokenizer.py`; i casi di prova in `test/fixtures/pocket-tokenizer-casi.json` vengono dalla libreria originale. |
| `voce.f32`, `voce.json` | L'impronta della voce: gli embedding del Mimi encoder di Pocket TTS (fp32 ONNX, float32, forma `[1, 272, 1024]`, col «bos» davanti) da circa 21,7 s di parlato italiano letto da Kokoro con la voce `im_nicola` (sid 36, velocità 0,95, testo vario con domande, numeri e pause) | Nostra, da una voce sintetica: Kokoro-82M, voce `im_nicola`, licenza **Apache-2.0** (modello `kokoro-int8-multi-lang-v1_0` di sherpa-onnx, scaricato il 22/10/2026). Script e audio di riferimento in `.backup/voce-nicola/` (`riferimenti.cjs`, `rif-nicola.wav`, `pocket-campioni.mts`, `pocket-nicola.wav`). Scelta dal proprietario il 22/10/2026 fra 5 campioni: prima parola entro 0,50 s, prima parola breve sentita 90% (resoconto del 22/10). |

**Attribuzione richiesta da CC-BY-4.0** (va negli avvisi di terze parti del programma): «Pocket TTS —
Kyutai (https://kyutai.org), licenza CC BY 4.0; modelli convertiti in ONNX e quantizzati
(KevinAHM/pocket-tts-onnx); usati senza modifiche ai pesi».

## Impronte (SHA-256)

I file `.onnx` non sono nel repository (125 MB): si rimettono qui da KevinAHM/pocket-tts-onnx e devono
avere queste impronte. `tools/after-pack.cjs` le ricontrolla tutte nel pacchetto e **ferma la build** se
un file manca o è diverso; la stessa tabella sta in `impronte.json`, letta dal programma.

| File | Byte | SHA-256 |
|---|---|---|
| `bundle.json` | 24.365 | `c779c25fd836c9b85a3fc570474774777176757bd6bec0b5bffbbe599644a9f9` |
| `flow_lm_flow_int8.onnx` | 9.962.530 | `21b2bec2f9ae4323fc545a0c7ffb274bdfa925a699fd304ed03aba53e4ca9129` |
| `flow_lm_main_int8.onnx` | 76.341.079 | `f43ce4d823471095a7bd6d9dcfcceb46145ea96b0f2b85b7d668f15816965055` |
| `mimi_decoder_int8.onnx` | 22.684.077 | `f120bc5cddca9514c511f128786f5d9e6e6893b067faae5e30f5b2bd5643aa03` |
| `text_conditioner.onnx` | 16.388.344 | `692369f5ac340006fa44252155da77fe6c8a60a859848297777e0caea534068e` |
| `tokenizer.json` | 124.155 | `6fcf6dbb8397f5824163e17ec14ff4e01fe224ce198768d2638f5be91eb5c9c0` |
| `voce.f32` | 1.114.112 | `23bfc2c4e3dc8842decd1832fcbb38d6721e57ca344796eba1254f2ee47f2b8f` |
| `voce.json` | 51 | `71e13a569bd1ffa9926fe67abf53be976d73b49e2d93fd786b827bc4535f0237` |

## Misure fatte qui (15/10/2026, Intel Core Ultra 5 125H)

- Il motore TypeScript dà **gli stessi identici fotogrammi latenti** del wrapper Python di riferimento
  (temperatura 0, scarto 0), e il tokenizer gli stessi id di SentencePiece su 17 frasi.
- RTF 0,45–0,49 (Python: 0,25; la differenza è onnxruntime-node che copia 49 MB di stato a ogni passo),
  prima parola dopo ~150 ms, caricamento ~0,8 s.
- Somiglianza di timbro con la voce progettata (ERes2Net): 0,73 col riferimento lungo, 0,67 col corto.
- Chiarezza (Whisper base, 12 prove): errori sulle parole 26% a temperatura 0,7, **14% a 0,5** (scelta).
