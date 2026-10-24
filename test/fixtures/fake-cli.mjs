// CLI di prova innocua e deterministica per i test del CLI Runtime: `node fake-cli.mjs <modo> …`.
import { spawn } from 'node:child_process';

const [mode = 'help', ...rest] = process.argv.slice(2);
const arg = (i, d) => rest[i] ?? d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

switch (mode) {
  case 'echo-env': {
    const env = {};
    for (const name of rest) env[name] = process.env[name] ?? null;
    process.stdout.write(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD ?? null, env, argv: rest }) + '\n');
    break;
  }
  case 'argv':
    process.stdout.write(JSON.stringify(rest) + '\n');
    break;
  case 'both':
    process.stdout.write('riga-out-1\nriga-out-2\n');
    process.stderr.write('riga-err-1\n');
    break;
  case 'exit':
    process.stderr.write(`esco con ${arg(0, '1')}\n`);
    process.exit(Number(arg(0, '1')));
    break;
  case 'sleep':
    process.stdout.write('vivo\n');
    await sleep(Number(arg(0, '60000')));
    break;
  case 'silent-sleep':
    await sleep(Number(arg(0, '60000')));
    break;
  case 'abort':
    process.stdout.write('sto per cadere\n');
    process.abort();
    break;
  case 'lines': {
    const n = Number(arg(0, '1000'));
    let out = '';
    for (let i = 1; i <= n; i++) out += `riga ${i}\n`;
    process.stdout.write(out);
    break;
  }
  case 'split-utf8': {
    // "città €" spezzato a metà di un carattere multibyte, poi una riga finale senza a-capo.
    const bytes = Buffer.from('città €\nultima riga', 'utf8');
    process.stdout.write(bytes.subarray(0, 4));
    await sleep(50);
    process.stdout.write(bytes.subarray(4, 9));
    await sleep(50);
    process.stdout.write(bytes.subarray(9));
    break;
  }
  case 'long-line':
    process.stdout.write('x'.repeat(Number(arg(0, '100000'))) + '\nfine\n');
    break;
  case 'echo-stdin': {
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        process.stdout.write(`eco:${buf.slice(0, nl)}\n`);
        buf = buf.slice(nl + 1);
      }
    });
    process.stdin.on('end', () => {
      process.stdout.write('stdin chiuso\n');
      process.exit(0);
    });
    break;
  }
  case 'ignore-eof':
    // Non reagisce né alla fine di stdin né a Ctrl+C: serve il kill dell'albero.
    process.on('SIGINT', () => undefined);
    process.stdin.resume();
    process.stdin.on('end', () => undefined);
    process.stdout.write('ostinato\n');
    await sleep(Number(arg(0, '60000')));
    break;
  case 'spawn-child': {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    process.stdout.write(`figlio ${child.pid}\n`);
    await sleep(60_000);
    break;
  }
  case 'pty-echo': {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdout.write(`pronto tty=${Boolean(process.stdout.isTTY)} cols=${process.stdout.columns}\r\n`);
    process.stdout.on('resize', () => process.stdout.write(`resize ${process.stdout.columns}x${process.stdout.rows}\r\n`));
    process.stdin.on('data', (d) => {
      if (d.includes('\u0003')) {
        process.stdout.write('ctrl-c ricevuto\r\n');
        process.exit(0);
      }
      process.stdout.write(`ECO:${d.replace(/\r/g, '')}\r\n`);
      if (d.includes('quit')) process.exit(7);
    });
    break;
  }
  default:
    process.stderr.write(`modo sconosciuto: ${mode}\n`);
    process.exit(64);
}
