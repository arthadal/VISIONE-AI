// Mappa del codice (P-107l): simboli e import di un file, con espressioni regolari per linguaggio. Non è
// un compilatore: basta trovare DOVE sta una funzione, una classe o un tipo (file e riga), che è ciò che
// fa risparmiare all'agente l'esplorazione. Funzioni pure, testate.
import { posix } from 'node:path';
import { CODEMAP_LIMITS } from '../../shared/contracts/index.ts';

export type SymbolKind = 'function' | 'class' | 'type' | 'method' | 'const' | 'section' | 'table';

export interface CodeSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly exported: boolean;
}

export interface FileFacts {
  readonly lang: string;
  readonly lines: number;
  readonly symbols: CodeSymbol[];
  /** Destinazioni degli import interni, come percorso relativo alla radice senza estensione. */
  readonly imports: string[];
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  py: 'py', go: 'go', rs: 'rs', cs: 'cs', java: 'java', kt: 'kt', kts: 'kt', php: 'php', rb: 'rb',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cxx: 'c', swift: 'swift', dart: 'dart',
  md: 'md', sql: 'sql', ps1: 'ps1', psm1: 'ps1', sh: 'sh',
  // Indicizzati per percorso (il nome del file conta), senza simboli.
  json: 'data', yml: 'data', yaml: 'data', toml: 'data', css: 'style', scss: 'style', html: 'html', xml: 'data', txt: 'text'
};

/** Il linguaggio dall'estensione, o null se il file non si indicizza. */
export function langOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return LANG_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Percorso senza estensione: la chiave con cui un import trova il suo file. */
export function importKey(path: string): string {
  const p = path.replace(/\\/g, '/');
  const noExt = p.replace(/\.(?:d\.)?[a-z]+$/i, '');
  // «cartella/index.ts» e «pacchetto/__init__.py» si importano col nome della cartella.
  return noExt.replace(/\/(?:index|__init__)$/, '');
}

const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'else', 'do', 'try', 'with', 'await', 'typeof', 'super', 'this', 'constructor', 'elif', 'using', 'lock', 'foreach', 'sizeof', 'defined']);

type Rule = readonly [RegExp, SymbolKind, boolean?];

// Prime righe: il gruppo 1 è il nome. Il terzo valore: il simbolo è esportato.
const RULES: Record<string, readonly Rule[]> = {
  ts: [
    [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function', true],
    [/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class', true],
    [/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*export\s+(?:declare\s+)?(?:interface|type|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)/, 'type', true],
    [/^(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
    [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, 'function', true],
    [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'const', true],
    [/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, 'function'],
    [/^(?:const|let)\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, 'const'],
    // Metodi di classi e di oggetti restituiti: «  build(input) {», «  async start(): Promise<void> {».
    [/^\s{2,8}(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^={;]+)?\{\s*$/, 'method']
  ],
  py: [
    [/^def\s+([A-Za-z_]\w*)/, 'function', true],
    [/^async\s+def\s+([A-Za-z_]\w*)/, 'function', true],
    [/^class\s+([A-Za-z_]\w*)/, 'class', true],
    [/^\s{4}(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'method'],
    [/^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, 'const']
  ],
  go: [
    [/^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, 'method'],
    [/^func\s+([A-Za-z_]\w*)/, 'function'],
    [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type'],
    [/^type\s+([A-Za-z_]\w*)\s/, 'type']
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/, 'class']
  ],
  cs: [
    [/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|unsafe|file)\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s+(?:(?:public|private|protected|internal|static|override|virtual|async|abstract|sealed|extern|unsafe|new|partial)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/, 'method']
  ],
  java: [
    [/^\s*(?:@\w+\s+)*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/, 'method']
  ],
  kt: [
    [/^\s*(?:(?:public|private|internal|protected|open|abstract|sealed|data|enum|inner|value)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s*(?:(?:public|private|internal|protected|override|open|suspend|inline|operator|infix)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, 'function']
  ],
  swift: [
    [/^\s*(?:(?:public|private|internal|open|fileprivate|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s*(?:(?:public|private|internal|open|fileprivate|static|override|mutating|final|@\w+)\s+)*func\s+([A-Za-z_]\w*)/, 'function']
  ],
  dart: [
    [/^\s*(?:abstract\s+)?(?:class|mixin|enum|extension)\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s*(?:static\s+)?(?:Future<[^>]*>|void|[A-Z]\w*(?:<[^>]*>)?|int|double|bool|String)\s+([a-z_]\w*)\s*\(/, 'function']
  ],
  php: [
    [/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/, 'function']
  ],
  rb: [
    [/^\s*(?:class|module)\s+([A-Z]\w*)/, 'class'],
    [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, 'function']
  ],
  c: [
    [/^(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, 'type'],
    [/^(?:[A-Za-z_][\w:<>,*&\s]*?[\s*&])([A-Za-z_][\w:]*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/, 'function'],
    [/^#define\s+([A-Za-z_]\w*)/, 'const']
  ],
  sql: [[/^\s*create\s+(?:or\s+replace\s+)?(?:temp\s+|temporary\s+)?(?:table|view|index|trigger|function|procedure)\s+(?:if\s+not\s+exists\s+)?["`[]?([A-Za-z_][\w.]*)/i, 'table']],
  ps1: [[/^\s*function\s+([A-Za-z_][\w-]*)/i, 'function']],
  sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/, 'function']]
};
RULES.js = RULES.ts!;

const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Simboli e import di un file. `path` è relativo alla radice, con le barre in avanti. */
export function extractFacts(path: string, text: string): FileFacts {
  const lang = langOf(path) ?? 'text';
  const lines = text.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const imports = new Set<string>();
  const dir = posix.dirname(path);
  const rules = RULES[lang];
  let fence = false;
  for (let i = 0; i < lines.length && symbols.length < CODEMAP_LIMITS.maxSymbolsPerFile; i++) {
    const raw = lines[i]!;
    if (raw.length > 400) continue;
    if (lang === 'md') {
      if (/^\s*```/.test(raw)) fence = !fence;
      const h = fence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(raw);
      if (h) symbols.push({ name: h[2]!.slice(0, 120), kind: 'section', line: i + 1, exported: h[1]!.length <= 2 });
      continue;
    }
    if (!rules) continue;
    for (const [re, kind, exported] of rules) {
      const m = re.exec(raw);
      const name = m?.[1];
      if (!name || NOT_NAMES.has(name) || name.length > 120) continue;
      symbols.push({ name, kind, line: i + 1, exported: exported === true });
      break;
    }
  }
  if (lang === 'ts' || lang === 'js') {
    for (const m of text.matchAll(JS_IMPORT)) imports.add(importKey(posix.normalize(posix.join(dir, m[1]!))));
  } else if (lang === 'py') {
    for (const m of text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import/gm)) {
      let base = dir;
      for (let k = 1; k < m[1]!.length; k++) base = posix.dirname(base);
      imports.add(importKey(posix.normalize(posix.join(base, m[2]!.replace(/\./g, '/')))));
    }
    for (const m of text.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm)) {
      const mod = m[1] ?? m[2];
      if (mod) imports.add(mod.replace(/\./g, '/'));
    }
  }
  imports.delete(importKey(path));
  return { lang, lines: lines.length, symbols, imports: [...imports].filter((k) => k !== '' && k !== '.' && !k.startsWith('..')) };
}
