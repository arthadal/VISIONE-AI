// Frame del canale main ↔ core (parentPort del utilityProcess). Validati in entrambe le direzioni.
import { z } from 'zod';
import { commandEnvelopeSchema, commandResponseSchema } from './commands.ts';
import { correlationIdSchema, visioneEventSchema } from './events.ts';
import { coreToVoiceSchema, voiceToCoreSchema } from './voice.ts';

export const FRAME_VERSION = 1;
const v = z.literal(FRAME_VERSION);

export const mainToCoreFrameSchema = z.discriminatedUnion('kind', [
  /** Comando da eseguire. */
  z.strictObject({ v, kind: z.literal('cmd'), command: commandEnvelopeSchema }),
  /** Annulla un comando in corso (timeout lato main o richiesta esplicita). */
  z.strictObject({ v, kind: z.literal('cancel'), id: correlationIdSchema, reason: z.string().max(200) }),
  /** Eventi prodotti dal main da registrare nel journal (supervisore, ciclo di vita dell'app). */
  z.strictObject({ v, kind: z.literal('ingest'), events: z.array(visioneEventSchema).max(500) }),
  /** Heartbeat del supervisore. */
  z.strictObject({ v, kind: z.literal('hb'), n: z.number().int().nonnegative() }),
  /** Spegnimento cooperativo entro `deadlineMs`. */
  z.strictObject({ v, kind: z.literal('shutdown'), reason: z.string().max(200), deadlineMs: z.number().int().positive() }),
  /** Fatti del processo voce (o del suo ciclo di vita), inoltrati dal main senza logica (Fase 9). */
  z.strictObject({ v, kind: z.literal('voice'), msg: voiceToCoreSchema })
]);
export type MainToCoreFrame = z.infer<typeof mainToCoreFrameSchema>;

export const coreToMainFrameSchema = z.discriminatedUnion('kind', [
  /** Core avviato: journal aperto, gestori registrati. */
  z.strictObject({ v, kind: z.literal('ready'), pid: z.number().int(), coreVersion: z.string(), startupMs: z.number().nonnegative() }),
  z.strictObject({ v, kind: z.literal('res'), response: commandResponseSchema }),
  z.strictObject({ v, kind: z.literal('evt'), event: visioneEventSchema }),
  /** Id degli eventi di `ingest` registrati (anche se già presenti): il main può scartarli. */
  z.strictObject({ v, kind: z.literal('ingested'), ids: z.array(z.string()).max(500) }),
  z.strictObject({ v, kind: z.literal('hb-ack'), n: z.number().int().nonnegative() }),
  /** Spegnimento completato, il processo sta per uscire con codice 0. */
  z.strictObject({ v, kind: z.literal('stopped') }),
  /** Errore che impedisce l'avvio o la prosecuzione; il processo esce con codice ≠ 0. */
  z.strictObject({ v, kind: z.literal('fatal'), message: z.string().max(2000) }),
  /** Ordini al processo voce (o al main per il suo ciclo di vita, `control`). */
  z.strictObject({ v, kind: z.literal('voice'), msg: coreToVoiceSchema })
]);
export type CoreToMainFrame = z.infer<typeof coreToMainFrameSchema>;

type Distribute<U> = U extends unknown ? Omit<U, 'v'> : never;
export type MainToCoreFrameBody = Distribute<MainToCoreFrame>;
export type CoreToMainFrameBody = Distribute<CoreToMainFrame>;
