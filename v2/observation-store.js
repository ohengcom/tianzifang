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
  const count = await upsertObservations(db, [observation]);
  return count;
}

export async function upsertObservations(db, observations, { chunkSize = 500 } = {}) {
  let total = 0;
  for (let offset = 0; offset < observations.length; offset += chunkSize) {
    const chunk = observations.slice(offset, offset + chunkSize);
    if (!chunk.length) continue;
    const params = [];
    const values = chunk
      .map((observation, index) => {
        const base = index * 12;
        params.push(
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
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}::jsonb, $${base + 12}, NOW())`;
      })
      .join(',\n');

    const result = await db.run(
      `
        INSERT INTO observations(
          observed_at, source_id, entity_id, metric, granularity,
          value_num, value_text, unit, quality, confidence, raw, run_id, updated_at
        )
        VALUES ${values}
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
      params,
    );
    total += result.rowCount;
  }
  return total;
}

export async function upsertObservationSlow(db, observation) {
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
