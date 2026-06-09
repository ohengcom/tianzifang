import { USER_AGENT } from '../config/settings.js';

export class BaseCollector {
  constructor() {
    this.name = 'base';
  }

  now() {
    return new Date();
  }

  nowISO() {
    return `${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T')}+08:00`;
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
    return resp.json();
  }

  async fetchText(url) {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    return resp.text();
  }

  async save(db, records) {
    const ts = this.nowISO();
    let count = 0;
    for (const [metric, value, unit, confidence, raw] of records) {
      await db.run(
        'INSERT INTO crowd_data (ts, source, metric, value, unit, confidence, raw_json) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [ts, this.name, metric, value, unit, confidence, raw ? JSON.stringify(raw) : null],
      );
      count++;
    }
    return count;
  }
}
