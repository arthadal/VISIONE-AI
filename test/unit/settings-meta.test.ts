// Impostazioni spiegate (P-94) e con suggerimenti selezionabili (P-95): la mappatura etichette→config
// copre ogni voce reale con sezione e spiegazione; i valori consigliati sono REALI (voci it-IT Edge,
// preset di velocità/tono, livelli del contratto) e restano combinabili con un valore scritto a mano.
import { TTS_PROVIDERS } from '../../src/shared/contracts/index.ts';
import { describe, expect, it } from 'vitest';
import { LOG_LEVELS } from '../../src/shared/node/logging.ts';
import { DEFAULT_CONFIG } from '../../src/shared/node/config.ts';
import {
  IT_VOICES, leaves, optionsFor, TTS_PROVIDERS_UI, MODEL_PATHS, modelSuggestions, SETTING_META, SETTING_SECTIONS, settingMeta,
  settingsBySection, TTS_PITCH_PRESETS, TTS_RATE_PRESETS, type SettingLeaf
} from '../../src/renderer/app/settings-meta.ts';

const config = DEFAULT_CONFIG as unknown as Record<string, unknown>;

describe('impostazioni spiegate (P-94)', () => {
  it('ogni voce reale della configurazione ha etichetta italiana, spiegazione e sezione dichiarata', () => {
    const list = leaves(config);
    expect(list.length).toBeGreaterThan(30);
    for (const leaf of list) {
      expect(SETTING_META[leaf.path], leaf.path).toBeDefined();
      const meta = settingMeta(leaf.path);
      expect(meta.label, leaf.path).not.toBe(leaf.path);
      expect(meta.help.length, leaf.path).toBeGreaterThan(10);
      expect(SETTING_SECTIONS.some((s) => s.id === meta.section), leaf.path).toBe(true);
    }
  });

  it('raggruppa per sezioni nell\'ordine dichiarato, solo con voci reali della config', () => {
    const groups = settingsBySection(config);
    const ids = groups.map((g) => g.section.id);
    const expected = SETTING_SECTIONS.map((s) => s.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(expected);
    expect(ids).toEqual(['logging', 'supervisor', 'runtime', 'director', 'agents', 'memory', 'voice', 'system', 'ui', 'offline']);
    const paths = new Set(groups.flatMap((g) => g.items.map((i: SettingLeaf) => i.path)));
    expect(paths.has('logging.level')).toBe(true);
    expect(paths.has('memory.searchLimit')).toBe(true);
    expect(paths.has('supervisor.heartbeatIntervalMs')).toBe(true);
    // I controlli dedicati restano fuori dalla griglia (già presenti in cima al cassetto).
    expect(paths.has('voice.wake.enabled')).toBe(false);
    expect(paths.has('ui.desktop')).toBe(false);
    expect(paths.has('ui.scene')).toBe(false);
  });

  it('le scelte dichiarate coincidono con i valori reali del contratto (livelli di log)', () => {
    expect(settingMeta('logging.level').options?.map((o) => o.value)).toEqual([...LOG_LEVELS]);
    // P-95: il livello di log si può anche scrivere a mano (combobox), quindi ha i suggerimenti.
    expect(settingMeta('logging.level').suggestions?.map((o) => o.value)).toEqual([...LOG_LEVELS]);
  });

  it('P-95: i suggerimenti sono valori REALI e i campi aperti restano scrivibili a mano', () => {
    // Voci it-IT di Windows (elencate dal sistema il 07/10/2026, P-103) e del servizio Edge
    // (verificate il 06/10/2026): mai nomi inventati.
    expect(IT_VOICES.map((o) => o.value)).toEqual([
      'Microsoft Cosimo', 'Microsoft Elsa',
      'it-IT-DiegoNeural', 'it-IT-ElsaNeural', 'it-IT-IsabellaNeural', 'it-IT-GiuseppeMultilingualNeural'
    ]);
    expect(settingMeta('voice.tts.voice').suggestions).toEqual(IT_VOICES);
    expect(settingMeta('voice.tts.rate').suggestions).toEqual(TTS_RATE_PRESETS);
    expect(settingMeta('voice.tts.pitch').suggestions).toEqual(TTS_PITCH_PRESETS);
    expect(TTS_RATE_PRESETS.map((o) => o.value)).toEqual(['+0%', '+5%', '-5%', '+10%', '-10%']);
    expect(TTS_PITCH_PRESETS.map((o) => o.value)).toEqual(['-2Hz', '0', '+2Hz']);
    // I tre campi modello sono nella lista dedicata: lì i suggerimenti arrivano dagli agenti reali.
    expect([...MODEL_PATHS].sort()).toEqual(['agents.coder.model', 'agents.defaultModel', 'agents.ultra.model']);
    expect(modelSuggestions(['a/b', 'a/b', '  ', 'c/d'])).toEqual([
      { value: 'a/b', label: 'a/b' }, { value: 'c/d', label: 'c/d' }
    ]);
  });

  it('un percorso sconosciuto resta il percorso, con fallback dichiarato (nessuna etichetta inventata)', () => {
    const meta = settingMeta('futura.voce');
    expect(meta.label).toBe('futura.voce');
    expect(meta.section).toBe('other');
    expect(meta.help.length).toBeGreaterThan(10);
  });

  it('P-104/P-110: motore del parlato per edizione — tester voce VISIONE e Windows, sviluppo tutti; valore non ammesso dichiarato', () => {
    const values = (o: ReturnType<typeof optionsFor>): string[] => (o ?? []).map((x) => x.value);
    expect(values(optionsFor('voice.tts.provider', 'sviluppo', 'kokoro'))).toEqual(['visione', 'windows', 'kokoro', 'edge']);
    expect(values(optionsFor('voice.tts.provider', 'tester', 'windows'))).toEqual(['visione', 'windows']);
    const kept = optionsFor('voice.tts.provider', 'tester', 'kokoro') ?? [];
    expect(kept.map((x) => x.value)).toEqual(['visione', 'windows', 'kokoro']);
    expect(kept[2]?.label).toMatch(/non disponibile in questa versione: parla Windows/);
    expect(optionsFor('voice.tts.provider', 'tester', 'qualcosa')?.map((x) => x.value)).toEqual(['visione', 'windows']);
    // Lo specchio della UI coincide con la regola dei contratti usata da main e processo voce.
    expect(TTS_PROVIDERS_UI).toEqual(TTS_PROVIDERS);
    // Le altre voci con scelte esatte non dipendono dall'edizione.
    expect(optionsFor('logging.level', 'tester', 'info')?.length).toBeGreaterThan(1);
    expect(optionsFor('logging.level', 'tester', 'info')).toEqual(optionsFor('logging.level', 'sviluppo', 'info'));
  });
});
