// Compatibilità con le versioni di OpenCode (21/10/2026): le opzioni si leggono dalla guida della CLI installata.
// Estratti reali: v2.0.12 (PC del proprietario) e 1.19.3 (npm, VM Windows 11 da zero).
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINT_PROFILES, LOCAL_TOOLS_OFF, buildConfigContent, buildExportArgs, buildTurnArgs, featuresFromHelp, featuresFromVersion, fileMessage, opencodeMajor } from '../../src/core/adapters/opencode/command.ts';
import { mapEngineError, parseSessionExport, stderrReason } from '../../src/core/adapters/opencode/parser.ts';

const RUN_V2 = [
  'FLAGS',
  '  --standalone            Run with a private server instead of the background service',
  '  --session, -s string    Session ID to continue',
  '  --model, -m string      Model to use in the format provider/model#variant',
  '  --format choice         Output format (choices: default, json)',
  '  --file, -f string       File to attach to the message',
  'GLOBAL FLAGS',
  '  --print-logs                                                        Print logs to stderr (server logs require --standalone)'
].join('\n');
const MAIN_V2 = 'SUBCOMMANDS\n  run                Run OpenCode with a message\n  session            Manage sessions\n  service            Manage the background server\n';
const RUN_V1 = [
  'opencode run [message..]',
  '',
  'run opencode with a message',
  '',
  'Options:',
  '  -s, --session      session id to continue                                                 [string]',
  '  -m, --model        model to use in the format of provider/model                           [string]',
  '      --format       format: default (formatted) or json (raw JSON events)',
  '  -f, --file         file(s) to attach to message                                            [array]',
  '      --auto         auto-approve permissions that are not explicitly denied (dangerous!)'
].join('\n');
const MAIN_V1 = 'Commands:\n  opencode run [message..]     run opencode with a message\n  opencode export [sessionID]  export session data as JSON\n  opencode session             manage sessions\n';

