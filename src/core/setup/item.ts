// Dal tipo del motore (sola lettura) al contratto: senza lo script dell'installatore, che resta nel core.
import type { SetupItem } from '../../shared/contracts/index.ts';
import type { AdapterSetupItem } from '../adapters/index.ts';

/** Dal tipo del motore (sola lettura) al contratto. */
export function toItem(i: AdapterSetupItem): SetupItem {
  const item: SetupItem = { id: i.id, label: i.label, ok: i.ok, optional: i.optional, detail: i.detail, steps: [...i.steps], commands: [...i.commands] };
  if (i.link) item.link = i.link;
  if (i.forProfile) item.forProfile = i.forProfile;
  if (i.action?.kind === 'login-terminal') item.action = { kind: 'login-terminal', args: [...i.action.args] };
  else if (i.action?.kind === 'env-key') item.action = { kind: 'env-key', envName: i.action.envName };
  else if (i.action?.kind === 'install') item.action = { kind: 'install', source: i.action.source, admin: i.action.admin, ...(i.action.verb ? { verb: i.action.verb } : {}) };
  return item;
}
