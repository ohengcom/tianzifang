import { USER_AGENT } from '../config/settings.js';
import { toShanghaiIsoString } from '../utils/time.js';

export class BaseCollector {
  constructor() {
    this.name = 'base';
  }

  now() {
    return new Date();
  }

  nowISO() {
    return toShanghaiIsoString();
  }

  todayStr() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  }

  async fetchJSON(url, options = {}) {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...options.headers },
      signal: AbortSignal.timeout(20000),
      ...options,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
    }
    try {
      return await resp.json();
    } catch (error) {
      throw new Error(`Invalid JSON from ${url}: ${error.message}`);
    }
  }

  async fetchText(url, options = {}) {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...options.headers },
      signal: AbortSignal.timeout(20000),
      ...options,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
    }
    return resp.text();
  }

  async save(db, records) {
    const ts = this.nowISO();
    let count = 0;
    for (const [metric, value, unit, confidence, raw] of records) {
      const isNumericValue = value === null || typeof value === 'number';
      const numericValue = isNumericValue ? value : null;
      const textValue = isNumericValue ? null : String(value);
      const result = await db.run(
        `
        INSERT INTO crowd_data (ts, source, metric, value, text_value, unit, confidence, raw_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (ts, source, metric) DO UPDATE SET
          value = EXCLUDED.value,
          text_value = EXCLUDED.text_value,
          unit = EXCLUDED.unit,
          confidence = EXCLUDED.confidence,
          raw_json = EXCLUDED.raw_json,
          created_at = NOW()
        WHERE crowd_data.value IS DISTINCT FROM EXCLUDED.value
          OR crowd_data.text_value IS DISTINCT FROM EXCLUDED.text_value
          OR crowd_data.unit IS DISTINCT FROM EXCLUDED.unit
          OR crowd_data.confidence IS DISTINCT FROM EXCLUDED.confidence
          OR crowd_data.raw_json IS DISTINCT FROM EXCLUDED.raw_json
      `,
        [ts, this.name, metric, numericValue, textValue, unit, confidence, raw ? JSON.stringify(raw) : null],
      );
      count += result.rowCount;
    }
    return count;
  }
}
