# VISIONE

**Il tuo assistente personale per Windows: parli, lui organizza una squadra di agenti IA che lavorano davvero sul tuo PC.**

Dici «hey VISIONE» o scrivi in chat. Il **Director** capisce la richiesta, la divide in compiti e la affida
alla squadra — Esecutore, Revisore, Ricercatore — che crea file, esegue comandi e cerca informazioni.
Poi ti riferisce a voce e in chat. Tutto in italiano, tutto sul tuo computer.

---

## ⚠️ STATO BETA / WIP

> **VISIONE è in fase di test.** La versione attuale è la **nightly `1.1.0-beta.41`**: funziona, ma è un
> lavoro in corso. Possono esserci errori, comportamenti strani e cambiamenti da una versione all'altra.
> Non affidarle ancora nulla di insostituibile.

**Hai trovato un problema? Aprilo nelle [Issue](../../issues).** Sono particolarmente utili le segnalazioni su:

- 🎙️ **Timeout della voce** — per esempio l'avviso *«nessuna risposta dal core entro 6000 ms»*, o la voce che
  non risponde dopo «hey VISIONE»;
- 🤖 **Timeout o errori di Claude Code** — la verifica dei motori che fallisce, risposte che non arrivano,
  agenti che restano fermi;
- 🗣️ parole storpiate o tagliate nella voce, pannelli che non si spostano, qualunque altra cosa ti sembri sbagliata.

Per aiutarci a capire in fretta, nella Issue scrivi:

1. la **versione** (è scritta in alto, accanto al nome VISIONE);
2. **cosa hai fatto** e **cosa ti aspettavi**;
3. **cosa è successo invece** (una schermata aiuta);
4. se puoi, allega il pacchetto creato da **«Segnala un problema»** (lo trovi in `%APPDATA%\VISIONE\segnalazioni\`).

---

## ✨ Cosa sa fare

- **🎙️ Voce** — parola d'avvio «hey VISIONE», ascolto e voce sintetica italiana, tutto in locale.
- **💬 Chat e gruppi di lavoro** — per ogni richiesta il Director apre un gruppo, chiama gli agenti con
  `@nome` e raccoglie i risultati; con `@nome testo` scrivi direttamente a un agente. Puoi allegare file 📎.
- **🧑‍🤝‍🧑 Una squadra vera** — gli agenti lavorano sul PC; le azioni delicate passano da **approvazioni**
  che confermi tu.
- **🖥️ Un'interfaccia viva** — scena 3D animata, Umanoide che parla, widget (orologio, meteo, sistema,
  calendario, note) e pannelli che si spostano, si ridimensionano e ricordano la posizione.
- **🧭 Procedura guidata** al primo avvio, per collegare i motori IA che hai già (account e chiavi restano sul tuo PC).
- **🔒 Privacy prima di tutto** — nessun servizio nuovo obbligatorio, nessuna chiave salvata in chiaro.

## 🧱 Stack

| Livello | Tecnologia |
|---|---|
| Linguaggio | **TypeScript** 7 |
| App desktop | **Electron** 44 (processo principale + core separato) |
| Interfaccia | **React** 19 |
| Build | **Vite** 7 con electron-vite 5 |
| Test | Vitest (unitari, contratto, end-to-end) |
| Voce | onnxruntime-node, sherpa-onnx (ascolto e parola d'avvio, in locale) |
| Pacchetto | electron-builder (installer NSIS per Windows x64) |

## 🚀 Avvio in locale

**Requisiti:** Windows 10/11 x64, [Node.js](https://nodejs.org) 24 o successivo.

```bash
npm install
npm run dev
```

`npm run dev` apre VISIONE in modalità sviluppo, con ricaricamento automatico dell'interfaccia.

I modelli della voce non sono nel repository: `npm run voice:models -- --check` dice cosa manca e
`npm run voice:models` lo scarica, verificando dimensione e SHA-256.

### Altri comandi utili

| Comando | Cosa fa |
|---|---|
| `npm run check` | tipi, igiene del repository, test e documenti: deve essere verde prima di ogni modifica |
| `npm test` | solo i test unitari |
| `npm run test:e2e` | compila e prova l'app vera, end-to-end |
| `npm run build` | compila senza creare l'installer |
| `npm run dist` | crea l'installer per Windows in `dist/` |

## 📄 Licenza

VISIONE è distribuito con licenza **GNU General Public License v3.0** (solo la versione 3): il testo completo è in
[LICENSE](LICENSE). Alcune parti dell'interfaccia derivano da progetti MIT: i loro avvisi sono in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
