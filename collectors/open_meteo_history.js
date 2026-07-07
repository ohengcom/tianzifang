import { z } from 'zod';
import { upsertObservation } from '../v2/observation-store.js';

const TIANZIFANG_COORDS = { latitude: 31.2107, longitude: 121.4692 };
const SOURCE_ID = 'open_meteo_archive';

const DailyArchiveSchema = z.object({
  daily: z.object({
    time: z.array(z.iso.date()),
    temperature_2m_max: z.array(z.number().nullable()).optional(),
    temperature_2m_min: z.array(z.number().nullable()).optional(),
    precipitation_sum: z.array(z.number().nullable()).optional(),
    weather_code: z.array(z.number().int().nullable()).optional(),
  }),
});

function dailyUrl(startDate, endDate) {
  const params = new URLSearchParams({
    latitude: String(TIANZIFANG_COORDS.latitude),
    longitude: String(TIANZIFANG_COORDS.longitude),
    start_date: startDate,
    end_date: endDate,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    timezone: 'Asia/Shanghai',
  });
  return `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;
}

export async function fetchOpenMeteoDailyArchive(startDate, endDate) {
  const url = dailyUrl(startDate, endDate);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`Open-Meteo archive HTTP ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  const parsed = DailyArchiveSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Open-Meteo archive schema mismatch: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function backfillOpenMeteoDaily(db, { startDate, endDate, runId = null } = {}) {
  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required for Open-Meteo backfill');
  }
  if (startDate > endDate) {
    throw new Error(`Open-Meteo backfill startDate must be before endDate: ${startDate} > ${endDate}`);
  }

  const data = await fetchOpenMeteoDailyArchive(startDate, endDate);
  const metrics = [
    ['weather_temp_max', 'temperature_2m_max', '℃'],
    ['weather_temp_min', 'temperature_2m_min', '℃'],
    ['weather_precipitation_mm', 'precipitation_sum', 'mm'],
    ['weather_code', 'weather_code', 'code'],
  ];
  let count = 0;
  for (let i = 0; i < data.daily.time.length; i++) {
    const date = data.daily.time[i];
    const observedAt = `${date}T00:00:00+08:00`;
    for (const [metric, field, unit] of metrics) {
      const values = data.daily[field] || [];
      const value = values[i];
      if (value === null || value === undefined) continue;
      count += await upsertObservation(db, {
        observedAt,
        sourceId: SOURCE_ID,
        metric,
        granularity: 'day',
        valueNum: value,
        unit,
        quality: 'measured',
        confidence: 0.9,
        runId,
        raw: { provider: 'open-meteo', field, date, coords: TIANZIFANG_COORDS },
      });
    }
  }
  return count;
}
