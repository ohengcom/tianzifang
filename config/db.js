import pg from 'pg';

const { Pool } = pg;

import { NEON_URL } from './settings.js';
import { initV2Db } from './v2_schema.js';

let _db = null;

// Small query wrapper on top of pg Pool.
// 使用 Pool 而非单 Client：连接自动复用与重连，适合常驻的 --schedule 进程。
class PgWrapper {
  constructor(pool) {
    this._pool = pool;
  }

  // db.exec(sql) → [{ columns, values }]
  async exec(sql, params = []) {
    const result = await this._pool.query(sql, params);
    if (!result.rows.length) return [];
    const columns = result.fields.map((f) => f.name);
    const values = result.rows.map((row) => columns.map((c) => row[c]));
    return [{ columns, values }];
  }

  // db.run(sql, params) → execute with params
  async run(sql, params = []) {
    return this._pool.query(sql, params);
  }

  // db.prepare(sql) → returns stmt with .run() and .free()
  prepare(sql) {
    const pool = this._pool;
    return {
      async run(params = []) {
        await pool.query(sql, params);
      },
      free() {
        /* no-op for pg */
      },
    };
  }

  async close() {
    await this._pool.end();
  }
}

export async function getDb() {
  if (_db) return _db;
  if (!NEON_URL) {
    throw new Error('NEON_URL environment variable is required');
  }
  const pool = new Pool({
    connectionString: NEON_URL,
    // Neon 要求 SSL；'require' 会启用 TLS 并校验证书，
    // 避免 rejectUnauthorized:false 带来的中间人风险。
    ssl: 'require',
    // 闲置连接超时回收，避免 Neon serverless 端 idle 断连。
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
  });
  // 连接失败时让上层看到清晰错误，而不是静默留给下一次 query。
  pool.on('error', (err) => {
    console.error('[db] pool error:', err.message);
  });
  _db = new PgWrapper(pool);
  return _db;
}

export async function initDb() {
  const db = await getDb();

  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      notes TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // crowd_data.ts 使用 TIMESTAMPTZ，支持真正的时间范围索引和时区转换。
  // 如果表已存在但 ts 还是 TEXT，执行一次迁移（ALTER + 重建索引）。
  await db.run(`
    CREATE TABLE IF NOT EXISTS crowd_data (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      metric TEXT NOT NULL,
      value DOUBLE PRECISION,
      text_value TEXT,
      unit TEXT,
      confidence TEXT DEFAULT 'measured',
      raw_json TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.run(`ALTER TABLE crowd_data ADD COLUMN IF NOT EXISTS text_value TEXT`);
  await db.run(`
    UPDATE crowd_data
    SET text_value = unit, unit = ''
    WHERE source = 'weather'
      AND metric = 'weather_desc'
      AND text_value IS NULL
      AND value IS NULL
      AND unit IS NOT NULL
  `);

  // 迁移：若 ts 列仍为 TEXT，原地转换为 TIMESTAMPTZ。
  await db.run(`
    DO $$
    BEGIN
      IF (SELECT data_type FROM information_schema.columns
          WHERE table_name = 'crowd_data' AND column_name = 'ts') = 'text' THEN
        ALTER TABLE crowd_data
          ALTER COLUMN ts TYPE TIMESTAMPTZ
          USING ts::timestamptz;
      END IF;
    END$$
  `);

  await db.run(`
    DELETE FROM crowd_data a
    USING crowd_data b
    WHERE a.ts = b.ts
      AND a.source = b.source
      AND a.metric = b.metric
      AND a.id < b.id
  `);

  await db.run(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'crowd_data_ts_source_metric_key'
      ) THEN
        ALTER TABLE crowd_data
          ADD CONSTRAINT crowd_data_ts_source_metric_key
          UNIQUE (ts, source, metric);
      END IF;
    END$$
  `);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_crowd_ts ON crowd_data(ts)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_crowd_source ON crowd_data(source)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_crowd_metric ON crowd_data(metric)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_crowd_source_metric_ts ON crowd_data(source, metric, ts)`);

  await db.run(`
    CREATE TABLE IF NOT EXISTS daily_summary (
      date TEXT PRIMARY KEY,
      weekday INTEGER,
      is_holiday INTEGER DEFAULT 0,
      holiday_name TEXT,
      weather_desc TEXT,
      temperature_high DOUBLE PRECISION,
      temperature_low DOUBLE PRECISION,
      max_crowd INTEGER,
      avg_crowd DOUBLE PRECISION,
      peak_hour INTEGER,
      total_visitors INTEGER,
      notes TEXT
    )
  `);
  await db.run(`ALTER TABLE daily_summary ADD COLUMN IF NOT EXISTS holiday_name TEXT`);
  await db.run(`ALTER TABLE daily_summary ADD COLUMN IF NOT EXISTS weather_desc TEXT`);
  await db.run(`ALTER TABLE daily_summary ADD COLUMN IF NOT EXISTS temperature_high DOUBLE PRECISION`);
  await db.run(`ALTER TABLE daily_summary ADD COLUMN IF NOT EXISTS temperature_low DOUBLE PRECISION`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_daily_summary_weekday_holiday ON daily_summary(weekday, is_holiday)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_daily_summary_weather_desc ON daily_summary(weather_desc)`);

  await db.run(
    `
      INSERT INTO schema_migrations(version, notes)
      VALUES ($1, $2)
      ON CONFLICT (version) DO UPDATE SET
        notes = EXCLUDED.notes,
        applied_at = NOW()
    `,
    ['2026-07-07-neon-core-schema', 'Neon PostgreSQL schema, idempotent columns, upsert keys, and query indexes'],
  );

  await initV2Db(db);
  return db;
}

export async function closeDb() {
  if (!_db) return;
  await _db.close();
  _db = null;
}
