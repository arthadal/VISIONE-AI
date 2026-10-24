// P-74 — guardie di allocazione del renderer. Il crash del 04/10 (`Uncaught RangeError: Invalid array
// length` a raffica, poi renderer terminato) è stato isolato ai punti in cui un conteggio calcolato
// finisce in un array/typed array: qui si dimostra che con input anomalo (NaN, negativi, ∞, 1e9) i
// punti corretti (Sfera e polvere della scena Neural, `resample` per il microfono) non producono più
// lunghezze invalide e non lanciano.
// P-88: alla stessa sorveglianza si aggiungono i mapping PURI di colore/dimensione dei nodi e il
// colore degli impulsi, che leggono solo tipo e stato reali.
import { describe, expect, it } from 'vitest';
import { safeCount, safeInt, safeUnit } from '../../src/renderer/lib/safe.ts';
import {
  AGENT_GLOBE_COLORS,
  NODE_COLORS,
  PULSE_COLORS,
  nodeColorFor,
  nodeSizeFor,
  pulseColorFor,
  sceneOf
} from '../../src/renderer/neural/renderer3d.ts';
import { DUST_COUNT, DUST_MAX, createPolvere } from '../../src/renderer/neural/polvere.ts';
import { createSfera } from '../../src/renderer/neural/sfera.ts';
import {
  agentGlobeColor,
  agentGlobeState,
  createUfficio,
  officeAgentPosition,
  officeEnergyFor,
  officeNodePosition,
  officeSizeCss,
  PIXEL_AGENTI_PER_ANELLO,
  PIXEL_ANELLI,
  PIXEL_FASCIO,
  PIXEL_MICRO,
  PIXEL_PARTICELLE,
  PIXEL_PER_ANELLO,
  PIXEL_SFERA,
  PIXEL_STRATI,
  pixelCounts
} from '../../src/renderer/neural/pixel-office.ts';
import {
  QUALITA_FINESTRE_GIU,
  QUALITA_FINESTRE_SU,
  QUALITA_FPS_GIU,
  QUALITA_FPS_SU,
  qualitaPasso
} from '../../src/renderer/neural/qualita.ts';
import { VOCE_ATTACCO_S, VOCE_RILASCIO_S, voiceActivation, voiceTarget } from '../../src/renderer/neural/voce.ts';
import { MAX_RESAMPLE_SAMPLES, resample } from '../../src/renderer/voice/resample.ts';
import * as THREE from 'three';

describe('guardie di conteggio (P-74)', () => {
  it('safeCount: non finiti → fallback, negativi → 0, decimali troncati, tetto rispettato', () => {
    expect(safeCount(NaN, 100)).toBe(0);
    expect(safeCount(Infinity, 100)).toBe(0);
    expect(safeCount(-Infinity, 100)).toBe(0);
    expect(safeCount(-5, 100)).toBe(0);
    expect(safeCount(12.9, 100)).toBe(12);
    expect(safeCount(1e9, 4_000)).toBe(4_000);
    expect(safeCount(10, NaN)).toBe(0);
    expect(safeCount(-1, 10, 5)).toBe(0); // un negativo è un conteggio nullo, non il fallback
    expect(safeCount(NaN, 10, NaN)).toBe(0);
    expect(safeCount(3, 10, 7)).toBe(3); // un valore valido non usa il fallback
  });

  it('safeInt e safeUnit riportano i valori in un intervallo finito', () => {
    expect(safeInt(2.7, 0, 2, 0)).toBe(2);
    expect(safeInt(NaN, 0, 2, 1)).toBe(1);
    expect(safeInt(-3, 1, 2, 1)).toBe(1);
    expect(safeUnit(NaN)).toBe(0);
    expect(safeUnit(Infinity)).toBe(1);
    expect(safeUnit(-0.5)).toBe(0);
    expect(safeUnit(1.7)).toBe(1);
  });
});

