// Assistente personale (beta.5, P-109): un promemoria scattato nel core diventa una notifica di
// Windows. Il testo è quello che dice la voce (`message`, già composto dal core); un clic sulla
// notifica riporta VISIONE in primo piano. Nessuna logica di dominio: il main mostra e basta.
import { Notification } from 'electron';
import type { TypedEvent } from '../shared/contracts/index.ts';

export interface ReminderNotifier {
  show(event: TypedEvent<'assistant.reminder.fired'>): void;
}

export function createReminderNotifier(opts: { onClick: () => void; warn: (msg: string, err: unknown) => void }): ReminderNotifier {
  // Le notifiche vive restano referenziate: senza, il garbage collector può chiuderle prima del clic.
  const live = new Set<Notification>();
  return {
    show(event) {
      try {
        if (!Notification.isSupported()) return;
        const n = new Notification({
          title: event.payload.kind === 'appointment' ? 'VISIONE · Appuntamento' : 'VISIONE · Promemoria',
          body: event.payload.message,
          silent: false
        });
        live.add(n);
        const drop = (): void => { live.delete(n); };
        n.on('click', () => { drop(); opts.onClick(); });
        n.on('close', drop);
        n.on('failed', drop);
        n.show();
      } catch (err) {
        opts.warn('notifica del promemoria non mostrata', err);
      }
    }
  };
}
