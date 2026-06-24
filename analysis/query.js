#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getDb } from '../config/db.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const USAGE = 'node analysis/query.js [today|date YYYY-MM-DD|summary|forecast]';

export function validateDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) {
    throw new Error(`Invalid date format, expected YYYY-MM-DD: ${dateStr || ''}`);
  }
  return dateStr;
}

export async function showToday() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  await showDate(today);
}

export async function showDate(dateStr) {
  const date = validateDate(dateStr);
  const db = await getDb();
  console.log(`\nCrowd data for ${date}`);
  console.log('-'.repeat(50));

  const rows = await db.exec(
    `
      SELECT ts, value, confidence FROM crowd_data
      WHERE source = $1 AND metric = $2
        AND ts >= $3::timestamptz AND ts < ($3::timestamptz + interval '1 day')
      ORDER BY ts
    `,
    ['gov_tour', 'in_park_count', `${date}T00:00:00+08:00`],
  );

  if (rows.length > 0 && rows[0].values.length > 0) {
    console.log(`\nIn-park count (${rows[0].values.length} rows):`);
    for (const [ts, value, confidence] of rows[0].values) {
      const time = new Date(ts).toLocaleTimeString('sv-SE', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
      });
      const marker = confidence === 'measured' ? 'measured' : 'derived';
      console.log(`  ${time}  ${marker.padEnd(8)} ${String(Math.round(value)).padStart(6)} people`);
    }
  } else {
    console.log('\nIn-park count: no data');
  }

  const weather = await db.exec(
    `
      SELECT metric, value, unit FROM crowd_data
      WHERE source = $1
        AND ts >= $2::timestamptz AND ts < ($2::timestamptz + interval '1 day')
      ORDER BY ts, metric
    `,
    ['weather', `${date}T00:00:00+08:00`],
  );
  if (weather.length > 0 && weather[0].values.length > 0) {
    console.log('\nWeather:');
    for (const [metric, value, unit] of weather[0].values) {
      if (metric === 'weather_desc') console.log(`  ${unit}`);
      else console.log(`  ${metric}: ${value}${unit}`);
    }
  }

  const summary = await db.exec('SELECT * FROM daily_summary WHERE date = $1', [date]);
  if (summary.length > 0 && summary[0].values.length > 0) {
    const columns = summary[0].columns;
    const row = Object.fromEntries(columns.map((column, index) => [column, summary[0].values[0][index]]));
    console.log('\nDaily summary:');
    console.log(`  Max crowd: ${row.max_crowd} people`);
    console.log(`  Avg crowd: ${row.avg_crowd} people`);
    console.log(`  Peak hour: ${row.peak_hour}:00`);
  }
}

export async function showSummary() {
  const db = await getDb();
  console.log('\nData summary');
  console.log('-'.repeat(40));

  const total = await db.exec('SELECT COUNT(*) AS count FROM crowd_data');
  const days = await db.exec('SELECT COUNT(*) AS count FROM daily_summary');
  const range = await db.exec('SELECT MIN(date) AS first_date, MAX(date) AS last_date FROM daily_summary');

  console.log(`  Total records: ${total[0]?.values[0]?.[0] || 0}`);
  console.log(`  Daily summaries: ${days[0]?.values[0]?.[0] || 0}`);
  if (range.length > 0 && range[0].values[0][0]) {
    console.log(`  Date range: ${range[0].values[0][0]} ~ ${range[0].values[0][1]}`);
  }
}

export async function forecast() {
  const db = await getDb();
  const now = new Date();

  console.log('\n7-day crowd forecast');
  console.log('-'.repeat(60));

  for (let i = 0; i < 7; i++) {
    const future = new Date(now);
    future.setDate(future.getDate() + i);
    const dateStr = future.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const wd = future.getDay() === 0 ? 6 : future.getDay() - 1;
    const dayName = DAY_NAMES[wd];

    const hist = await db.exec(
      `
        SELECT AVG(avg_crowd) AS avg_crowd, AVG(max_crowd) AS max_crowd, COUNT(*) AS sample_count
        FROM daily_summary
        WHERE weekday = $1 AND is_holiday = $2
      `,
      [wd, 0],
    );

    let estAvg;
    let estMax;
    let confidence;
    const sampleCount = Number(hist[0]?.values[0]?.[2] || 0);
    if (sampleCount > 0) {
      estAvg = Math.round(hist[0].values[0][0]);
      estMax = Math.round(hist[0].values[0][1]);
      confidence = `based on ${sampleCount} historical days`;
    } else {
      const base = wd < 5 ? 26000 : 35000;
      estAvg = Math.round(base * 0.2);
      estMax = Math.round(base * 0.35);
      confidence = 'default estimate';
    }

    const marker = i === 0 ? '*' : ' ';
    console.log(
      `${marker} ${dateStr} ${dayName}  avg:${String(estAvg).padStart(5)}  max:${String(estMax).padStart(5)}  (${confidence})`,
    );
  }
}

export async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'summary';

  switch (cmd) {
    case 'today':
      await showToday();
      break;
    case 'date':
      await showDate(args[1]);
      break;
    case 'summary':
      await showSummary();
      break;
    case 'forecast':
      await forecast();
      break;
    default:
      console.log(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