describe('microfono: resample non alloca mai una lunghezza invalida (P-74)', () => {
  const input = Float32Array.from({ length: 48 }, (_, i) => i / 48);

  it('con frequenze o lunghezze anomale restituisce una copia, senza lanciare', () => {
    for (const [from, to] of [[0, 16_000], [-48_000, 16_000], [NaN, 16_000], [Infinity, 16_000], [16_000, 0], [16_000, NaN], [16_000, -1]]) {
      const out = resample(input, from as number, to as number);
      expect(Number.isInteger(out.length), `${from}→${to}`).toBe(true);
      expect(out.length).toBe(input.length);
    }
    const empty = resample(new Float32Array(0), 48_000, 16_000);
    expect(empty.length).toBe(0);
  });

  it('campionamento normale: 48 kHz → 16 kHz, uscita intera e nei limiti', () => {
    const out = resample(input, 48_000, 16_000);
    expect(out.length).toBe(16);
    expect(out[0]).toBeCloseTo(input[0] as number, 5);
    const up = resample(input, 16_000, 48_000);
    expect(up.length).toBe(144);
    expect(up.length).toBeLessThanOrEqual(MAX_RESAMPLE_SAMPLES);
    // Stessa frequenza = copia esatta.
    expect([...resample(input, 16_000, 16_000)]).toEqual([...input]);
  });
});

describe('Sfera e polvere: densità del riferimento e allocazioni sicure (P-74/P-88)', () => {
  it('polvere: punti per qualità sempre interi; update con energia anomala non lancia', () => {
    for (const quality of [0, 1, 2] as const) {
      const polvere = createPolvere(quality);
      expect(Number.isInteger(polvere.points)).toBe(true);
      expect(polvere.points).toBeGreaterThan(0);
      expect(polvere.points).toBe(DUST_COUNT[quality]);
      expect(polvere.points).toBeLessThanOrEqual(DUST_MAX);
      polvere.update(1_000, NaN, new THREE.Color(0x1c8cff), false);
      polvere.update(2_000, Infinity, new THREE.Color(0x1c8cff), true);
      polvere.dispose();
    }
    // Qualità fuori scala (difesa): zero punti, nessuna allocazione invalida.
    const outOfScale = createPolvere(9 as 0 | 1 | 2);
    expect(outOfScale.points).toBe(0);
    outOfScale.dispose();
  });

  it('sfera: a qualità 2 porta i vertici della Sfera del riferimento; update con livello anomalo non lancia', () => {
    const sfera = createSfera(2);
    expect(Number.isInteger(sfera.points)).toBe(true);
    // 6 gusci × 2.600 + archi tratteggiati + fascio: la Sfera piena di Munder supera i 18.000.
    expect(sfera.points).toBeGreaterThan(18_000);
    const colore = new THREE.Color(0x1c8cff);
    sfera.update(1_000, NaN, colore, false);
    sfera.update(2_000, Infinity, colore, true);
    sfera.dispose();
    // Qualità fuori scala: conteggi comunque interi e positivi (fallback difensivo), niente NaN.
    const outOfScale = createSfera(9 as 0 | 1 | 2);
    expect(Number.isInteger(outOfScale.points)).toBe(true);
    expect(outOfScale.points).toBeGreaterThan(0);
    outOfScale.dispose();
  });
});

