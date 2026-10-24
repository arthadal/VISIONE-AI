// La conversazione con VISIONE come fra persone (22/10/2026): regole pure, usate da Chat.tsx e provate dai test.
// Dal 23/10/2026 la storia viene dal database (`chat.history`), non dagli ultimi eventi della UI.
import type { AttachedFileDto, ChatRequestDto, Language } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

export type ChatRole = 'owner' | 'assistant';

export interface ChatTurn {
  id: string;
  at: number;
  role: ChatRole;
  who: string;
  text: string;
  /** Allegati del proprietario (24/10/2026). */
  files?: readonly AttachedFileDto[];
}

/** Le richieste del proprietario e le risposte di VISIONE, in parole: niente esiti tecnici né resoconti di protocollo. */
export function requestTurns(requests: readonly ChatRequestDto[], lang: Language = 'it'): ChatTurn[] {
  const en = lang === 'en';
  const turns: ChatTurn[] = [];
  for (const r of requests) {
    // 🎤: detta a voce, il testo è ciò che ha sentito il microfono (24/10/2026: frasi trascritte male sembravano sue).
    turns.push({ id: `${r.id}:q`, at: r.at, role: 'owner', who: translate(lang, 'windows.chat.owner'), text: r.voice ? `🎤 ${r.text}` : r.text, ...(r.files.length > 0 ? { files: r.files } : {}) });
    if (r.status === 'open') continue;
    const text = r.status === 'succeeded'
      ? (r.answer?.trim() || (en ? 'Done.' : 'Fatto.'))
      : r.status === 'cancelled'
        ? (en ? 'Stopped, as you asked.' : 'Mi sono fermata, come mi hai chiesto.')
        : `${translate(lang, 'windows.chat.failed')}${r.reason ? `: ${r.reason}` : '.'}`;
    turns.push({ id: `${r.id}:a`, at: r.answeredAt ?? r.at, role: 'assistant', who: 'VISIONE', text });
  }
  return turns;
}

/** Al più tanti allegati per messaggio: lo stesso limite del core (`ATTACH_LIMITS.files`). */
export const ATTACH_MAX = 10;

/** Il nome del file, senza cartelle. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * Il messaggio da inviare: il testo e una riga «📎 percorso» per allegato, il formato che il core legge
 * (`shared/lib/attachments.ts`; un test verifica che i due vadano d'accordo).
 */
export function composeMessage(text: string, paths: readonly string[]): string {
  return [text.trim(), ...[...new Set(paths)].slice(0, ATTACH_MAX).map((p) => `📎 ${p}`)].filter((l) => l.length > 0).join('\n');
}

/** Un colore stabile per nome, come nei gruppi di WhatsApp. */
export function nameColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 68%)`;
}
