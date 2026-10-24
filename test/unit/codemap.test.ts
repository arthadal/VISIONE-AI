// Mappa del codice (P-107l): simboli per linguaggio, parole del compito, punteggio e grafo, indice
// incrementale su una cartella vera, sezione del brief.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodeMap, mentionedRoots, rootProblem } from '../../src/core/codemap/index.ts';
import { rankFiles, renderMap, taskTerms, type IndexedFile } from '../../src/core/codemap/rank.ts';
import { extractFacts, importKey } from '../../src/core/codemap/symbols.ts';
import { migrate, openDb } from '../../src/core/db/index.ts';
import { COMMAND_DEFINITIONS } from '../../src/shared/contracts/index.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const names = (text: string, path: string): string[] => extractFacts(path, text).symbols.map((s) => `${s.kind}:${s.name}:${s.line}`);

describe('simboli', () => {
  it('TypeScript: funzioni, classi, tipi, costanti, frecce, metodi e import interni', () => {
    const ts = [
      "import { a } from './util/index.ts';",
      "import type { B } from '../shared/b';",
      "const lazy = await import('./lazy.js');",
      'export function createThing(x: number): string {',
      '  if (x) {',
      '  }',
      '}',
      'export class Engine extends Base {',
      '  async start(): Promise<void> {',
      '  }',
      '}',
      'export interface Options { a: number }',
      'type Local = string;',
      'export const LIMIT = 5;',
      'export const handler = async (req: Request) => {',
      'const helper = (s: string): number => s.length;',
      'function inner() {}'
    ].join('\n');
    expect(names(ts, 'src/core/thing.ts')).toEqual([
      'function:createThing:4', 'class:Engine:8', 'method:start:9', 'type:Options:12', 'type:Local:13', 'const:LIMIT:14',
      'function:handler:15', 'function:helper:16', 'function:inner:17'
    ]);
    expect(extractFacts('src/core/thing.ts', ts).imports.sort()).toEqual(['src/core/lazy', 'src/core/util', 'src/shared/b']);
    expect(extractFacts('src/core/thing.ts', ts).symbols.find((s) => s.name === 'createThing')?.exported).toBe(true);
  });

  it('Python, Go, Rust, C#, SQL e titoli dei documenti', () => {
    expect(names('import os\nfrom .models import User\n\nclass Shop:\n    def buy(self):\n        pass\n\ndef main():\n    pass\nMAX_ITEMS = 3', 'app/shop.py'))
      .toEqual(['class:Shop:4', 'method:buy:5', 'function:main:8', 'const:MAX_ITEMS:10']);
    expect(extractFacts('app/shop.py', 'from .models import User\nfrom pkg.core import x').imports.sort()).toEqual(['app/models', 'pkg/core']);
    expect(names('package main\nfunc (s *Server) Serve() {}\nfunc main() {}\ntype Server struct {', 'cmd/main.go')).toEqual(['method:Serve:2', 'function:main:3', 'type:Server:4']);
    expect(names('pub struct Cache {}\nimpl Cache {\n    pub fn get(&self) {}\n}\nasync fn run() {}', 'src/cache.rs')).toEqual(['type:Cache:1', 'class:Cache:2', 'function:get:3', 'function:run:5']);
    expect(names('namespace X {\npublic sealed class Invoice {\n    public decimal Total(int n) {\n    }\n}', 'Invoice.cs')).toEqual(['class:Invoice:2', 'method:Total:3']);
    expect(names('CREATE TABLE IF NOT EXISTS orders (id INT);', 'db/schema.sql')).toEqual(['table:orders:1']);
    expect(names('# Guida\n\n```\n# non un titolo\n```\n## Installazione\n#### troppo profondo', 'README.md')).toEqual(['section:Guida:1', 'section:Installazione:6']);
  });

  it('chiave degli import: senza estensione, la cartella per index e __init__', () => {
    expect(importKey('src/core/index.ts')).toBe('src/core');
    expect(importKey('pkg/__init__.py')).toBe('pkg');
    expect(importKey('src/a.d.ts')).toBe('src/a');
  });
});