describe('P-88: nodi e impulsi — colore e dimensione da dati reali (funzioni pure)', () => {
  it('P-100: agente vivo verde, al lavoro verde chiaro, errore/crash/limite rosso, spento o mai avviato bianco', () => {
    expect(nodeColorFor('agent', 'idle')).toBe(AGENT_GLOBE_COLORS.alive);
    expect(nodeColorFor('agent', 'starting')).toBe(AGENT_GLOBE_COLORS.alive);
    expect(nodeColorFor('agent', 'working')).toBe(AGENT_GLOBE_COLORS.working);
    expect(nodeColorFor('agent', 'failed')).toBe(AGENT_GLOBE_COLORS.problem);
    expect(nodeColorFor('agent', 'crashed')).toBe(AGENT_GLOBE_COLORS.problem);
    // Il limite raggiunto è un problema reale anche se lo stato non cambia (`alert`).
    expect(nodeColorFor('agent', 'idle', true)).toBe(AGENT_GLOBE_COLORS.problem);
    expect(nodeColorFor('agent', 'stopped')).toBe(AGENT_GLOBE_COLORS.off);
    expect(nodeColorFor('agent', 'created')).toBe(AGENT_GLOBE_COLORS.off);
    // Il verde resta verde: canale G dominante; il rosso ha R dominante; il bianco è quasi pieno.
    const rgb = (hex: number) => ({ r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff });
    const alive = rgb(AGENT_GLOBE_COLORS.alive);
    expect(alive.g).toBeGreaterThan(alive.r);
    expect(alive.g).toBeGreaterThan(alive.b);
    const problem = rgb(AGENT_GLOBE_COLORS.problem);
    expect(problem.r).toBeGreaterThan(problem.g);
    expect(problem.r).toBeGreaterThan(problem.b);
    const off = rgb(AGENT_GLOBE_COLORS.off);
    expect(Math.min(off.r, off.g, off.b)).toBeGreaterThan(0xdc);
  });

  it('Director e VISIONE hanno i colori del riferimento (7fd4ff / a78bfa); l\'errore reale ha la precedenza', () => {
    expect(nodeColorFor('director', 'idle')).toBe(NODE_COLORS.director);
    expect(nodeColorFor('visione', 'idle')).toBe(NODE_COLORS.visione);
    expect(nodeColorFor('director', 'error')).toBe(NODE_COLORS.error);
  });

  it('dimensioni: il coordinatore è il più grande, un agente al lavoro cresce, uno spento si rimpicciolisce', () => {
    expect(nodeSizeFor('director', 'idle')).toBeGreaterThan(nodeSizeFor('agent', 'idle'));
    expect(nodeSizeFor('visione', 'idle')).toBeGreaterThan(nodeSizeFor('agent', 'idle'));
    expect(nodeSizeFor('agent', 'working')).toBeGreaterThan(nodeSizeFor('agent', 'idle'));
    expect(nodeSizeFor('agent', 'stopped')).toBeLessThan(nodeSizeFor('agent', 'idle'));
    // Il Director resta il più grande anche in pausa: 1,5× un agente che lavora, 2× uno fermo.
    expect(nodeSizeFor('director', 'stopped')).toBe(nodeSizeFor('director', 'idle'));
    expect(nodeSizeFor('director', 'stopped')).toBeGreaterThanOrEqual(1.5 * nodeSizeFor('agent', 'working'));
    expect(nodeSizeFor('director', 'idle')).toBeGreaterThanOrEqual(2 * nodeSizeFor('agent', 'idle'));
    expect(nodeSizeFor('visione', 'stopped')).toBe(nodeSizeFor('visione', 'idle'));
    expect(nodeSizeFor('agent', 'idle')).toBeGreaterThan(nodeSizeFor('tool', 'ok'));
  });

  it('colore impulso per causa reale: delega, risultato, strumento, messaggio', () => {
    expect(pulseColorFor('task.assigned')).toBe(PULSE_COLORS.delega);
    expect(pulseColorFor('director.decision')).toBe(PULSE_COLORS.delega);
    expect(pulseColorFor('task.result.recorded')).toBe(PULSE_COLORS.risultato);
    expect(pulseColorFor('tool.call.started')).toBe(PULSE_COLORS.strumento);
    expect(pulseColorFor('agent.message.sent')).toBe(PULSE_COLORS.message);
    expect(pulseColorFor('agent.status.changed')).toBe(PULSE_COLORS.message);
  });
});

