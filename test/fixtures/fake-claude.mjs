// Claude Code finto per i test dell'adapter: un TUI minimo in PTY che legge `--settings`, esegue
// davvero i comandi di hook configurati (shim reale → pipe reale di VISIONE) e reagisce alle
// risposte di controllo (deny, continue:false, additionalContext). Nessuna rete, nessun account.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('2.1.286-fake (Claude Code)\n');
  process.exit(0);
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag('--session-id') ?? flag('--resume');
const resumed = args.includes('--resume');
// Casella di input come il TUI reale (2.1.299, misurato il 16/10/2026): `❯` solo se il terminale è
// riconosciuto come Unicode (TERM xterm-256color o Windows Terminal), altrimenti `>`.
const PROMPT = process.env.TERM === 'xterm-256color' || process.env.WT_SESSION ? '❯' : '>';
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'));
if (!existsSync(flag('--append-system-prompt-file'))) {
  process.stderr.write('identity mancante\n');
  process.exit(2);
}
const out = (s) => process.stdout.write(s + '\r\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tokens(command) {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/** Esegue l'hook come farebbe Claude Code: JSON su stdin, risposta JSON (facoltativa) su stdout. */
function hook(event, payload) {
  const entry = event === 'StatusLine' ? settings.statusLine : settings.hooks?.[event]?.[0]?.hooks?.[0];
  if (!entry) return Promise.resolve(null);
  const [cmd, ...rest] = tokens(entry.command);
  return new Promise((resolve) => {
    const child = spawn(cmd, rest, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('exit', () => {
      try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch { resolve(null); }
    });
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: event, cwd: process.cwd(), ...payload }));
  });
}

let interrupted = false;
let busy = false;
let ctrlC = 0;

async function turn(prompt) {
  busy = true;
  interrupted = false;
  const submit = await hook('UserPromptSubmit', { prompt });
  if (submit?.continue === false) {
    out(`fermato: ${submit.stopReason}`);
  } else {
    if (submit?.hookSpecificOutput?.additionalContext) out(`contesto: ${submit.hookSpecificOutput.additionalContext}`);
    // Limite di quota (P-83): banner reale della CLI 2.1.289, poi il turno si chiude (Stop).
    if (prompt.includes('LIMITE')) {
      out('Usage limit reached \u00b7 limit resets 3:00 PM');
      await hook('Stop', { stop_hook_active: false, last_assistant_message: 'limite di quota raggiunto' });
      busy = false;
      out('\u276f ');
      return;
    }
    if (prompt.includes('crash')) process.exit(3);
    const pre = await hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'nota.txt' }, tool_use_id: 'toolu_01' });
    if (pre?.hookSpecificOutput?.permissionDecision === 'deny') {
      out(`NEGATO: ${pre.hookSpecificOutput.permissionDecisionReason}`);
    } else if (pre?.continue === false) {
      out(`fermato: ${pre.stopReason}`);
    } else {
      const post = await hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'nota.txt' }, tool_use_id: 'toolu_01', tool_response: { content: 'ok' } });
      if (post?.hookSpecificOutput?.additionalContext) out(`contesto: ${post.hookSpecificOutput.additionalContext}`);
      if (prompt.includes('lento')) {
        for (let i = 0; i < 60 && !interrupted; i++) await sleep(100);
      }
      out(interrupted ? 'interrotto' : `risposta: ${prompt}`);
    }
  }
  await hook('StatusLine', { context_window: { context_window_size: 200000, total_input_tokens: 1234 } });
  // Testo finale nell'hook Stop (`last_assistant_message`); con un brief su file risponde con la
  // riga `RISPOSTA:` del brief, come farebbe un agente che legge le istruzioni.
  const brief = /nel file (\S+)/.exec(prompt)?.[1];
  const text = brief && existsSync(brief) ? readFileSync(brief, 'utf8') : prompt;
  const answer = /RISPOSTA:([^.\n]*)/.exec(text)?.[1]?.trim() ?? `risposta: ${prompt}`;
  await hook('Stop', { stop_hook_active: false, ...(interrupted ? {} : { last_assistant_message: answer }) });
  busy = false;
  out(`${PROMPT} `);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
