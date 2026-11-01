// Fase 6 — contratti e moduli puri dell'orchestrazione: validazione dei piani (dipendenze, cicli),
// tabelle delle transizioni di task e istanze, policy delle azioni, audit log a catena di hash,
// coda delle approvazioni, riduttore dello stato per agenti/task/Director/approvazioni.
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_TARGET_MAX, approvalTarget, createApprovalQueue } from '../../src/core/approvals/index.ts';
import { auditHash, createAuditLog } from '../../src/core/audit/index.ts';
import { parseAgentPlan } from '../../src/core/director/index.ts';
import { createActionPolicy, SHELL_MAX_CHARS } from '../../src/core/policy/index.ts';
import { createStateStore, emptyDomainCounts } from '../../src/core/state/index.ts';
import {
  canAgentTransition,
  canTaskTransition,
  createEvent,
  isTerminalTaskStatus,
  taskStatusSchema,
  validatePlan,
  type TaskStatus
} from '../../src/shared/contracts/index.ts';
import { createRuntimeHarness, type RuntimeHarness } from '../runtime-harness.ts';

const harnesses: RuntimeHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});
function harness(): RuntimeHarness {
  const h = createRuntimeHarness();
  harnesses.push(h);
  return h;
}

describe('piani: validazione deterministica', () => {
  it('ordine topologico stabile (a parità, ordine di dichiarazione)', () => {
    const plan = validatePlan([
      { key: 'c', dependsOn: ['a', 'b'] },
      { key: 'a', dependsOn: [] },
      { key: 'b', dependsOn: ['a'] },
      { key: 'd', dependsOn: [] }
    ]);
    expect(plan).toEqual({ ok: true, order: ['a', 'b', 'c', 'd'] });
  });

  it('dipendenza circolare rifiutata con i passi coinvolti, sempre uguale', () => {
    const steps = [{ key: 'a', dependsOn: ['c'] }, { key: 'b', dependsOn: ['a'] }, { key: 'c', dependsOn: ['b'] }, { key: 'x', dependsOn: [] }];
    const first = validatePlan(steps);
    expect(first).toEqual({ ok: false, problems: ['dipendenza circolare tra: a, b, c'] });
    expect(validatePlan(steps)).toEqual(first);
  });

  it('dipendenze inesistenti, da sé stessi, duplicate e chiavi doppie', () => {
    expect(validatePlan([{ key: 'a', dependsOn: ['z'] }])).toMatchObject({ ok: false, problems: ['a dipende da un passo inesistente: z'] });
    expect(validatePlan([{ key: 'a', dependsOn: ['a'] }])).toMatchObject({ ok: false, problems: ['a dipende da sé stesso'] });
    expect(validatePlan([{ key: 'a', dependsOn: [] }, { key: 'a', dependsOn: [] }])).toMatchObject({ ok: false, problems: ['chiave duplicata: a'] });
    expect(validatePlan([{ key: 'a', dependsOn: [] }, { key: 'b', dependsOn: ['a', 'a'] }])).toMatchObject({ ok: false });
  });

  it('piano di un agente: JSON nel testo, schema, cicli e agenti sconosciuti', () => {
    const known = new Set(['a1', 'a2']);
    const ok = parseAgentPlan('Ecco il piano:\n{"steps":[{"key":"s1","title":"Uno","spec":"fai uno","agentId":"a1"},{"key":"s2","title":"Due","spec":"fai due","dependsOn":["s1"]}]}\nfine', known);
    expect(ok).toMatchObject({ ok: true, steps: [{ key: 's1', agentId: 'a1' }, { key: 's2', dependsOn: ['s1'] }] });
    expect(parseAgentPlan('nessun piano', known)).toEqual({ ok: false, problem: 'nessun oggetto JSON nella risposta' });
    expect(parseAgentPlan('{"steps":[{"key":"s1","title":"x","spec":"y","dependsOn":["s1"]}]}', known)).toMatchObject({ ok: false, problem: expect.stringMatching(/sé stesso/) });
    expect(parseAgentPlan('{"steps":[{"key":"s1","title":"x","spec":"y","agentId":"intruso"}]}', known)).toMatchObject({ ok: false, problem: expect.stringMatching(/sconosciuto/) });
    expect(parseAgentPlan('{"steps":[]}', known)).toMatchObject({ ok: false });
    expect(parseAgentPlan('{"steps": [ {"key": "s1", ', known)).toMatchObject({ ok: false });
  });
});