describe('OpenCode: opzioni dalla guida, non dal numero di versione', () => {
  it('2.x: --standalone e `session export`; 1.x: niente --standalone ed `export` principale', () => {
    expect(featuresFromHelp(RUN_V2, MAIN_V2)).toEqual({ standalone: true, topLevelExport: false, fileArray: false });
    expect(featuresFromHelp(RUN_V1, MAIN_V1)).toEqual({ standalone: false, topLevelExport: true, fileArray: true });
  });

  it('un\'opzione nominata solo in una descrizione non conta (la 2.0.12 cita --standalone sotto --print-logs)', () => {
    const senza = RUN_V2.split('\n').filter((l) => !l.startsWith('  --standalone')).join('\n');
    expect(featuresFromHelp(senza, MAIN_V2)?.standalone).toBe(false);
  });

  it('guida illeggibile o non riconosciuta: decide la versione, e una versione illeggibile vale 2.x', () => {
    expect(featuresFromHelp(null, null)).toBeNull();
    expect(featuresFromHelp('Usage: qualcosa d\'altro', MAIN_V1)).toBeNull();
    expect(opencodeMajor('opencode v2.0.12')).toBe(2);
    expect(opencodeMajor('1.19.3')).toBe(1);
    expect(opencodeMajor('opencode')).toBeNull();
    expect(featuresFromVersion('1.19.3')).toEqual({ standalone: false, topLevelExport: true, fileArray: true });
    expect(featuresFromVersion('opencode v2.0.12')).toEqual({ standalone: true, topLevelExport: false, fileArray: false });
    expect(featuresFromVersion(null)).toEqual({ standalone: true, topLevelExport: false, fileArray: false });
  });

  it('argomenti del turno e dell\'export secondo le opzioni', () => {
    const turn = { model: 'nvidia/x/y', engineSessionId: 'ses_1', message: 'ciao' };
    expect(buildTurnArgs(turn)).toEqual(['run', '--standalone', '--format', 'json', '--session', 'ses_1', '--model', 'nvidia/x/y', 'ciao']);
    const v1 = { standalone: false, topLevelExport: true, fileArray: true };
    expect(buildTurnArgs(turn, v1)).toEqual(['run', '--format', 'json', '--session', 'ses_1', '--model', 'nvidia/x/y', 'ciao']);
    // Testo lungo via file: nella 1.x `--file` è un array e si mangerebbe il messaggio, che va prima (VM 21/10/2026).
    const lungo = { ...turn, file: 'C:/brief/t1.md', message: 'Esegui le istruzioni contenute nel file allegato.' };
    expect(buildTurnArgs(lungo).slice(-3)).toEqual(['--file', 'C:/brief/t1.md', 'Esegui le istruzioni contenute nel file allegato.']);
    expect(buildTurnArgs(lungo, v1).slice(-3)).toEqual(['Esegui le istruzioni contenute nel file allegato.', '--file', 'C:/brief/t1.md']);
    expect(buildExportArgs('ses_1')).toEqual(['session', 'export', '--standalone', 'ses_1']);
    expect(buildExportArgs('ses_1', v1)).toEqual(['export', 'ses_1']);
    expect(buildExportArgs('ses_1', { standalone: false, topLevelExport: false, fileArray: false })).toEqual(['session', 'export', 'ses_1']);
  });

  it('il brief in un file: la riga sulla lingua della risposta si ripete nel messaggio (24/10/2026)', () => {
    expect(fileMessage('Compito: ricetta\n---\nRispondi in italiano con il risultato finale.\n')).toBe('Esegui le istruzioni contenute nel file allegato. Rispondi in italiano con il risultato finale.');
    expect(fileMessage('Compito\nRispondi in inglese con il risultato finale (write it in English).')).toBe('Esegui le istruzioni contenute nel file allegato. Rispondi in inglese con il risultato finale (write it in English).');
    expect(fileMessage('Brief della verifica\nseconda riga')).toBe('Esegui le istruzioni contenute nel file allegato.');
  });

  it('1.x: errore {name, data} del provider, export con la riga «Exporting session», motivo dallo stderr', () => {
    expect(mapEngineError({ name: 'APIError', data: { message: 'Forbidden: Authorization failed', statusCode: 403 } })).toMatchObject({ code: 'provider_unavailable' });
    expect(mapEngineError({ name: 'UnknownError', data: { message: 'Unexpected server error.' } })).toMatchObject({ code: 'engine_error', message: 'UnknownError: Unexpected server error.' });
    // 404 «Function … Not found for account» (NVIDIA, 21/10/2026): detto in chiaro e non ritentato.
    const gone = mapEngineError({ name: 'APIError', data: { message: 'Not Found: Function \'abc\': Not found for account \'xyz\'', statusCode: 404, isRetryable: false } });
    expect(gone).toMatchObject({ code: 'engine_error', retryable: false });
    expect(gone.message).toMatch(/^il modello non è disponibile per il tuo account del fornitore \(HTTP 404\): scegline un altro nella squadra\. Dettaglio: Not Found/);
    const doc = JSON.stringify({ info: { id: 'ses_1', tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 0 } } } }, null, 2);
    expect(parseSessionExport(`Exporting session: ses_1\n${doc}`).sessionId).toBe('ses_1');
    expect(parseSessionExport(doc).usage).not.toBeNull();
    expect(stderrReason(RUN_V1, '1.19.3')).toBe('OpenCode 1.19.3 non ha riconosciuto gli argomenti e ha stampato la guida');
    expect(stderrReason('\u001b[31mError: qualcosa\u001b[0m\n\n', null)).toBe('Error: qualcosa');
    expect(stderrReason('  \n', null)).toBeNull();
  });
});

describe('agenti locali: configurazione leggera (22/10/2026)', () => {
  const profile = (id: string) => DEFAULT_ENDPOINT_PROFILES.find((p) => p.id === id)!;
  const config = (id: string, permissions: string) => JSON.parse(buildConfigContent({ model: `${profile(id).provider}/m:7b`, profile: profile(id), permissions })) as Record<string, unknown>;

  it('Ollama: via gli strumenti superflui e il titolo; il terminale solo se permesso', () => {
    const ro = config('ollama', 'read-only');
    const tools = ro.tools as Record<string, boolean>;
    for (const t of LOCAL_TOOLS_OFF) expect(tools[t]).toBe(false);
    expect(tools.bash).toBe(false);
    expect(Object.values(tools).every((v) => v === false)).toBe(true);
    expect(tools.read ?? tools.glob ?? tools.grep ?? tools.edit).toBeUndefined();
    expect(ro.agent).toEqual({ title: { disable: true } });
    expect((config('ollama', 'workspace-exec').tools as Record<string, boolean>).bash).toBeUndefined();
    expect(config('ollama', 'workspace-write').permission).toEqual({ edit: 'allow', bash: 'deny', webfetch: 'deny', external_directory: 'deny' });
  });

  it('servizi in rete: configurazione invariata', () => {
    const nv = config('nvidia', 'workspace-write');
    expect(nv.tools).toBeUndefined();
    expect(nv.agent).toBeUndefined();
    expect(Object.keys(nv)).toEqual(['$schema', 'enabled_providers', 'share', 'autoupdate', 'model', 'provider', 'permission']);
  });
});
