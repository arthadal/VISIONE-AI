// OpenCode finto per i test dell'adapter: riproduce le uscite reali registrate in
// test/fixtures/opencode (OpenCode v2.0.12, 01/10/2026). Nessuna rete, nessun modello.
// Con FAKE_OPENCODE_VERSION=1.x si comporta come la 1.19.3 di npm (fixture in opencode/v1, VM
// 21/10/2026): `--standalone` sconosciuto (guida su stderr, uscita 1) ed export `opencode export <id>`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'opencode');
const fx = (name) => readFileSync(join(fixtures, name), 'utf8');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `1-muta`: una 1.x che non dichiara la versione in modo leggibile (si ricade sugli argomenti della 2.x).
const legacy = /^1/.test(process.env.FAKE_OPENCODE_VERSION ?? '');
const HELP_V1 = 'opencode run [message..]\n\nrun opencode with a message\n\nPositionals:\n  message  message to send  [array] [default: []]\n\nOptions:\n  -h, --help  show help  [boolean]\n      --format  format: default (formatted) or json (raw JSON events)  [string]\n  -f, --file  file(s) to attach to message  [array]\n      --auto  auto-approve permissions that are not explicitly denied (dangerous!)\n              [boolean] [default: false]\n';

if (args[0] === '--version') {
  const v = process.env.FAKE_OPENCODE_VERSION ?? '';
  process.stdout.write(!legacy ? 'opencode v2.0.12-fake\n' : /^\d+\.\d+/.test(v) ? `${v}\n` : 'opencode\n');
  process.exit(0);
}

// Le guide, che l'adapter legge per sapere quali opzioni ci sono (forme reali ridotte: v2.0.12 sul PC del
// proprietario, 1.19.3 nella VM, 21/10/2026). La 1.x le stampa su stderr. `FAKE_OPENCODE_NOHELP`: illeggibili.
if (args.includes('--help')) {
  appendFileSync(join(process.cwd(), 'fake-oc-help.log'), `${args.join(' ')}\n`);
  if (process.env.FAKE_OPENCODE_NOHELP) process.exit(2);
  if (legacy) {
    process.stderr.write(args[0] === 'run' ? HELP_V1 : 'Commands:\n  opencode run [message..]     run opencode with a message\n  opencode export [sessionID]  export session data as JSON\n  opencode session             manage sessions\n');
  } else {
    process.stdout.write(args[0] === 'run'
      ? 'FLAGS\n  --standalone            Run with a private server instead of the background service\n  --format string         Output format\n  --file, -f string       File to attach to the message\n'
      : 'SUBCOMMANDS\n  run                Run OpenCode with a message\n  session            Manage sessions\n');
  }
  process.exit(0);
}

if (legacy) {
  if (args.includes('--standalone')) {
    process.stderr.write(HELP_V1);
    process.exit(1);
  }
  if (args[0] === 'export') {
    process.stdout.write(`Exporting session: ${args[1]}\n`);
    process.stdout.write(fx('session-export.json'));
    process.exit(0);
  }
  if (args[0] === 'run') {
    const fileAt = args.indexOf('--file');
    writeFileSync(join(process.cwd(), 'fake-oc-last.json'), JSON.stringify({ argv: args, cwd: process.cwd(), pwd: process.env.PWD ?? null, config: null, fileText: fileAt >= 0 && existsSync(args[fileAt + 1]) ? readFileSync(args[fileAt + 1], 'utf8') : null }));
    // Come yargs nella 1.19.3: `--file` è un array e prende anche gli argomenti che lo seguono (VM, 21/10/2026).
    const swallowed = fileAt >= 0 ? args.slice(fileAt + 1).find((a, i) => i > 0 && !a.startsWith('-')) : undefined;
    if (swallowed !== undefined) {
      process.stderr.write(`\x1b[91m\x1b[1mError: \x1b[0mFile not found: ${swallowed}\n`);
      process.exit(1);
    }
    if (!process.env.NVIDIA_API_KEY) {
      process.stdout.write(fx('v1/run-nokey.ndjson'));
      process.exit(1);
    }
    process.stdout.write(fx('v1/run-tool.ndjson'));
    process.exit(0);
  }
}

if (args[0] === 'session' && args[1] === 'export') {
  const id = args.find((a, i) => i > 1 && !a.startsWith('--'));
  if (!id || id.startsWith('ses_inesistente')) {
    process.stderr.write(`Session not found: ${id}\r\n`);
    process.exit(1);
  }
  process.stdout.write(fx('session-export.json'));
  process.exit(0);
}

if (args[0] === 'run') {
  const message = args.at(-1) ?? '';
  const file = flag('--file');
  const session = flag('--session');
  // Traccia per le asserzioni dei test: argv, config, cartella. La config contiene solo riferimenti.
  writeFileSync(join(process.cwd(), 'fake-oc-last.json'), JSON.stringify({
    argv: args, cwd: process.cwd(), pwd: process.env.PWD ?? null,
    config: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null,
    fileText: file && existsSync(file) ? readFileSync(file, 'utf8') : null
  }));
  // Le istruzioni sono il messaggio più il brief allegato (testi lunghi via file, come il turno reale);
  // le righe con un percorso sono escluse: le cartelle temporanee hanno nomi casuali.
  const brief = file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('/') && !l.includes('\\')).join(' ') : '';
  const instructions = `${message} ${brief}`;
  if (session && session.startsWith('ses_inesistente')) {
    process.stdout.write(fx('run-nosession.ndjson'));
    process.exit(1);
  }
  if (!process.env.NVIDIA_API_KEY) {
    process.stdout.write(fx('run-nokey.ndjson'));
    process.exit(1);
  }
  if (instructions.includes('bloccato')) {
    const counter = join(process.cwd(), '.fake-oc-lock');
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(n + 1));
    if (n < 2) {
      process.stderr.write('SQLiteError: database is locked\n');
      process.exit(1);
    }
  }
  if (instructions.includes('lento')) {
    process.stdout.write(fx('run-turn.ndjson').split('\n')[0] + '\n');
    await sleep(30_000);
    process.exit(0);
  }
  // Parola intera: i brief del Context Builder contengono "task".
  if (/\bask\b/.test(instructions)) {
    process.stdout.write(fx('run-ask.ndjson'));
    process.stderr.write(JSON.parse(fx('run-ask.meta.json')).stderr);
    process.exit(1);
  }
  // `MEMORIA-FINTA <valore>`: il testo finale dichiara un fatto (riga `MEMORIA:` del protocollo, P-43).
  const fact = /MEMORIA-FINTA (\S+)/.exec(instructions)?.[1];
  if (fact) {
    process.stdout.write(fx('run-turn.ndjson').replaceAll('"text":"OK"', `"text":${JSON.stringify(`Fatto.\nMEMORIA: il valore concordato è ${fact}`)}`));
    process.exit(0);
  }
  process.stdout.write(fx(instructions.includes('strumento') ? 'run-tool.ndjson' : 'run-turn.ndjson'));
  process.exit(0);
}

process.stderr.write(`comando non emulato: ${args.join(' ')}\n`);
process.exit(2);
