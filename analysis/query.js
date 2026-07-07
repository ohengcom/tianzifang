#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getHolidayInfoForDate } from '../collectors/holiday.js';
import { getDb } from '../config/db.js';
import { shanghaiDate, weekdayFromShanghaiDate } from '../utils/time.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const USAGE = 'node analysis/query.js [today|date YYYY-MM-DD|summary|forecast]';
const DEFAULT_FORECAST = {
  weekday: { avg: 5200, max: 9100 },
  weekend: { avg: 7000, max: 12250 },
  holiday: { avg: 8200, max: 14500 },
};

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
      SELECT metric, value, text_value, unit FROM crowd_data
      WHERE source = $1
        AND ts >= $2::timestamptz AND ts < ($2::timestamptz + interval '1 day')
      ORDER BY ts, metric
    `,
    ['weather', `${date}T00:00:00+08:00`],
  );
  if (weather.length > 0 && weather[0].values.length > 0) {
    console.log('\nWeather:');
    for (const [metric, value, textValue, unit] of weather[0].values) {
      if (metric === 'weather_desc') console.log(`  ${textValue || unit || ''}`);
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

export function weatherBucket(description = '') {
  const text = String(description || '').toLowerCase();
  if (!text) return null;
  if (/雨|rain|shower|drizzle|雷|storm/.test(text)) return 'rain';
  if (/雪|snow|sleet/.test(text)) return 'snow';
  if (/雾|霾|fog|mist|haze/.test(text)) return 'poor_visibility';
  if (/晴|sunny|clear/.test(text)) return 'clear';
  if (/云|阴|cloud|overcast/.test(text)) return 'cloudy';
  return 'other';
}

export function estimateFromHistory(rows, fallbackKey) {
  const sampleCount = Number(rows?.[0]?.[2] || 0);
  if (sampleCount > 0) {
    return {
      avg: Math.round(Number(rows[0][0])),
      max: Math.round(Number(rows[0][1])),
      sampleCount,
    };
  }
  return { ...DEFAULT_FORECAST[fallbackKey], sampleCount: 0 };
}

async function loadWeatherForecast() {
  try {
    const resp = await fetch('https://wttr.in/Shanghai?format=j1', {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await resp.json();
    const byDate = new Map();
    for (const day of data.weather || []) {
      const desc = day.hourly?.[4]?.lang_zh?.[0]?.value || day.hourly?.[4]?.weatherDesc?.[0]?.value || '';
      byDate.set(day.date, {
        description: desc,
        bucket: weatherBucket(desc),
        maxTemp: day.maxtempC != null ? Number(day.maxtempC) : null,
        minTemp: day.mintempC != null ? Number(day.mintempC) : null,
      });
    }
    return byDate;
  } catch {
    return new Map();
  }
}

function weatherBucketSql() {
  return `
    CASE
      WHEN weather_desc ILIKE '%雨%' OR weather_desc ILIKE '%rain%' OR weather_desc ILIKE '%shower%' THEN 'rain'
      WHEN weather_desc ILIKE '%雪%' OR weather_desc ILIKE '%snow%' THEN 'snow'
      WHEN weather_desc ILIKE '%雾%' OR weather_desc ILIKE '%霾%' OR weather_desc ILIKE '%fog%' OR weather_desc ILIKE '%haze%' THEN 'poor_visibility'
      WHEN weather_desc ILIKE '%晴%' OR weather_desc ILIKE '%sunny%' OR weather_desc ILIKE '%clear%' THEN 'clear'
      WHEN weather_desc ILIKE '%云%' OR weather_desc ILIKE '%阴%' OR weather_desc ILIKE '%cloud%' OR weather_desc ILIKE '%overcast%' THEN 'cloudy'
      ELSE 'other'
    END
  `;
}

async function queryHistory(db, { weekday, isHoliday, bucket = null }) {
  const bucketFilter = bucket ? `AND ${weatherBucketSql()} = $3` : '';
  const params = bucket ? [weekday, isHoliday, bucket] : [weekday, isHoliday];
  return db.exec(
    `
      SELECT AVG(avg_crowd) AS avg_crowd, AVG(max_crowd) AS max_crowd, COUNT(*) AS sample_count
      FROM daily_summary
      WHERE weekday = $1
        AND COALESCE(is_holiday, 0) = $2
        AND avg_crowd IS NOT NULL
        AND max_crowd IS NOT NULL
        ${bucketFilter}
    `,
    params,
  );
}

export async function forecast() {
  const db = await getDb();
  const weatherByDate = await loadWeatherForecast();

  console.log('\n7-day crowd forecast');
  console.log('-'.repeat(92));

  for (let i = 0; i < 7; i++) {
    const dateStr = shanghaiDate(i);
    const wd = weekdayFromShanghaiDate(dateStr);
    const dayName = DAY_NAMES[wd];
    let holidayInfo;
    try {
      holidayInfo = getHolidayInfoForDate(dateStr);
    } catch {
      holidayInfo = { isHoliday: 0, holidayName: '', isWorkday: wd < 5 ? 1 : 0 };
    }
    const weather = weatherByDate.get(dateStr) || {};
    const fallbackKey = holidayInfo.isHoliday ? 'holiday' : wd < 5 ? 'weekday' : 'weekend';

    let hist = null;
    let source = 'default estimate';
    if (weather.bucket) {
      hist = await queryHistory(db, { weekday: wd, isHoliday: holidayInfo.isHoliday, bucket: weather.bucket });
      if (Number(hist[0]?.values[0]?.[2] || 0) > 0) {
        source = `${hist[0].values[0][2]} historical days, same weekday/holiday/weather`;
      }
    }
    if (!hist || Number(hist[0]?.values[0]?.[2] || 0) === 0) {
      hist = await queryHistory(db, { weekday: wd, isHoliday: holidayInfo.isHoliday });
      if (Number(hist[0]?.values[0]?.[2] || 0) > 0) {
        source = `${hist[0].values[0][2]} historical days, same weekday/holiday`;
      }
    }

    const estimate = estimateFromHistory(hist[0]?.values, fallbackKey);
    const weatherLabel = weather.description || 'weather n/a';
    const holidayLabel = holidayInfo.holidayName || (holidayInfo.isHoliday ? 'holiday' : 'regular');
    const marker = i === 0 ? '*' : ' ';
    console.log(
      `${marker} ${dateStr} ${dayName}  avg:${String(estimate.avg).padStart(5)}  max:${String(estimate.max).padStart(5)}  ${holidayLabel}  ${weatherLabel}  (${source})`,
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
