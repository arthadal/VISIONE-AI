// End-to-end sull'app Electron compilata (`npm run test:e2e`). Usa una home temporanea.
// Verifica: finestra e UI, superficie del preload, isolamento del renderer (niente Node, niente
// rete esterna), ping UI → core → UI, stato reale del core nella UI (Fase 4), verifica dei motori
// dalla UI con processi reali del CLI Runtime (Fase 5, CLI finte in testa al PATH), kill del core con
// UI aperta, ricollegamento e recupero dello stato, persistenza.
/// <reference lib="dom" />
/// <reference path="../../src/renderer/env.d.ts" />
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/core/db/index.ts';
import type { CoreStateSnapshot, VisioneEvent, SupervisorSnapshot } from '../../src/shared/contracts/index.ts';
import { tempHome } from '../helpers.ts';

/** Versione dello schema del database: l'ultima migrazione, non un numero scritto a mano (era fermo a 12). */
const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;
/** Versione reale dell'app (package.json): i test non la scrivono a mano. */
const APP_VERSION = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;

const electronPath = createRequire(import.meta.url)('electron') as string;
const root = resolve('.');
const home = tempHome('visione-e2e-');
// CLI finte come shim npm (`"%_prog%" "<script>" %*`): la discovery le trova prima di quelle reali.
const fakeBin = join(home.dir, 'fake-bin');
mkdirSync(fakeBin, { recursive: true });
// Config di test deterministica: niente agenti predefiniti, niente fullscreen e scena pixel-office
// (P-89): le prove Neural esercitano la variante scelta dal proprietario.
mkdirSync(join(home.dir, 'config'), { recursive: true });
writeFileSync(join(home.dir, 'config', 'visione.json'), JSON.stringify({ version: 1, agents: { seedDefaults: false }, ui: { fullscreen: false, desktop: false, scene: 'pixel-office', expert: true, guideSeen: true, language: 'it' }, telemetry: { system: false, sensors: { enabled: false } } }));
for (const [name, script] of [['opencode', 'fake-opencode.mjs'], ['claude', 'fake-claude.mjs']] as const) {
  writeFileSync(join(fakeBin, `${name}.cmd`), `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%"  "${resolve('test/fixtures', script)}" %*\r\n`);
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  env.VISIONE_HOME = home.dir;
  // Valore fittizio per OpenCode finto (controlla solo che esista): mai la chiave reale nei test.
  env.NVIDIA_API_KEY = 'valore-di-prova';
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  env[pathKey] = `${fakeBin};${env[pathKey] ?? ''}`;
  // Audio muto (15/10/2026): le prove fanno parlare VISIONE e la riavviano a metà frase; dagli
  // altoparlanti del proprietario si sentiva la voce a pezzi.
  const app = await _electron.launch({ executablePath: electronPath, args: ['--mute-audio', '.'], cwd: root, env });
  const page = await app.firstWindow();
  // Schermo pulito (11/10/2026): di partenza c'è solo l'Umanoide. Le prove dei pannelli partono dal
  // layout classico, tutto acceso; lo schermo pulito ha la sua prova (in fondo).
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate((layout) => {
    localStorage.setItem('visione.panelli.v1', JSON.stringify(layout));
    localStorage.setItem('visione.schermo.v1', JSON.stringify({ bottom: true, strip: true, tabs: true, sceneInfo: true }));
  }, CLASSIC_LAYOUT);
  await page.reload();
  return { app, page };
}

/** Il layout di prima dello schermo pulito: pannelli accesi, widget spenti tranne l'Umanoide. */
const CLASSIC_LAYOUT = {
  left: ['humanoid', 'voice', 'director', 'approvals', 'clock'],
  right: ['system', 'agents', 'tasks', 'engines', 'diag', 'weather', 'graphs'],
  hidden: ['clock', 'weather', 'graphs'], collapsed: [], floats: {}, sizes: {}, layout: 2
};

const supervisor = (page: Page) => page.evaluate(() => window.visione.supervisor.get());
const journal = (page: Page) =>
  page.evaluate(async () => {
    const res = await window.visione.events.list({ afterSeq: 0, limit: 500 });
    return res.ok ? res.data.events : [];
  });
const text = (page: Page, id: string) => page.getByTestId(id).textContent();
const coreState = (page: Page) =>
  page.evaluate(async () => {
    const res = await window.visione.state.get();
    if (!res.ok) throw new Error(res.error.code);
    return res.data;
  });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let app: ElectronApplication;
let page: Page;
let crashEventId = '';

beforeAll(async () => {
  ({ app, page } = await launch());
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  home.cleanup();
});

