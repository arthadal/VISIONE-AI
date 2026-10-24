// Telemetria di sistema (Fase 14): un campione è un fatto misurato, mai stimato. Ogni campo non
// disponibile su questa macchina/piattaforma è `null`; la UI lo rende `N/D`. Non esistono valori di
// riempimento: se il dato manca, manca. Categorie: VISIONE_EVENT_MODEL §4, DECISIONI P-59.
import { z } from 'zod';

const percent = z.number().min(0).max(100).nullable();
const bytes = z.number().int().nonnegative().nullable();
const rate = z.number().nonnegative().nullable();

/** Campione di telemetria di sistema (a bassa frequenza; evento effimero `telemetry.sample`). */
export const telemetrySampleSchema = z.strictObject({
  /** Carico CPU complessivo, dal delta dei tempi dei core (`os.cpus`). */
  cpuPercent: percent,
  ramUsedBytes: bytes,
  ramTotalBytes: bytes,
  /** Utilizzo GPU 3D, dalle classi WMI di performance (solo Windows). */
  gpuPercent: percent,
  /** GPU in uso: dedicata se disponibile, altrimenti condivisa (integrata). */
  vramUsedBytes: bytes,
  /** Temperatura CPU reale dal provider di sensori esterno (LibreHardwareMonitor, loopback); altrimenti null. */
  cpuTemperatureC: z.number().min(-50).max(200).nullable(),
  /** Temperatura GPU reale dallo stesso provider, quando l'hardware la espone; altrimenti null. */
  gpuTemperatureC: z.number().min(-50).max(200).nullable(),
  netRxBytesPerSec: rate,
  netTxBytesPerSec: rate,
  /** Capacità del collegamento di rete, in bit/s. */
  netLinkBps: rate,
  /** Numero di core logici (contesto per la CPU). */
  cpuCount: z.number().int().positive().nullable(),
  /** Uptime del sistema in secondi. */
  uptimeSec: z.number().nonnegative().nullable()
});
export type TelemetrySample = z.infer<typeof telemetrySampleSchema>;

/** Riga di aggregato al minuto (tabella `telemetry_minutes`, VISIONE_DATA_MODEL §1). */
export const telemetryAggregateRowSchema = z.strictObject({
  metric: z.string().min(1).max(40),
  subject: z.string().max(40),
  min: z.number().nullable(),
  max: z.number().nullable(),
  avg: z.number().nullable(),
  samples: z.number().int().nonnegative(),
  unknownSamples: z.number().int().nonnegative()
});
export type TelemetryAggregateRow = z.infer<typeof telemetryAggregateRowSchema>;

/** Aggregato di un minuto di campioni (evento durevole `telemetry.aggregate`). */
export const telemetryAggregateSchema = z.strictObject({
  minute: z.number().int().nonnegative(),
  rows: z.array(telemetryAggregateRowSchema).max(64)
});
export type TelemetryAggregate = z.infer<typeof telemetryAggregateSchema>;
