// Zoom sull'agente (11/10/2026): l'inquadratura da vicino non passa mai dentro la Sfera centrale,
// la camera gira per la via più corta e la sfera dell'agente scala anche i suoi punti.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { approachAngle, CORE_RADIUS, crossesCore, FOCUS_DIST, focusOrbit, orbitPosition } from '../../src/renderer/neural/focus.ts';
import { createGraph, layout, type GraphNode } from '../../src/renderer/neural/graph.ts';
import { createSfera } from '../../src/renderer/neural/sfera.ts';

const agentsAt = (count: number): Array<[number, number, number]> => {
  const g = createGraph();
  for (let i = 0; i < count; i++) {
    const id = `agent:a${i}`;
    const node: GraphNode = { id, kind: 'agent', label: `A${i}`, parent: null, status: 'idle', alert: false, createdAt: 0, lastEventAt: 0, lastEventId: null, events: 0, position: [0, 0, 0] };
    g.nodes.set(id, node);
  }
  layout(g);
  return [...g.nodes.values()].filter((n) => n.kind === 'agent').map((n) => n.position);
};

describe('zoom sull\'agente: inquadratura', () => {
  it('per ogni squadra da 1 a 12 agenti la camera sta fuori dalla Sfera e la Sfera non copre l\'agente', () => {
    for (let count = 1; count <= 12; count++) {
      for (const pos of agentsAt(count)) {
        const orbit = focusOrbit(pos);
        expect(orbit.dist).toBe(FOCUS_DIST);
        const cam = orbitPosition(pos, orbit);
        expect(Math.hypot(...cam), `${count} agenti, ${pos.join(',')}`).toBeGreaterThan(CORE_RADIUS + 0.3);
        // Agente fuori dal guscio esterno: la Sfera non si mette mai in mezzo. Agente già dentro il
        // guscio (la disposizione schiaccia la profondità): la camera esce per la via più breve, cioè
        // lungo la retta dal centro all'agente.
        if (Math.hypot(...pos) > CORE_RADIUS) expect(crossesCore(cam, pos), `${count} agenti, ${pos.join(',')}`).toBe(false);
        else {
          const away = [cam[0] - pos[0], cam[1] - pos[1], cam[2] - pos[2]];
          const cos = (away[0]! * pos[0] + away[1]! * pos[1] + away[2]! * pos[2]) / (Math.hypot(...away) * Math.hypot(...pos));
          expect(cos, `${count} agenti, ${pos.join(',')}`).toBeGreaterThan(0.999);
        }
        // Agente davanti alla Sfera: la camera lo guarda dal lato di chi guarda lo schermo.
        if (pos[2] >= 0) expect(cam[2]).toBeGreaterThan(pos[2]);
      }
    }
  });

  it('agente al centro (caso degenere): inquadratura frontale, niente NaN', () => {
    const o = focusOrbit([0, 0, 0]);
    expect(Number.isFinite(o.az) && Number.isFinite(o.el)).toBe(true);
    expect(orbitPosition([0, 0, 0], o)[2]).toBeGreaterThan(0);
  });

  it('la camera gira per la via più corta (da 170° a -170° sono 20°, non 340°)', () => {
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    const half = approachAngle(from, to, 0.5);
    expect(Math.abs(Math.cos(half) - Math.cos(Math.PI))).toBeLessThan(1e-9);
    expect(Math.abs(approachAngle(from, to, 1) - from)).toBeCloseTo((20 * Math.PI) / 180, 9);
  });

  it('il controllo di attraversamento riconosce un segmento che passa per il centro', () => {
    expect(crossesCore([0, 0, 5], [0, 0, -5])).toBe(true);
    expect(crossesCore([3, 0, 5], [3, 0, -5])).toBe(false);
  });
});

describe('zoom sull\'agente: sfera in scala', () => {
  it('setScale scala la geometria; valori anomali non arrivano alla GPU', () => {
    const s = createSfera(0);
    s.setScale(0.4);
    expect(s.group.scale.x).toBeCloseTo(0.4, 9);
    s.setScale(Number.NaN);
    expect(s.group.scale.x).toBeGreaterThan(0);
    s.setScale(-3);
    expect(s.group.scale.x).toBeGreaterThan(0);
    s.update(1_000, 0.5, new THREE.Color(0x45f0a0), false);
    s.dispose();
  });
});
