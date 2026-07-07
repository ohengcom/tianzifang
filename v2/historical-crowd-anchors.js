import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { upsertObservations } from './observation-store.js';

const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;

const sourceSchema = z
  .object({
    sourceId: z.string().min(1).default('reported_crowd'),
    sourceType: z.string().min(1).default('report'),
    displayName: z.string().min(1).default('Reported historical crowd anchors'),
    reliability: z.number().min(0).max(1).default(0.7),
    cadence: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .default({});

export const historicalCrowdAnchorSchema = z
  .object({
    id: z.string().min(1),
    observedAt: z.string().min(10),
    metric: z.enum([
      'daily_total_visitors',
      'reported_daily_visitors',
      'reported_peak_daily_visitors',
      'period_total_visitors',
      'reported_instant_visitors',
      'reported_partial_day_visitors',
      'activity_event',
      'context_signal',
    ]),
    granularity: z.enum(['instant', 'day', 'period']),
    valueNum: z.number().positive().optional(),
    valueText: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    quality: z.string().min(1).default('reported'),
    confidence: z.number().min(0).max(1).default(0.7),
    comparator: z.enum(['eq', 'gte', 'lte', 'approx']).default('eq'),
    source: sourceSchema,
    period: z
      .object({
        start: z.string().nullable().optional(),
        end: z.string().nullable().optional(),
        precision: z.string().min(1).default('reported'),
      })
      .optional(),
    provenance: z.object({
      title: z.string().min(1),
      url: z.string().url(),
      publisher: z.string().min(1),
      publishedAt: z.string().min(10),
      quote: z.string().min(1),
      retrievedAt: z.string().min(10),
      verification: z.string().min(1),
    }),
    notes: z.string().nullable().optional(),
  })
  .refine((anchor) => anchor.valueNum != null || anchor.valueText || anchor.provenance, {
    message: 'Anchor must include valueNum, valueText, or provenance',
  });

const anchorListSchema = z.array(historicalCrowdAnchorSchema);

function normalizeObservedAt(value) {
  return dateOnlyRe.test(value) ? `${value}T00:00:00+08:00` : value;
}

export function parseHistoricalCrowdAnchors(value) {
  return anchorListSchema.parse(value);
}

export function toHistoricalCrowdObservation(anchor, { runId = null } = {}) {
  return {
    observedAt: normalizeObservedAt(anchor.observedAt),
    sourceId: anchor.source.sourceId,
    entityId: 'tianzifang',
    metric: anchor.metric,
    granularity: anchor.granularity,
    valueNum: anchor.valueNum ?? null,
    valueText: anchor.valueText ?? null,
    unit: anchor.unit ?? null,
    quality: anchor.quality,
    confidence: anchor.confidence,
    runId,
    raw: {
      anchor_id: anchor.id,
      comparator: anchor.comparator,
      period: anchor.period || null,
      provenance: anchor.provenance,
      notes: anchor.notes || null,
    },
  };
}

async function ensureSource(db, source) {
  await db.run(
    `
      INSERT INTO data_sources(source_id, source_type, display_name, reliability, cadence, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (source_id) DO UPDATE SET
        source_type = EXCLUDED.source_type,
        display_name = EXCLUDED.display_name,
        reliability = EXCLUDED.reliability,
        cadence = EXCLUDED.cadence,
        notes = EXCLUDED.notes,
        active = TRUE,
        updated_at = NOW()
    `,
    [
      source.sourceId,
      source.sourceType,
      source.displayName,
      source.reliability,
      source.cadence || 'ad hoc',
      source.notes || 'Reported historical Tianzifang crowd anchor',
    ],
  );
}

export async function importHistoricalCrowdAnchors(db, anchors, { runId = null } = {}) {
  const parsed = parseHistoricalCrowdAnchors(anchors);
  if (!parsed.length) return 0;
  const sources = new Map(parsed.map((anchor) => [anchor.source.sourceId, anchor.source]));
  for (const source of sources.values()) await ensureSource(db, source);
  const observations = parsed.map((anchor) => toHistoricalCrowdObservation(anchor, { runId }));
  return upsertObservations(db, observations);
}

export async function readHistoricalCrowdAnchors(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return parseHistoricalCrowdAnchors(JSON.parse(raw));
}
