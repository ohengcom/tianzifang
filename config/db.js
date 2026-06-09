import pg from 'pg';

const { Client } = pg;

import { NEON_URL } from './settings.js';

let _client = null;

// Small query wrapper on top of pg.
class PgWrapper {
  constructor(client) {
    this._client = client;
  }

  // db.exec(sql) → [{ columns, values }]
  async exec(sql, params = []) {
    const result = await this._client.query(sql, params);
    if (!result.rows.length) return [];
    const columns = result.fields.map((f) => f.name);
    const values = result.rows.map((row) => columns.map((c) => row[c]));
    return [{ columns, values }];
  }

  // db.run(sql, params) → execute with params
  async run(sql, params = []) {
    await this._client.query(sql, params);
  }

  // db.prepare(sql) → returns stmt with .run() and .free()
  prepare(sql) {
    const client = this._client;
    return {
      async run(params = []) {
        await client.query(sql, params);
      },
      free() {
        /* no-op for pg */
      },
    };
  }
}

export async function getDb() {
  if (_client) return _client;
  const client = new Client({
    connectionString: NEON_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  _client = new PgWrapper(client);
  return _client;
}

export function saveDb(_db) {
  // PostgreSQL auto-commits, nothing to do
}

export async function initDb() {
  const db = await getDb();
  await db.run(`
    CREATE TABLE IF NOT EXISTS crowd_data (
      id SERIAL PRIMARY KEY,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      metric TEXT NOT NULL,
      value DOUBLE PRECISION,
      unit TEXT,
      confidence TEXT DEFAULT 'measured',
      raw_json TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_crowd_ts ON crowd_data(ts)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_crowd_source ON crowd_data(source)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_crowd_metric ON crowd_data(metric)`);
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
  return db;
}
