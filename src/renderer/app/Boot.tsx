// Sequenza di avvio (Fase 23, P-70): pannello informativo con le tappe REALI dello stato. Non
// intercetta i click (pointer-events: none): è solo informazione. Spartisce da solo quando il core è
// pronto; se qualcosa non va, resta e lo dichiara.
import type { CoreStateSnapshot, SupervisorSnapshot } from '../../shared/contracts/index.ts';
import { useLanguage, useT } from '../lib/i18n/index.ts';
import { bootComplete, bootSteps } from './boot.ts';

const MARK: Record<string, string> = { done: '■', active: '▸', pending: '·', warn: '△', error: '▲' };

export function Boot({ sup, core }: { sup: SupervisorSnapshot | null; core: CoreStateSnapshot | null }) {
  const t = useT();
  const lang = useLanguage();
  if (bootComplete(sup, core)) return null;
  const steps = bootSteps(sup, core, lang);
  return (
    <div className="boot" role="status" aria-live="polite" data-testid="boot-overlay">
      <div className="boot-box">
        <h2 className="type">{t('shell.boot.title')}</h2>
        <ul className="boot-list">
          {steps.map((s) => (
            <li key={s.id} className="boot-step" data-testid={`boot-${s.id}`} data-status={s.status}>
              <span className={`boot-mark st-${s.status}`} aria-hidden="true">{MARK[s.status] ?? '·'}</span>
              <span className="small">{s.label}</span>
              {s.detail && <span className="muted small mono">{s.detail}</span>}
            </li>
          ))}
        </ul>
        {core?.error.last && <p className="error small">{core.error.last.code}: {core.error.last.message}</p>}
      </div>
    </div>
  );
}
