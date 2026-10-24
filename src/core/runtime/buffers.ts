// Gestione dell'uscita dei processi: righe complete (anche quando una riga arriva spezzata in più
// blocchi), righe troppo lunghe spezzate senza perderne nulla, coda limitata per la diagnosi.

/** Lunghezza massima di una riga consegnata in un pezzo; oltre viene spezzata (`partial`). */
export const MAX_LINE = 1024 * 1024;

export interface Line {
  readonly text: string;
  /** La riga continua nel pezzo successivo (era più lunga di MAX_LINE). */
  readonly partial: boolean;
}

export class LineSplitter {
  private pending = '';
  private readonly maxLine: number;
  constructor(maxLine = MAX_LINE) {
    this.maxLine = maxLine;
  }

  /** Righe complete contenute nel blocco; il resto attende il blocco successivo. */
  push(chunk: string): Line[] {
    const out: Line[] = [];
    let data = this.pending + chunk;
    for (;;) {
      const nl = data.indexOf('\n');
      if (nl === -1) break;
      const line = data.slice(0, nl);
      data = data.slice(nl + 1);
      this.split(line.endsWith('\r') ? line.slice(0, -1) : line, out);
    }
    while (data.length > this.maxLine) {
      out.push({ text: data.slice(0, this.maxLine), partial: true });
      data = data.slice(this.maxLine);
    }
    this.pending = data;
    return out;
  }

  /** Fine del flusso: l'ultima riga senza a-capo non va persa. */
  flush(): Line[] {
    if (this.pending === '') return [];
    const out: Line[] = [];
    this.split(this.pending, out);
    this.pending = '';
    return out;
  }

  private split(line: string, out: Line[]): void {
    let rest = line;
    while (rest.length > this.maxLine) {
      out.push({ text: rest.slice(0, this.maxLine), partial: true });
      rest = rest.slice(this.maxLine);
    }
    out.push({ text: rest, partial: false });
  }
}

/** Ultimi `capacity` caratteri di un flusso. */
export class TailBuffer {
  private data = '';
  private total = 0;
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  append(chunk: string): void {
    this.total += chunk.length;
    this.data = (this.data + chunk).slice(-this.capacity);
  }

  get text(): string {
    return this.data;
  }

  /** Caratteri ricevuti in tutto (anche quelli usciti dalla coda). */
  get length(): number {
    return this.total;
  }
}

/** Divide un testo in pezzi di al più `size` caratteri (per gli eventi di uscita). */
export function chunks(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
