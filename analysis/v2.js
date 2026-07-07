#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { collectAmapWeather } from '../collectors/amap_weather.js';
import { closeDb, getDb, initDb } from '../config/db.js';
import { shanghaiDate } from '../utils/time.js';
import { deriveDailyFeatures } from '../v2/daily-features.js';
import { finishRun, startRun } from '../v2/observation-store.js';

const USAGE = 'node analysis/v2.js [init|collect-amap-weather|derive START END|summary]';

async function summary() {
  const db = await getDb();
  const tables = await db.exec(`
    SELECT 'observations' AS table_name, COUNT(*)::int AS count FROM observations
    UNION ALL
    SELECT 'daily_features', COUNT(*)::int FROM daily_features
    UNION ALL
    SELECT 'data_sources', COUNT(*)::int FROM data_sources
  `);
  for (const [table, count] of tables[0]?.values || []) {
    console.log(`${table}: ${count}`);
  }
  const features = await db.exec(`
    SELECT
      date::text,
      sample_count,
      ROUND(avg_in_park::numeric, 1) AS avg_in_park,
      max_in_park,
      coverage_minutes,
      ROUND(quality_score::numeric, 3) AS quality_score
    FROM daily_features
    ORDER BY date DESC
    LIMIT 10
  `);
  if (features[0]?.values?.length) {
    console.log('\nRecent daily features:');
    console.log('date | samples | avg_in_park | max_in_park | coverage_minutes | quality_score');
    for (const row of features[0].values) console.log(row.join(' | '));
  }
}

export async function main() {
  const [cmd, startArg, endArg] = process.argv.slice(2);
  const db = await getDb();
  switch (cmd || 'summary') {
    case 'init':
      await initDb();
      console.log('v2 schema initialized');
      break;
    case 'collect-amap-weather': {
      const runId = await startRun(db, {
        sourceId: 'amap_weather',
        collector: 'amap_weather',
        rawContext: { city: '310101', district: 'Shanghai Huangpu' },
      });
      try {
        const count = await collectAmapWeather(db, { runId });
        await finishRun(db, runId, { status: 'ok', recordsInserted: count });
        console.log(`collected AMap weather observations: ${count}`);
      } catch (error) {
        await finishRun(db, runId, { status: 'error', errorMessage: error.message });
        throw error;
      }
      break;
    }
    case 'derive': {
      const startDate = startArg || '2025-10-03';
      const endDate = endArg || shanghaiDate(0);
      const results = await deriveDailyFeatures(db, { startDate, endDate });
      console.log(`derived daily_features: ${results.length}`);
      break;
    }
    case 'summary':
      await summary();
      break;
    default:
      console.log(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
