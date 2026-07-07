export async function startRun(db, { sourceId, collector, rawContext = null }) {
  const result = await db.run(
    `
      INSERT INTO collection_runs(source_id, collector, status, raw_context)
      VALUES ($1, $2, 'running', $3::jsonb)
      RETURNING run_id
    `,
    [sourceId, collector, rawContext ? JSON.stringify(rawContext) : null],
  );
  return result.rows[0].run_id;
}

export async function finishRun(db, runId, { status = 'ok', recordsInserted = 0, errorMessage = null } = {}) {
  await db.run(
    `
      UPDATE collection_runs
      SET status = $2, finished_at = NOW(), records_inserted = $3, error_message = $4
      WHERE run_id = $1
    `,
    [runId, status, recordsInserted, errorMessage],
  );
}

export async function upsertObservation(db, observation) {
  const result = await db.run(
    `
      INSERT INTO observations(
        observed_at, source_id, entity_id, metric, granularity,
        value_num, value_text, unit, quality, confidence, raw, run_id, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, NOW())
      ON CONFLICT (observed_at, source_id, entity_id, metric, granularity) DO UPDATE SET
        value_num = EXCLUDED.value_num,
        value_text = EXCLUDED.value_text,
        unit = EXCLUDED.unit,
        quality = EXCLUDED.quality,
        confidence = EXCLUDED.confidence,
        raw = EXCLUDED.raw,
        run_id = EXCLUDED.run_id,
        updated_at = NOW()
    `,
    [
      observation.observedAt,
      observation.sourceId,
      observation.entityId || 'tianzifang',
      observation.metric,
      observation.granularity,
      observation.valueNum ?? null,
      observation.valueText ?? null,
      observation.unit ?? null,
      observation.quality || 'measured',
      observation.confidence ?? 1,
      observation.raw ? JSON.stringify(observation.raw) : null,
      observation.runId ?? null,
    ],
  );
  return result.rowCount;
}
