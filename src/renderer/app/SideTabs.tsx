// Linguette laterali (11/10/2026, schermo pulito): sul bordo destro, una per tema, si aprono come
// cartelle e mostrano le schermate di quel tema anche se sullo schermo sono spente. Una sola aperta
// alla volta; si chiude con la stessa linguetta, con × o con Esc.
import { useEffect, useState, type ReactNode } from 'react';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { panelVisible, tabVisible, useExpert } from '../lib/mode.ts';
import { groupTitle, PANEL_GROUPS, panelTitle, type PanelId } from './panels.ts';

const TABS: ReadonlyArray<{ id: string; title: string; panels: readonly PanelId[] }> = [
  ...PANEL_GROUPS,
  { id: 'log', title: 'Registro', panels: [] } // il titolo mostrato viene da `groupTitle` (lingua)
];

export function SideTabs({ renderPanel, logView, onDetach }: { renderPanel: (id: PanelId) => ReactNode; logView: ReactNode; onDetach?: (id: PanelId) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const expert = useExpert();
  const t = useT();
  const lang = useLanguage();
  const tabs = TABS.filter((x) => tabVisible(x.id, expert)).map((x) => ({ ...x, title: groupTitle(x.id, lang), panels: x.panels.filter((id) => panelVisible(id, expert)) }));
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const tab = tabs.find((x) => x.id === open) ?? null;
  return (
    <>
      <nav className="side-tabs" aria-label={t('shell.sidetabs.aria')} data-testid="side-tabs">
        {tabs.map((x) => (
          <button
            key={x.id} type="button" className={`side-tab${open === x.id ? ' on' : ''}`}
            aria-expanded={open === x.id} data-testid={`side-tab-${x.id}`}
            title={x.panels.length > 0 ? x.panels.map((id) => panelTitle(id, lang)).join(' · ') : t('shell.sidetabs.logTitle')}
            onClick={() => setOpen((o) => (o === x.id ? null : x.id))}
          ><span>{x.title}</span></button>
        ))}
      </nav>
      {tab && (
        <aside className="side-drawer" aria-label={tab.title} data-testid={`side-drawer-${tab.id}`}>
          <header className="side-drawer-head">
            <span className="hp-title">{tab.title}</span>
            <button type="button" className="jwin-close" aria-label={t('shell.sidetabs.close', { title: tab.title })} onClick={() => setOpen(null)}>×</button>
          </header>
          <div className="side-drawer-body">
            {tab.panels.map((id) => (
              <div key={id} className="side-drawer-item" data-panel={id}>
                {/* ⇱ porta il pannello sullo schermo, mobile come l'Umanoide (24/10/2026). */}
                {onDetach && (
                  <button
                    type="button" className="dk-btn side-detach" data-testid={`side-detach-${id}`}
                    aria-label={t('shell.sidetabs.detach', { title: panelTitle(id, lang) })} title={t('shell.sidetabs.detachTitle')}
                    onClick={() => { onDetach(id); setOpen(null); }}
                  >⇱</button>
                )}
                {renderPanel(id)}
              </div>
            ))}
            {tab.id === 'log' && logView}
          </div>
        </aside>
      )}
    </>
  );
}
