// Contratto dell'Assistente personale (beta.5, P-109): promemoria e appuntamenti locali, tabella
// `reminders` (migrazione 9). Tutto resta sul PC: nessun servizio esterno.
import { z } from 'zod';

export const ASSISTANT_LIMITS = {
  textChars: 500,
  /** Rinvio massimo di un promemoria («tra 10 minuti», «domani»): una settimana. */
  snoozeMaxMinutes: 7 * 24 * 60,
  listMax: 200,
  /** Avviso prima di un appuntamento. */
  appointmentLeadMinutes: 15,
  /** P-109b: liste («spesa», «regali»…): elementi per lista, lunghezza di un elemento e del nome. */
  listItems: 200,
  itemChars: 120,
  listNameChars: 40,
  lists: 20
} as const;

/** P-109b: il timer è un promemoria a durata («tra 10 minuti») che scatta con «tempo scaduto». */
export const reminderKindSchema = z.enum(['reminder', 'appointment', 'timer']);
export type ReminderKind = z.infer<typeof reminderKindSchema>;

/** pending = in attesa; fired = scattato e non ancora chiuso; done/cancelled = chiusi. */
export const reminderStatusSchema = z.enum(['pending', 'fired', 'done', 'cancelled']);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;

export const reminderSourceSchema = z.enum(['voice', 'ui']);
export type ReminderSource = z.infer<typeof reminderSourceSchema>;

export const reminderActionSchema = z.enum(['done', 'cancel', 'snooze']);

/** P-109b: ricorrenza; `weekly` torna nello stesso giorno della settimana della prima volta. */
export const reminderRepeatSchema = z.enum(['daily', 'weekdays', 'weekly']);
export type ReminderRepeat = z.infer<typeof reminderRepeatSchema>;
export type ReminderAction = z.infer<typeof reminderActionSchema>;

const time = z.number().int().nonnegative();

export const reminderSchema = z.strictObject({
  id: z.string().min(1).max(64),
  text: z.string().max(ASSISTANT_LIMITS.textChars),
  kind: reminderKindSchema,
  /** Quando è l'impegno. */
  dueAt: time,
  /** Quando avvisare (per gli appuntamenti un quarto d'ora prima). */
  notifyAt: time,
  status: reminderStatusSchema,
  source: reminderSourceSchema,
  createdAt: time,
  updatedAt: time,
  firedAt: time.nullable(),
  /** Ricorrenza (P-109b): quando scatta, il promemoria si ripresenta alla volta successiva. */
  repeat: reminderRepeatSchema.nullable()
});
export type Reminder = z.infer<typeof reminderSchema>;

/** P-109b: un elemento di una lista («latte» nella lista della spesa). */
export const listItemSchema = z.strictObject({
  id: z.string().min(1).max(64),
  text: z.string().max(ASSISTANT_LIMITS.itemChars),
  createdAt: time
});
export type ListItem = z.infer<typeof listItemSchema>;

export const assistantListSchema = z.strictObject({
  name: z.string().max(ASSISTANT_LIMITS.listNameChars),
  items: z.array(listItemSchema).max(ASSISTANT_LIMITS.listItems)
});
export type AssistantList = z.infer<typeof assistantListSchema>;