describe('parole del compito', () => {
  it('toglie le parole generiche, spezza camelCase e snake_case, riconosce i nomi di file', () => {
    const { terms, names: files } = taskTerms('Correggi createContextBuilder in context.ts: il file deve leggere max_items');
    // «create» è un verbo generico: resta solo come parte del nome intero.
    expect(terms).toEqual(['createcontextbuilder', 'context', 'builder', 'leggere', 'max_items', 'max', 'items']);
    expect(files).toEqual(['context.ts']);
  });
});

const file = (id: number, path: string, symbols: [string, number, boolean?][], imports: string[] = []): IndexedFile => ({
  id, path, key: importKey(path), imports,
  symbols: symbols.map(([name, line, exported]) => ({ name, kind: 'function', line, exported: exported === true }))
});

describe('punteggio e grafo', () => {
  const files = [
    file(1, 'src/billing/invoice.ts', [['createInvoice', 10, true], ['invoiceTotal', 40, true]], ['src/billing/tax']),
    file(2, 'src/billing/tax.ts', [['vatRate', 3, true], ['applyVat', 12, true]]),
    file(3, 'src/ui/InvoicePage.tsx', [['InvoicePage', 5, true]], ['src/billing/invoice']),
    file(4, 'src/auth/login.ts', [['login', 2, true]]),
    file(5, 'docs/notes.md', [])
  ];

  it('prima il file col simbolo esatto, poi i collegati dal grafo; niente se il compito non c\'entra', () => {
    const ranked = rankFiles(files, 'Il totale di createInvoice è sbagliato');
    expect(ranked.map((r) => [r.file.path, r.via])).toEqual([
      ['src/billing/invoice.ts', null],
      ['src/billing/tax.ts', 'src/billing/invoice.ts'],
      // «invoice» (parte di createInvoice) è nel nome del file e del componente: entra da solo.
      ['src/ui/InvoicePage.tsx', null]
    ]);
    expect(ranked[0]!.matched.map((s) => s.name)).toEqual(['createInvoice', 'invoiceTotal']);
    expect(rankFiles(files, 'Scrivi una poesia sul mare')).toEqual([]);
  });

  it('compito in italiano, codice in inglese: le traduzioni ordinano ma da sole non fanno entrare la mappa', () => {
    const code = [
      file(1, 'src/app/clipboard.ts', [['readClipboard', 4, true]]),
      file(2, 'src/app/terminal.ts', [['pasteInTerminal', 9, true]]),
      file(3, 'src/agenda/reminders.ts', [['addReminder', 3, true]])
    ];
    // «terminale» c'è davvero (terminal.ts); «appunti» porta con sé «clipboard».
    expect(rankFiles(code, 'Incollare gli appunti nel terminale non funziona').map((r) => r.file.path)).toEqual(['src/app/terminal.ts', 'src/app/clipboard.ts']);
    // Solo traduzioni («ricordami» → reminder): non è un compito di codice.
    expect(rankFiles(code, 'Ricordami di chiamare Luca')).toEqual([]);
  });

  it('la sezione: cartella, file e righe, entro il tetto di caratteri', () => {
    const lines = renderMap('C:\\progetto', 5, rankFiles(files, 'Correggi createInvoice'));
    expect(lines[0]).toContain('C:\\progetto (5 file indicizzati');
    expect(lines[1]).toBe('- src/billing/invoice.ts — createInvoice (r. 10), invoiceTotal (r. 40)');
    expect(lines[2]).toContain('collegato a invoice.ts');
    // Se non entra nemmeno un file, niente sezione.
    expect(renderMap('C:\\p', 5, rankFiles(files, 'Correggi createInvoice'), 150)).toEqual([]);
  });
});

