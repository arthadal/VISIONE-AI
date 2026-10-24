// System Control (Fase 24b, P-72): metriche REALI (null = N/D) e azioni di controllo supportate.
// Spegni/Riavvia/Blocca richiedono un secondo click di conferma (e il core esige `confirm: true`).
import { useEffect, useState } from 'react';
import type { CommandResult } from '../../../shared/contracts/index.ts';
import { useT } from '../../lib/i18n/index.ts';

type Info = CommandResult<'system.control.info'>;
type Action = 'volume-up' | 'volume-down' | 'mute-toggle' | 'task-manager' | 'settings' | 'lock' | 'sleep' | 'shutdown' | 'restart';

const gb = (n: number): string => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
const uptime = (s: number): string => `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;

export function SystemPane({ ready }: { ready: boolean }) {
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = (): void => {
    if (!ready) return;
    void window.visione.system.control.info().then((res) => {
      if (res.ok) { setInfo(res.data); setError(null); }
      else setError(`${res.error.code}: ${res.error.message}`);
    });
  };
  useEffect(load, [ready]);

  const run = (action: Action, confirmed = false): void => {
    void window.visione.system.control.exec({ action, ...(confirmed ? { confirm: true as const } : {}) }).then((res) => {
      setConfirm(null);
      if (res.ok) { setNote(res.data.note ?? t('windows.system.done', { action })); setError(null); }
      else setError(`${res.error.code}: ${res.error.message}`);
    });
  };
  const act = (action: Action): void => {
    if ((action === 'shutdown' || action === 'restart' || action === 'lock') && confirm !== action) {
      setConfirm(action);
      return;
    }
    run(action, true);
  };

  const memUsed = info ? info.memTotalBytes - info.memFreeBytes : 0;
  return (
    <div className="pane system-pane" data-testid="win-system">
      <dl className="kv">
        <dt>{t('windows.system.machine')}</dt><dd className="mono" data-testid="system-hostname">{info?.hostname ?? '—'}</dd>
        <dt>Windows</dt><dd className="mono small">{info?.windows ?? '—'}</dd>
        <dt>CPU</dt><dd className="mono small">{info ? t('windows.system.cpuValue', { model: info.cpuModel, n: info.cpuCount }) : '—'}</dd>
        <dt>RAM</dt><dd className="mono" data-testid="system-mem">{info ? t('windows.system.ramValue', { used: gb(memUsed), total: gb(info.memTotalBytes) }) : '—'}</dd>
        <dt>{t('windows.system.disk')}</dt><dd className="mono">{info?.disk ? t('windows.system.diskValue', { used: gb(info.disk.totalBytes - info.disk.freeBytes), free: gb(info.disk.freeBytes) }) : t('windows.common.na')}</dd>
        <dt>uptime</dt><dd className="mono">{info ? uptime(info.uptimeSec) : '—'}</dd>
        <dt>{t('windows.system.load')}</dt><dd className="mono small">{info?.loadavg ? info.loadavg.map((v) => v.toFixed(2)).join(' / ') : t('windows.common.na')}</dd>
      </dl>
      <div className="row">
        <button type="button" onClick={() => run('volume-down')} data-testid="ctl-volume-down">Vol −</button>
        <button type="button" onClick={() => run('volume-up')} data-testid="ctl-volume-up">Vol +</button>
        <button type="button" onClick={() => run('mute-toggle')} data-testid="ctl-mute">{t('windows.system.mute')}</button>
        <button type="button" onClick={() => run('task-manager')} data-testid="ctl-taskmgr">Task Manager</button>
        <button type="button" onClick={() => run('settings')} data-testid="ctl-settings">{t('windows.system.settings')}</button>
      </div>
      <div className="row">
        <button type="button" className={confirm === 'lock' ? 'danger' : ''} onClick={() => act('lock')} data-testid="ctl-lock">{t('windows.system.lock')}{confirm === 'lock' ? ` · ${t('windows.system.confirm')}` : ''}</button>
        <button type="button" onClick={() => run('sleep')} data-testid="ctl-sleep">{t('windows.system.sleep')}</button>
        <button type="button" className={confirm === 'restart' ? 'danger' : ''} onClick={() => act('restart')} data-testid="ctl-restart">{t('windows.system.restart')}{confirm === 'restart' ? ` · ${t('windows.system.confirm')}` : ''}</button>
        <button type="button" className={confirm === 'shutdown' ? 'danger' : ''} onClick={() => act('shutdown')} data-testid="ctl-shutdown">{t('windows.system.shutdown')}{confirm === 'shutdown' ? ` · ${t('windows.system.confirm')}` : ''}</button>
        <button type="button" onClick={load} data-testid="ctl-refresh">{t('windows.common.refresh')}</button>
      </div>
      {note && <p className="muted small" data-testid="ctl-note">{note}</p>}
      {error && <p className="error small" data-testid="ctl-error">{error}</p>}
    </div>
  );
}
