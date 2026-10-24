// Collegamento a Electron degli schemi dell'Esplora (`file-protocol.ts`): registrazione come schemi
// sicuri prima di `ready`, poi i gestori sulla sessione. Ogni richiesta rifà i controlli della
// politica sul percorso REALE (dopo i collegamenti simbolici): niente fuori dalle radici consentite.
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { app, nativeImage, protocol, shell, type Session } from 'electron';
import type { Logger } from '../shared/node/logging.ts';
import { FILE_SCHEME, isServablePath, mimeOf, parseRange, parseSchemeUrl, THUMB_SCHEME, type FilePolicy } from './file-protocol.ts';

/** Da chiamare PRIMA di `app.whenReady()`. */
export function registerFileSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: THUMB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ]);
}

const notFound = (): Response => new Response('non disponibile', { status: 404 });
const png = (image: Electron.NativeImage, maxAge: number): Response =>
  new Response(new Uint8Array(image.toPNG()), { headers: { 'content-type': 'image/png', 'cache-control': `max-age=${maxAge}` } });

const isShortcut = (p: string): boolean => /\.lnk$/i.test(p);

/** Da dove prendere l'icona: per un collegamento quella del programma a cui porta, come in Esplora risorse. */
function iconSources(real: string): string[] {
  if (!isShortcut(real)) return [real];
  try {
    const link = shell.readShortcutLink(real);
    return [link.icon, link.target, real].filter((p): p is string => typeof p === 'string' && p !== '');
  } catch {
    return [real];
  }
}

/** Icona di Windows del file (programmi, collegamenti, archivi…): il ripiego quando non c'è una miniatura. */
async function fileIcon(real: string): Promise<Response> {
  for (const source of iconSources(real)) {
    try {
      const icon = await app.getFileIcon(source, { size: 'large' });
      if (!icon.isEmpty()) return png(icon, 300);
    } catch {
      // sorgente illeggibile (percorso con variabili, programma disinstallato): si prova la successiva
    }
  }
  return notFound();
}

/** Percorso reale servibile, o null. */
function realServable(path: string, policy: FilePolicy): string | null {
  if (!isServablePath(path, policy)) return null;
  try {
    const real = realpathSync.native(path);
    return isServablePath(real, policy) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function handleFileSchemes(session: Session, policy: FilePolicy, log: Logger): void {
  session.protocol.handle(FILE_SCHEME, (request) => {
    const parsed = parseSchemeUrl(request.url, FILE_SCHEME);
    const real = parsed ? realServable(parsed.path, policy) : null;
    const mime = real ? mimeOf(real) : null;
    if (!real || !mime) {
      log.warn('anteprima negata', { url: request.url.slice(0, 200) });
      return notFound();
    }
    const size = statSync(real).size;
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'invalid') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const body = size === 0 ? null : (Readable.toWeb(createReadStream(real, { start, end })) as ReadableStream);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        'content-type': mime,
        'content-length': String(size === 0 ? 0 : end - start + 1),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
      }
    });
  });
  session.protocol.handle(THUMB_SCHEME, async (request) => {
    const parsed = parseSchemeUrl(request.url, THUMB_SCHEME);
    const real = parsed ? realServable(parsed.path, policy) : null;
    if (!parsed || !real) return notFound();
    if (isShortcut(real)) return fileIcon(real);
    try {
      const image = await nativeImage.createThumbnailFromPath(real, { width: parsed.size, height: parsed.size });
      return image.isEmpty() ? fileIcon(real) : png(image, 60);
    } catch {
      // Nessuna miniatura per questo tipo di file (programmi, archivi, testi): l'icona di Windows.
      return fileIcon(real);
    }
  });
}