describe('indice di una cartella vera', () => {
  const setup = () => {
    const { dir, cleanup } = tempHome('visione-codemap-');
    const db = openDb(join(dir, 'visione.db'));
    migrate(db);
    cleanups.push(() => {
      db.close();
      cleanup();
    });
    const root = join(dir, 'progetto');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'src', 'cart.ts'), "import { price } from './price.ts';\nexport function addToCart(id: string) {\n  return price(id);\n}\n");
    writeFileSync(join(root, 'src', 'price.ts'), 'export function price(id: string): number {\n  return 1;\n}\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'export function addToCart() {}');
    writeFileSync(join(root, '.git', 'config.txt'), 'x');
    writeFileSync(join(root, 'logo.png'), 'not indexed');
    const roots = [root];
    const { log } = memoryLogger();
    const map = createCodeMap({ db, log, roots: () => roots });
    cleanups.unshift(() => map.close());
    return { db, map, root, roots };
  };

  it('indicizza il progetto (non le dipendenze né le cartelle nascoste) e risponde al compito', async () => {
    const { map, root } = setup();
    expect(map.status()).toMatchObject([{ root, files: 0, scannedAt: null, inUse: true, enabled: true }]);
    const st = await map.scan(root);
    expect(st).toMatchObject({ root, files: 2, symbols: 2, truncated: false, error: null, scanning: false });
    const lines = map.forTurn(root, 'Il pulsante addToCart non aggiunge niente');
    expect(lines[1]).toBe('- src/cart.ts — addToCart (r. 2)');
    expect(lines[2]).toBe('- src/price.ts — price (r. 1) · collegato a cart.ts');
  });

  it('incrementale: un file cambiato si rilegge, uno cancellato sparisce', async () => {
    const { map, root } = setup();
    await map.scan(root);
    writeFileSync(join(root, 'src', 'cart.ts'), 'export function removeFromCart(id: string) {}\n');
    utimesSync(join(root, 'src', 'cart.ts'), new Date(), new Date(Date.now() + 5_000));
    rmSync(join(root, 'src', 'price.ts'));
    expect(await map.scan(root)).toMatchObject({ files: 1, symbols: 1 });
    expect(map.forTurn(root, 'sistema removeFromCart')[1]).toBe('- src/cart.ts — removeFromCart (r. 1)');
    expect(map.forTurn(root, 'sistema price')).toEqual([]);
  });

  it('spenta per una cartella: niente nel brief', async () => {
    const { map, root } = setup();
    await map.scan(root);
    expect(map.setEnabled(root, false).enabled).toBe(false);
    expect(map.forTurn(root, 'addToCart')).toEqual([]);
    expect(map.status()[0]).toMatchObject({ enabled: false, inUse: true });
  });

  it('cartelle citate nel compito: dal file si risale alla radice del progetto, poi la mappa la usa', async () => {
    const { map, root } = setup();
    const other = join(root, '..', 'altro-progetto');
    mkdirSync(join(other, 'src', 'deep'), { recursive: true });
    writeFileSync(join(other, 'package.json'), '{}');
    writeFileSync(join(other, 'src', 'deep', 'invoice.ts'), 'export function createInvoice() {}\n');
    const task = `Correggi createInvoice in ${join(other, 'src', 'deep', 'invoice.ts')}, grazie.`;
    expect(mentionedRoots(task)).toEqual([other]);
    expect(mentionedRoots(`lavora su ${join(other, 'src')} e poi riferisci`)).toEqual([other]);
    expect(mentionedRoots('copia in C:\\Windows\\System32 e in C:\\')).toEqual([]);
    expect(mentionedRoots('niente percorsi qui')).toEqual([]);
    // Prima volta: la cartella citata parte in background, intanto c'è quella dell'agente (qui niente di pertinente).
    expect(map.forTurn(root, task)).toEqual([]);
    await map.scan(other);
    const lines = map.forTurn(root, task);
    expect(lines[0]).toContain(other);
    expect(lines[1]).toBe('- src/deep/invoice.ts — createInvoice (r. 1)');
  });

  it('cartelle rifiutate: disco intero, cartella utente, inesistente', () => {
    expect(rootProblem('C:\\')).toBe('è un disco intero');
    expect(rootProblem(homedir())).toBe('è la cartella utente intera');
    expect(rootProblem(join(homedir(), 'non-esiste-visione-xyz'))).toBe('cartella non trovata');
    expect(rootProblem('relativo/cartella')).toBe('percorso non assoluto');
  });

  it('lo stato rispetta il contratto del comando', async () => {
    const { map, root } = setup();
    await map.scan(root);
    expect(COMMAND_DEFINITIONS['codemap.status'].result.safeParse({ roots: map.status() }).success).toBe(true);
  });
});
