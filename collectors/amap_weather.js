import { z } from 'zod';
import { AMAP_KEY } from '../config/settings.js';
import { upsertObservation } from '../v2/observation-store.js';

const AMAP_WEATHER_URL = 'https://restapi.amap.com/v3/weather/weatherInfo';
const HUANGPU_ADCODE = '310101';
const SOURCE_ID = 'amap_weather';

const AmapLiveSchema = z.object({
  status: z.string(),
  info: z.string().optional(),
  infocode: z.string().optional(),
  lives: z
    .array(
      z.object({
        province: z.string().optional(),
        city: z.string().optional(),
        adcode: z.string(),
        weather: z.string().optional(),
        temperature: z.string().optional(),
        winddirection: z.string().optional(),
        windpower: z.string().optional(),
        humidity: z.string().optional(),
        reporttime: z.string(),
        temperature_float: z.string().optional(),
        humidity_float: z.string().optional(),
      }),
    )
    .optional(),
});

const AmapForecastSchema = z.object({
  status: z.string(),
  info: z.string().optional(),
  infocode: z.string().optional(),
  forecasts: z
    .array(
      z.object({
        city: z.string().optional(),
        adcode: z.string(),
        province: z.string().optional(),
        reporttime: z.string(),
        casts: z.array(
          z.object({
            date: z.iso.date(),
            week: z.string().optional(),
            dayweather: z.string().optional(),
            nightweather: z.string().optional(),
            daytemp: z.string().optional(),
            nighttemp: z.string().optional(),
            daywind: z.string().optional(),
            nightwind: z.string().optional(),
            daypower: z.string().optional(),
            nightpower: z.string().optional(),
            daytemp_float: z.string().optional(),
            nighttemp_float: z.string().optional(),
          }),
        ),
      }),
    )
    .optional(),
});

function requireAmapKey() {
  if (!AMAP_KEY) {
    throw new Error('AMAP_KEY environment variable is required for AMap weather collection');
  }
  return AMAP_KEY;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function amapObservedAt(reporttime) {
  return `${reporttime.replace(' ', 'T')}+08:00`;
}

async function fetchAmapWeather(extensions) {
  const params = new URLSearchParams({
    key: requireAmapKey(),
    city: HUANGPU_ADCODE,
    extensions,
    output: 'JSON',
  });
  const response = await fetch(`${AMAP_WEATHER_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`AMap weather HTTP ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (payload.status !== '1') {
    throw new Error(`AMap weather API error ${payload.infocode || ''}: ${payload.info || 'unknown error'}`);
  }
  return payload;
}

async function saveNumeric(db, { observedAt, metric, value, unit, granularity, raw, runId }) {
  if (value === null || value === undefined) return 0;
  return upsertObservation(db, {
    observedAt,
    sourceId: SOURCE_ID,
    metric,
    granularity,
    valueNum: value,
    unit,
    quality: 'measured',
    confidence: 0.75,
    runId,
    raw,
  });
}

async function saveText(db, { observedAt, metric, value, granularity, raw, runId }) {
  if (!value) return 0;
  return upsertObservation(db, {
    observedAt,
    sourceId: SOURCE_ID,
    metric,
    granularity,
    valueText: value,
    quality: 'measured',
    confidence: 0.75,
    runId,
    raw,
  });
}

async function collectLive(db, runId) {
  const parsed = AmapLiveSchema.safeParse(await fetchAmapWeather('base'));
  if (!parsed.success) {
    throw new Error(`AMap live weather schema mismatch: ${parsed.error.message}`);
  }
  const live = parsed.data.lives?.[0];
  if (!live) return 0;

  const observedAt = amapObservedAt(live.reporttime);
  const raw = { provider: 'amap', mode: 'base', adcode: HUANGPU_ADCODE, live };
  let count = 0;
  count += await saveNumeric(db, {
    observedAt,
    metric: 'weather_temp',
    value: numberOrNull(live.temperature_float ?? live.temperature),
    unit: 'C',
    granularity: 'instant',
    raw,
    runId,
  });
  count += await saveNumeric(db, {
    observedAt,
    metric: 'weather_humidity',
    value: numberOrNull(live.humidity_float ?? live.humidity),
    unit: '%',
    granularity: 'instant',
    raw,
    runId,
  });
  count += await saveText(db, {
    observedAt,
    metric: 'weather_condition',
    value: live.weather,
    granularity: 'instant',
    raw,
    runId,
  });
  count += await saveText(db, {
    observedAt,
    metric: 'weather_wind_direction',
    value: live.winddirection,
    granularity: 'instant',
    raw,
    runId,
  });
  count += await saveText(db, {
    observedAt,
    metric: 'weather_wind_power',
    value: live.windpower,
    granularity: 'instant',
    raw,
    runId,
  });
  return count;
}

async function collectForecast(db, runId) {
  const parsed = AmapForecastSchema.safeParse(await fetchAmapWeather('all'));
  if (!parsed.success) {
    throw new Error(`AMap forecast weather schema mismatch: ${parsed.error.message}`);
  }
  const forecast = parsed.data.forecasts?.[0];
  if (!forecast) return 0;

  let count = 0;
  for (const cast of forecast.casts) {
    const observedAt = `${cast.date}T00:00:00+08:00`;
    const raw = { provider: 'amap', mode: 'all', adcode: HUANGPU_ADCODE, reporttime: forecast.reporttime, cast };
    count += await saveNumeric(db, {
      observedAt,
      metric: 'weather_temp_max',
      value: numberOrNull(cast.daytemp_float ?? cast.daytemp),
      unit: 'C',
      granularity: 'day',
      raw,
      runId,
    });
    count += await saveNumeric(db, {
      observedAt,
      metric: 'weather_temp_min',
      value: numberOrNull(cast.nighttemp_float ?? cast.nighttemp),
      unit: 'C',
      granularity: 'day',
      raw,
      runId,
    });
    count += await saveText(db, {
      observedAt,
      metric: 'weather_condition_day',
      value: cast.dayweather,
      granularity: 'day',
      raw,
      runId,
    });
    count += await saveText(db, {
      observedAt,
      metric: 'weather_condition_night',
      value: cast.nightweather,
      granularity: 'day',
      raw,
      runId,
    });
  }
  return count;
}

export async function collectAmapWeather(db, { runId = null } = {}) {
  const liveCount = await collectLive(db, runId);
  const forecastCount = await collectForecast(db, runId);
  return liveCount + forecastCount;
}
