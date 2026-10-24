// Pannelli del dock (P-96): logica pura di chiusura/riapertura, tendina, riordino (anche tra le
// colonne), posizione di rilascio e persistenza in localStorage. Nessun React, nessun DOM.
import { describe, expect, it } from 'vitest';
import {
  DOCK_STORAGE_KEY, FLOAT_MIN_HEIGHT, FLOAT_MIN_WIDTH, LEGACY_MIN_KEY, clampFloat, clearFloat, clearFloats, dropBefore, floatingCount,
  floatingOf, floatingSizeOf, isCollapsed, isHidden, loadDock, movePanel, normalizeDock, panelMeta, resizeRect, saveDock, setFloat, setSize,
  hiddenCount, resetDock, showAll, toggleCollapsed, toggleHidden, toggleWidget, visibleIds, widgetsOn, WIDGET_IDS, floatBox,
  CLEAN_LAYOUT, columnInUse, everythingOn, onlyEssentials, PANEL_GROUPS, PANEL_IDS, showPanel, togglePanel,
  type DockState, type StorageLike
} from '../../src/renderer/app/panels.ts';
import { defaultDock } from '../../src/renderer/app/panels.ts';

/** Il layout di prima dello schermo pulito (pannelli accesi, widget spenti tranne l'Umanoide): base dei test dei meccanismi. */
const classic = (): DockState => ({ ...defaultDock(), hidden: ['clock', 'weather', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat'] });

function fakeStorage(init: Record<string, string> = {}): StorageLike & { map: Record<string, string> } {
  const map = { ...init };
  return { map, getItem: (k) => map[k] ?? null, setItem: (k, v) => { map[k] = v; } };
}

describe('pannelli del dock (P-96)', () => {
  it('schermo pulito di partenza (11/10/2026): acceso solo l\'Umanoide in cima a sinistra, tutto il resto spento ma al suo posto', () => {
    const d = defaultDock();
    expect(d.left).toEqual(['humanoid', 'voice', 'director', 'approvals', 'clock']);
    expect(d.right).toEqual(['system', 'agents', 'tasks', 'engines', 'diag', 'weather', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat']);
    expect(visibleIds(d, 'left')).toEqual(['humanoid']);
    expect(visibleIds(d, 'right')).toEqual([]);
    expect(d.hidden).toEqual(PANEL_IDS.filter((id) => id !== 'humanoid'));
    expect(d.layout).toBe(CLEAN_LAYOUT);
    expect(columnInUse(d, 'left')).toBe(true);
    expect(columnInUse(d, 'right')).toBe(false);
    expect(d.collapsed).toEqual([]);
    expect(d.floats).toEqual({});
    expect(d.sizes).toEqual({});
    expect(panelMeta('tasks').title).toBe('Task · Eventi');
  });

  it('chiude un pannello e lo riapre con la posizione scelta (anche dopo uno spostamento)', () => {
    let d: DockState = classic();
    d = movePanel(d, 'voice', 'right', 'agents');
    expect(d.left).toEqual(['humanoid', 'director', 'approvals', 'clock']);
    expect(d.right).toEqual(['system', 'voice', 'agents', 'tasks', 'engines', 'diag', 'weather', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat']);
    d = toggleHidden(d, 'voice');
    expect(isHidden(d, 'voice')).toBe(true);
    expect(visibleIds(d, 'right')).not.toContain('voice');
    expect(visibleIds(d, 'left')).toEqual(['humanoid', 'director', 'approvals']);
    d = toggleHidden(d, 'voice');
    expect(isHidden(d, 'voice')).toBe(false);
    expect(visibleIds(d, 'right')).toEqual(['system', 'voice', 'agents', 'tasks', 'engines', 'diag']);
    // «mostra tutti» non cambia nulla quando non c'è nessun chiuso.
    expect(showAll(d)).toBe(d);
  });

  it('sposta dentro la stessa colonna e tra colonne; non cambia stato se la posizione è identica', () => {
    let d: DockState = classic();
    const same = movePanel(d, 'director', 'left', 'approvals');
    expect(same).toBe(d); // già subito prima di approvals
    d = movePanel(d, 'approvals', 'left', 'voice');
    expect(d.left).toEqual(['humanoid', 'approvals', 'voice', 'director', 'clock']);
    // In fondo alla colonna o davanti a un id che non esiste lì: accodato.
    d = movePanel(d, 'diag', 'left', null);
    expect(d.left).toEqual(['humanoid', 'approvals', 'voice', 'director', 'clock', 'diag']);
    expect(d.right).not.toContain('diag');
    d = movePanel(d, 'diag', 'right', 'inesistente' as never);
    expect(d.right).toEqual(['system', 'agents', 'tasks', 'engines', 'weather', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat', 'diag']);
    // Id sconosciuto: nessun cambiamento.
    expect(movePanel(d, 'boh' as never, 'left', null)).toBe(d);
  });

  it('tendina ed espansione dal pannello; doppio toggle torna allo stato di partenza', () => {
    let d: DockState = classic();
    d = toggleCollapsed(d, 'system');
    expect(isCollapsed(d, 'system')).toBe(true);
    expect(isCollapsed(d, 'agents')).toBe(false);
    d = toggleCollapsed(d, 'system');
    expect(isCollapsed(d, 'system')).toBe(false);
  });

  it('normalizza dati corrotti: id sconosciuti scartati, duplicati e mancanti riparati', () => {
    const d = normalizeDock({
      left: ['voice', 'voce-finta', 'voice', 'approvals'],
      right: ['diag'],
      hidden: ['agents', 'agents', 'finto'],
      collapsed: ['system', 7],
      layout: CLEAN_LAYOUT
    });
    expect(d.left).toEqual(['humanoid', 'voice', 'approvals', 'director', 'clock']);
    expect(d.right).toEqual(['diag', 'system', 'agents', 'tasks', 'engines', 'weather', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat']);
    // I widget che l'archivio non conosceva partono spenti, l'Umanoide acceso in cima a sinistra.
    expect(d.hidden).toEqual(['agents', 'clock', 'weather', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat']);
    expect(d.collapsed).toEqual(['system']);
    expect(normalizeDock('guasto')).toEqual(defaultDock());
    expect(normalizeDock(null)).toEqual(defaultDock());
  });

  it('salva e rilegge lo stato: il layout sopravvive al riavvio del renderer', () => {
    const storage = fakeStorage();
    let d = classic();
    d = toggleHidden(d, 'approvals');
    d = toggleCollapsed(d, 'engines');
    d = movePanel(d, 'system', 'left', 'voice');
    saveDock(d, storage);
    expect(loadDock(storage)).toEqual(d);
    // Dati illeggibili: layout di partenza, nessun crash.
    expect(loadDock(fakeStorage({ [DOCK_STORAGE_KEY]: '{rotto' }))).toEqual(defaultDock());
  });

  it('migra la vecchia tendina dei pannelli HUD solo se il nuovo stato non esiste', () => {
    const legacy = fakeStorage({ [LEGACY_MIN_KEY]: JSON.stringify({ Voce: true, 'Task · Eventi': true, Altro: true }) });
    const migrated = loadDock(legacy);
    expect(migrated.collapsed).toEqual(['voice', 'tasks']);
    // Con il nuovo stato presente, la vecchia chiave è ignorata.
    const both = fakeStorage({ [DOCK_STORAGE_KEY]: JSON.stringify(classic()), [LEGACY_MIN_KEY]: JSON.stringify({ Voce: true }) });
    expect(loadDock(both).collapsed).toEqual([]);
  });

  it('posizione di rilascio: prima della prima metà superata, in fondo oltre l\'ultima', () => {
    const rects = [
      { id: 'voice' as const, mid: 100 },
      { id: 'system' as const, mid: 200 },
      { id: 'agents' as const, mid: 300 }
    ];
    expect(dropBefore(rects, 50)).toBe('voice');
    expect(dropBefore(rects, 150)).toBe('system');
    expect(dropBefore(rects, 250)).toBe('agents');
    expect(dropBefore(rects, 500)).toBeNull();
    expect(dropBefore([], 100)).toBeNull();
  });

  it('P-98: posizione libera: setFloat/clearFloat, persistenza, normalizzazione di dati corrotti', () => {
    let d: DockState = classic();
    expect(floatingOf(d, 'voice')).toBeNull();
    expect(floatingCount(d)).toBe(0);
    d = setFloat(d, 'voice', { x: 412, y: 233 });
    expect(floatingOf(d, 'voice')).toEqual({ x: 412, y: 233 });
    expect(floatingCount(d)).toBe(1);
    // Posizione identica → stato identico (nessun re-render); coordinate non finite o id ignoti ignorati.
    expect(setFloat(d, 'voice', { x: 412, y: 233 })).toBe(d);
    expect(setFloat(d, 'voice', { x: NaN, y: 10 })).toBe(d);
    expect(setFloat(d, 'voice', { x: 10, y: Infinity })).toBe(d);
    expect(setFloat(d, 'boh' as never, { x: 1, y: 2 })).toBe(d);
    // La posizione sopravvive al riavvio del renderer.
    const storage = fakeStorage();
    saveDock(d, storage);
    expect(loadDock(storage)).toEqual(d);
    // Doppio click / «Reimposta layout»: torna al dock, la posizione libera si dimentica.
    const back = clearFloat(d, 'voice');
    expect(floatingOf(back, 'voice')).toBeNull();
    expect(clearFloats(d).floats).toEqual({});
    expect(clearFloats(back)).toBe(back); // già ancorato: nessun cambiamento
    // Normalizzazione: floats validi tenuti, corrotti (NaN, stringhe, id ignoti) scartati.
    const n = normalizeDock({
      ...classic(),
      floats: { voice: { x: 10, y: 20 }, agents: { x: NaN, y: 3 }, tasks: 'qui', finto: { x: 1, y: 1 } }
    });
    expect(n.floats).toEqual({ voice: { x: 10, y: 20 } });
  });

  it('P-98: clampFloat chiude la posizione nella finestra e tiene la testata raggiungibile', () => {
    // Fuori a sinistra/sopra: riportata dentro (sotto la topbar).
    expect(clampFloat({ x: -50, y: -80 }, 300, 200, 1536, 864)).toEqual({ x: 0, y: 46 });
    // Fuori a destra/sotto: resta interamente visibile.
    expect(clampFloat({ x: 3000, y: 2000 }, 300, 200, 1536, 864)).toEqual({ x: 1236, y: 744 });
    // Valori non finiti: posizione sicura, mai NaN.
    const safe = clampFloat({ x: NaN, y: NaN }, 300, 200, 1536, 864);
    expect(Number.isFinite(safe.x)).toBe(true);
    expect(Number.isFinite(safe.y)).toBe(true);
    expect(safe.x).toBe(0);
    // Pannello più largo della finestra: x resta 0.
    expect(clampFloat({ x: 500, y: 100 }, 2000, 200, 1536, 864).x).toBe(0);
  });

  it('P-99: dimensioni di un pannello libero — setSize con minimi, no-op, persistenza e pulizia', () => {
    let d: DockState = classic();
    d = setFloat(d, 'engines', { x: 300, y: 200 });
    expect(floatingSizeOf(d, 'engines')).toBeNull();
    d = setSize(d, 'engines', { w: 420, h: 380 });
    expect(floatingSizeOf(d, 'engines')).toEqual({ w: 420, h: 380 });
    // Stesse dimensioni → stato identico (nessun re-render); non finite o id ignoti ignorati.
    expect(setSize(d, 'engines', { w: 420, h: 380 })).toBe(d);
    expect(setSize(d, 'engines', { w: NaN, h: 380 })).toBe(d);
    expect(setSize(d, 'boh' as never, { w: 100, h: 100 })).toBe(d);
    // Minimi garantiti e valori frazionari arrotondati.
    expect(floatingSizeOf(setSize(d, 'engines', { w: 10, h: 10 }), 'engines')).toEqual({ w: FLOAT_MIN_WIDTH, h: FLOAT_MIN_HEIGHT });
    expect(floatingSizeOf(setSize(d, 'engines', { w: 333.6, h: 222.4 }), 'engines')).toEqual({ w: 334, h: 222 });
    // La dimensione sopravvive al riavvio del renderer insieme alla posizione.
    const storage = fakeStorage();
    saveDock(d, storage);
    expect(loadDock(storage)).toEqual(d);
    // Normalizzazione: dimensioni corrotte scartate, minime applicate a quelle valide.
    const n = normalizeDock({
      ...classic(),
      sizes: { engines: { w: 400, h: 300 }, voice: { w: NaN, h: 200 }, tasks: { w: 1, h: 2 }, finto: { w: 10, h: 10 } }
    });
    expect(n.sizes).toEqual({ engines: { w: 400, h: 300 }, tasks: { w: FLOAT_MIN_WIDTH, h: FLOAT_MIN_HEIGHT } });
    // Riportare il pannello al dock dimentica dimensioni e posizione; «Reimposta layout» pulisce tutto.
    const back = clearFloat(d, 'engines');
    expect(floatingSizeOf(back, 'engines')).toBeNull();
    expect(floatingOf(back, 'engines')).toBeNull();
    expect(clearFloats(d).sizes).toEqual({});
    expect(clearFloats(setSize(classic(), 'voice', { w: 300, h: 200 })).sizes).toEqual({});
  });

  it('P-99: resizeRect — allarga/stringi dai lati e dagli angoli, minimi e bordi della finestra', () => {
    const start = { x: 300, y: 200, w: 400, h: 300 };
    // Bordo destro: cresce a destra, sinistra ferma.
    expect(resizeRect(start, 'e', 80, 0, 1536, 864)).toEqual({ x: 300, y: 200, w: 480, h: 300 });
    // Bordo sinistro: si allarga a sinistra (x cala, w cresce) e si stringe (x sale, w cala).
    expect(resizeRect(start, 'w', -60, 0, 1536, 864)).toEqual({ x: 240, y: 200, w: 460, h: 300 });
    expect(resizeRect(start, 'w', 60, 0, 1536, 864)).toEqual({ x: 360, y: 200, w: 340, h: 300 });
    // Bordo inferiore e superiore.
    expect(resizeRect(start, 's', 0, 120, 1536, 864)).toEqual({ x: 300, y: 200, w: 400, h: 420 });
    expect(resizeRect(start, 'n', 0, -40, 1536, 864)).toEqual({ x: 300, y: 160, w: 400, h: 340 });
    // Angolo sud-est: entrambi gli assi.
    expect(resizeRect(start, 'se', 10, 20, 1536, 864)).toEqual({ x: 300, y: 200, w: 410, h: 320 });
    // Minimi: il bordo opposto resta fermo (mai spostamenti da soli).
    expect(resizeRect(start, 'se', -10_000, -10_000, 1536, 864)).toEqual({ x: 300, y: 200, w: FLOAT_MIN_WIDTH, h: FLOAT_MIN_HEIGHT });
    expect(resizeRect(start, 'w', 10_000, 0, 1536, 864)).toEqual({ x: 300 + (400 - FLOAT_MIN_WIDTH), y: 200, w: FLOAT_MIN_WIDTH, h: 300 });
    // Non esce dalla finestra: il lato est si ferma al bordo e, se serve, scatta il minimo
    // spostando il pannello verso l'interno (mai un pannello più piccolo dei minimi).
    expect(resizeRect({ x: 1400, y: 700, w: 120, h: 140 }, 'se', 500, 500, 1536, 864)).toEqual({ x: 1316, y: 700, w: 220, h: 164 });
    // Input non finiti: mai NaN.
    const safe = resizeRect({ x: NaN, y: 10, w: NaN, h: 200 }, 'se', NaN, NaN, 1536, 864);
    expect(Number.isFinite(safe.x) && Number.isFinite(safe.y) && Number.isFinite(safe.w) && Number.isFinite(safe.h)).toBe(true);
  });
});

describe('widget del cruscotto (11/10/2026): orologio, meteo, grafici', () => {
  it('si accendono a scelta: la prima volta si posano liberi al centro senza coprirsi; spenti non contano fra i pannelli chiusi', () => {
    let d = classic();
    const box = (id: 'clock' | 'weather' | 'graphs') => floatBox(d, id, 1920, 1080);
    expect(WIDGET_IDS).toEqual(['clock', 'weather', 'graphs', 'humanoid', 'calendar', 'notes', 'agenda', 'replies', 'chat']);
    expect(widgetsOn(d)).toEqual(['humanoid']);
    d = toggleWidget(d, 'clock', 1920, 1080);
    d = toggleWidget(d, 'graphs', 1920, 1080);
    expect(widgetsOn(d)).toEqual(['clock', 'graphs', 'humanoid']);
    const a = floatingOf(d, 'clock');
    const b = floatingOf(d, 'graphs');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Nella zona centrale, fra le due colonne del dock.
    expect(a!.x).toBeGreaterThanOrEqual(480);
    expect(a!.x + box('clock').w).toBeLessThanOrEqual(1440);
    // Posati senza coprirsi: i due rettangoli (ingombro di partenza) non si toccano.
    const overlap = (p: { x: number; y: number }, ps: { w: number; h: number }, q: { x: number; y: number }, qs: { w: number; h: number }): boolean =>
      p.x < q.x + qs.w && q.x < p.x + ps.w && p.y < q.y + qs.h && q.y < p.y + ps.h;
    expect(overlap(a!, box('clock'), b!, box('graphs'))).toBe(false);
    d = toggleWidget(d, 'weather', 1920, 1080);
    const c = floatingOf(d, 'weather')!;
    expect(overlap(c, box('weather'), a!, box('clock')) || overlap(c, box('weather'), b!, box('graphs'))).toBe(false);
    // Tutti dentro la finestra.
    for (const [p, sz] of [[a!, box('clock')], [b!, box('graphs')], [c, box('weather')]] as const) {
      expect(p.x + sz.w).toBeLessThanOrEqual(1920);
      expect(p.y + sz.h).toBeLessThanOrEqual(1080);
    }
    d = toggleWidget(d, 'weather', 1920, 1080);
    expect(hiddenCount(d)).toBe(0);
    // Spento e riacceso: torna dove il proprietario l'aveva lasciato.
    d = setFloat(d, 'clock', { x: 40, y: 300 });
    d = toggleWidget(toggleWidget(d, 'clock', 1920, 1080), 'clock', 1920, 1080);
    expect(floatingOf(d, 'clock')).toEqual({ x: 40, y: 300 });
    // Un pannello non è un widget: toggleWidget non lo tocca.
    expect(toggleWidget(d, 'voice', 1920, 1080)).toBe(d);
  });

  it('«mostra tutti i pannelli» non accende i widget; «reimposta posizioni» lascia tutto acceso o spento com\'era', () => {
    let d = toggleHidden(classic(), 'agents');
    d = toggleWidget(d, 'weather', 1280, 800);
    const shown = showAll(d);
    expect(shown.hidden).toEqual(['clock', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat']);
    const reset = resetDock(d);
    expect(reset.hidden).toEqual(['clock', 'graphs', 'calendar', 'notes', 'agenda', 'replies', 'chat', 'agents']);
    expect(reset.floats).toEqual({});
    expect(visibleIds(reset, 'right')).toContain('weather');
  });

  it('stato salvato prima dello schermo pulito: si pulisce una volta (resta l\'Umanoide), posizioni e tendine restano', () => {
    const old = { left: ['voice', 'director', 'approvals'], right: ['system', 'agents', 'tasks', 'engines', 'diag'], hidden: ['diag'], collapsed: ['engines'], floats: { voice: { x: 10, y: 90 } }, sizes: {} };
    const d = loadDock(fakeStorage({ [DOCK_STORAGE_KEY]: JSON.stringify(old) }));
    expect(d.hidden).toEqual(PANEL_IDS.filter((id) => id !== 'humanoid'));
    expect(d.layout).toBe(CLEAN_LAYOUT);
    expect(d.collapsed).toEqual(['engines']);
    expect(floatingOf(d, 'voice')).toEqual({ x: 10, y: 90 });
    expect(d.left[0]).toBe('humanoid');
    // Una volta sola: quello che il proprietario accende dopo resta acceso ai riavvii.
    const after = normalizeDock(JSON.parse(JSON.stringify(togglePanel(d, 'system', 1536, 864))));
    expect(isHidden(after, 'system')).toBe(false);
    expect(hiddenCount(after)).toBe(7);
  });

  it('finestra piccola (1087×683): i tre widget più piccoli accesi trovano posto senza coprirsi', () => {
    let d = defaultDock();
    for (const id of ['clock', 'weather', 'graphs'] as const) d = toggleWidget(d, id, 1087, 683);
    const rects = (['clock', 'weather', 'graphs'] as const).map((id) => ({ ...floatingOf(d, id)!, ...floatBox(d, id, 1087, 683) }));
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i]!;
      expect(a.x >= 0 && a.y >= 0 && a.x + a.w <= 1087 && a.y + a.h <= 683).toBe(true);
      for (let j = i + 1; j < rects.length; j++) {
        const b = rects[j]!;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
  });

  it('schermo intero del proprietario (1536×864, 1920×1080 al 125%): l\'Umanoide resta fisso a sinistra, gli altri widget liberi senza coprirsi', () => {
    let d = defaultDock();
    for (const id of ['clock', 'weather', 'graphs'] as const) d = toggleWidget(d, id, 1536, 864);
    expect(floatingOf(d, 'humanoid')).toBeNull();
    expect(d.left[0]).toBe('humanoid');
    // Spento e riacceso dal menu: torna al suo posto, non libero.
    d = toggleWidget(toggleWidget(d, 'humanoid', 1536, 864), 'humanoid', 1536, 864);
    expect(floatingOf(d, 'humanoid')).toBeNull();
    expect(isHidden(d, 'humanoid')).toBe(false);
    const rects = (['clock', 'weather', 'graphs'] as const).map((id) => ({ ...floatingOf(d, id)!, ...floatBox(d, id, 1536, 864) }));
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i]!;
      expect(a.x >= 0 && a.y >= 0 && a.x + a.w <= 1536 && a.y + a.h <= 864).toBe(true);
      for (let j = i + 1; j < rects.length; j++) {
        const b = rects[j]!;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
  });
});

describe('schermo pulito (11/10/2026): caselle, gruppi, colonne', () => {
  it('ogni pannello sta in un gruppo del menu (l\'Umanoide a parte), nessuno due volte', () => {
    const grouped = PANEL_GROUPS.flatMap((g) => g.panels);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped, 'humanoid', 'chat'].sort()).toEqual([...PANEL_IDS].sort());
  });

  it('casella del menu: i pannelli al loro posto nel dock, i widget con le loro regole', () => {
    let d = defaultDock();
    d = togglePanel(d, 'system', 1536, 864);
    expect(isHidden(d, 'system')).toBe(false);
    expect(floatingOf(d, 'system')).toBeNull();
    expect(columnInUse(d, 'right')).toBe(true);
    d = togglePanel(d, 'clock', 1536, 864);
    expect(floatingOf(d, 'clock')).not.toBeNull();
    // Un widget libero non tiene in vita la colonna.
    d = togglePanel(d, 'system', 1536, 864);
    expect(columnInUse(d, 'right')).toBe(false);
  });

  it('un widget acceso non si posa sopra la colonna in uso (l\'Umanoide a sinistra)', () => {
    let d = defaultDock();
    for (const id of ['clock', 'calendar', 'notes', 'replies'] as const) d = togglePanel(d, id, 1087, 683);
    const leftEdge = 16 + Math.min(330, 1087 * 0.23);
    for (const id of ['clock', 'calendar', 'notes', 'replies'] as const) expect(floatingOf(d, id)!.x).toBeGreaterThanOrEqual(leftEdge);
  });

  it('«solo l\'Umanoide» e «accendi tutto»: posizioni e misure restano', () => {
    let d = setFloat(everythingOn(defaultDock()), 'weather', { x: 500, y: 200 });
    expect(d.hidden).toEqual([]);
    d = onlyEssentials(d);
    expect(d.hidden).toEqual(PANEL_IDS.filter((id) => id !== 'humanoid'));
    expect(floatingOf(d, 'weather')).toEqual({ x: 500, y: 200 });
    expect(everythingOn(everythingOn(d))).toEqual(everythingOn(d));
  });
});

describe('chat e pannelli sullo schermo (24/10/2026)', () => {
  it('la chat parte spenta; mostrata si posa libera e intera, poi resta dove la si mette', () => {
    let d = defaultDock();
    expect(d.hidden).toContain('chat');
    d = showPanel(d, 'chat', 1600, 900);
    expect(d.hidden).not.toContain('chat');
    const pos = floatingOf(d, 'chat')!;
    expect(pos).not.toBeNull();
    const box = floatBox(d, 'chat', 1600, 900);
    expect(pos.x + box.w).toBeLessThanOrEqual(1600);
    expect(pos.y + box.h).toBeLessThanOrEqual(900);
    // Spostata, piegata, chiusa e riaperta: torna aperta nello stesso punto.
    d = toggleCollapsed(setFloat(d, 'chat', { x: 40, y: 120 }), 'chat');
    d = showPanel(toggleHidden(d, 'chat'), 'chat', 1600, 900);
    expect(isCollapsed(d, 'chat')).toBe(false);
    expect(floatingOf(d, 'chat')).toEqual({ x: 40, y: 120 });
  });

  it('un pannello già sullo schermo nella sua colonna resta lì (solo riaperto)', () => {
    const d = showPanel(toggleCollapsed(everythingOn(defaultDock()), 'system'), 'system', 1600, 900);
    expect(isCollapsed(d, 'system')).toBe(false);
    expect(floatingOf(d, 'system')).toBeNull();
    expect(visibleIds(d, 'right')).toContain('system');
  });
});