describe('transizioni', () => {
  it('task: terminali senza uscite, ritorno in coda solo da running/waiting', () => {
    for (const s of taskStatusSchema.options) {
      if (isTerminalTaskStatus(s)) for (const t of taskStatusSchema.options) expect(canTaskTransition(s, t), `${s}→${t}`).toBe(false);
    }
    expect(canTaskTransition('created', 'queued')).toBe(true);
    expect(canTaskTransition('created', 'blocked')).toBe(true);
    expect(canTaskTransition('queued', 'running')).toBe(true);
    expect(canTaskTransition('running', 'timed_out')).toBe(true);
    expect(canTaskTransition('running', 'queued')).toBe(true);
    expect(canTaskTransition('waiting', 'queued')).toBe(true);
    expect(canTaskTransition('queued', 'succeeded')).toBe(false);
    expect(canTaskTransition('waiting', 'running')).toBe(false);
    expect(canTaskTransition('queued', 'blocked')).toBe(false);
    const terminal: TaskStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out', 'blocked'];
    expect(taskStatusSchema.options.filter(isTerminalTaskStatus)).toEqual(terminal);
  });

  it('istanze: tabella dell\'architettura più attesa di conferma e recupero', () => {
    expect(canAgentTransition(null, 'created')).toBe(true);
    expect(canAgentTransition(null, 'idle')).toBe(false);
    expect(canAgentTransition('starting', 'waiting')).toBe(true);
    expect(canAgentTransition('waiting', 'starting')).toBe(true);
    expect(canAgentTransition('stopped', 'starting')).toBe(false);
    expect(canAgentTransition('idle', 'working')).toBe(true);
    expect(canAgentTransition('working', 'stopped')).toBe(false);
  });
});

describe('policy delle azioni', () => {
  const policy = createActionPolicy({ protectedRoots: ['C:\\Users\\prova\\munder-difflin', 'C:\\Users\\prova\\jarvis'], platform: 'win32' });
  const roots = ['C:\\VISIONE\\workspace\\a1', 'C:\\VISIONE\\agents\\a1'];
  const cls = (kind: string, target: string, detail?: Record<string, unknown>, actor: 'agent' | 'director' | 'owner' = 'agent') =>
    policy.classify({ kind, target, ...(detail ? { detail } : {}) }, { actor, roots }).class;

  it('bloccate sempre: remoti git, credenziali, cartelle protette e di sistema, acquisti', () => {
    expect(cls('git', 'push origin main')).toBe('block');
    expect(cls('git', 'remote add origin https://example.invalid/r.git')).toBe('block');
    expect(cls('shell.exec', 'git push --force')).toBe('block');
    expect(cls('fs.write', 'C:\\Users\\prova\\munder-difflin\\src\\x.ts')).toBe('block');
    expect(cls('fs.write', 'C:\\Users\\prova\\jarvis\\a.txt')).toBe('block');
    expect(cls('fs.delete', 'C:\\Windows\\System32\\x.dll')).toBe('block');
    expect(cls('fs.write', 'C:\\')).toBe('block');
    expect(cls('fs.read', 'C:\\Users\\prova\\.ssh\\id_rsa')).toBe('block');
    expect(cls('fs.read', 'C:\\VISIONE\\workspace\\a1\\.env')).toBe('block');
    expect(cls('purchase', 'abbonamento')).toBe('block');
    expect(cls('provider.activate', 'a pagamento', undefined, 'owner')).toBe('block');
    expect(cls('message.send', 'a2', { hops: 13 })).toBe('block');
  });

  it('con approvazione: fuori dalle radici, install, download, comandi fuori elenco, fiducia, sconosciute', () => {
    expect(cls('fs.write', 'C:\\Altro\\file.txt')).toBe('approval');
    expect(cls('fs.delete', 'C:\\VISIONE\\workspace\\a1\\vecchi', { recursive: true })).toBe('approval');
    expect(cls('fs.delete', 'C:\\VISIONE\\workspace\\a1\\x', { count: 7 })).toBe('approval');
    expect(cls('shell.exec', 'npm install left-pad')).toBe('approval');
    expect(cls('shell.exec', 'curl https://example.invalid')).toBe('approval');
    expect(cls('shell.exec', 'python script.py')).toBe('approval');
    expect(cls('git', 'merge agent/a1')).toBe('approval');
    expect(cls('net.connect', 'example.invalid')).toBe('approval');
    expect(cls('agent.define', 'nuovo', undefined, 'director')).toBe('approval');
    expect(cls('engine.workspace.trust', 'C:\\VISIONE\\workspace\\a1', undefined, 'owner')).toBe('approval');
    expect(cls('qualcosa.di.nuovo', 'x')).toBe('approval');
  });

  it('consentite: radici dell\'agente, git locale, comandi in elenco, azioni del proprietario', () => {
    expect(cls('fs.read', 'C:\\VISIONE\\workspace\\a1\\src\\a.ts')).toBe('allow');
    expect(cls('fs.write', 'C:\\visione\\WORKSPACE\\a1\\nuovo.txt')).toBe('allow');
    expect(cls('git', 'commit -m "ok"')).toBe('allow');
    expect(cls('shell.exec', 'npm test')).toBe('allow');
    expect(cls('message.send', 'a2', { hops: 3 })).toBe('allow');
    expect(cls('agent.define', 'nuovo', undefined, 'owner')).toBe('allow');
  });
});

