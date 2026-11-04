// Processi di lavoro mai rallentati da Windows (issue #1 su GitHub, idea 8): lo script, la sua lettura e, su
// Windows, la chiamata vera su un processo figlio di prova (nessuna rete, nessun permesso da amministratore).
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { keepFullSpeed, parseQos, qosScript, type QosResult } from '../../src/shared/node/qos.ts';

describe('rallentamento di Windows (EcoQoS e risoluzione del timer)', () => {
  it('lo script porta solo pid numerici e chiede maschera 5 e stato 0', () => {
    const script = qosScript([123, 456]);
    expect(script).toContain('foreach ($id in @(123, 456))');
    expect(script).toContain('$t.ControlMask = 5; $t.StateMask = 0');
    expect(script).toContain('SetProcessInformation($h, 4,');
  });

  it("l'uscita si legge riga per riga; il resto si ignora", () => {
    expect(parseQos('12 ok 5 0\r\n999 err 87\r\nrumore\n')).toEqual([
      { pid: 12, ok: true, detail: '5 0' },
      { pid: 999, ok: false, detail: '87' }
    ]);
  });

  it.runIf(process.platform === 'win32')('su Windows: il processo figlio resta a piena velocità, un pid inesistente dà errore', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      const pid = child.pid as number;
      const results = await new Promise<QosResult[]>((resolve, reject) => {
        keepFullSpeed([pid, 999_999_996], (r, error) => (error ? reject(new Error(error)) : resolve(r)));
      });
      expect(results).toEqual([{ pid, ok: true, detail: '5 0' }, { pid: 999_999_996, ok: false, detail: expect.stringMatching(/^\d+$/) }]);
    } finally {
      child.kill();
    }
  }, 30_000);
});