out(`fake-claude sessione ${sessionId}${resumed ? ' (ripresa)' : ''}`);
if (process.env.FAKE_CLAUDE_ONBOARDING === '1') {
  // Prima configurazione non finita (come la 2.1.299 dopo `auth login`, 18/10/2026): la scelta del tema, e
  // nessun hook finché qualcuno non sceglie. Ogni tasto ricevuto si registra: VISIONE non deve rispondere.
  const word = (s) => s.split(' ').join('\x1b[1C');
  process.stdout.write(`\x1b[2J\x1b[2;2H${word("Let's get started.")}\x1b[4;2H${word('Choose the text style that looks best with your terminal')}\x1b[6;2H❯\x1b[1C${word('1. Auto (match terminal)')}\x1b[7;4H${word('2. Dark mode')}\x1b[10;2H${word('1  function greet() {')}\x1b[12;2H${word('3  }')}`);
  const marker = join(process.cwd(), 'fake-claude-onboarding-keys');
  process.stdin.on('data', (d) => writeFileSync(marker, `${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}${JSON.stringify(d)}\n`));
  await new Promise(() => undefined);
}
if (process.env.FAKE_CLAUDE_TRUST === '1') {
  // Dialogo di fiducia come quello reale (2.1.286): testo posizionato con sequenze del cursore,
  // nessun hook finché qualcuno non risponde. Ogni tasto ricevuto viene registrato per il test.
  // La selezione parte (di proposito) su "No": chi conferma deve leggere lo schermo e spostarsi
  // con le frecce; Invio su "Yes" prosegue, Invio su "No" esce con 1 come il TUI reale.
  const word = (s) => s.split(' ').join('\x1b[1C');
  let selected = 0;
  // Freccia `❯` con un terminale Unicode, `>` senza (VISIONE avviata dall'icona).
  const arrow = process.env.FAKE_CLAUDE_ARROW || '❯';
  const draw = () => process.stdout.write(
    `\x1b[14;2H${selected === 0 ? arrow : ' '}\x1b[1C${word('No, exit')}\x1b[15;2H${selected === 1 ? arrow : ' '}\x1b[1C${word('Yes, I trust this folder')}\x1b[17;2H${word('Enter to confirm · Esc to cancel')}\x1b[>0q\x1b[?u`
  );
  process.stdout.write(`\x1b[2J\x1b[3;2H${word('Accessing workspace:')}\x1b[5;2H${word('Quick safety check: Is this a project you created or one you trust?')}`);
  draw();
  const marker = join(process.cwd(), 'fake-claude-trust-answered');
  let answered = false;
  await new Promise((resolve) => {
    process.stdin.on('data', (d) => {
      if (answered) return;
      writeFileSync(marker, `${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}${JSON.stringify(d)}\n`);
      if (d.includes('\x1b[A') || d.includes('\x1b[B')) {
        selected = 1 - selected;
        // Come 2.1.293 dal vivo (10/10/2026): si riscrive solo la colonna della freccia, non le opzioni.
        process.stdout.write(`\x1b[14;2H${selected === 0 ? arrow : ' '}\x1b[15;2H${selected === 1 ? arrow : ' '}`);
      } else if (d.includes('\r')) {
        if (selected !== 1) process.exit(1);
        answered = true;
        // Come un TUI reale: ciò che si digita prima del prompt resta in attesa, non va perso.
        process.stdin.pause();
        out('');
        resolve();
      }
    });
  });
}
await hook('SessionStart', { source: resumed ? 'resume' : 'startup' });
out(`${PROMPT} `);
let line = '';
process.stdin.resume();
process.stdin.on('data', (d) => {
  // Come il TUI reale (2.1.299, misurato il 16/10/2026): un testo lungo arrivato tutto insieme (fra 700 e
  // 900 caratteri in su) non si vede carattere per carattere ma come «[Pasted text #1]».
  const pasted = d.length > 800 && !d.includes('\r');
  if (pasted) process.stdout.write('[Pasted text #1 +0 lines]');
  // Come ConPTY (misurato il 17/10/2026): le celle già uguali sullo schermo non tornano nel flusso. Un
  // inizio identico al turno prima («Compito: …») arriva come spostamento del cursore, non come testo.
  const skip = !pasted && line === '' && d.startsWith('Compito: ') ? 20 : 0;
  if (skip) process.stdout.write(`\x1b[7;${skip + 3}H`);
  let typed = 0;
  for (const ch of d) {
    if (ch === '\u0003') {
      if (++ctrlC >= 2 || !busy) process.exit(0);
      continue;
    }
    if (ch === '\u001b') {
      interrupted = true;
      continue;
    }
    if (ch === '\r') {
      const prompt = line;
      line = '';
      if (prompt === '/exit') process.exit(0);
      if (!busy && prompt !== '') void turn(prompt);
      continue;
    }
    line += ch;
    if (!pasted && typed++ >= skip) process.stdout.write(ch);
  }
});