describe('policy: modalità fiducia e percorsi custoditi (P-102)', () => {
  const policy = createActionPolicy({
    protectedRoots: ['C:\\Users\\prova\\jarvis'],
    guardedRoots: ['C:\\VISIONE\\config', 'C:\\VISIONE\\data', 'C:\\VISIONE\\runtime'],
    guardedPatterns: [/\.claude[\\/]+settings(\.local)?\.json/i, /(^|[\\/\s"'])opencode\.jsonc?\b/i],
    platform: 'win32'
  });
  const roots = ['C:\\VISIONE\\workspace\\a1', 'C:\\VISIONE\\agents\\a1'];
  const verdict = (kind: string, target: string, trusted: boolean, detail?: Record<string, unknown>) =>
    policy.classify({ kind, target, ...(detail ? { detail } : {}) }, { actor: 'agent', roots, trusted });
  const cls = (kind: string, target: string, trusted: boolean, detail?: Record<string, unknown>) => verdict(kind, target, trusted, detail).class;

  it('senza fiducia nulla cambia: le stesse azioni chiedono ancora l\'approvazione', () => {
    expect(cls('shell.exec', 'python script.py', false)).toBe('approval');
    expect(cls('net.connect', 'github.com', false)).toBe('approval');
    expect(cls('fs.write', 'C:\\Altro\\file.txt', false)).toBe('approval');
  });

  it('in fiducia passano comandi, rete, pacchetti, download e file fuori dalle radici, tracciati come :trusted', () => {
    for (const [kind, target] of [
      ['shell.exec', 'python script.py'], ['shell.exec', 'npm install left-pad'], ['shell.exec', 'curl https://example.invalid'],
      ['net.connect', 'github.com'], ['fs.read', 'C:\\Altro\\a.txt'], ['fs.write', 'C:\\Altro\\file.txt'],
      ['git', 'merge agent/a1'], ['package.install', 'left-pad'], ['net.download', 'modello']
    ] as const) {
      const v = verdict(kind, target, true);
      expect(v.class, `${kind} ${target}`).toBe('allow');
      expect(v.rule).toMatch(/:trusted$/);
    }
  });

  it('in fiducia restano i blocchi e le approvazioni critiche', () => {
    expect(cls('git', 'push origin main', true)).toBe('block');
    expect(cls('fs.read', 'C:\\Users\\prova\\.ssh\\id_rsa', true)).toBe('block');
    expect(cls('fs.write', 'C:\\Users\\prova\\jarvis\\a.txt', true)).toBe('block');
    expect(cls('purchase', 'abbonamento', true)).toBe('block');
    expect(cls('policy.disable', 'tutto', true)).toBe('block');
    expect(cls('agent.define', 'nuovo', true)).toBe('approval');
    expect(cls('config.change', 'x', true)).toBe('approval');
    expect(cls('engine.transport.headless', 'x', true)).toBe('approval');
    expect(cls('fs.delete', 'C:\\Altro\\cartella', true, { recursive: true })).toBe('approval');
    expect(cls('qualcosa.di.nuovo', 'x', true)).toBe('approval');
  });

  it('percorsi custoditi: scriverli chiede sempre il proprietario, anche dentro le radici e in fiducia', () => {
    for (const trusted of [false, true]) {
      expect(cls('fs.write', 'C:\\VISIONE\\config\\visione.json', trusted)).toBe('approval');
      expect(cls('fs.delete', 'C:\\VISIONE\\data\\visione.db', trusted)).toBe('approval');
      expect(cls('fs.write', 'C:\\VISIONE\\runtime\\shims\\visione-hook.cjs', trusted)).toBe('approval');
      expect(cls('fs.write', 'C:\\VISIONE\\workspace\\a1\\.claude\\settings.local.json', trusted)).toBe('approval');
      expect(cls('fs.write', 'C:\\VISIONE\\workspace\\a1\\opencode.json', trusted)).toBe('approval');
    }
    // Il resto delle radici resta libero e la lettura dei custoditi non è una scrittura.
    expect(cls('fs.write', 'C:\\VISIONE\\workspace\\a1\\src\\a.ts', false)).toBe('allow');
    expect(cls('fs.read', 'C:\\VISIONE\\config\\visione.json', true)).toBe('allow');
  });

  it('in fiducia un comando che nomina un percorso custodito non passa da solo', () => {
    expect(verdict('shell.exec', 'copy x.json C:\\VISIONE\\config\\visione.json', true)).toMatchObject({ class: 'approval', rule: 'shell:other:guarded' });
    expect(cls('shell.exec', 'echo {} > c:/visione/runtime/shims/settings-a1.json', true)).toBe('approval');
    expect(cls('shell.exec', 'node -e "fs.writeFileSync(\'.claude/settings.json\', x)"', true)).toBe('approval');
    expect(cls('shell.exec', 'del opencode.json', true)).toBe('approval');
    expect(cls('shell.exec', 'type opencode.json', true)).toBe('allow'); // sola lettura in elenco
    expect(cls('shell.exec', 'python build.py', true)).toBe('allow');
  });

  it('comandi composti: ogni pezzo deve essere consentito, le redirezioni su file sono scritture', () => {
    expect(cls('shell.exec', 'npm run check 2>&1 | tail -15', false)).toBe('allow');
    expect(cls('shell.exec', 'cd C:\\VISIONE\\workspace\\a1 && npm test', false)).toBe('allow');
    expect(cls('shell.exec', 'npm test && python x.py', false)).toBe('approval');
    expect(cls('shell.exec', 'npm test; del /q C:\\Altro', false)).toBe('approval');
    expect(cls('shell.exec', 'echo ciao > C:\\Altro\\x.txt', false)).toBe('approval');
    expect(cls('shell.exec', 'ls > /dev/null', false)).toBe('allow');
    expect(cls('shell.exec', 'echo $(whoami)', false)).toBe('approval');
    expect(cls('git', 'status && curl https://example.invalid', false)).toBe('approval');
    expect(cls('git', 'log --oneline | head -5', false)).toBe('allow');
    expect(cls('shell.exec', 'npm test && git push origin main', false)).toBe('block');
    // In fiducia la catena passa, ma non se nomina un percorso custodito.
    expect(cls('shell.exec', 'npm test && python x.py', true)).toBe('allow');
    expect(cls('shell.exec', 'npm test && copy a C:\\VISIONE\\data\\b', true)).toBe('approval');
  });

  it('`&` singolo separa i comandi (cmd.exe e bash): un inizio in elenco non copre il resto', () => {
    expect(cls('shell.exec', 'echo ciao & del /s /q C:\\Users\\prova\\Documents', false)).toBe('approval');
    expect(cls('shell.exec', 'npm test & calc.exe', false)).toBe('approval');
    expect(cls('shell.exec', 'echo ciao & git push origin main', false)).toBe('block');
    expect(cls('git', 'status & del /q C:\\Altro', false)).toBe('approval');
    // Le redirezioni innocue restano innocue: `2>&1` e `&> /dev/null` non diventano pezzi della catena.
    expect(cls('shell.exec', 'npm test 2>&1 | findstr FAIL', false)).toBe('allow');
    expect(cls('shell.exec', 'npm test &> /dev/null', false)).toBe('allow');
  });

  it('un comando lunghissimo non si classifica da solo: serve il proprietario, anche in fiducia', () => {
    const lungo = `echo ${'a'.repeat(SHELL_MAX_CHARS)} && rm -rf ~/Documenti`;
    for (const trusted of [false, true]) expect(verdict('shell.exec', lungo, trusted)).toMatchObject({ class: 'approval', rule: 'shell:long' });
    expect(verdict('shell.exec', `echo ${'a'.repeat(1_100)} && rm -rf ~/Documenti`, false)).toMatchObject({ class: 'approval', rule: 'shell:other' });
  });
});

describe('audit log a catena di hash', () => {
  it('righe concatenate, verificate; una modifica rompe la catena nel punto esatto', () => {
    const h = harness();
    const audit = createAuditLog(h.db, { now: () => 1_000 });
    const a = audit.record({ actor: 'owner', action: 'agent.define', subject: 'a1', decision: 'done', detail: 'NVIDIA_API_KEY=nvapi-segretissima123', correlationId: 'corr-0001' });
    const b = audit.record({ actor: 'director', action: 'director.submit', decision: 'rule', detail: 'obiettivo' });
    expect(a.seq).toBe(1);
    expect(b.prevHash).toBe(a.hash);
    expect(b.hash).toBe(auditHash(a.hash, { ...b }));
    expect(a.detail).not.toContain('segretissima');
    expect(audit.verify()).toEqual({ ok: true, checked: 2, brokenAt: null });
    expect(audit.list(10).map((e) => e.seq)).toEqual([1, 2]);
    h.db.prepare("UPDATE audit_log SET decision = 'alterata' WHERE seq = 2").run();
    expect(audit.verify()).toEqual({ ok: false, checked: 2, brokenAt: 2 });
  });
});

describe('coda delle approvazioni', () => {
  it('richiesta riusata finché aperta, decisione idempotente, evento e audit', async () => {
    const h = harness();
    const audit = createAuditLog(h.db);
    const q = createApprovalQueue({ db: h.db, events: h.emitter, audit });
    const req = { kind: 'fs.write', target: 'C:\\fuori\\x.txt', reason: 'scrittura fuori', requestedBy: 'director', taskId: 't1', correlationId: 'corr-appr-1' };
    const first = q.request(req);
    const again = q.request(req);
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, approval: { id: first.approval.id } });
    expect(q.pendingCount()).toBe(1);
    expect(q.isGranted('fs.write', 'C:\\fuori\\x.txt')).toBe(false);
    const decided = q.decide(first.approval.id, 'grant', 'owner', { note: 'ok' });
    expect(decided).toMatchObject({ alreadyDecided: false, approval: { status: 'granted', decidedBy: 'owner', note: 'ok' } });
    expect(q.decide(first.approval.id, 'deny', 'owner')).toMatchObject({ alreadyDecided: true, approval: { status: 'granted' } });
    expect(q.decide('inesistente', 'grant', 'owner')).toBeNull();
    expect(q.isGranted('fs.write', 'C:\\fuori\\x.txt')).toBe(true);
    // Chiusa la prima, una nuova richiesta uguale crea una nuova riga.
    expect(q.request(req).created).toBe(true);
    await h.idle();
    const types = h.events.map((e) => e.type);
    expect(types.filter((t) => t === 'approval.requested')).toHaveLength(2);
    expect(types.filter((t) => t === 'approval.granted')).toHaveLength(1);
    expect(h.events.find((e) => e.type === 'approval.requested')?.correlationId).toBe('corr-appr-1');
    expect(audit.list(10).map((e) => `${e.action}:${e.decision}`)).toEqual(['approval.request:fs.write:pending', 'approval.decide:fs.write:granted', 'approval.request:fs.write:pending']);
  });

  it('bersagli oltre 1000 caratteri: l\'approvazione vale per il comando intero, non per chi ha lo stesso inizio', () => {
    const h = harness();
    const q = createApprovalQueue({ db: h.db, events: h.emitter, audit: createAuditLog(h.db) });
    const inizio = `echo ${'a'.repeat(1_100)}`;
    const buono = `${inizio} && npm test`;
    const cattivo = `${inizio} && del /q C:\\Altro`;
    const { approval } = q.request({ kind: 'shell.exec', target: buono, reason: 'comando lungo', requestedBy: 'agent:a1', correlationId: 'corr-appr-2' });
    expect(approval.target).toHaveLength(APPROVAL_TARGET_MAX);
    expect(approval.target).toBe(approvalTarget(buono));
    expect(q.request({ kind: 'shell.exec', target: buono, reason: 'di nuovo', requestedBy: 'agent:a1', correlationId: 'corr-appr-3' }).created).toBe(false);
    q.decide(approval.id, 'grant', 'owner');
    expect(q.isGranted('shell.exec', buono)).toBe(true);
    expect(q.isGranted('shell.exec', cattivo)).toBe(false);
    // Fino a 1000 caratteri il bersaglio resta quello vero (le righe già registrate continuano a valere).
    expect(approvalTarget('C:\\fuori\\x.txt')).toBe('C:\\fuori\\x.txt');
  });
});

describe('stato: riepiloghi di agenti, task, Director, approvazioni', () => {
  it('conteggi dall\'avvio, poi solo dagli eventi', () => {
    const domain = emptyDomainCounts();
    domain.tasks.running = 1;
    domain.agentsDefined = 2;
    const store = createStateStore({
      domain, bootId: '01J0000000000000000000000A', pid: 1, startedAt: 0, appVersion: 'x', coreVersion: 'x', dbSchema: 4, quarantined: null,
      recovered: { previousRun: null, applicationRunning: false, lastEvent: null, lastError: null, journalLastSeq: 0, journalCount: 0 }
    });
    expect(store.snapshot()).toMatchObject({ tasks: { active: 1 }, agents: { defined: 2 } });
    const apply = (e: ReturnType<typeof createEvent>) => store.apply({ kind: 'event', event: { ...e, seq: null } });
    apply(createEvent('task.created', { taskId: 't1', kind: 'work', parentId: 'r', rootId: 'r', title: 'x', assigneeAgentId: null, dependsOn: [], priority: 1, createdBy: 'o' }));
    apply(createEvent('task.status.changed', { taskId: 't1', rootId: 'r', kind: 'work', from: 'created', to: 'queued', reason: 'pronto', attempt: 0, error: null }));
    apply(createEvent('task.status.changed', { taskId: 't0', rootId: 'r', kind: 'work', from: 'running', to: 'succeeded', reason: 'ok', attempt: 1, error: null }));
    apply(createEvent('agent.status.changed', { instanceId: 'i1', agentId: 'a1', from: null, to: 'created', reason: 'nuova' }));
    apply(createEvent('agent.status.changed', { instanceId: 'i1', agentId: 'a1', from: 'idle', to: 'working', reason: 't1' }));
    apply(createEvent('approval.requested', { approvalId: 'p1', kind: 'k', target: 't', reason: 'r', requestedBy: 'd', taskId: null, agentId: null }));
    apply(createEvent('director.goal.received', { rootTaskId: 'r', planner: 'rule', chars: 3, by: 'o' }));
    const s = store.snapshot();
    expect(s.tasks).toMatchObject({ active: 1, byStatus: { queued: 1, running: 0, succeeded: 1, created: 0 }, last: { taskId: 't0', status: 'succeeded' } });
    expect(s.agents).toMatchObject({ defined: 2, live: 1, working: 1, last: { agentId: 'a1', status: 'working' } });
    expect(s.approvals.pending).toBe(1);
    expect(s.director.activeGoals).toBe(1);
    apply(createEvent('director.summary', { rootTaskId: 'r', outcome: 'succeeded', counts: { total: 1, succeeded: 1, failed: 0, cancelled: 0, timedOut: 0, blocked: 0 }, text: 'ok' }));
    apply(createEvent('approval.denied', { approvalId: 'p1', kind: 'k', target: 't', decidedBy: 'owner', note: null }));
    apply(createEvent('agent.status.changed', { instanceId: 'i1', agentId: 'a1', from: 'working', to: 'crashed', reason: 'x' }));
    expect(store.snapshot()).toMatchObject({ director: { activeGoals: 0 }, approvals: { pending: 0 }, agents: { live: 0, working: 0 } });
  });
});
