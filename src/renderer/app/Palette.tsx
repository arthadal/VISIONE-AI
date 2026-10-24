// Palette comandi (Ctrl+K): azioni della UI raggiungibili da tastiera. Esc chiude.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../lib/i18n/index.ts';

export interface PaletteAction {
  id: string;
  label: string;
  run(): void;
}

export function Palette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shown = useMemo(() => actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase())), [actions, query]);
  useEffect(() => inputRef.current?.focus(), []);
  const run = (a: PaletteAction | undefined): void => {
    if (!a) return;
    onClose();
    a.run();
  };
  return (
    <div className="palette-backdrop" onClick={onClose} role="presentation">
      <div className="palette" role="dialog" aria-label={t('shell.palette.dialog')} onClick={(e) => e.stopPropagation()} data-testid="palette">
        <input
          ref={inputRef}
          aria-label={t('shell.palette.search')}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(shown.length - 1, i + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            if (e.key === 'Enter') { e.preventDefault(); run(shown[index]); }
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <ul role="listbox">
          {shown.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === index}>
              <button type="button" className={i === index ? 'selected' : ''} onClick={() => run(a)}>{a.label}</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