describe('VISIONE — applicazione Electron', () => {
  it('apre la finestra e mostra stato del core, collegamento, ultimo evento e versione', async () => {
    expect(await page.title()).toBe('VISIONE');
    await expect.poll(() => text(page, 'core-state'), { timeout: 20_000 }).toBe('ready');
    await expect.poll(() => text(page, 'connection'), { timeout: 10_000 }).toBe('collegato');
    expect(await text(page, 'app-version')).toBe(APP_VERSION);
    expect(await text(page, 'ping')).toMatch(/ms$/);
    expect((await text(page, 'last-event'))?.length).toBeGreaterThan(0);
    // Fase 23: la sequenza di avvio si chiude quando il core è pronto; il centro notifiche si apre.
    await expect.poll(() => page.getByTestId('boot-overlay').count(), { timeout: 30_000 }).toBe(0);
    await page.getByTestId('notify-bell').click();
    await expect.poll(() => page.getByTestId('notify-panel').count(), { timeout: 5_000 }).toBe(1);
    await page.getByTestId('notify-bell').click();
    await expect.poll(() => page.getByTestId('notify-panel').count(), { timeout: 5_000 }).toBe(0);
  });

  it('voce (Fase 9, P-105, P-110): processo locale avviato; senza modelli d\'ascolto parla con la voce VISIONE inclusa e lo dichiara', async () => {
    // I modelli d'ascolto non sono inclusi nella build (si scaricano su consenso dalla procedura
    // guidata): la voce è pronta a PARLARE, l'ascolto resta spento e il nome del motore lo dice.
    // Parla la voce inclusa (P-110), non Windows: onnxruntime-node caricato prima di sherpa e modelli trovati.
    await expect.poll(async () => (await coreState(page)).voice.status, { timeout: 30_000 }).toBe('ready');
    const voice = (await coreState(page)).voice;
    expect(voice.listening).toBe(false);
    expect(voice.engines?.stt).toBe('ascolto spento: modelli da scaricare');
    expect(voice.engines?.vad).toBe('ascolto spento: modelli da scaricare');
    // P-106: senza modelli dei filtri nessun filtro è attivo (niente giudizi sulla voce).
    expect(voice.filters).toMatchObject({ denoise: false, speaker: false, owner: false, ownerOnly: false });
    const models = await page.evaluate(() => window.visione.voice.modelsStatus('listening'));
    expect(models.ok && models.data.complete).toBe(false);
    expect(voice.engines?.tts).toBe('VISIONE (Pocket TTS)');
    // Parla davvero: la frase parte e finisce, e il motore resta quello (nessun ripiego su Windows).
    await expect.poll(async () => (await coreState(page)).voice.speaking, { timeout: 30_000 }).toBeNull();
    const said = await page.evaluate(() => window.visione.voice.speak('Buonasera, signore. Tutti i sistemi sono operativi.'));
    expect(said.ok).toBe(true);
    await expect.poll(async () => (await coreState(page)).voice.speaking, { timeout: 10_000 }).not.toBeNull();
    await expect.poll(async () => (await coreState(page)).voice.speaking, { timeout: 30_000 }).toBeNull();
    expect((await coreState(page)).voice.engines?.tts).toBe('VISIONE (Pocket TTS)');
  });

  it('il renderer vede solo window.visione: niente Node, filesystem, processi', async () => {
    const surface = await page.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      return {
        require: typeof g.require,
        process: typeof g.process,
        module: typeof g.module,
        buffer: typeof g.Buffer,
        visione: Object.keys(window.visione).sort(),
        system: Object.keys(window.visione.system).sort(),
        state: Object.keys(window.visione.state).sort(),
        events: Object.keys(window.visione.events).sort(),
        files: Object.keys(window.visione.files).sort(),
        support: Object.keys(window.visione.support).sort(),
        runtime: Object.keys(window.visione.runtime).sort(),
        engines: Object.keys(window.visione.engines).sort(),
        agents: Object.keys(window.visione.agents).sort(),
        director: Object.keys(window.visione.director).sort(),
        tasks: Object.keys(window.visione.tasks).sort(),
        approvals: Object.keys(window.visione.approvals).sort(),
        audit: Object.keys(window.visione.audit).sort(),
        memory: Object.keys(window.visione.memory).sort(),
        terminal: Object.keys(window.visione.terminal).sort(),
        config: Object.keys(window.visione.config).sort(),
        voice: Object.keys(window.visione.voice).sort(),
        widgets: Object.keys(window.visione.widgets).sort(),
        vision: Object.keys(window.visione.vision).sort(),
        assistant: Object.keys(window.visione.assistant).sort(),
        training: Object.keys(window.visione.training).sort(),
        codemap: Object.keys(window.visione.codemap).sort(),
        offline: Object.keys(window.visione.offline).sort(),
        supervisor: Object.keys(window.visione.supervisor).sort()
      };
    });
    expect(surface).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      buffer: 'undefined',
      visione: ['agents', 'approvals', 'assistant', 'audit', 'chat', 'codemap', 'config', 'director', 'engines', 'events', 'files', 'groups', 'memory', 'offline', 'runtime', 'setup', 'state', 'supervisor', 'support', 'system', 'tasks', 'terminal', 'training', 'vision', 'voice', 'widgets'],
      system: ['apps', 'control', 'fullscreen', 'openExternal', 'ping', 'quit', 'relaunch', 'status'],
      files: ['copy', 'fromClipboard', 'list', 'mkdir', 'move', 'open', 'pathOf', 'pick', 'read', 'remove', 'rename', 'roots', 'search', 'trash'],
      support: ['report'],
      state: ['get', 'subscribe'],
      events: ['get', 'list', 'subscribe'],
      runtime: ['processes', 'stop'],
      engines: ['probe', 'restart'],
      // Fase 6: nessun metodo avvia un processo o sceglie un eseguibile. P-99: `rename` cambia solo
      // il nome mostrato; `restart` ri-verifica e riavvia SESSIONI esistenti, non processi scelti.
      agents: ['archive', 'define', 'interrupt', 'list', 'models', 'rename', 'start', 'stop', 'tell', 'tuning'],
      director: ['interrupt', 'submit'],
      tasks: ['cancel', 'get', 'list'],
      approvals: ['decide', 'list'],
      audit: ['list'],
      // Fase 7: memoria del proprietario (nessun avvio di processi).
      memory: ['promote', 'reflect', 'search', 'write'],
      // Fase 8: la shell la sceglie il core; input e dimensioni solo per le sessioni interattive.
      terminal: ['close', 'input', 'list', 'open', 'resize', 'snapshot'],
      config: ['get', 'update'],
      // Fase 9: la voce è locale; il push-to-talk e la frase del proprietario sono gli unici ingressi.
      // P-105/P-106: modelli scaricati su consenso e impronta della voce del proprietario.
      voice: ['accuracy', 'benchmark', 'enroll', 'modelsDownload', 'modelsStatus', 'ptt', 'restart', 'speak', 'status', 'stop', 'talkTo', 'wake'],
      // Widget (11/10/2026): solo il meteo, chiesto al core (il renderer resta senza rete).
      widgets: ['weather'],
      vision: ['face'],
      assistant: ['add', 'ask', 'list', 'lists', 'parse', 'removeItem', 'update'],
      // P-107k: Addestramento, regole scelte dall'utente (nessun processo, nessuna rete).
      training: ['add', 'list', 'remove', 'set'],
      // P-107l: mappa del codice delle cartelle degli agenti (solo cartelle già note al core).
      codemap: ['preview', 'scan', 'set', 'status'],
      // 17/10/2026: modalità offline; il modello si scarica solo su consenso, da un indirizzo fisso del core.
      offline: ['ask', 'cancelDownload', 'download', 'set', 'status'],
      supervisor: ['get', 'subscribe']
    });
  });

  it('il renderer non raggiunge host esterni (CSP) e il main blocca la rete della sessione', async () => {
    const fromRenderer = await page.evaluate(() =>
      fetch('https://visione-netguard.invalid/').then(() => 'raggiunto', () => 'bloccato')
    );
    expect(fromRenderer).toBe('bloccato');
    // Senza CSP (navigazione avviata dal main): la guardia di rete della sessione deve bloccarla.
    const fromSession = await app.evaluate(async ({ BrowserWindow }) => {
      const probe = new BrowserWindow({ show: false });
      try {
        await probe.loadURL('https://visione-netguard.invalid/');
        return 'raggiunto';
      } catch (err) {
        return String(err);
      } finally {
        probe.destroy();
      }
    });
    expect(fromSession).toMatch(/ERR_BLOCKED_BY_CLIENT/);
  });

  it('system.ping fa il giro UI → main → core → main → UI', async () => {
    const res = await page.evaluate(() => window.visione.system.ping('e2e'));
    const sup = await supervisor(page);
    expect(res).toMatchObject({ ok: true, data: { pong: true, echo: 'e2e', pid: sup.pid } });
    const status = await page.evaluate(() => window.visione.system.status());
    expect(status).toMatchObject({ ok: true, data: { schemaVersion: SCHEMA_VERSION, coreVersion: APP_VERSION } });
  });

  it('la UI mostra lo stato reale del core, aggiornato per notifica', async () => {
    await expect.poll(() => text(page, 'core-status'), { timeout: 10_000 }).toBe('ready');
    await expect.poll(() => text(page, 'app-state'), { timeout: 10_000 }).toBe('running');
    expect(await text(page, 'db-status')).toBe('ok');
    expect(await text(page, 'ipc-status')).toBe('connected');
    expect(await text(page, 'db-schema')).toBe(String(SCHEMA_VERSION));
    const sup = await supervisor(page);
    const snap: CoreStateSnapshot = await coreState(page);
    expect(snap.core).toMatchObject({ status: 'ready', pid: sup.pid, previousRun: null, recovered: false });

    // I contatori mostrati coincidono con quelli del core (stessa fonte, nessun dato inventato).
    await expect.poll(async () => {
      const [shown, s] = [await text(page, 'event-count'), await coreState(page)];
      return shown === String(s.database.journalCount) && s.database.journalCount === (await journal(page)).length;
    }, { timeout: 10_000 }).toBe(true);
    expect(Number(await text(page, 'events-since-start'))).toBeGreaterThan(0);
    const last = await text(page, 'last-event');
    expect(last?.length).toBeGreaterThan(0);

    // Notifiche spinte dal core alla pagina, senza richiederle: un ping le fa avanzare.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __states: number[] };
      g.__states = [];
      window.visione.state.subscribe((s) => g.__states.push(s.revision));
    });
    const before = (await coreState(page)).revision;
    await page.evaluate(() => window.visione.system.ping('stato'));
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __states: number[] }).__states.at(-1) ?? 0), { timeout: 5_000 })
      .toBeGreaterThan(before);
    // L'evento correlato al ping arriva alla pagina e il comando risulta completato nello stato.
    const res = await page.evaluate(() => window.visione.system.ping('corr'));
    expect(res.ok).toBe(true);
    await expect.poll(async () => (await coreState(page)).ipc.commandsCompleted, { timeout: 5_000 }).toBeGreaterThan(2);
    await expect.poll(() => text(page, 'ipc-commands'), { timeout: 5_000 }).toMatch(/^\d+ ok/);
  });

  it('lo stato ricevuto dalla pagina è una copia: modificarla non tocca il core', async () => {
    const tampered = await page.evaluate(async () => {
      const res = await window.visione.state.get();
      if (!res.ok) return 'errore';
      (res.data.core as { status: string }).status = 'crashed';
      return res.data.core.status;
    });
    expect(tampered).toBe('crashed');
    expect((await coreState(page)).core.status).toBe('ready');
  });

  it('verifica dei motori dalla UI: UI → core → runtime → processi probe → eventi e stato nella UI', async () => {
    expect(await text(page, 'engines-state')).toBe('non verificati');
    expect(await text(page, 'processes-created')).toBe('0');
    await page.getByRole('button', { name: 'Verifica motori' }).click();
    // Fase 8: anche `pty-generic` (la CLI la sceglie ogni agente).
    await expect.poll(() => page.getByTestId('engines').locator('li').count(), { timeout: 20_000 }).toBe(3);
    expect(await text(page, 'engine-opencode')).toContain('opencode v2.0.12-fake');
    expect(await text(page, 'engine-claude-code')).toContain('2.1.286-fake (Claude Code)');
    expect(await text(page, 'engine-opencode')).toContain('disponibile');
    // Due processi `probe` reali, usciti con 0: contatori dallo stato del core, spinti alla UI.
    await expect.poll(() => text(page, 'processes-created'), { timeout: 10_000 }).toBe('2');
    // I due probe possono uscire dopo che il contatore degli avviati è già a 2.
    await expect.poll(() => text(page, 'processes-active'), { timeout: 10_000 }).toBe('0 attivi');
    expect(await text(page, 'processes-last')).toMatch(/^exited · /);
    const all = await journal(page);
    const types = all.map((e) => e.type);
    expect(types.filter((t) => t === 'system.cli.discovered')).toHaveLength(2);
    expect(types.filter((t) => t === 'process.exited')).toHaveLength(2);
    const created = all.filter((e) => e.type === 'process.created').map((e) => e.payload as { kind: string; exe: string; argCount: number });
    expect(created.map((p) => p.kind)).toEqual(['probe', 'probe']);
    // La UI non può avviare processi né scegliere un eseguibile.
    const res = await page.evaluate(() => (window.visione as unknown as { runtime: { start?: unknown } }).runtime.start);
    expect(res).toBeUndefined();
    const stop = await page.evaluate(() => window.visione.runtime.stop('inesistente'));
    expect(stop).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('Director (Fase 6): obiettivo dalla UI, piano su due motori diversi, approvazione dalla UI, azione bloccata', async () => {
    const model = 'nvidia/nvidia/nemotron-3-super-120b-a12b';
    const def = (id: string, adapter: string, competences: string[], extra: Record<string, unknown> = {}) => ({
      id, name: id, role: `agente ${id}`, competences, engine: { adapter, ...extra }, persona: { instructions: 'Rispondi in italiano.', language: 'it' },
      workspace: { root: id, isolation: 'shared' }, permissions: 'read-only', limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
    });
    const defined = await page.evaluate(async (defs) => Promise.all(defs.map((d) => window.visione.agents.define(d as never))), [
      def('esecutore', 'opencode', ['code'], { model }), def('revisore', 'claude-code', ['review'])
    ]);
    expect(defined).toMatchObject([{ ok: true }, { ok: true }]);
    await expect.poll(() => text(page, 'agents-count'), { timeout: 10_000 }).toBe('2 definiti · 0 vivi');

    // 1. Dalla UI: un obiettivo → RulePlanner → un task al primo agente compatibile → risultato reale della CLI finta.
    await page.getByTestId('goal-input').fill('Rispondi OK');
    await page.getByTestId('goal-submit').click();
    await expect.poll(() => text(page, 'goal-status'), { timeout: 30_000 }).toBe('succeeded');
    expect(await text(page, 'goal-tasks')).toContain('esecutore');

    // 2. Piano esplicito: OpenCode produce, Claude Code (PTY, hook, shim) rivede dopo.
    const submitted = await page.evaluate(() => window.visione.director.submit({
      goal: 'Produci e rivedi', title: 'Produci e rivedi',
      plan: { steps: [
        { key: 'p', title: 'Produci', spec: 'Rispondi OK', agentId: 'esecutore' },
        { key: 'r', title: 'Rivedi', spec: 'Rivedi.\nRISPOSTA:revisione e2e.', competence: 'review', dependsOn: ['p'] }
      ] }
    }));
    expect(submitted.ok).toBe(true);
    const rootId = submitted.ok ? submitted.data.rootTaskId : '';
    await expect.poll(async () => (await journal(page)).some((e) => e.type === 'director.summary' && (e.payload as { rootTaskId: string }).rootTaskId === rootId), { timeout: 60_000 }).toBe(true);
    // Conversazione a voce (15/10/2026): la sintesi porta la risposta vera, quella dell'ultimo passo.
    const summary = (await journal(page)).find((e) => e.type === 'director.summary' && (e.payload as { rootTaskId: string }).rootTaskId === rootId);
    expect((summary?.payload as { answer?: string | null } | undefined)?.answer).toBe('revisione e2e');
    const tree = await page.evaluate((id) => window.visione.tasks.get(id), rootId);
    expect(tree.ok && tree.data.children.map((c) => `${c.title}:${c.status}:${c.assigneeAgentId}:${c.result?.summary ?? ''}`)).toEqual([
      'Produci:succeeded:esecutore:OK', 'Rivedi:succeeded:revisore:revisione e2e'
    ]);

    // 3. Azione con approvazione: il task si ferma; il proprietario approva dalla UI; poi termina.
    const waiting = await page.evaluate(() => window.visione.director.submit({
      goal: 'Scrivi fuori', plan: { steps: [{ key: 'w', title: 'Scrivi fuori', spec: 'Rispondi OK', agentId: 'esecutore', actions: [{ kind: 'fs.write', target: 'C:\\fuori-da-visione\\nota.txt' }] }] }
    }));
    const waitingRoot = waiting.ok ? waiting.data.rootTaskId : '';
    await expect.poll(() => text(page, 'approvals-pending'), { timeout: 10_000 }).toBe('1 in attesa');
    const before = await page.evaluate((id) => window.visione.tasks.get(id), waitingRoot);
    expect(before.ok && before.data.children[0]?.status).toBe('waiting');
    await page.getByRole('button', { name: 'Approva', exact: true }).click();
    await expect.poll(async () => {
      const r = await page.evaluate((id) => window.visione.tasks.get(id), waitingRoot);
      return r.ok ? r.data.task.status : 'errore';
    }, { timeout: 30_000 }).toBe('succeeded');
    await expect.poll(() => text(page, 'approvals-pending'), { timeout: 10_000 }).toBe('0 in attesa');

    // 4. Azione bloccata: non parte mai (nessun processo per quel task).
    const blocked = await page.evaluate(() => window.visione.director.submit({
      goal: 'Pubblica', plan: { steps: [{ key: 'b', title: 'Pubblica', spec: 'git push', agentId: 'esecutore', actions: [{ kind: 'git', target: 'push origin main' }] }] }
    }));
    const blockedRoot = blocked.ok ? blocked.data.rootTaskId : '';
    await expect.poll(async () => {
      const r = await page.evaluate((id) => window.visione.tasks.get(id), blockedRoot);
      return r.ok ? `${r.data.task.status}:${r.data.children[0]?.error?.code ?? ''}` : 'errore';
    }, { timeout: 10_000 }).toBe('failed:policy_blocked');
    const blockedTaskId = await page.evaluate(async (id) => {
      const r = await window.visione.tasks.get(id);
      return r.ok ? r.data.children[0]?.id ?? '' : '';
    }, blockedRoot);
    const processes = (await journal(page)).filter((e) => e.type === 'process.created').map((e) => (e.payload as { owner: { taskId: string | null } }).owner.taskId);
    expect(processes).not.toContain(blockedTaskId);
    // Stato del core e audit coerenti; la catena dell'audit è integra.
    const state = await coreState(page);
    expect(state).toMatchObject({ agents: { defined: 2 }, approvals: { pending: 0 }, director: { activeGoals: 0 } });
    const audit = await page.evaluate(() => window.visione.audit.list(200));
    expect(audit.ok && audit.data.chain.ok).toBe(true);
    expect(audit.ok && audit.data.entries.some((e) => e.action === 'blocked:git')).toBe(true);
  });

  it('Memoria (Fase 7): dalla UI scrittura e ricerca; il fatto della CLI OpenCode finta entra nel brief di Claude Code finto', async () => {
    const written = await page.evaluate(() => window.visione.memory.write({ scope: 'global', title: 'Cliente', content: 'Il cliente del progetto si chiama Orione', pinned: true }));
    expect(written).toMatchObject({ ok: true, data: { created: true, item: { scope: 'global', pinned: true, source: 'owner:ui' } } });
    const submitted = await page.evaluate(() => window.visione.director.submit({
      goal: 'Concorda e controlla',
      plan: { steps: [
        { key: 'c', title: 'Concorda', spec: 'MEMORIA-FINTA porta4321', agentId: 'esecutore' },
        { key: 'k', title: 'Controlla', spec: 'Controlla il valore concordato per il cliente.\nRISPOSTA:controllo e2e.', competence: 'review', dependsOn: ['c'] }
      ] }
    }));
    const rootId = submitted.ok ? submitted.data.rootTaskId : '';
    await expect.poll(async () => (await journal(page)).some((e) => e.type === 'director.summary' && (e.payload as { rootTaskId: string }).rootTaskId === rootId), { timeout: 60_000 }).toBe(true);
    const found = await page.evaluate(() => window.visione.memory.search({ query: 'valore concordato' }));
    expect(found.ok && found.data.items[0]).toMatchObject({ scope: 'task', source: 'agent:esecutore', origin: 'turn', content: 'il valore concordato è porta4321' });
    // Il brief del revisore (file scritto dal core) contiene il fatto e il fatto fissato del proprietario.
    const built = (await journal(page)).filter((e) => e.type === 'memory.context.built').map((e) => e.payload as { agentId: string; file: string });
    const brief = readFileSync(built.filter((b) => b.agentId === 'revisore').at(-1)?.file as string, 'utf8');
    expect(brief).toMatch(/## Memoria pertinente[^#]*il valore concordato è porta4321/);
    expect(brief).toContain('Cliente: Il cliente del progetto si chiama Orione');
    const tree = await page.evaluate((id) => window.visione.tasks.get(id), rootId);
    expect(tree.ok && tree.data.children.map((c) => c.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('Command center (Fase 8): viste, HUD dichiarato, palette, cassetti Memoria e Impostazioni, shell reale nella vista Terminale', async () => {
    for (const id of ['tab-neural', 'tab-tasks', 'tab-events', 'tab-terminal', 'hud', 'neural', 'events', 'goal-input', 'terminal-view']) {
      expect(await page.getByTestId(id).count(), id).toBe(1);
    }
    // HUD: valori dal core; i campionatori di sistema (Fase 10) dichiarati non disponibili, mai stimati.
    expect(await page.getByTestId('metric-agents').getAttribute('data-status')).toBe('ok');
    // Fase 14: CPU e RAM sono misure reali del sistema (`os`), non più N/D.
    await expect.poll(() => page.getByTestId('metric-cpu').getAttribute('data-status'), { timeout: 15_000 }).toBe('ok');
    expect(await text(page, 'metric-cpu')).toMatch(/\d/);
    await expect.poll(() => page.getByTestId('metric-ram').getAttribute('data-status')).toBe('ok');
    // Temperatura: la macchina non la espone -> N/D dichiarato, mai inventata.
    expect(await page.getByTestId('metric-temp').getAttribute('data-status')).toBe('unavailable');
    expect(await text(page, 'metric-temp')).toContain('N/D');
    // TTFT: non esposto dai motori -> N/D dichiarato.
    expect(await page.getByTestId('metric-ttft').getAttribute('data-status')).toBe('unavailable');

    // Palette da tastiera: Ctrl+K → "Terminale" → Invio.
    await page.keyboard.press('Control+k');
    await expect.poll(() => page.getByTestId('palette').count()).toBe(1);
    await page.keyboard.type('Mostra Terminale');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('tab-terminal').getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('palette').count()).toBe(0);

    // Shell reale scelta dal core (PowerShell), xterm, input da tastiera, eco nello scrollback del core.
    // P-87: all'apertura la barra inferiore è piegata (composizione della reference): qui si espande,
    // perché il terminale vive lì. Il comportamento resta identico.
    if ((await page.locator('.row-bottom.collapsed').count()) > 0) {
      await page.getByTestId('toggle-bottom-shade').click();
    }
    await page.getByTestId('terminal-open').click();
    const host = page.getByTestId('terminal-host');
    await expect.poll(() => host.count(), { timeout: 15_000 }).toBe(1);
    const pid = (await host.getAttribute('data-process')) as string;
    // Testo dello schermo senza le sequenze di controllo di ConPTY.
    const scroll = async (): Promise<string> => {
      const r = await page.evaluate((id) => window.visione.terminal.snapshot(id), pid);
      return r.ok ? r.data.text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') : '';
    };
    await expect.poll(scroll, { timeout: 30_000 }).toMatch(/PS [A-Z]:\\/);
    await host.click();
    await page.keyboard.type('echo visione-e2e-fase8');
    await page.keyboard.press('Enter');
    // Il comando digitato (eco) e la sua uscita.
    const echoed = async (): Promise<number> => (await scroll()).split('visione-e2e-fase8').length - 1;
    await expect.poll(echoed, { timeout: 20_000 }).toBeGreaterThanOrEqual(2).catch(async (err: unknown) => {
      console.log('SCHERMO', JSON.stringify((await scroll()).slice(-800)));
      throw err;
    });
    const sessions = await page.evaluate(() => window.visione.terminal.list());
    expect(sessions.ok && sessions.data.sessions.find((s) => s.processId === pid)).toMatchObject({ kind: 'terminal', interactive: true });
    await page.getByRole('button', { name: /^chiudi shell/ }).click();
    await expect.poll(async () => {
      const r = await page.evaluate(() => window.visione.terminal.list());
      return r.ok ? r.data.sessions.find((s) => s.processId === pid)?.endedAt ?? null : null;
    }, { timeout: 15_000 }).not.toBeNull();
    expect((await journal(page)).filter((e) => e.type === 'terminal.session.opened' || e.type === 'terminal.session.closed').map((e) => e.type)).toEqual(['terminal.session.opened', 'terminal.session.closed']);

    // Memoria (finestra, dal menu Finestre): scrittura del proprietario e ricerca.
    await page.getByTestId('windows-menu').click();
    await page.getByTestId('win-open-memory').click();
    await page.getByTestId('memory-content').fill('Il colore del progetto è il blu notte');
    // La finestra può finire sotto la barra del terminale: il clic va al pulsante, non alle coordinate.
    await page.getByTestId('memory-write').dispatchEvent('click');
    await expect.poll(() => text(page, 'memory-note'), { timeout: 5_000 }).toBe('scritto');
    expect(await text(page, 'memory-items')).toContain('Il colore del progetto è il blu notte');
    await page.getByTestId('windows-menu').click();
    await page.getByTestId('win-close-all').click();
    expect(await page.getByTestId('memory-drawer').count()).toBe(0);

    // Addestramento in vista nella barra in alto (17/10/2026): un clic apre la finestra.
    await page.getByTestId('open-training').click();
    await expect.poll(() => page.locator('[data-kind="training"]').count(), { timeout: 5_000 }).toBe(1);
    await page.getByTestId('windows-menu').click();
    await page.getByTestId('win-close-all').click();
    await expect.poll(() => page.locator('[data-kind="training"]').count()).toBe(0);

    // Cassetto Impostazioni: modifica validata, vale dal prossimo avvio del core.
    await page.getByTestId('open-settings').click();
    // Wake word (P-81): il toggle dedicato c'è anche senza motori (la config si salva, il runtime no).
    // Il cassetto carica la config in modo asincrono: si attende la comparsa (stesso requisito).
    await expect.poll(() => page.getByTestId('setting-wake-enabled').count(), { timeout: 5_000 }).toBe(1);
    expect(await page.getByTestId('setting-wake-enabled').isChecked()).toBe(false);
    // Modalità esperto (17/10/2026): spegnerla è immediato, accenderla chiede conferma; «Annulla» non cambia nulla.
    await page.getByTestId('setting-expert').uncheck();
    await expect.poll(() => page.getByTestId('setting-expert').isChecked()).toBe(false);
    await page.getByTestId('setting-expert').click();
    await expect.poll(() => page.getByTestId('expert-confirm').count()).toBe(1);
    await page.getByTestId('expert-cancel').click();
    expect(await page.getByTestId('expert-confirm').count()).toBe(0);
    expect(await page.getByTestId('setting-expert').isChecked()).toBe(false);
    await page.getByTestId('setting-expert').click();
    await page.getByTestId('expert-ok').click();
    await expect.poll(() => page.getByTestId('setting-expert').isChecked()).toBe(true);
    await page.getByTestId('setting-memory.searchLimit').fill('5');
    await page.getByTestId('settings-save').click();
    await expect.poll(() => text(page, 'settings-saved'), { timeout: 5_000 }).toContain('memory.searchLimit');
    const cfg = await page.evaluate(() => window.visione.config.get());
    expect(cfg.ok && cfg.data).toMatchObject({ restartRequired: true, config: { memory: { searchLimit: 5 } } });
    // 11/10/2026: un'impostazione che vale dal riavvio apre la richiesta; «Più tardi» lascia un promemoria in alto.
    await expect.poll(() => page.getByTestId('restart-prompt').count(), { timeout: 5_000 }).toBe(1);
    expect((await text(page, 'restart-changed'))?.trim().length ?? 0).toBeGreaterThan(0);
    await page.getByTestId('restart-later').click();
    await expect.poll(() => page.getByTestId('restart-pending').count()).toBe(1);
    await page.locator('aside[aria-label="Impostazioni"] button[aria-label="chiudi"]').click();
    await expect.poll(() => page.getByTestId('settings-drawer').count()).toBe(0);
  }, 120_000);

  it('modalità offline (17/10/2026): spia, tasto con avviso sui limiti, risposta locale, ritorno online', async () => {
    await expect.poll(() => page.getByTestId('offline-lamp').count(), { timeout: 10_000 }).toBe(1);
    // Il tasto chiede conferma e spiega i limiti; senza modello scaricato lo dice. «Annulla» non cambia nulla.
    await page.getByTestId('offline-enter').click();
    await expect.poll(() => page.getByTestId('offline-confirm').count()).toBe(1);
    expect(await page.getByTestId('offline-notice-missing').count()).toBe(1);
    expect(await page.getByTestId('offline-download').count()).toBe(1);
    await page.getByTestId('offline-cancel').click();
    expect(await page.getByTestId('offline-confirm').count()).toBe(0);
    expect(await page.getByTestId('offline-lamp').getAttribute('data-state')).not.toBe('offline');
    await page.getByTestId('offline-enter').click();
    await page.getByTestId('offline-ok').click();
    await expect.poll(() => page.getByTestId('offline-lamp').getAttribute('data-state')).toBe('offline');
    // Offline la barra comandi va al modello locale; ora e data le sa anche senza modello.
    await page.getByTestId('goal-input').fill('che ore sono?');
    await page.getByTestId('goal-submit').click();
    await expect.poll(() => text(page, 'offline-reply-text'), { timeout: 10_000 }).toMatch(/^(Sono le|È l'una)/);
    // Una frase fuori dalle regole, senza modello: lo dice invece di mandarla agli agenti.
    await page.getByTestId('goal-input').fill('mi avvisi alle sei che devo uscire?');
    await page.getByTestId('goal-submit').click();
    await expect.poll(() => text(page, 'offline-reply-text'), { timeout: 10_000 }).toContain('non è scaricato');
    await page.getByTestId('offline-leave').click();
    await expect.poll(() => page.getByTestId('offline-lamp').getAttribute('data-state')).not.toBe('offline');
    expect(await page.getByTestId('offline-reply').count()).toBe(0);
  }, 60_000);

  it('UI core proprietaria (Fase 11): Chat, Director e Logs da dati reali, nessuno stato finto', async () => {
    // Chat: il compositore è collegato a director.submit; i turni nascono solo dagli eventi reali.
    await page.getByTestId('tab-chat').click();
    await expect.poll(() => page.getByTestId('chat-messages').count()).toBe(1);
    // 24/10/2026: la chat è un pannello del dock, libero sullo schermo (spostabile, ridimensionabile, a tendina).
    expect(await page.locator('[data-panel="chat"]').getAttribute('data-panel-float')).toBe('true');
    expect(await page.getByTestId('panel-resize-chat').count()).toBe(1);
    await page.getByTestId('chat-input').fill('Verifica chat fase undici');
    await page.getByTestId('chat-send').click();
    // Il turno del proprietario è il titolo del goal reale (evento `task.created` kind=goal).
    await expect.poll(async () => text(page, 'chat-messages'), { timeout: 15_000 }).toContain('Verifica chat fase undici');
    // Compaiono turni reali di agenti/Director (CLI finte), non contenuti hardcoded.
    await expect.poll(async () => page.getByTestId('chat-turn').count(), { timeout: 30_000 }).toBeGreaterThan(1);

    // Allegati (24/10/2026): 📎 → file scelto (finestra di scelta simulata nel main) → etichetta in attesa → invio →
    // etichetta nel fumetto; l'agente riceve una copia nella sua cartella di lavoro.
    const allegato = join(home.dir, 'preventivo-e2e.txt');
    writeFileSync(allegato, 'totale 1200 euro');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog;
    }, allegato);
    await page.getByTestId('chat-attach').click();
    await page.getByTestId('chat-attach-files').click();
    await expect.poll(async () => text(page, 'chat-pending-files')).toContain('preventivo-e2e.txt');
    await page.getByTestId('chat-input').fill('Controlla il preventivo allegato');
    await page.getByTestId('chat-send').click();
    await expect.poll(() => page.getByTestId('chat-file').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await page.getByTestId('chat-file').first().textContent()).toContain('preventivo-e2e.txt');
    expect(await page.getByTestId('chat-pending-files').count()).toBe(0);
    const workspaces = join(home.dir, 'workspace');
    const copied = (): boolean => existsSync(workspaces) && readdirSync(workspaces).some((a) => existsSync(join(workspaces, a, '.allegati')));
    await expect.poll(copied, { timeout: 60_000 }).toBe(true);

    // Tendina e chiusura come l'Umanoide; il tasto «Chat» la riapre nello stesso punto e la richiude.
    const chatBox = await page.locator('[data-panel="chat"]').boundingBox();
    await page.getByTestId('panel-collapse-chat').click();
    await expect.poll(() => page.getByTestId('chat-messages').isVisible()).toBe(false);
    await page.getByTestId('panel-close-chat').click();
    await expect.poll(() => page.locator('[data-panel="chat"]').count()).toBe(0);
    await page.getByTestId('tab-chat').click();
    await expect.poll(() => page.getByTestId('chat-messages').isVisible()).toBe(true);
    expect(await page.locator('[data-panel="chat"]').boundingBox()).toMatchObject({ x: chatBox!.x, y: chatBox!.y });
    await page.getByTestId('tab-chat').click();
    await expect.poll(() => page.locator('[data-panel="chat"]').count()).toBe(0);

    // Director: piani, decisioni e sintesi dagli eventi `director.*`.
    await page.getByTestId('tab-director').click();
    await expect.poll(() => page.getByTestId('director-view').count()).toBe(1);
    await expect.poll(async () => text(page, 'director-decisions'), { timeout: 15_000 }).not.toBe('');
    expect(await text(page, 'director-active-goals')).toMatch(/\d+ obiettivi attivi/);

    // Logs: filtro reale per gravità; la vista Eventi resta unica (nessuna duplicazione di viste).
    await page.getByTestId('tab-logs').click();
    expect(await page.getByTestId('logs').count()).toBe(1);
    expect(await page.getByTestId('events').count()).toBe(1);
  }, 120_000);

  it('Neural 3D (Fase 8): worker, effetto tracciabile per evento, nessuna animazione senza eventi, 20 agenti con qualità adattiva, contesto WebGL ripristinato', async () => {
    await page.getByTestId('tab-neural').click();
    const neural = page.getByTestId('neural');
    const attr = (n: string) => neural.getAttribute(`data-${n}`);
    // P-89: la scena è quella scelta in `ui.scene` (config del test = pixel-office).
    await expect.poll(() => attr('scene'), { timeout: 10_000 }).toBe('pixel-office');
    expect(await attr('context')).toBe('ok');
    await expect.poll(() => attr('mode')).toBe('worker');
    const def = (id: string) => ({
      id, name: id, role: `agente ${id}`, competences: ['general'], engine: { adapter: 'opencode', model: 'nvidia/nvidia/nemotron-3-super-120b-a12b' },
      persona: { instructions: 'x', language: 'it' }, workspace: { root: id, isolation: 'shared' }, permissions: 'read-only',
      limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
    });
    // 20 agenti dalla UI: eventi reali → nodi e impulsi.
    const out = await page.evaluate(async (defs) => Promise.all(defs.map((d) => window.visione.agents.define(d as never))), Array.from({ length: 20 }, (_, i) => def(`neurale${i}`)));
    expect(out.every((r) => r.ok)).toBe(true);
    await expect.poll(async () => Number(await attr('nodes')), { timeout: 10_000 }).toBeGreaterThanOrEqual(22);
    // Ogni evento di dominio ha un effetto tracciabile: l'id dell'ultimo è nel registro effetti del renderer.
    const last = (await journal(page)).filter((e) => e.type === 'agent.definition.created').at(-1);
    await expect.poll(
      () => page.evaluate((id) => (window as unknown as { __visioneNeural: { effects(): Array<{ eventId: string }> } }).__visioneNeural.effects().some((e) => e.eventId === id), last?.id ?? ''),
      { timeout: 10_000 }
    ).toBe(true);
    await expect.poll(() => text(page, 'neural-effects'), { timeout: 5_000 }).not.toBe('');
    expect(Number(await attr('domain'))).toBeGreaterThan(20);
    // Fase 12: Director è il nodo centrale (dal coordinatore reale); archi e glow additivo presenti.
    expect(Number(await attr('edges'))).toBeGreaterThanOrEqual(20);
    expect(Number(await attr('glow'))).toBeGreaterThan(0);
    await expect.poll(() => page.locator('[data-label="director"]').textContent(), { timeout: 5_000 }).toBe('Director');

    // Fase 12.5: core volumetrico di Director, campo ambientale e stato reale del coordinatore.
    expect(Number(await attr('core'))).toBeGreaterThan(0);
    expect(Number(await attr('ambient'))).toBeGreaterThanOrEqual(0);
    expect(['idle', 'planning', 'working', 'error']).toContain(await attr('director'));

    // Hover reale: raycast sulla scena. Si cerca un nodo agente effettivamente colpibile.
    const box = await page.locator('.neural-canvas').boundingBox();
    expect(box).not.toBeNull();
    const labels = await page.evaluate(() => (window as unknown as { __visioneNeural: { labels(): Array<{ id: string; nx: number; ny: number }> } }).__visioneNeural.labels());
    const points = labels.filter((l) => l.id.startsWith('agent:')).map((l) => ({ id: l.id, x: (box?.x ?? 0) + l.nx, y: (box?.y ?? 0) + l.ny }));
    const scans = await page.evaluate((list) => list.map((p) => ({ id: p.id, x: p.x, y: p.y, picked: (window as unknown as { __visioneNeural: { pickAt(x: number, y: number): string | null } }).__visioneNeural.pickAt(p.x, p.y) })), points);
    const hit = scans.find((s) => s.picked !== null);
    expect(hit, `nessun nodo agente colpibile (${scans.filter((s) => s.picked !== null).length}/${scans.length})`).toBeTruthy();

    if (hit?.picked) {
      await page.evaluate((p) => {
        const canvas = document.querySelector('.neural-canvas') as HTMLCanvasElement;
        canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x, clientY: p.y, bubbles: true }));
      }, { x: hit.x, y: hit.y });
      await expect.poll(async () => page.evaluate(() => (window as unknown as { __visioneNeural: { stats(): { hover: string | null } } }).__visioneNeural.stats().hover), { timeout: 5_000 }).toBe(hit.picked);
      // P-88: la label dell'agente compare al passaggio (concetto `.rete-etichetta` di Munder),
      // con nome e riga tipo/stato; il canvas prende il cursore a puntatore.
      const hoverLabel = page.locator(`[data-label="${hit.picked}"]`);
      await expect.poll(() => hoverLabel.count(), { timeout: 5_000 }).toBe(1);
      expect(await hoverLabel.textContent()).toContain('AGENTE');
      expect(await page.locator('.neural-canvas').evaluate((el) => (el as HTMLElement).style.cursor)).toBe('pointer');
      // Click sulla label del nodo → selezione + pannello contestuale con dati veri; il secondo click chiude.
      await page.evaluate((p) => {
        const canvas = document.querySelector('.neural-canvas') as HTMLCanvasElement;
        canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 }));
        canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 }));
      }, { x: hit.x, y: hit.y });
      await expect.poll(() => page.getByTestId('node-panel').count()).toBe(1);
      expect(await text(page, 'node-panel-title')).toBe(hit.picked.slice('agent:'.length));
      await expect.poll(async () => page.getByTestId('node-panel').textContent()).toContain('opencode');
      expect(await neural.getAttribute('data-selected')).toBe(hit.picked);
      await page.locator('.node-panel button[aria-label="chiudi"]').click();
      await expect.poll(() => page.getByTestId('node-panel').count()).toBe(0);
      // P-88: il click sul globo apre davvero la finestra dell'agente; il test la richiude per non
      // lasciare stato alle prove successive.
      await expect.poll(() => page.locator('[data-window]').count(), { timeout: 5_000 }).toBeGreaterThan(0);
      await page.getByTestId('windows-menu').click();
      await page.getByTestId('win-close-all').click();
      await expect.poll(() => page.locator('[data-window]').count(), { timeout: 5_000 }).toBe(0);
    }

    // Director selezionabile: pannello con stato reale del coordinatore.
    await page.locator('[data-label="director"]').click();
    await expect.poll(async () => page.getByTestId('node-panel').textContent()).toContain('coordinatore');
    await page.locator('.node-panel button[aria-label="chiudi"]').click();
    await expect.poll(() => page.getByTestId('node-panel').count()).toBe(0);
    // Fase 12.7: il click su Director apre la vista Director; i pannelli sono riducibili.
    await expect.poll(() => page.getByTestId('tab-director').getAttribute('aria-selected')).toBe('true');
    await page.getByTestId('tab-neural').click();
    // Schermo pulito: la barra in basso si spegne e si riaccende dal menu Widget.
    await page.getByTestId('widgets-menu').click();
    await page.getByTestId('screen-toggle-bottom').click();
    await expect.poll(() => page.locator('.app.hide-bottom').count()).toBe(1);
    await page.getByTestId('screen-toggle-bottom').click();
    await expect.poll(() => page.locator('.app.hide-bottom').count()).toBe(0);
    await page.keyboard.press('Escape');
    // P-90: movimento ambientale SEMPRE attivo (anche a riposo): il ciclo del renderer gira, l'fps
    // mostrato è reale e due letture a distanza differiscono. Nessuna attività finta: 0 impulsi e
    // nessun evento di dominio nuovo.
    const reading = async () => ({ frames: Number(await attr('frames')), domain: Number(await attr('domain')) });
    await expect.poll(async () => Number(await attr('pulses-active')), { timeout: 30_000 }).toBe(0);
    await expect.poll(async () => attr('director'), { timeout: 30_000 }).toBe('idle');
    const quiet = await reading();
    await page.waitForTimeout(600);
    const moved = await reading();
    expect(moved.frames - quiet.frames).toBeGreaterThan(5);
    const idle = await reading();
    await page.waitForTimeout(1_500);
    const after = await reading();
    expect(after.domain).toBe(idle.domain);
    expect(after.frames - idle.frames).toBeGreaterThan(10);
    expect(Number(await attr('fps'))).toBeGreaterThan(0);
    expect(await attr('animating')).toBe('true');

    // Prestazioni: replay ×20 degli eventi reali del journal (≥ 20 agenti), fps misurati dal renderer.
    await page.evaluate(() => (window as unknown as { __visioneNeural: { replay(s: number): Promise<void> } }).__visioneNeural.replay(20));
    const samples: Array<{ fps: number | null; quality: number }> = [];
    for (let i = 0; i < 160 && (await attr('replay')) !== 'done'; i++) {
      const s = await page.evaluate(() => (window as unknown as { __visioneNeural: { stats(): { fps: number | null; quality: number } } }).__visioneNeural.stats());
      samples.push({ fps: s.fps, quality: s.quality });
      await page.waitForTimeout(250);
    }
    const stats = await page.evaluate(() => (window as unknown as { __visioneNeural: { stats(): Record<string, unknown> } }).__visioneNeural.stats());
    const measured = samples.map((s) => s.fps).filter((f): f is number => f !== null);
    console.log('Neural 3D — prestazioni', JSON.stringify({ samples: measured.length, min: Math.min(...measured), max: Math.max(...measured), final: stats }));
    expect(await attr('replay')).toBe('done');
    expect(measured.length).toBeGreaterThan(0);
    // DoD: 60 fps oppure qualità adattiva intervenuta.
    expect(Math.min(...measured.slice(-4)) >= 55 || (stats.quality as number) < 2).toBe(true);
    expect(stats.pulsesTotal as number).toBeGreaterThan(20);
    await page.getByTestId('neural-live').click();
    await expect.poll(() => attr('replay')).toBe('live');

    // Contesto WebGL perso e ripristinato: risorse ricostruite, la scena torna a disegnare.
    await page.evaluate(() => {
      const canvas = document.querySelector('.neural-canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
      (window as unknown as { __lose: WEBGL_lose_context }).__lose = gl.getExtension('WEBGL_lose_context') as WEBGL_lose_context;
      (window as unknown as { __lose: WEBGL_lose_context }).__lose.loseContext();
    });
    await expect.poll(() => attr('context'), { timeout: 10_000 }).toBe('lost');
    await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
    await expect.poll(() => attr('context'), { timeout: 10_000 }).toBe('restored');
    const framesBefore = Number(await attr('frames'));
    expect(await page.evaluate(async (d) => (await window.visione.agents.define(d as never)).ok, def('dopo-ripristino'))).toBe(true);
    await expect.poll(async () => Number(await attr('frames')), { timeout: 10_000 }).toBeGreaterThan(framesBefore);
    expect(Number(await attr('nodes'))).toBeGreaterThanOrEqual(23);
  }, 120_000);

  it('Neural 3D (Fase 13): Director→Agent e Agent→Director dagli eventi reali; rete idle a riposo', async () => {
    await page.getByTestId('tab-neural').click();
    const neural = page.getByTestId('neural');
    const attr = (n: string) => neural.getAttribute(`data-${n}`);
    // Un agente dedicato, motore finto: nessun modello reale, nessuna rete.
    const def = {
      id: 'fase13', name: 'Fase 13', role: 'agente di prova', competences: ['general'], engine: { adapter: 'opencode', model: 'nvidia/nvidia/nemotron-3-super-120b-a12b' },
      persona: { instructions: 'x', language: 'it' }, workspace: { root: 'fase13', isolation: 'shared' }, permissions: 'read-only',
      limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
    };
    expect(await page.evaluate(async (d) => (await window.visione.agents.define(d as never)).ok, def)).toBe(true);
    // Obiettivo con piano esplicito: l'assegnazione reale a `fase13` viene dal Director.
    const submit = await page.evaluate(async () => window.visione.director.submit({
      goal: 'Obiettivo fase 13', plan: { steps: [{ key: 's1', title: 'Passo fase 13', spec: 'Rispondi con la parola ok.', agentId: 'fase13' }] }
    } as never));
    expect(submit.ok).toBe(true);
    const hasPulse = (from: string, to: string) => page.evaluate(([f, t]) => {
      const dbg = (window as unknown as { __visioneNeural: { pulses(): Array<{ from: string; to: string }> } }).__visioneNeural;
      return dbg.pulses().some((p) => p.from === f && p.to === t);
    }, [from, to] as const);
    // FLUSSO 1: Director → Agent, da un evento reale di assegnazione.
    await expect.poll(() => hasPulse('director', 'agent:fase13'), { timeout: 30_000 }).toBe(true);
    // FLUSSO 2: il risultato reale dell'agente torna al coordinatore (Agent → Director).
    await expect.poll(() => hasPulse('agent:fase13', 'director'), { timeout: 60_000 }).toBe(true);
    // A vuoto la rete resta idle: nessun impulso attivo, nessuna attività simulata.
    await expect.poll(async () => Number(await attr('pulses-active')), { timeout: 30_000 }).toBe(0);
  }, 120_000);

  it('JARVIS Command Center (Fase 18): Window Manager reale (apri/deduplica/focus/minimizza/trascina/chiudi) e finestre per agente senza cross-talk', async () => {
    const windows = () => page.locator('[data-window]');
    const menu = async (id: string): Promise<void> => {
      await page.getByTestId('windows-menu').click();
      await page.getByTestId(id).click();
    };
    // Stato pulito.
    await menu('win-close-all');
    await expect.poll(() => windows().count(), { timeout: 5_000 }).toBe(0);

    // Apri Director e Telemetria; riaprire Director NON crea una seconda finestra (deduplica).
    await menu('win-open-director');
    await menu('win-open-telemetry');
    await expect.poll(() => windows().count(), { timeout: 5_000 }).toBe(2);
    await menu('win-open-director');
    expect(await windows().count()).toBe(2);
    expect(await page.getByTestId('win-director').textContent()).toContain('Director');

    // Focus: il click sulla testata porta la finestra davanti.
    await page.locator('[data-window="telemetry"] .jwin-head').click();
    await expect.poll(() => page.locator('[data-window="telemetry"].focused').count(), { timeout: 5_000 }).toBe(1);

    // Minimizza → dock → ripristina.
    await page.getByRole('button', { name: 'minimizza Director' }).click();
    await expect.poll(() => page.getByTestId('dock-director').count(), { timeout: 5_000 }).toBe(1);
    await page.getByTestId('dock-director').click();
    await expect.poll(() => page.getByTestId('dock-director').count(), { timeout: 5_000 }).toBe(0);
    await expect.poll(() => page.getByTestId('win-director').count()).toBe(1);

    // Tendina: il corpo sparisce, la finestra resta cliccabile; il pulsante la ridispiega.
    await page.getByRole('button', { name: 'tendina Director' }).click();
    await expect.poll(() => page.locator('[data-window="director"].shaded').count(), { timeout: 5_000 }).toBe(1);
    expect(await page.locator('[data-window="director"] .jwin-body').count()).toBe(0);
    await page.getByRole('button', { name: 'tendina Director' }).click();
    await expect.poll(() => page.locator('[data-window="director"].shaded').count(), { timeout: 5_000 }).toBe(0);
    expect(await page.locator('[data-window="director"] .jwin-body').count()).toBe(1);

    // Trascinamento reale dell'intestazione (pointer sul window): giù e a sinistra, ben dentro i limiti.
    const head = page.locator('[data-window="telemetry"] .jwin-head');
    const start = await head.boundingBox();
    expect(start).not.toBeNull();
    await page.mouse.move((start?.x ?? 0) + 30, (start?.y ?? 0) + 12);
    await page.mouse.down();
    await page.mouse.move((start?.x ?? 0) - 60, (start?.y ?? 0) + 160, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await page.locator('[data-window="telemetry"]').boundingBox())?.y ?? 0, { timeout: 5_000 }).toBeGreaterThan((start?.y ?? 0) + 30);

    // Aggancio ai bordi (P-68): con la sola finestra Telemetria aperta, rilasciata a ~10 px dal
    // bordo sinistro si allinea a x=0 e lo segnala con la classe `snapped`.
    await menu('win-close-all');
    await expect.poll(() => windows().count(), { timeout: 5_000 }).toBe(0);
    await menu('win-open-telemetry');
    await expect.poll(() => page.locator('[data-window="telemetry"]').count(), { timeout: 5_000 }).toBe(1);
    const solo = await page.locator('[data-window="telemetry"] .jwin-head').boundingBox();
    await page.mouse.move((solo?.x ?? 0) + 20, (solo?.y ?? 0) + 10);
    await page.mouse.down();
    await page.mouse.move(30, (solo?.y ?? 0) + 120, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await page.locator('[data-window="telemetry"]').boundingBox())?.x ?? -1, { timeout: 5_000 }).toBe(0);
    expect(await page.locator('[data-window="telemetry"].snapped').count()).toBe(1);

    // Launcher (Fase 24, P-71): elenco REALE delle app installate dal menu Start di Windows.
    await menu('win-open-apps');
    await expect.poll(() => page.getByTestId('win-apps').count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => page.locator('[data-testid^="app-item-"]').count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // Fase 24b: File Manager reale (elenco dalla home vera, dentro le radici consentite) e
    // System Control (metriche reali). Nessuna operazione distruttiva.
    await menu('win-open-files');
    await expect.poll(() => page.getByTestId('win-files').count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => page.locator('[data-testid^="files-root-"]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.locator('[data-testid="files-entry"]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await menu('win-open-system');
    await expect.poll(() => page.getByTestId('win-system').count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(async () => (await page.getByTestId('system-hostname').textContent())?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await page.getByTestId('system-mem').textContent())?.includes('usati di') ?? false, { timeout: 15_000 }).toBe(true);

    // Due agenti distinti → due finestre distinte con identificatori reali e terminali separati.
    await menu('win-close-all');
    await expect.poll(() => windows().count(), { timeout: 5_000 }).toBe(0);
    await page.getByTestId('open-agent-fase13').click();
    await page.getByTestId('open-agent-neurale0').click();
    await expect.poll(() => page.getByTestId('win-agent-fase13').count(), { timeout: 5_000 }).toBe(1);
    await expect.poll(() => page.getByTestId('win-agent-neurale0').count(), { timeout: 5_000 }).toBe(1);
    expect(await page.getByTestId('win-agent-fase13').getAttribute('data-agent')).toBe('fase13');
    expect(await page.getByTestId('win-agent-neurale0').getAttribute('data-agent')).toBe('neurale0');
    await expect.poll(() => page.getByTestId('agent-term-fase13').count()).toBe(1);
    await expect.poll(() => page.getByTestId('agent-term-neurale0').count()).toBe(1);
    // Fase 21: tab del pannello agente e chat diretta (presenza; il percorso di invio è coperto
    // dall'integrazione `agent-tell.test.ts` con Task Engine e Agent Manager reali).
    expect(await page.getByTestId('agent-tab-chat-fase13').count()).toBe(1);
    expect(await page.getByTestId('agent-chat-input-fase13').count()).toBe(1);
    expect(await page.getByTestId('agent-tab-metrics-neurale0').count()).toBe(1);
    await menu('win-close-all');
    await expect.poll(() => windows().count(), { timeout: 5_000 }).toBe(0);

    // Tendina globale (menu Widget): piega tutte le schede, ricliccarla le dispiega.
    await page.getByTestId('widgets-menu').click();
    await page.getByTestId('shade-all').click();
    await expect.poll(() => page.locator('.card.collapsed').count(), { timeout: 5_000 }).toBeGreaterThan(3);
    await page.getByTestId('shade-all').click();
    await expect.poll(() => page.locator('.card.collapsed').count(), { timeout: 5_000 }).toBe(0);
    await page.keyboard.press('Escape');
  }, 120_000);

  it('parlare con un agente dal suo terminale: riga sotto il PTY in sola lettura (Claude) e riga del flusso (motore senza terminale), stessa via della chat', async () => {
    const lastSeq = async (): Promise<number> => page.evaluate(async () => { const r = await window.visione.events.list({ limit: 1 }); return r.ok ? (r.data.events.at(-1)?.seq ?? 0) : 0; });
    // Esito del compito creato per QUELL'agente dopo `after`.
    const outcome = (agentId: string, after: number) => async (): Promise<string | null> => page.evaluate(async ({ agentId, after }) => {
      const r = await window.visione.events.list({ afterSeq: after, limit: 500, types: ['task.created', 'task.result.recorded'] });
      if (!r.ok) return null;
      const created = r.data.events.find((e) => e.type === 'task.created' && (e.payload as { assigneeAgentId?: string }).assigneeAgentId === agentId);
      if (!created) return null;
      const id = (created.payload as { taskId: string }).taskId;
      const done = r.data.events.find((e) => e.type === 'task.result.recorded' && (e.payload as { taskId: string }).taskId === id);
      return done ? (done.payload as { outcome: string }).outcome : null;
    }, { agentId, after });

    // Claude (PTY in sola lettura): la riga «scrivi all'agente» sotto il terminale reale.
    let after = await lastSeq();
    // Nella finestra piccola della prova l'elenco Agenti scorre sotto altre schede: si preme il pulsante vero.
    await page.getByTestId('open-agent-terminal-revisore').dispatchEvent('click');
    await expect.poll(() => page.getByTestId('tab-terminal').getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true');
    await expect.poll(() => page.getByTestId('terminal-tell-input-revisore').count(), { timeout: 60_000 }).toBe(1);
    await page.getByTestId('terminal-tell-input-revisore').fill('saluto dal terminale e2e');
    await page.getByTestId('terminal-tell-send-revisore').click();
    await expect.poll(() => page.getByTestId('terminal-tell-note-revisore').textContent(), { timeout: 10_000 }).toContain('inviato');
    await expect.poll(outcome('revisore', after), { timeout: 60_000 }).toBe('success');

    // Motore senza terminale: il flusso ha la sua riga d'invio, nessun doppione.
    after = await lastSeq();
    // Nella finestra piccola della prova l'elenco Agenti scorre sotto altre schede: si preme il pulsante vero.
    await page.getByTestId('open-agent-terminal-fase13').dispatchEvent('click');
    await expect.poll(() => page.getByTestId('terminal-stream-input-fase13').count(), { timeout: 30_000 }).toBe(1);
    expect(await page.getByTestId('terminal-tell-input-fase13').count()).toBe(0);
    await page.getByTestId('terminal-stream-input-fase13').locator('input').fill('saluto dal flusso e2e');
    await page.getByTestId('terminal-stream-input-fase13').locator('input').press('Enter');
    await expect.poll(outcome('fase13', after), { timeout: 60_000 }).toBe('success');
  }, 150_000);

  it('widget (11/10/2026): si accendono dal menu uno dopo l\'altro, si posano senza coprirsi e seguono le regole delle schede', async () => {
    await page.getByTestId('widgets-menu').click();
    // Ogni clic deve arrivare alla voce del menu: il widget appena acceso non la copre.
    for (const id of ['clock', 'weather', 'graphs']) await page.getByTestId(`widget-toggle-${id}`).click();
    await page.keyboard.press('Escape');
    for (const id of ['clock', 'weather', 'graphs']) await expect.poll(() => page.locator(`.dock-float[data-panel="${id}"]`).count(), { timeout: 5_000 }).toBe(1);
    const rects = await page.evaluate(() => [...document.querySelectorAll('.dock-float[data-panel]')].filter((e) => ['clock', 'weather', 'graphs'].includes((e as HTMLElement).dataset.panel ?? '')).map((e) => e.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!; const c = rects[j]!;
      expect(a.x < c.x + c.width && c.x < a.x + a.width && a.y < c.y + c.height && c.y < a.y + a.height).toBe(false);
    }
    // Orologio vero, meteo che chiede la città (nessuna rete senza una città), grafici dai campioni reali.
    await expect.poll(async () => (await page.getByTestId('widget-clock-time').textContent())?.length ?? 0).toBeGreaterThan(3);
    expect(await page.getByTestId('widget-weather-city').count()).toBe(1);
    // Regole delle schede: tendina, chiudi (si riaccende dal menu nello stesso posto).
    await page.getByTestId('panel-collapse-clock').click();
    await expect.poll(() => page.locator('.dock-float[data-panel="clock"]').getAttribute('data-panel-collapsed')).toBe('true');
    await page.getByTestId('panel-collapse-clock').click();
    const before = await page.locator('.dock-float[data-panel="graphs"]').boundingBox();
    await page.getByTestId('panel-close-graphs').click();
    await expect.poll(() => page.locator('.dock-float[data-panel="graphs"]').count()).toBe(0);
    await page.getByTestId('widgets-menu').click();
    await page.getByTestId('widget-toggle-graphs').click();
    await page.keyboard.press('Escape');
    const after = await page.locator('.dock-float[data-panel="graphs"]').boundingBox();
    expect(after?.x).toBe(before?.x);
    expect(after?.y).toBe(before?.y);
    // Spenti di nuovo: nessun widget libero resta sullo schermo.
    await page.getByTestId('widgets-menu').click();
    for (const id of ['clock', 'weather', 'graphs']) await page.getByTestId(`widget-toggle-${id}`).click();
    await page.keyboard.press('Escape');
    for (const id of ['clock', 'weather', 'graphs']) await expect.poll(() => page.locator(`.dock-float[data-panel="${id}"]`).count()).toBe(0);
  }, 60_000);

  it('renderer restart: la finestra si ricarica e ricostruisce lo stato dal core (nessuna perdita)', async () => {
    await expect.poll(() => text(page, 'connection'), { timeout: 10_000 }).toBe('collegato');
    await expect.poll(() => text(page, 'core-state'), { timeout: 20_000 }).toBe('ready');
    const before = await supervisor(page);
    const snapBefore = await coreState(page);
    const eventsBefore = await journal(page);
    // Riavvio del RENDERER (reload della finestra): il core NON viene toccato.
    await page.reload();
    await expect.poll(() => page.title(), { timeout: 20_000 }).toBe('VISIONE');
    await expect.poll(() => text(page, 'core-state'), { timeout: 20_000 }).toBe('ready');
    await expect.poll(() => text(page, 'connection'), { timeout: 15_000 }).toBe('collegato');
    const after = await supervisor(page);
    expect(after.pid).toBe(before.pid); // stesso processo core, nessun riavvio del backend
    const snapAfter = await coreState(page);
    expect(snapAfter.bootId).toBe(snapBefore.bootId); // stesso avvio del core
    expect(snapAfter.agents.live).toBe(snapBefore.agents.live);
    // Lo stato persistente è ricostruito dal journal (non dallo stato volatile della UI).
    const eventsAfter = await journal(page);
    expect(eventsAfter.length).toBeGreaterThanOrEqual(eventsBefore.length);
    expect(eventsAfter[0]?.id).toBe(eventsBefore[0]?.id);
  }, 120_000);

  it('kill del core: la UI resta aperta, il supervisore riavvia, la UI si ricollega', async () => {
    await page.evaluate(() => { (globalThis as Record<string, unknown>).__e2eMarker = 'stessa pagina'; });
    const received: string[] = [];
    await page.exposeFunction('__e2eEvent', (type: string) => received.push(type));
    await page.evaluate(() => {
      window.visione.events.subscribe((e) => void (globalThis as unknown as { __e2eEvent(t: string): void }).__e2eEvent(e.type));
    });

    const before: SupervisorSnapshot = await supervisor(page);
    expect(before.pid).not.toBeNull();
    process.kill(before.pid as number, 'SIGKILL');

    await expect.poll(async () => {
      const s = await supervisor(page);
      return s.state === 'ready' && s.pid !== before.pid ? 'riavviato' : s.state;
    }, { timeout: 20_000 }).toBe('riavviato');
    expect(alive(before.pid as number)).toBe(false);
    expect(app.windows()).toHaveLength(1);
    expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__e2eMarker)).toBe('stessa pagina');

    await expect.poll(() => text(page, 'connection'), { timeout: 10_000 }).toBe('collegato');
    expect(await text(page, 'core-restarts')).toBe('1');
    // Il nuovo core ha ricostruito lo stato dal journal: uscita non pulita riconosciuta.
    await expect.poll(() => text(page, 'core-previous'), { timeout: 10_000 }).toBe('ready · recuperato');
    expect(await coreState(page)).toMatchObject({ core: { status: 'ready', recovered: true }, application: { status: 'running' } });
    expect(await page.evaluate(() => window.visione.system.ping('dopo'))).toMatchObject({ ok: true, data: { echo: 'dopo' } });
    // La memoria sopravvive alla caduta del core.
    const remembered = await page.evaluate(() => window.visione.memory.search({ query: 'Orione' }));
    expect(remembered.ok && remembered.data.items.map((i) => i.content)).toContain('Il cliente del progetto si chiama Orione');

    await expect.poll(async () => (await journal(page)).some((e) => e.type === 'core.restarted'), { timeout: 10_000 }).toBe(true);
    const all: VisioneEvent[] = await journal(page);
    const crash = all.find((e) => e.type === 'core.crashed');
    expect(crash?.payload).toMatchObject({ pid: before.pid, reason: 'exit', willRestart: true });
    crashEventId = crash?.id ?? '';
    expect(received).toEqual(expect.arrayContaining(['core.crashed', 'core.restarted']));
  });

  it('procedura guidata (18/10/2026): un riavvio del core non la riporta al primo passo', async () => {
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-open-setup').click();
    await expect.poll(() => page.getByTestId('setup-step-benvenuto').count(), { timeout: 10_000 }).toBe(1);
    await page.locator('.setup-actions .setup-primary').click();
    await expect.poll(() => page.getByTestId('setup-step-motori').count()).toBe(1);

    const before: SupervisorSnapshot = await supervisor(page);
    process.kill(before.pid as number, 'SIGKILL');
    await expect.poll(async () => {
      const s = await supervisor(page);
      return s.state === 'ready' && s.pid !== before.pid ? 'riavviato' : s.state;
    }, { timeout: 20_000 }).toBe('riavviato');

    // La stessa procedura torna visibile sul passo dei motori: non è ripartita dal benvenuto.
    await expect.poll(() => page.getByTestId('setup-wizard').isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await page.getByTestId('setup-step-motori').count()).toBe(1);
    expect(await page.getByTestId('setup-step-benvenuto').count()).toBe(0);
    await page.locator('.setup-close').click();
    await expect.poll(() => page.getByTestId('setup-wizard').count()).toBe(0);
  }, 60_000);

  it('chiusura ordinata e riavvio: gli eventi precedenti sopravvivono', async () => {
    const corePid = (await supervisor(page)).pid as number;
    const mainPid = await app.evaluate(() => process.pid);
    await app.close();
    await expect.poll(() => alive(corePid) || alive(mainPid), { timeout: 15_000 }).toBe(false);

    ({ app, page } = await launch());
    await expect.poll(() => text(page, 'core-state'), { timeout: 20_000 }).toBe('ready');
    // Chiusura ordinata: il riavvio non è un recupero.
    await expect.poll(() => text(page, 'core-previous'), { timeout: 10_000 }).toBe('stopped');
    await expect.poll(async () => (await journal(page)).some((e) => e.type === 'core.stopped'), { timeout: 10_000 }).toBe(true);
    const all = await journal(page);
    const types = all.map((e) => e.type);
    expect(all.some((e) => e.id === crashEventId)).toBe(true);
    expect(types).toEqual(expect.arrayContaining(['app.started', 'app.shutdown', 'system.stopped', 'core.stopped', 'core.crashed', 'core.restarted']));
    expect(all.filter((e) => e.type === 'app.started')).toHaveLength(2);
  });

  it('schermo pulito (11/10/2026): di partenza solo Umanoide e scena; le linguette aprono il resto; solo umanoide e accendi tutto', async () => {
    await page.evaluate(() => {
      localStorage.removeItem('visione.panelli.v1');
      localStorage.removeItem('visione.schermo.v1');
    });
    await page.reload();
    // Lo stato del core si legge dal supervisore: la Diagnostica, che lo mostra, qui è spenta.
    await expect.poll(async () => (await supervisor(page)).state, { timeout: 20_000 }).toBe('ready');
    // Visibili solo l'Umanoide (in cima a sinistra) e la scena; colonna di destra e barra in basso spente.
    await expect.poll(() => page.locator('.dock-item[data-panel]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.panel))).toEqual(['humanoid']);
    expect(await page.locator('.app.hide-right.hide-bottom').count()).toBe(1);
    expect(await page.getByTestId('agent-strip').count()).toBe(0);
    expect(await page.getByTestId('neural').count()).toBe(1);
    // Replay e legenda restano sulla scena; la riga tecnica no.
    // Il replay è da esperto (11/10/2026): la modalità arriva dalla configurazione, un attimo dopo il ricaricamento.
    await expect.poll(() => page.getByTestId('neural-replay').isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await page.getByTestId('neural-legend').isVisible()).toBe(true);
    expect(await page.getByTestId('neural-stats').isVisible()).toBe(false);
    // Linguetta «Sistema»: la cartella mostra il pannello Sistema anche se è spento sullo schermo.
    await page.getByTestId('side-tab-system').click();
    await expect.poll(() => page.getByTestId('side-drawer-system').locator('[data-panel="system"]').count()).toBe(1);
    // ⇱ porta il pannello sullo schermo, libero e mobile come l'Umanoide; la cartella si chiude.
    await page.getByTestId('side-detach-system').click();
    await expect.poll(() => page.getByTestId('side-drawer-system').count()).toBe(0);
    expect(await page.locator('.dock-item[data-panel="system"]').getAttribute('data-panel-float')).toBe('true');
    await page.getByTestId('panel-close-system').click();
    await expect.poll(() => page.locator('.dock-item[data-panel="system"]').count()).toBe(0);
    await page.getByTestId('side-tab-system').click();
    await expect.poll(() => page.getByTestId('side-drawer-system').count()).toBe(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('side-drawer-system').count()).toBe(0);
    // Registro: il log leggibile.
    await page.getByTestId('side-tab-log').click();
    await expect.poll(() => page.getByTestId('side-log').count()).toBe(1);
    await page.getByTestId('side-tab-log').click();
    // Accendi tutto e torna a «solo l'umanoide».
    await page.getByTestId('widgets-menu').click();
    await page.getByTestId('widgets-all-on').click();
    await expect.poll(() => page.locator('.dock-item[data-panel]').count()).toBeGreaterThan(8);
    await page.getByTestId('widgets-only-essentials').click();
    await expect.poll(() => page.locator('.dock-item[data-panel]').count()).toBe(1);
    await page.keyboard.press('Escape');
  }, 60_000);
});
