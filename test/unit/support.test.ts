// Segnala un problema (11/10/2026): il pacchetto non deve contenere dati personali né segreti.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditLog } from '../../src/core/audit/index.ts';
import { anonymize, createSupport, REPORT_LOG_LINES, reportName, tailLines } from '../../src/core/support/index.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const ctx = { userHome: 'C:\\Users\\Mario', userName: 'Mario', computerName: 'PC-DI-MARIO' };

describe('Segnala un problema', () => {
  it('anonimizza: home in ogni forma, utente, PC, email e segreti', () => {
    const text = [
      'aperto C:\\Users\\Mario\\Documenti\\contratto.pdf',
      'json "C:\\\\Users\\\\Mario\\\\AppData\\\\x"',
      'avanti c:/users/mario/Desktop',
      'utente Mario su PC-DI-MARIO, scrivi a mario.rossi@example.com',
      // chiave finta costruita qui: nel repository non deve esistere nemmeno una forma di segreto
      `NVIDIA_API_KEY=${'nvapi'}-${'x'.repeat(32)}`,
      'Marione resta (non è il nome intero)',
      'anteprima visione-thumb://local/C%3A%5CUsers%5CMario%5CDownloads%5Cx.exe e altro%2FMario%2Fy'
    ].join('\n');
    const out = anonymize(text, ctx);
    expect(out).toContain('%USERPROFILE%\\Documenti\\contratto.pdf');
    expect(out).toContain('"%USERPROFILE%\\\\AppData\\\\x"');
    expect(out).toContain('%USERPROFILE%/Desktop');
    expect(out).toContain('utente <utente> su <pc>');
    expect(out).toContain('<email>');
    expect(out).not.toMatch(/nvapi-/);
    expect(out).toContain('Marione');
    expect(out.toLowerCase()).not.toMatch(/users[\\/]+mario/);
    expect(out).toContain('visione-thumb://local/%USERPROFILE%%5CDownloads');
    expect(out).toContain('altro%2F<utente>%2Fy');
    expect(out.replace('Marione', '')).not.toMatch(/Mario/);
  });

  it('ultime righe e nome del pacchetto', () => {
    expect(tailLines('a\n\nb\r\nc\n', 2)).toEqual(['b', 'c']);
    expect(reportName(new Date(2026, 9, 11, 9, 5, 7).getTime())).toBe('segnalazione-20261011-090507');
  });

  it('pacchetto: descrizione, informazioni e registri ripuliti; zip; audit', async () => {
    const home = tempHome('visione-support-').dir;
    const logs = join(home, 'logs');
    mkdirSync(logs);
    const many = Array.from({ length: REPORT_LOG_LINES + 50 }, (_, i) => JSON.stringify({ n: i, path: `C:\\Users\\Mario\\file${i}.txt` }));
    writeFileSync(join(logs, 'core.jsonl'), many.join('\n'));
    const audits: Array<Record<string, unknown>> = [];
    const zips: string[] = [];
    const support = createSupport({
      visionHome: home, logsDir: logs, privacy: ctx,
      app: { versione: '1.1.0-beta.9' },
      snapshot: () => ({ errori: 2 }),
      config: () => ({ voice: { volume: 250 }, secrets: { token: 'segretissimo-123456' }, ui: { note: 'C:\\Users\\Mario\\x' } }),
      audit: { record: (e: Record<string, unknown>) => audits.push(e) } as unknown as AuditLog,
      log: memoryLogger('error').log,
      now: () => new Date(2026, 9, 11, 22, 0, 0).getTime(),
      zip: async (src, dst) => { zips.push(`${src}→${dst}`); return true; }
    });
    const r = await support.report('VISIONE si è bloccata mentre Mario apriva C:\\Users\\Mario\\Desktop', 'owner:ui');
    expect(r.zipped).toBe(true);
    expect(r.file.endsWith('segnalazione-20261011-220000.zip')).toBe(true);
    expect(r.files).toEqual(['descrizione.txt', 'informazioni.json', 'core.jsonl']);
    const all = r.files.map((f) => readFileSync(join(r.folder, f), 'utf8')).join('\n');
    expect(all).not.toMatch(/Mario/);
    expect(all).not.toMatch(/segretissimo/);
    expect(readFileSync(join(r.folder, 'core.jsonl'), 'utf8').trim().split('\n')).toHaveLength(REPORT_LOG_LINES);
    expect(JSON.parse(readFileSync(join(r.folder, 'informazioni.json'), 'utf8')).app.versione).toBe('1.1.0-beta.9');
    expect(zips).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'support.report', decision: 'done' });
  });
});