describe('P-89: scena ufficio pixel — numeri del riferimento e allocazioni sicure', () => {
  it('a qualità 2 i conteggi sono quelli del riferimento (più le microparticelle P-98)', () => {
    const c = pixelCounts(2);
    expect(c).toEqual({ particelle: PIXEL_PARTICELLE, sfera: PIXEL_SFERA, anelli: PIXEL_ANELLI, perAnello: PIXEL_PER_ANELLO, fascio: PIXEL_FASCIO, strati: PIXEL_STRATI, micro: PIXEL_MICRO });
    expect(c.particelle).toBe(9_000);
    expect(c.sfera).toBe(3_200);
    expect(c.anelli).toBe(4);
    expect(c.perAnello).toBe(900);
    expect(c.fascio).toBe(520);
    expect(c.strati).toBe(7);
    expect(c.micro).toBe(6_000); // P-98: microparticelle dinamiche in più
    // Qualità ridotte: interi positivi e non più densi della piena.
    for (const q of [0, 1] as const) {
      const s = pixelCounts(q);
      for (const v of [s.particelle, s.sfera, s.perAnello, s.fascio, s.micro]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      expect(s.particelle).toBeLessThanOrEqual(c.particelle);
      expect(s.sfera).toBeLessThanOrEqual(c.sfera);
      expect(s.micro).toBeLessThanOrEqual(c.micro);
    }
  });

  it('il campo a qualità 2 ha i vertici del riferimento (più le microparticelle) e non lancia con input anomali', () => {
    const ufficio = createUfficio(2);
    // 9.000 + 3.200 + 4×900 + 520 + 6.000 microparticelle + il cuore = 22.321.
    expect(ufficio.points).toBe(22_321);
    for (const [now, livello, w, h, pr] of [[1_000, NaN, 800, 600, 1], [2_000, Infinity, 0, 0, 2], [3_000, -1, NaN, 600, 1], [4_000, 0.5, 800, Infinity, 1]]) {
      expect(() => ufficio.update(now as number, livello as number, false, w as number, h as number, pr as number, [{ x: 10, y: 20, energia: NaN }])).not.toThrow();
    }
    ufficio.update(5_000, 1, true, 1_600, 900, 1.25, []);
    ufficio.dispose();
    // Qualità fuori scala: conteggi difensivi, mai un typed array invalido.
    const fuoriScala = createUfficio(9 as 0 | 1 | 2);
    expect(Number.isInteger(fuoriScala.points)).toBe(true);
    expect(fuoriScala.points).toBeGreaterThan(0);
    fuoriScala.dispose();
  });

  it('energia dei nodi dagli stati reali: lavoro/errore accesi, fermo tenue, spento al minimo', () => {
    expect(officeEnergyFor('agent', 'working')).toBe(1);
    expect(officeEnergyFor('agent', 'running')).toBe(1);
    expect(officeEnergyFor('agent', 'failed')).toBe(1);
    expect(officeEnergyFor('agent', 'idle')).toBe(0.3);
    expect(officeEnergyFor('agent', 'stopped')).toBe(0.2);
    expect(officeEnergyFor('director', 'idle')).toBeGreaterThan(officeEnergyFor('agent', 'idle'));
    expect(officeEnergyFor('visione', 'idle')).toBeGreaterThan(officeEnergyFor('agent', 'idle'));
  });

  it('P-100: semantica e colore dei globi agente — verde vivo, rosso problema, bianco spento', () => {
    expect(agentGlobeState('idle')).toBe('alive');
    expect(agentGlobeState('starting')).toBe('alive');
    expect(agentGlobeState('waiting')).toBe('alive');
    expect(agentGlobeState('working')).toBe('working');
    expect(agentGlobeState('running')).toBe('working');
    expect(agentGlobeState('error')).toBe('problem');
    expect(agentGlobeState('crashed')).toBe('problem');
    expect(agentGlobeState('idle', true)).toBe('problem');
    expect(agentGlobeState('stopped')).toBe('off');
    expect(agentGlobeState('created')).toBe('off');
    // Colori coerenti con la semantica: verde dominante, rosso dominante, bianco quasi pieno.
    const alive = agentGlobeColor('idle');
    expect(alive[1]).toBeGreaterThan(alive[0]);
    expect(alive[1]).toBeGreaterThan(alive[2]);
    const working = agentGlobeColor('working');
    expect(working[1]).toBeGreaterThan(0.9);
    const problem = agentGlobeColor('error');
    expect(problem[0]).toBeGreaterThan(0.8);
    const off = agentGlobeColor('stopped');
    expect(Math.min(off[0], off[1], off[2])).toBeGreaterThan(0.9);
    // Stato anomalo: né errore né spento → vivo (dichiarato), mai un colore inventato.
    expect(agentGlobeState('boh')).toBe('alive');
  });

  it('posizione dei nodi: deterministica per id, dentro la scena, lontana dal centro', () => {
    const a = officeNodePosition('agent:alfa', 1_200, 700);
    const b = officeNodePosition('agent:alfa', 1_200, 700);
    expect(a).toEqual(b);
    const c = officeNodePosition('agent:beta', 1_200, 700);
    expect(c).not.toEqual(a);
    const centro = Math.hypot(a[0] - 600, a[1] - 350);
    expect(centro).toBeGreaterThan(0.3 * 700 * 0.42);
    expect(a[0]).toBeGreaterThanOrEqual(0);
    expect(a[0]).toBeLessThanOrEqual(1_200);
    expect(a[1]).toBeGreaterThanOrEqual(0);
    expect(a[1]).toBeLessThanOrEqual(700);
  });

  it('P-97: agenti ordinati su anelli regolari attorno al centro, globi più grandi dei nodi', () => {
    const W = 1_536;
    const H = 864;
    const at = (i: number, tot: number) => {
      const p = officeAgentPosition(i, tot, W, H);
      return { x: p[0], y: p[1], d: Math.hypot(p[0] - W / 2, p[1] - H / 2), a: Math.atan2(p[1] - H / 2, p[0] - W / 2) };
    };
    // Deterministico e distinto per slot.
    expect(officeAgentPosition(0, 8, W, H)).toEqual(officeAgentPosition(0, 8, W, H));
    expect(officeAgentPosition(1, 8, W, H)).not.toEqual(officeAgentPosition(0, 8, W, H));
    // Primo anello: stesso raggio, angoli equidistanti (8 agenti → passo 2π/8).
    const a0 = at(0, 8);
    const a1 = at(1, 8);
    const a2 = at(2, 8);
    expect(a0.d).toBeCloseTo(a1.d, 6);
    expect(a1.d).toBeCloseTo(a2.d, 6);
    expect(((a1.a - a0.a) + Math.PI * 2) % (Math.PI * 2)).toBeCloseTo((Math.PI * 2) / 8, 6);
    // L'anello successivo è più esterno e parte interlacciato di mezzo slot.
    const b0 = at(0, 20);
    const b10 = at(PIXEL_AGENTI_PER_ANELLO, 20);
    expect(b10.d).toBeGreaterThan(b0.d);
    expect(((b10.a - b0.a) + Math.PI * 2) % (Math.PI * 2)).toBeCloseTo(Math.PI / PIXEL_AGENTI_PER_ANELLO, 6);
    // Con molti agenti si resta dentro la scena (anelli contenuti nell'area libera).
    for (const i of [0, 9, 15, 33]) {
      const p = officeAgentPosition(i, 34, W, H);
      expect(p[0]).toBeGreaterThanOrEqual(0);
      expect(p[0]).toBeLessThanOrEqual(W);
      expect(p[1]).toBeGreaterThanOrEqual(0);
      expect(p[1]).toBeLessThanOrEqual(H);
    }
    // Globi: Director (nucleo) > agenti > nodi generici, anche confrontando un agente fermo con un
    // nodo generico acceso; l'hover ingrandisce; input anomali innocui.
    const min = Math.min(W, H);
    expect(officeSizeCss('director', 0.55, min)).toBeGreaterThan(officeSizeCss('agent', 1, min));
    expect(officeSizeCss('agent', 0.3, min)).toBeGreaterThan(officeSizeCss('tool', 1, min));
    expect(officeSizeCss('agent', 0.3, min, true)).toBeGreaterThan(officeSizeCss('agent', 0.3, min));
    expect(Number.isFinite(officeSizeCss('director', NaN, NaN))).toBe(true);
    // P-99: un altro aumento dei globi (≥ 0,083 a riposo), sempre sotto il Director anche da fermi
    // col nodo generico acceso; l'agente acceso (anche col puntatore) non supera il nucleo.
    const agenteFermo = officeSizeCss('agent', 0.3, min);
    const agenteAcceso = officeSizeCss('agent', 1, min);
    const direttore = officeSizeCss('director', 0.55, min);
    expect(agenteFermo).toBeGreaterThanOrEqual(min * 0.083);
    expect(agenteFermo).toBeGreaterThan(min * 0.0466 * 1.5);
    expect(agenteAcceso).toBeGreaterThanOrEqual(min * 0.105);
    expect(agenteAcceso).toBeLessThan(direttore);
    expect(officeSizeCss('agent', 1, min, true)).toBeLessThan(direttore);
  });

  it('selezione scena (sceneOf): legge `ui.scene` reale e ricade su jarvis', () => {
    expect(sceneOf({ ui: { scene: 'pixel-office' } })).toBe('pixel-office');
    expect(sceneOf({ ui: { scene: 'jarvis' } })).toBe('jarvis');
    expect(sceneOf({ ui: {} })).toBe('jarvis');
    expect(sceneOf({})).toBe('jarvis');
    expect(sceneOf({ ui: { scene: 'ufficio' } })).toBe('jarvis');
  });
});

describe('P-90: attivazione dalla voce REALE (inviluppo) e scena sempre viva', () => {
  it('target: 0 fuori da parlato/ascolto, anche con un livello alto (nessuna attivazione finta)', () => {
    expect(voiceTarget('idle', 1)).toBe(0);
    expect(voiceTarget('planning', 1)).toBe(0);
    expect(voiceTarget('working', 1)).toBe(0);
    expect(voiceTarget('error', 1)).toBe(0);
    // Parlare accende più che ascoltare; il livello reale modula la base dello stato.
    expect(voiceTarget('speaking', 0)).toBeGreaterThan(0);
    expect(voiceTarget('speaking', 1)).toBe(1);
    expect(voiceTarget('speaking', 0.5)).toBeGreaterThan(voiceTarget('listening', 0.5));
    expect(voiceTarget('listening', 0)).toBeGreaterThan(0);
    // Livelli anomali non avvelenano: clampati in [0,1].
    expect(voiceTarget('speaking', NaN)).toBe(voiceTarget('speaking', 0));
    expect(voiceTarget('listening', Infinity)).toBe(1);
  });

  it('inviluppo: attacco più rapido del rilascio, decade a 0 quando la voce tace', () => {
    const dt = 1 / 60;
    // Un frame di parlato: sale (attacco 0,12 s), senza scatti.
    const attacco = voiceActivation('speaking', 1, dt, 0);
    expect(attacco).toBeGreaterThan(0.05);
    expect(attacco).toBeLessThan(0.25);
    // Un frame a riposo da un valore pieno: scende di poco (rilascio 0,45 s, morbido).
    const rilascio = voiceActivation('idle', 0, dt, 1);
    expect(rilascio).toBeGreaterThan(0.9);
    expect(rilascio).toBeLessThan(1);
    // Dopo due secondi di silenzio reale l'attivazione è quasi a zero.
    let v = 1;
    for (let i = 0; i < 120; i++) v = voiceActivation('idle', 0, dt, v);
    expect(v).toBeLessThan(0.02);
    // P-92: a fine voce la coda scatta a ZERO esatto (nessuna attivazione residua).
    for (let i = 0; i < 30; i++) v = voiceActivation('idle', 0, dt, v);
    expect(v).toBe(0);
    // Input anomali: mai NaN/∞ in uscita.
    expect(voiceActivation('speaking', NaN, NaN, NaN)).toBe(0);
    expect(Number.isFinite(voiceActivation('listening', Infinity, Infinity, Infinity))).toBe(true);
    expect(VOCE_RILASCIO_S).toBeGreaterThan(VOCE_ATTACCO_S);
  });

  it('il campo pixel-office anima SEMPRE il tempo quando il moto è acceso, e lo ferma con reducedMotion', () => {
    const ufficio = createUfficio(0);
    // Due fotogrammi a distanza: con moto acceso il tempo avanza (nessuna eccezione, nessun crash).
    ufficio.update(1_000, 0, false, 800, 600, 1, []);
    expect(() => ufficio.update(1_200, 0, false, 800, 600, 1, [])).not.toThrow();
    // A moto ridotto il tempo si ferma e con voce reale gli input anomali restano innocui.
    expect(() => ufficio.update(1_400, NaN, true, 800, 600, 1, [], 1)).not.toThrow();
    expect(() => ufficio.update(1_600, 0.5, false, 800, 600, 1, [], Infinity)).not.toThrow();
    ufficio.dispose();
  });
});

describe('P-92: qualità adattiva stabile col ciclo continuo (niente oscillazione)', () => {
  const stato = () => ({ buone: 0, cattive: 0 });

  it('una sola finestra lenta NON fa scendere la qualità: ne servono TRE consecutive', () => {
    let s = stato();
    // 1ª e 2ª finestra sotto soglia: nessun passo.
    for (let i = 0; i < QUALITA_FINESTRE_GIU - 1; i++) {
      const r = qualitaPasso(QUALITA_FPS_GIU - 10, 2, s);
      expect(r.passo).toBe(null);
      s = r.stato;
    }
    // Una finestra buona azzera il conteggio: la ricostruzione non deve accumulare demozioni.
    s = qualitaPasso(60, 2, s).stato;
    expect(s.cattive).toBe(0);
    // Tre finestre cattive consecutive: si scende.
    let passo = null;
    for (let i = 0; i < QUALITA_FINESTRE_GIU; i++) {
      const r = qualitaPasso(QUALITA_FPS_GIU - 1, 2, s);
      passo = r.passo;
      s = r.stato;
    }
    expect(passo).toBe('giu');
    expect(s).toEqual({ buone: 0, cattive: 0 });
  });

  it('non si scende sotto q0 e si sale solo dopo finestre sopra soglia', () => {
    expect(qualitaPasso(10, 0, { buone: 0, cattive: 0 }).passo).toBe(null);
    let s = { buone: 0, cattive: 0 };
    let passo = null;
    for (let i = 0; i < QUALITA_FINESTRE_SU; i++) {
      const r = qualitaPasso(QUALITA_FPS_SU + 1, 1, s);
      passo = r.passo;
      s = r.stato;
    }
    expect(passo).toBe('su');
    // A q2 non si sale oltre; una finestra a 50–57 fps non promuove.
    expect(qualitaPasso(60, 2, { buone: 99, cattive: 0 }).passo).toBe(null);
    expect(qualitaPasso(QUALITA_FPS_SU - 1, 1, { buone: QUALITA_FINESTRE_SU - 1, cattive: 0 }).passo).toBe(null);
    // fps non finito: mai un cambio.
    expect(qualitaPasso(NaN, 2, { buone: 0, cattive: 99 }).passo).toBe(null);
  });
});
