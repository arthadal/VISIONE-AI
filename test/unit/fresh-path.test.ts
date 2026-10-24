// PATH riletto dal registro dopo un'installazione (17/10/2026): senza, il core non trova il programma appena
// installato finché VISIONE non si riavvia. Nessun registro vero: il lettore è finto.
import { describe, expect, it } from 'vitest';
import { expandEnv, mergePaths, parseRegPath, refreshPath } from '../../src/shared/node/fresh-path.ts';

const REG_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools',
  ''
].join('\r\n');

describe('PATH dal registro', () => {
  it('legge il valore di reg query, espande le variabili, unisce senza doppioni', () => {
    expect(parseRegPath(REG_OUTPUT)).toBe('%USERPROFILE%\\.local\\bin;C:\\Tools');
    expect(parseRegPath('nessun valore')).toBeNull();
    expect(expandEnv('%USERPROFILE%\\bin;%NON_ESISTE%\\x', { USERPROFILE: 'C:\\Users\\m' })).toBe('C:\\Users\\m\\bin;%NON_ESISTE%\\x');
    expect(mergePaths('C:\\A;C:\\B\\', 'c:\\b;C:\\C', ';C:\\A;;C:\\D')).toBe('C:\\A;C:\\B\\;C:\\C;C:\\D');
  });

  it('refreshPath: prima sistema e utente (nell\'ordine di Windows), poi ciò che il processo aveva in più', async () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\Vecchio;C:\\Windows', USERPROFILE: 'C:\\Users\\m' };
    const read = async (key: string): Promise<string | null> => (key.startsWith('HKLM') ? 'C:\\Windows;C:\\Program Files\\nodejs\\' : '%USERPROFILE%\\AppData\\Roaming\\npm');
    const out = await refreshPath(env, { read, platform: 'win32' });
    expect(out).toBe('C:\\Windows;C:\\Program Files\\nodejs\\;C:\\Users\\m\\AppData\\Roaming\\npm;C:\\Vecchio');
    expect(env.Path).toBe(out);
  });

  it('registro illeggibile o altro sistema: l\'ambiente resta com\'è', async () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    expect(await refreshPath(env, { read: async () => null, platform: 'win32' })).toBeNull();
    expect(await refreshPath(env, { read: async () => 'C:\\X', platform: 'darwin' })).toBeNull();
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});
