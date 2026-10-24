// Addestramento (P-107k): regole di lavoro per gli agenti. Il catalogo di VISIONE si attiva con un clic,
// con la spiegazione di cosa cambia e il costo in token; una regola entra nel lavoro di un agente solo
// quando il compito la riguarda (o sempre, se è segnata così). L'utente può scriverne di sue e, se vuole,
// cercare altre idee online nel Browser di VISIONE: niente parte da solo verso la rete.
import { useEffect, useMemo, useState } from 'react';
import type { Skill, VisioneEvent } from '../../../shared/contracts/index.ts';
import { useLanguage, useT } from '../../lib/i18n/index.ts';
import { formatAgo } from '../../lib/time.ts';
import { CodeMapSection } from './CodeMapSection.tsx';
import { estimateTokens, filterSkills, isSuggested, onlineSearchUrl, parseKeywordInput, summarize, TRAINING_FILTERS, type TrainingFilter } from './training-logic.ts';

export function TrainingPane({ ready, events, onOpenBrowser }: { ready: boolean; events: readonly VisioneEvent[]; onOpenBrowser?: (url: string) => void }) {
  const t = useT();
  const lang = useLanguage();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [perTurn, setPerTurn] = useState(4);
  const [recent, setRecent] = useState(0);
  const [filter, setFilter] = useState<TrainingFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', rule: '', keywords: '', always: false });
  const [formOpen, setFormOpen] = useState(false);
  // P-107l: seconda scheda, la mappa del codice delle cartelle degli agenti.
  const [view, setView] = useState<'rules' | 'map'>('rules');

  const load = (): void => {
    if (!ready) return;
    void window.visione.training.list().then((res) => {
      if (res.ok) { setSkills(res.data.skills); setPerTurn(res.data.perTurn); setRecent(res.data.recent); setError(null); }
      else setError(res.error.message);
    });
  };
  // La lingua cambia i testi del catalogo; un brief nuovo può averne contato l'uso: si rilegge (nessun polling).
  const lastBrief = events.findLast((e) => e.type === 'memory.context.built')?.id ?? null;
  useEffect(load, [ready, lang, lastBrief]);

  const replace = (skill: Skill): void => setSkills((list) => list?.map((s) => (s.id === skill.id ? skill : s)) ?? list);
  const toggle = (s: Skill): void => {
    setBusy(s.id);
    void window.visione.training.set(s.id, !s.active).then((res) => {
      setBusy(null);
      if (res.ok) { replace(res.data.skill); setError(null); }
      else setError(res.error.message);
    });
  };
  const remove = (s: Skill): void => {
    if (confirmDelete !== s.id) { setConfirmDelete(s.id); return; }
    setConfirmDelete(null);
    void window.visione.training.remove(s.id).then((res) => {
      if (res.ok) { setSkills((list) => list?.filter((x) => x.id !== s.id) ?? list); setError(null); }
      else setError(res.error.message);
    });
  };
  const keywords = parseKeywordInput(form.keywords);
  const canSave = form.title.trim().length > 0 && form.rule.trim().length > 0 && (keywords.length > 0 || form.always);
  const save = (): void => {
    if (!canSave) return;
    setBusy('new');
    void window.visione.training.add({ title: form.title.trim(), rule: form.rule.trim(), keywords, always: form.always }).then((res) => {
      setBusy(null);
      if (res.ok) {
        setSkills((list) => (list ? [...list, res.data.skill] : list));
        setForm({ title: '', rule: '', keywords: '', always: false });
        setFormOpen(false);
        setFilter('custom');
        setError(null);
      } else setError(res.error.message);
    });
  };

  const shown = useMemo(() => filterSkills(skills ?? [], filter, recent), [skills, filter, recent]);
  const suggestedCount = (skills ?? []).filter((s) => isSuggested(s, recent)).length;
  const sum = summarize(skills ?? []);
  const when = (s: Skill): string => (s.always
    ? t('windows.training.always')
    : t('windows.training.when', { words: s.topics }));

  const tabs = (
    <div className="training-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={view === 'rules'} className={`chip${view === 'rules' ? ' on' : ''}`} onClick={() => setView('rules')} data-testid="training-tab-rules">{t('windows.training.tabRules')}</button>
      <button type="button" role="tab" aria-selected={view === 'map'} className={`chip${view === 'map' ? ' on' : ''}`} onClick={() => setView('map')} data-testid="training-tab-map">{t('windows.training.tabMap')}</button>
    </div>
  );
  if (view === 'map') {
    return (
      <div className="pane training-pane" data-testid="win-training">
        {tabs}
        <CodeMapSection ready={ready} />
      </div>
    );
  }

  return (
    <div className="pane training-pane" data-testid="win-training">
      {tabs}
      <p className="training-intro">{t('windows.training.intro', { n: perTurn })}</p>
      <p className="training-summary small" data-testid="training-summary">
        {sum.active === 0
          ? t('windows.training.summaryNone')
          : t('windows.training.summary', { n: sum.active, always: sum.alwaysTokens, onDemand: sum.onDemand, tokens: sum.onDemandTokens })}
      </p>
      <div className="training-filters" role="tablist">
        {TRAINING_FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)} data-testid={`training-filter-${f}`}>
            {t(`windows.training.cat.${f}`)}{f === 'suggested' && suggestedCount > 0 ? ` (${suggestedCount})` : ''}
          </button>
        ))}
      </div>
      {skills === null && !error && <p className="muted small">{t('windows.training.loading')}</p>}
      {skills !== null && shown.length === 0 && <p className="muted small">{filter === 'custom' ? t('windows.training.noCustom') : t('windows.training.empty')}</p>}
      <ul className="training-list">
        {shown.map((s) => (
          <li key={s.id} className={`training-card${s.active ? ' on' : ''}`} data-testid={`training-skill-${s.id}`}>
            <div className="training-head">
              <strong>{s.title}</strong>
              <span className="training-meta mono small" title={t('windows.training.tokensTitle')}>~{s.tokens} token</span>
              <button type="button" className={`small${s.active ? '' : ' primary'}`} disabled={busy === s.id} onClick={() => toggle(s)} data-testid={`training-toggle-${s.id}`}>
                {s.active ? t('windows.training.remove') : t('windows.training.add')}
              </button>
            </div>
            {isSuggested(s, recent) && <p className="training-suggested small" data-testid={`training-suggested-${s.id}`}>{t('windows.training.suggestedNote', { n: s.suggested, of: recent })}</p>}
            {s.explain && <p className="small">{s.explain}</p>}
            <p className="muted small" title={s.always ? undefined : t('windows.training.keywordsTitle', { words: s.keywords.join(', ') })}>
              {when(s)}
              {s.uses > 0 && s.lastUsedAt !== null ? ` · ${t(s.uses === 1 ? 'windows.training.usedOne' : 'windows.training.used', { n: s.uses, ago: formatAgo(Date.now() - s.lastUsedAt, lang) })}` : ''}
            </p>
            <details>
              <summary className="small">{t('windows.training.ruleLabel')}</summary>
              <p className="training-rule mono small">{s.rule}</p>
            </details>
            {s.origin === 'custom' && (
              <button type="button" className={`small${confirmDelete === s.id ? ' danger' : ''}`} onClick={() => remove(s)} data-testid={`training-delete-${s.id}`}>
                {confirmDelete === s.id ? t('windows.training.deleteConfirm') : t('windows.training.delete')}
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="training-own">
        {!formOpen
          ? <button type="button" className="small" onClick={() => setFormOpen(true)} data-testid="training-new">{t('windows.training.new')}</button>
          : (
            <div className="training-form" data-testid="training-form">
              <label className="small">{t('windows.training.formTitle')}
                <input value={form.title} maxLength={80} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="training-form-title" />
              </label>
              <label className="small">{t('windows.training.formRule')}
                <textarea value={form.rule} maxLength={600} rows={3} onChange={(e) => setForm({ ...form, rule: e.target.value })} data-testid="training-form-rule" />
              </label>
              <label className="small">{t('windows.training.formKeywords')}
                <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder={t('windows.training.formKeywordsHint')} data-testid="training-form-keywords" />
              </label>
              <label className="small training-check">
                <input type="checkbox" checked={form.always} onChange={(e) => setForm({ ...form, always: e.target.checked })} data-testid="training-form-always" />
                {t('windows.training.formAlways')}
              </label>
              <p className="muted small">{t('windows.training.formCost', { tokens: form.rule.trim() ? estimateTokens(form.rule.trim()) : 0 })}</p>
              <div className="training-actions">
                <button type="button" className="small primary" disabled={!canSave || busy === 'new'} onClick={save} data-testid="training-form-save">{t('windows.training.formSave')}</button>
                <button type="button" className="small" onClick={() => setFormOpen(false)}>{t('windows.training.formCancel')}</button>
              </div>
            </div>
          )}
        {onOpenBrowser && (
          <p className="muted small training-online">
            {t('windows.training.online')}{' '}
            <button type="button" className="small" onClick={() => onOpenBrowser(onlineSearchUrl(lang))} data-testid="training-online">{t('windows.training.onlineButton')}</button>
          </p>
        )}
      </div>
      {error && <p className="error small" data-testid="training-error">{error}</p>}
    </div>
  );
}
