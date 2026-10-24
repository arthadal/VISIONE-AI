// Anti-collisione delle etichette della scena (P-95; P-98 per le label fisse e le info di hover).
// Il piazzamento è puro e deterministico. Verifica: nessuna sovrapposizione tra le label piazzate,
// priorità alla label sotto il puntatore, distanziamento con offset, estensione a tutta l'area
// quando l'ancora è affollata, e NESSUNA label ritirata (gli agenti sono sempre visibili).
import { describe, expect, it } from 'vitest';
import { clearDismissed, dismissPopover, labelPriority, labelSize, labelVisible, nodeExplanation, nodeInfoFields, resolveLabelCollisions, type SceneLabel } from '../../src/renderer/neural/labels.ts';

function label(over: Partial<SceneLabel> & { id: string }): SceneLabel {
  return {
    text: 'NEMO SUPER', kind: 'agent', status: 'working', x: 100, y: 100, nx: 70, ny: 110, r: 24, hot: false,
    ...over
  };
}

function overlaps(a: SceneLabel, b: SceneLabel): boolean {
  const sa = labelSize(a);
  const sb = labelSize(b);
  return a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h;
}

describe('anti-collisione delle etichette (P-95/P-98)', () => {
  it('con più agenti attivi le label si distanziano e non si sovrappongono', () => {
    const labels = [
      label({ id: 'agent:a', x: 300, y: 120 }),
      label({ id: 'agent:b', x: 302, y: 124 }),
      label({ id: 'agent:c', x: 299, y: 118 }),
      label({ id: 'agent:d', x: 301, y: 122 }),
      label({ id: 'director', kind: 'director', text: 'Director', status: 'idle', x: 400, y: 300, nx: 380, ny: 310 })
    ];
    const out = resolveLabelCollisions(labels, { width: 900, height: 600 });
    expect(out.length).toBe(labels.length);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i] as SceneLabel, out[j] as SceneLabel), `${out[i]?.id} vs ${out[j]?.id}`).toBe(false);
      }
    }
    // Le ancore reali dei nodi restano intatte (servono a hover e click).
    expect(out.find((l) => l.id === 'agent:a')).toMatchObject({ nx: 70, ny: 110 });
  });

  it('la label sotto il puntatore ha priorità assoluta e resta all\'ancora preferita', () => {
    const hot = label({ id: 'agent:a', hot: true });
    const other = label({ id: 'agent:b' });
    const out = resolveLabelCollisions([other, hot], { width: 900, height: 600 });
    // L' hot si piazza per primo alla sua ancora (x base, y base).
    expect(out.find((l) => l.id === 'agent:a')).toMatchObject({ x: 100, y: 100 });
    // L'altra, che punterebbe lo stesso punto, viene spostata.
    const moved = out.find((l) => l.id === 'agent:b') as SceneLabel;
    expect([moved.x, moved.y]).not.toEqual([100, 100]);
  });

  it('P-98: molte label sulla stessa ancora si distribuiscono in tutta l\'area, senza ritiri', () => {
    // 21 agenti con la stessa ancora (caso peggiore) in un\'area reale: tutte piazzate e mai
    // sovrapposte — l'algoritmo esce dai passi vicini all'ancora e scansiona l'area.
    const many = Array.from({ length: 21 }, (_, i) => label({ id: `agent:${i}`, text: `AGENTE ${i}`, x: 760, y: 430, nx: 768, ny: 432, r: 33 }));
    const area = { width: 1536, height: 864 };
    const out = resolveLabelCollisions(many, area);
    expect(out.length).toBe(many.length);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i] as SceneLabel, out[j] as SceneLabel), `${out[i]?.id} vs ${out[j]?.id}`).toBe(false);
      }
    }
    for (const l of out) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x + labelSize(l).w).toBeLessThanOrEqual(area.width);
      expect(l.y).toBeGreaterThanOrEqual(0);
      expect(l.y + labelSize(l).h).toBeLessThanOrEqual(area.height);
    }
  });

  it('P-100: con i margini delle sovrastrutture le label restano nell\'area libera', () => {
    const labels = Array.from({ length: 6 }, (_, i) => label({ id: `agent:${i}`, text: `AGENTE ${i}`, x: 10 + i * 400, y: 300, nx: 20 + i * 400, ny: 300 }));
    const area = { width: 1536, height: 864 };
    const insets = { left: 260, right: 300, top: 46, bottom: 120 };
    const out = resolveLabelCollisions(labels, area, insets);
    expect(out.length).toBe(labels.length);
    for (const l of out) {
      const s = labelSize(l);
      expect(l.x).toBeGreaterThanOrEqual(3 + 260 - 0.001);
      expect(l.x + s.w).toBeLessThanOrEqual(1536 - 300 - 3 + 0.001);
      expect(l.y).toBeGreaterThanOrEqual(3 + 46 - 0.001);
      expect(l.y + s.h).toBeLessThanOrEqual(864 - 120 - 3 + 0.001);
    }
    // Senza margini il comportamento resta quello di prima (default neutro).
    const plain = resolveLabelCollisions(labels, area);
    expect(plain.some((l) => l.x < 260)).toBe(true);
  });

  it('P-98: area minuscola → nessuna label sparisce; la hot resta alla sua ancora', () => {
    const many = Array.from({ length: 8 }, (_, i) => label({ id: `agent:${i}`, x: 90, y: 96 }));
    const area = { width: 240, height: 120 };
    const hot = label({ id: 'agent:3', x: 90, y: 96, hot: true });
    const visible = resolveLabelCollisions([...many.slice(0, 3), hot, ...many.slice(4), label({ id: 'director', kind: 'director', text: 'Director', x: 110, y: 98 })], area);
    // Mai ritirate: tutte presenti (l'area satura ammette la sovrapposizione minima).
    expect(visible.length).toBe(9);
    expect(visible.find((l) => l.id === 'agent:3')).toMatchObject({ x: 90, y: 96 });
    expect(visible.some((l) => l.id === 'director')).toBe(true);
  });

  it('visibilità e priorità: gli agenti sono SEMPRE visibili, gli altri si nominano al passaggio', () => {
    // P-98: label fisse per gli agenti, anche inattivi.
    expect(labelVisible(label({ id: 'agent:z', status: 'idle' }), null, null)).toBe(true);
    expect(labelVisible(label({ id: 'agent:z', status: 'stopped' }), null, null)).toBe(true);
    expect(labelVisible(label({ id: 'agent:z', status: 'idle' }), 'agent:z', null)).toBe(true);
    expect(labelVisible(label({ id: 'agent:z', status: 'working' }), null, null)).toBe(true);
    expect(labelVisible(label({ id: 'director', kind: 'director', status: 'idle' }), null, null)).toBe(true);
    // I nodi di servizio (non agenti) restano come P-95: visibili solo se hot o attivi.
    expect(labelVisible(label({ id: 'tool:x', kind: 'tool', status: 'idle' }), null, null)).toBe(false);
    expect(labelVisible(label({ id: 'tool:x', kind: 'tool', status: 'idle' }), 'tool:x', null)).toBe(true);
    expect(labelVisible(label({ id: 'tool:x', kind: 'tool', status: 'working' }), null, null)).toBe(true);
    expect(labelPriority(label({ id: 'agent:a', hot: true }))).toBeLessThan(labelPriority(label({ id: 'director', kind: 'director' })));
    expect(labelPriority(label({ id: 'agent:a', status: 'working' }))).toBeLessThan(labelPriority(label({ id: 'agent:b', status: 'idle' })));
  });

  it('P-98/P-99: info del popover di hover — tipo e spiegazione chiara, campi mancanti dichiarati «—»', () => {
    const fields = nodeInfoFields({
      role: 'AGENTE',
      kind: 'agent',
      text: 'coder',
      status: 'working',
      statusReason: 'turno in corso',
      adapter: 'opencode',
      model: 'deepseek/deepseek-flash',
      sessionId: 'sess-42',
      lastEventAt: 10_000,
      now: 25_000
    });
    expect(fields.map((f) => f.k)).toEqual(['nome', 'ruolo', 'tipo', 'stato', 'provider', 'modello', 'sessione', 'ultimo segnale', 'spiegazione']);
    expect(fields.find((f) => f.k === 'nome')?.v).toBe('coder');
    expect(fields.find((f) => f.k === 'ruolo')?.v).toBe('AGENTE');
    expect(fields.find((f) => f.k === 'tipo')?.v).toBe('agent');
    expect(fields.find((f) => f.k === 'stato')?.v).toBe('WORKING · turno in corso');
    expect(fields.find((f) => f.k === 'provider')?.v).toBe('opencode');
    expect(fields.find((f) => f.k === 'sessione')?.v).toBe('sess-42');
    expect(fields.find((f) => f.k === 'ultimo segnale')?.v).toBe('15 s fa');
    // Oltre il minuto: minuti, ore, giorni (12/10/2026).
    expect(nodeInfoFields({ text: 'x', role: 'TASK', kind: 'task', status: 'running', lastEventAt: 1, now: 1 + 2_270_000 }).find((f) => f.k === 'ultimo segnale')?.v).toBe('37 min fa');
    expect(fields.find((f) => f.k === 'spiegazione')?.v).toContain('agente reale del registro');
    // Anche i nodi di servizio hanno la loro spiegazione reale (P-99), non solo gli agenti.
    expect(nodeExplanation('tool')).toContain('strumento');
    expect(nodeExplanation('task')).toContain('unità di lavoro');
    expect(nodeExplanation('process')).toContain('processo del motore');
    expect(nodeExplanation('approval')).toContain('approvazione');
    expect(nodeExplanation('memory')).toContain('ricordo');
    // Director senza provider né sessione: «—» e «mai», nessun valore inventato.
    const director = nodeInfoFields({ role: 'COORDINATORE', kind: 'director', text: 'Director', status: 'idle' });
    expect(director.find((f) => f.k === 'provider')?.v).toBe('—');
    expect(director.find((f) => f.k === 'modello')?.v).toBe('—');
    expect(director.find((f) => f.k === 'sessione')?.v).toBe('—');
    expect(director.find((f) => f.k === 'ultimo segnale')?.v).toBe('mai');
    expect(director.find((f) => f.k === 'spiegazione')?.v).toContain('coordinatore');
    // Tipo assente: «—» dichiarato, mai inventato.
    const noKind = nodeInfoFields({ role: 'AGENTE', text: 'x', status: 'idle' });
    expect(noKind.find((f) => f.k === 'tipo')?.v).toBe('—');
    expect(noKind.find((f) => f.k === 'spiegazione')?.v).toBe('—');
    // P-100: un agente mai avviato si dichiara «MAI AVVIATO» (globo bianco), un task resta CREATED.
    const fresh = nodeInfoFields({ role: 'AGENTE', kind: 'agent', text: 'nuovo', status: 'created' });
    expect(fresh.find((f) => f.k === 'stato')?.v).toBe('MAI AVVIATO');
    const task = nodeInfoFields({ role: 'TASK', kind: 'task', text: 't', status: 'created' });
    expect(task.find((f) => f.k === 'stato')?.v).toBe('CREATED');
    // Input anomali: mai NaN/undefined nel testo.
    const weird = nodeInfoFields({ role: 'AGENTE', text: 'x', status: 'idle', lastEventAt: NaN, now: NaN });
    expect(weird.find((f) => f.k === 'ultimo segnale')?.v).toBe('mai');
  });

  it('P-100: × chiude il popover di UN nodo e il puntatore che esce lo riabilita', () => {
    let closed: ReadonlySet<string> = new Set();
    // Chiusura con × del nodo sotto il puntatore: resta chiuso anche se è ancora caldo.
    closed = dismissPopover(closed, 'agent:a');
    expect(closed.has('agent:a')).toBe(true);
    // Un secondo popover (selezione) si chiude in modo indipendente: l'insieme non si mescola.
    closed = dismissPopover(closed, 'director');
    expect([...closed].sort()).toEqual(['agent:a', 'director']);
    // Il puntatore lascia `agent:a`: si dimentica SOLO quella chiusura; l'altra resta.
    closed = clearDismissed(closed, 'agent:a');
    expect(closed.has('agent:a')).toBe(false);
    expect(closed.has('director')).toBe(true);
    // Puntatore fuori dalla scena (null): tutte le chiusure si azzerano.
    closed = clearDismissed(closed, null);
    expect(closed.size).toBe(0);
    // Idempotenza e immutabilità: l'insieme di partenza non viene mai mutato.
    const start: ReadonlySet<string> = new Set(['agent:b']);
    const next = dismissPopover(start, 'agent:b');
    expect([...start]).toEqual(['agent:b']);
    expect(next).not.toBe(start);
    expect([...next]).toEqual(['agent:b']);
    expect(dismissPopover(next, 'agent:b')).toEqual(next);
    expect(clearDismissed(new Set(), 'x')).toEqual(new Set());
  });
});
