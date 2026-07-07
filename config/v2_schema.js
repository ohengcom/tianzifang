export async function initV2Db(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS data_sources (
      source_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'api',
      display_name TEXT NOT NULL,
      reliability NUMERIC(4,3) NOT NULL DEFAULT 0.800,
      cadence TEXT,
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS collection_runs (
      run_id BIGSERIAL PRIMARY KEY,
      source_id TEXT REFERENCES data_sources(source_id),
      collector TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'partial')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      records_inserted INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      raw_context JSONB
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS observations (
      observation_id BIGSERIAL PRIMARY KEY,
      observed_at TIMESTAMPTZ NOT NULL,
      source_id TEXT NOT NULL REFERENCES data_sources(source_id),
      entity_id TEXT NOT NULL DEFAULT 'tianzifang',
      metric TEXT NOT NULL,
      granularity TEXT NOT NULL CHECK (granularity IN ('instant', 'hour', 'day')),
      value_num DOUBLE PRECISION,
      value_text TEXT,
      unit TEXT,
      quality TEXT NOT NULL DEFAULT 'measured',
      confidence NUMERIC(4,3) NOT NULL DEFAULT 1.000,
      raw JSONB,
      run_id BIGINT REFERENCES collection_runs(run_id),
      legacy_crowd_data_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT observations_value_present CHECK (value_num IS NOT NULL OR value_text IS NOT NULL OR raw IS NOT NULL)
    )
  `);

  await db.run(`ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_granularity_check`);
  await db.run(`
    ALTER TABLE observations
      ADD CONSTRAINT observations_granularity_check
      CHECK (granularity IN ('instant', 'hour', 'day', 'period'))
  `);

  await db.run(`ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_legacy_crowd_data_id_key`);
  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS observations_identity_key
    ON observations(observed_at, source_id, entity_id, metric, granularity)
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_observations_metric_time ON observations(metric, observed_at)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_observations_source_time ON observations(source_id, observed_at)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_observations_entity_time ON observations(entity_id, observed_at)`);
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_observations_legacy_crowd_data_id ON observations(legacy_crowd_data_id)`,
  );

  await db.run(`
    CREATE TABLE IF NOT EXISTS daily_features (
      date DATE PRIMARY KEY,
      entity_id TEXT NOT NULL DEFAULT 'tianzifang',
      sample_count INTEGER NOT NULL DEFAULT 0,
      measured_count INTEGER NOT NULL DEFAULT 0,
      first_sample_at TIMESTAMPTZ,
      last_sample_at TIMESTAMPTZ,
      min_in_park DOUBLE PRECISION,
      avg_in_park DOUBLE PRECISION,
      p50_in_park DOUBLE PRECISION,
      p95_in_park DOUBLE PRECISION,
      max_in_park DOUBLE PRECISION,
      peak_hour INTEGER,
      coverage_minutes INTEGER NOT NULL DEFAULT 0,
      occupancy_person_hours DOUBLE PRECISION,
      estimated_visits_low DOUBLE PRECISION,
      estimated_visits_mid DOUBLE PRECISION,
      estimated_visits_high DOUBLE PRECISION,
      reported_visitors DOUBLE PRECISION,
      reported_visitors_source TEXT,
      reported_visitors_confidence NUMERIC(4,3),
      activity_event_count INTEGER NOT NULL DEFAULT 0,
      context_signal_count INTEGER NOT NULL DEFAULT 0,
      strongest_context_confidence NUMERIC(4,3),
      weather_temp_max DOUBLE PRECISION,
      weather_temp_min DOUBLE PRECISION,
      weather_precipitation_mm DOUBLE PRECISION,
      weather_code INTEGER,
      is_holiday INTEGER,
      is_workday INTEGER,
      weekday INTEGER,
      quality_score NUMERIC(4,3) NOT NULL DEFAULT 0.000,
      notes TEXT,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.run(`ALTER TABLE daily_features ADD COLUMN IF NOT EXISTS reported_visitors DOUBLE PRECISION`);
  await db.run(`ALTER TABLE daily_features ADD COLUMN IF NOT EXISTS reported_visitors_source TEXT`);
  await db.run(`ALTER TABLE daily_features ADD COLUMN IF NOT EXISTS reported_visitors_confidence NUMERIC(4,3)`);
  await db.run(`ALTER TABLE daily_features ADD COLUMN IF NOT EXISTS activity_event_count INTEGER NOT NULL DEFAULT 0`);
  await db.run(`ALTER TABLE daily_features ADD COLUMN IF NOT EXISTS context_signal_count INTEGER NOT NULL DEFAULT 0`);
  await db.run(`ALTER TABLE daily_features ADD COLUMN IF NOT EXISTS strongest_context_confidence NUMERIC(4,3)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_daily_features_weekday_holiday ON daily_features(weekday, is_holiday)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_daily_features_quality ON daily_features(quality_score)`);

  await seedV2Sources(db);
  await installLegacySyncTrigger(db);
  await backfillLegacyObservations(db);

  await db.run(
    `
      INSERT INTO schema_migrations(version, notes)
      VALUES ($1, $2)
      ON CONFLICT (version) DO UPDATE SET notes = EXCLUDED.notes, applied_at = NOW()
    `,
    [
      '2026-07-07-v2-observation-model',
      'Standardized sources, collection runs, observations, daily features, and legacy sync trigger',
    ],
  );

  await db.run(
    `
      INSERT INTO schema_migrations(version, notes)
      VALUES ($1, $2)
      ON CONFLICT (version) DO UPDATE SET notes = EXCLUDED.notes, applied_at = NOW()
    `,
    [
      '2026-07-07-v2-context-anchor-features',
      'Added period/activity/context anchor support and daily context feature columns',
    ],
  );
}

async function seedV2Sources(db) {
  const sources = [
    [
      'gov_tour',
      'api',
      'Shanghai A-level scenic realtime API',
      0.95,
      '5m during open hours',
      'Official in-park count signal',
    ],
    [
      'weather',
      'api',
      'wttr.in current weather',
      0.65,
      '5m legacy / optional',
      'Convenient current weather; prefer AMap for China district current and forecast weather',
    ],
    [
      'holiday',
      'calendar',
      'China holiday table',
      0.85,
      'daily',
      'Configured statutory holiday and adjusted workday table',
    ],
    [
      'amap',
      'api',
      'Amap POI and traffic signals',
      0.65,
      'optional',
      'Optional local context signals when API key is available',
    ],
    [
      'amap_weather',
      'api',
      'AMap district weather API',
      0.75,
      'manual / scheduled',
      'Huangpu District current and forecast weather for Tianzifang context; no historical hourly backfill',
    ],
    ['manual', 'manual', 'Manual historical observations', 0.5, 'ad hoc', 'Legacy manually-entered historical values'],
    [
      'reported_crowd',
      'report',
      'Reported historical crowd anchors',
      0.7,
      'ad hoc',
      'Government or media reported visitor counts with explicit provenance; not continuous telemetry',
    ],
    [
      'reported_activity',
      'report',
      'Reported activity and context anchors',
      0.65,
      'ad hoc',
      'Events, promotions, policy shifts, and other context that can explain visitor changes',
    ],
  ];

  for (const source of sources) {
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
          updated_at = NOW()
      `,
      source,
    );
  }

  await db.run(`
    UPDATE data_sources
    SET active = FALSE,
        notes = 'Deprecated by project policy; do not use for new Tianzifang weather collection',
        updated_at = NOW()
    WHERE source_id = 'open_meteo_archive'
  `);

  await db.run(`
    INSERT INTO data_sources(source_id, source_type, display_name, reliability, cadence, notes)
    SELECT DISTINCT source, 'legacy', source, 0.500, NULL, 'Auto-discovered legacy crowd_data source'
    FROM crowd_data
    WHERE source NOT IN (SELECT source_id FROM data_sources)
    ON CONFLICT (source_id) DO NOTHING
  `);
}

async function installLegacySyncTrigger(db) {
  await db.run(`
    CREATE OR REPLACE FUNCTION safe_jsonb(raw_text TEXT)
    RETURNS JSONB AS $$
    BEGIN
      IF raw_text IS NULL OR raw_text = '' THEN
        RETURN NULL;
      END IF;

      BEGIN
        RETURN raw_text::jsonb;
      EXCEPTION WHEN others THEN
        RETURN jsonb_build_object('raw_text', raw_text);
      END;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);

  await db.run(`
    CREATE OR REPLACE FUNCTION observation_granularity(source_value TEXT, metric_value TEXT)
    RETURNS TEXT AS $$
    BEGIN
      IF source_value = 'holiday' THEN
        RETURN 'day';
      END IF;
      IF source_value = 'weather' AND metric_value IN ('temperature_max', 'temperature_min', 'weather_desc') THEN
        RETURN 'day';
      END IF;
      IF metric_value IN ('daily_total_visitors', 'reported_daily_visitors') THEN
        RETURN 'day';
      END IF;
      IF metric_value IN ('period_total_visitors', 'reported_peak_daily_visitors', 'activity_event', 'context_signal') THEN
        RETURN 'period';
      END IF;
      IF metric_value IN ('reported_instant_visitors', 'reported_partial_day_visitors') THEN
        RETURN 'instant';
      END IF;
      RETURN 'instant';
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);

  await db.run(`
    CREATE OR REPLACE FUNCTION observation_confidence(confidence_value TEXT)
    RETURNS NUMERIC AS $$
    BEGIN
      CASE COALESCE(confidence_value, 'measured')
        WHEN 'measured' THEN RETURN 1.000;
        WHEN 'stale' THEN RETURN 0.550;
        WHEN 'estimated' THEN RETURN 0.350;
        WHEN 'unavailable' THEN RETURN 0.100;
        ELSE RETURN 0.500;
      END CASE;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);

  await db.run(`
    CREATE OR REPLACE FUNCTION sync_crowd_data_to_observations()
    RETURNS TRIGGER AS $$
    DECLARE
      observed_ts TIMESTAMPTZ;
      granularity_value TEXT;
    BEGIN
      INSERT INTO data_sources(source_id, source_type, display_name, reliability, notes)
      VALUES (NEW.source, 'legacy', NEW.source, 0.500, 'Auto-created from crowd_data trigger')
      ON CONFLICT (source_id) DO NOTHING;

      granularity_value := observation_granularity(NEW.source, NEW.metric);
      observed_ts := NEW.ts;
      IF granularity_value = 'day' THEN
        observed_ts := date_trunc('day', NEW.ts AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
      END IF;

      INSERT INTO observations(
        observed_at, source_id, entity_id, metric, granularity,
        value_num, value_text, unit, quality, confidence, raw, legacy_crowd_data_id, updated_at
      )
      VALUES (
        observed_ts, NEW.source, 'tianzifang', NEW.metric, granularity_value,
        NEW.value, COALESCE(NEW.text_value, CASE WHEN NEW.metric = 'weather_desc' THEN NEW.unit ELSE NULL END),
        CASE WHEN NEW.metric = 'weather_desc' THEN NULL ELSE NEW.unit END,
        COALESCE(NEW.confidence, 'measured'), observation_confidence(NEW.confidence), safe_jsonb(NEW.raw_json), NEW.id, NOW()
      )
      ON CONFLICT (observed_at, source_id, entity_id, metric, granularity) DO UPDATE SET
        value_num = EXCLUDED.value_num,
        value_text = EXCLUDED.value_text,
        unit = EXCLUDED.unit,
        quality = EXCLUDED.quality,
        confidence = EXCLUDED.confidence,
        raw = EXCLUDED.raw,
        legacy_crowd_data_id = COALESCE(observations.legacy_crowd_data_id, EXCLUDED.legacy_crowd_data_id),
        updated_at = NOW();

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await db.run(`DROP TRIGGER IF EXISTS trg_sync_crowd_data_to_observations ON crowd_data`);
  await db.run(`
    CREATE TRIGGER trg_sync_crowd_data_to_observations
    AFTER INSERT OR UPDATE ON crowd_data
    FOR EACH ROW EXECUTE FUNCTION sync_crowd_data_to_observations()
  `);
}

async function backfillLegacyObservations(db) {
  await db.run(`
    INSERT INTO data_sources(source_id, source_type, display_name, reliability, notes)
    SELECT DISTINCT source, 'legacy', source, 0.500, 'Auto-created during v2 backfill'
    FROM crowd_data
    ON CONFLICT (source_id) DO NOTHING
  `);

  await db.run(`
    WITH normalized AS (
      SELECT
        CASE
          WHEN observation_granularity(source, metric) = 'day'
            THEN date_trunc('day', ts AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
          ELSE ts
        END AS observed_at,
        source AS source_id,
        'tianzifang' AS entity_id,
        metric,
        observation_granularity(source, metric) AS granularity,
        value AS value_num,
        COALESCE(text_value, CASE WHEN metric = 'weather_desc' THEN unit ELSE NULL END) AS value_text,
        CASE WHEN metric = 'weather_desc' THEN NULL ELSE unit END AS unit,
        COALESCE(confidence, 'measured') AS quality,
        observation_confidence(confidence) AS confidence,
        safe_jsonb(raw_json) AS raw,
        id AS legacy_crowd_data_id,
        ts
      FROM crowd_data
    ), deduped AS (
      SELECT DISTINCT ON (observed_at, source_id, entity_id, metric, granularity)
        observed_at,
        source_id,
        entity_id,
        metric,
        granularity,
        value_num,
        value_text,
        unit,
        quality,
        confidence,
        raw,
        legacy_crowd_data_id
      FROM normalized
      ORDER BY observed_at, source_id, entity_id, metric, granularity, ts DESC, legacy_crowd_data_id DESC
    )
    INSERT INTO observations(
      observed_at, source_id, entity_id, metric, granularity,
      value_num, value_text, unit, quality, confidence, raw, legacy_crowd_data_id, updated_at
    )
    SELECT
      observed_at,
      source_id,
      entity_id,
      metric,
      granularity,
      value_num,
      value_text,
      unit,
      quality,
      confidence,
      raw,
      legacy_crowd_data_id,
      NOW() AS updated_at
    FROM deduped
    ON CONFLICT (observed_at, source_id, entity_id, metric, granularity) DO UPDATE SET
      value_num = EXCLUDED.value_num,
      value_text = EXCLUDED.value_text,
      unit = EXCLUDED.unit,
      quality = EXCLUDED.quality,
      confidence = EXCLUDED.confidence,
      raw = EXCLUDED.raw,
      legacy_crowd_data_id = COALESCE(observations.legacy_crowd_data_id, EXCLUDED.legacy_crowd_data_id),
      updated_at = NOW()
  `);
}
