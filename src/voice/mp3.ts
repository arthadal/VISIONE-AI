// Allineamento dei frame MP3 (P-84): Edge Read Aloud produce MP3 a blocchi che possono spezzare un
// frame. Il renderer decodifica con Web Audio `decodeAudioData`: consegnare blocchi allineati al
// confine di frame evita di perdere l'ultimo frame parziale a ogni blocco (glitch udibili). Qui non
// si decodifica nulla: si riconosce l'intestazione MPEG (4 byte) e si ritagliano solo frame interi.

/** Bitrate (kbps) per indice, MPEG-1 Layer III. */
const BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
/** Bitrate (kbps) per indice, MPEG-2/2.5 Layer III. */
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
/** Frequenze (Hz) per indice, nelle tre versioni. */
const SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000], // MPEG-2.5
  2: [22050, 24000, 16000], // MPEG-2
  3: [44100, 48000, 32000] // MPEG-1
};

/**
 * Dimensione in byte del frame MP3 che inizia a `offset`, o null se lì non c'è un'intestazione
 * valida (Layer III, bitrate e frequenza noti). Non lancia mai.
 */
export function mp3FrameSize(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  const b0 = data[offset]!;
  const b1 = data[offset + 1]!;
  const b2 = data[offset + 2]!;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = riservata
  const layer = (b1 >> 1) & 0x03; // 1 = Layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleIndex = (b2 >> 2) & 0x03;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const mpeg1 = version === 3;
  const sampleRate = SAMPLE_RATES[version]![sampleIndex]!;
  const bitrate = (mpeg1 ? BITRATE_V1 : BITRATE_V2)[bitrateIndex]!;
  const padding = (b2 >> 1) & 0x01;
  return Math.floor(((mpeg1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding;
}

/**
 * Accumula byte MP3 e restituisce, a ogni `feed`, un blocco di soli frame interi (i byte parziali
 * restano in attesa). Eventuali byte fuori sincrono sono scartati dal decoder a valle; qui si cerca
 * la prossima intestazione valida. `flush` libera la coda (fine dello stream).
 */
export class Mp3Framer {
  private pending = new Uint8Array(0);
  /** Frame interi emessi finora (diagnostica onesta nei log). */
  frames = 0;

  feed(bytes: Uint8Array): Uint8Array[] {
    if (bytes.length === 0) return [];
    const data = new Uint8Array(this.pending.length + bytes.length);
    data.set(this.pending);
    data.set(bytes, this.pending.length);
    let cursor = 0;
    let chunkStart = -1;
    let chunkEnd = -1;
    let complete = 0;
    while (cursor + 4 <= data.length) {
      const size = mp3FrameSize(data, cursor);
      if (size === null) {
        cursor += 1;
        continue;
      }
      if (cursor + size > data.length) break; // frame incompleto: si attende il prossimo blocco
      if (chunkStart < 0) chunkStart = cursor;
      chunkEnd = cursor + size;
      complete += 1;
      cursor += size;
    }
    const out: Uint8Array[] = [];
    if (chunkStart >= 0 && chunkEnd > chunkStart) {
      out.push(data.slice(chunkStart, chunkEnd));
      this.frames += complete;
    }
    this.pending = data.slice(cursor);
    return out;
  }

  /** Coda non ancora emessa (frame finale incompleto): null se non c'è nulla. */
  flush(): Uint8Array | null {
    if (this.pending.length === 0) return null;
    const tail = this.pending;
    this.pending = new Uint8Array(0);
    return tail;
  }
}
