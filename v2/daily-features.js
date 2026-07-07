function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function hourFromTs(ts) {
  return Number(
    new Date(ts).toLocaleTimeString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
  );
}

function integrateOccupancy(samples) {
  let personMinutes = 0;
  let coverageMinutes = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const gapMinutes = (new Date(cur.ts).getTime() - new Date(prev.ts).getTime()) / 60000;
    if (gapMinutes <= 0 || gapMinutes > 30) continue;
    personMinutes += ((prev.value + cur.value) / 2) * gapMinutes;
    coverageMinutes += gapMinutes;
  }
  return { occupancyPersonHours: personMinutes / 60, coverageMinutes: Math.round(coverageMinutes) };
}

async function loadWeatherFeature(db, date, metric) {
  const rows = await db.exec(
    `
      SELECT value_num
      FROM observations
      WHERE source_id = 'amap_weather'
        AND entity_id = 'tianzifang'
        AND metric = $2
        AND granularity = 'day'
        AND observed_at = $1::timestamptz
      LIMIT 1
    `,
    [`${date}T00:00:00+08:00`, metric],
  );
  return rows[0]?.values?.[0]?.[0] ?? null;
}

async function loadHolidayFeature(db, date, metric) {
  const rows = await db.exec(
    `
      SELECT value_num
      FROM observations
      WHERE source_id = 'holiday'
        AND entity_id = 'tianzifang'
        AND metric = $2
        AND observed_at = $1::timestamptz
      LIMIT 1
    `,
    [`${date}T00:00:00+08:00`, metric],
  );
  return rows[0]?.values?.[0]?.[0] ?? null;
}

async function loadReportedVisitors(db, date) {
  const rows = await db.exec(
    `
      SELECT value_num, source_id, confidence
      FROM observations
      WHERE entity_id = 'tianzifang'
        AND metric IN ('daily_total_visitors', 'reported_daily_visitors')
        AND granularity = 'day'
        AND observed_at = $1::timestamptz
        AND value_num IS NOT NULL
      ORDER BY
        CASE metric
          WHEN 'daily_total_visitors' THEN 0
          ELSE 1
        END,
        confidence DESC
      LIMIT 1
    `,
    [`${date}T00:00:00+08:00`],
  );
  const row = rows[0]?.values?.[0];
  if (!row) return { visitors: null, source: null, confidence: null };
  return { visitors: row[0], source: row[1], confidence: row[2] };
}

function shanghaiDateOnly(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function dateOnly(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function anchorActiveOnDate(anchor, date) {
  const raw = anchor.raw || {};
  const period = raw.period || {};
  const start = dateOnly(period.start) || anchor.date;
  const end = dateOnly(period.end) || start;
  return start <= date && date <= end;
}

async function loadContextAnchors(db, date) {
  const rows = await db.exec(
    `
      SELECT observed_at, metric, value_num, value_text, source_id, confidence, raw
      FROM observations
      WHERE entity_id = 'tianzifang'
        AND metric IN (
          'activity_event',
          'context_signal',
          'reported_peak_daily_visitors',
          'reported_instant_visitors',
          'reported_partial_day_visitors'
        )
        AND observed_at >= ($1::date - interval '730 days')
        AND observed_at < ($1::date + interval '730 days')
      ORDER BY confidence DESC, observed_at
    `,
    [date],
  );
  return (rows[0]?.values || [])
    .map(([observedAt, metric, valueNum, valueText, sourceId, confidence, raw]) => ({
      date: shanghaiDateOnly(observedAt),
      metric,
      valueNum,
      valueText,
      sourceId,
      confidence: Number(confidence),
      raw,
    }))
    .filter((anchor) => anchorActiveOnDate(anchor, date));
}

export async function deriveDailyFeature(db, date) {
  const rows = await db.exec(
    `
      SELECT observed_at, value_num, quality
      FROM observations
      WHERE source_id = 'gov_tour'
        AND entity_id = 'tianzifang'
        AND metric = 'in_park_count'
        AND observed_at >= $1::timestamptz
        AND observed_at < ($1::timestamptz + interval '1 day')
        AND value_num IS NOT NULL
      ORDER BY observed_at
    `,
    [`${date}T00:00:00+08:00`],
  );
  const samples = (rows[0]?.values || []).map(([ts, value, quality]) => ({ ts, value: Number(value), quality }));
  if (!samples.length) return null;

  const values = samples.map((sample) => sample.value);
  const peak = samples.reduce((best, cur) => (cur.value > best.value ? cur : best), samples[0]);
  const { occupancyPersonHours, coverageMinutes } = integrateOccupancy(samples);
  const measuredCount = samples.filter((sample) => sample.quality === 'measured').length;
  const qualityScore = Math.min(1, (coverageMinutes / (13 * 60)) * 0.7 + (measuredCount / samples.length) * 0.3);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;

  const weatherTempMax = await loadWeatherFeature(db, date, 'weather_temp_max');
  const weatherTempMin = await loadWeatherFeature(db, date, 'weather_temp_min');
  const weatherPrecipitation = null;
  const weatherCode = null;
  const isHoliday = await loadHolidayFeature(db, date, 'is_holiday');
  const isWorkday = await loadHolidayFeature(db, date, 'is_workday');
  const weekday = await loadHolidayFeature(db, date, 'weekday');

  const estimatedVisitsMid = occupancyPersonHours ? occupancyPersonHours / 1.5 : null;
  const estimatedVisitsLow = occupancyPersonHours ? occupancyPersonHours / 2.0 : null;
  const estimatedVisitsHigh = occupancyPersonHours ? occupancyPersonHours / 1.0 : null;
  const reportedVisitors = await loadReportedVisitors(db, date);
  const contextAnchors = await loadContextAnchors(db, date);
  const activityEventCount = contextAnchors.filter((anchor) => anchor.metric === 'activity_event').length;
  const contextSignalCount = contextAnchors.length - activityEventCount;
  const strongestContextConfidence = contextAnchors.length
    ? Math.max(...contextAnchors.map((anchor) => anchor.confidence))
    : null;
  const contextNotes = contextAnchors
    .slice(0, 5)
    .map((anchor) => `${anchor.metric}:${anchor.raw?.anchor_id || anchor.sourceId}`)
    .join(';');

  await db.run(
    `
      INSERT INTO daily_features(
        date, entity_id, sample_count, measured_count, first_sample_at, last_sample_at,
        min_in_park, avg_in_park, p50_in_park, p95_in_park, max_in_park, peak_hour,
        coverage_minutes, occupancy_person_hours, estimated_visits_low, estimated_visits_mid, estimated_visits_high,
        reported_visitors, reported_visitors_source, reported_visitors_confidence,
        activity_event_count, context_signal_count, strongest_context_confidence,
        weather_temp_max, weather_temp_min, weather_precipitation_mm, weather_code,
        is_holiday, is_workday, weekday, quality_score, notes, computed_at
      )
      VALUES ($1, 'tianzifang', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, NOW())
      ON CONFLICT (date) DO UPDATE SET
        sample_count = EXCLUDED.sample_count,
        measured_count = EXCLUDED.measured_count,
        first_sample_at = EXCLUDED.first_sample_at,
        last_sample_at = EXCLUDED.last_sample_at,
        min_in_park = EXCLUDED.min_in_park,
        avg_in_park = EXCLUDED.avg_in_park,
        p50_in_park = EXCLUDED.p50_in_park,
        p95_in_park = EXCLUDED.p95_in_park,
        max_in_park = EXCLUDED.max_in_park,
        peak_hour = EXCLUDED.peak_hour,
        coverage_minutes = EXCLUDED.coverage_minutes,
        occupancy_person_hours = EXCLUDED.occupancy_person_hours,
        estimated_visits_low = EXCLUDED.estimated_visits_low,
        estimated_visits_mid = EXCLUDED.estimated_visits_mid,
        estimated_visits_high = EXCLUDED.estimated_visits_high,
        reported_visitors = EXCLUDED.reported_visitors,
        reported_visitors_source = EXCLUDED.reported_visitors_source,
        reported_visitors_confidence = EXCLUDED.reported_visitors_confidence,
        activity_event_count = EXCLUDED.activity_event_count,
        context_signal_count = EXCLUDED.context_signal_count,
        strongest_context_confidence = EXCLUDED.strongest_context_confidence,
        weather_temp_max = EXCLUDED.weather_temp_max,
        weather_temp_min = EXCLUDED.weather_temp_min,
        weather_precipitation_mm = EXCLUDED.weather_precipitation_mm,
        weather_code = EXCLUDED.weather_code,
        is_holiday = EXCLUDED.is_holiday,
        is_workday = EXCLUDED.is_workday,
        weekday = EXCLUDED.weekday,
        quality_score = EXCLUDED.quality_score,
        notes = EXCLUDED.notes,
        computed_at = NOW()
    `,
    [
      date,
      samples.length,
      measuredCount,
      samples[0].ts,
      samples.at(-1).ts,
      Math.min(...values),
      avg,
      percentile(values, 0.5),
      percentile(values, 0.95),
      Math.max(...values),
      hourFromTs(peak.ts),
      coverageMinutes,
      occupancyPersonHours || null,
      estimatedVisitsLow,
      estimatedVisitsMid,
      estimatedVisitsHigh,
      reportedVisitors.visitors,
      reportedVisitors.source,
      reportedVisitors.confidence,
      activityEventCount,
      contextSignalCount,
      strongestContextConfidence,
      weatherTempMax,
      weatherTempMin,
      weatherPrecipitation,
      weatherCode,
      isHoliday,
      isWorkday,
      weekday,
      qualityScore,
      [
        'estimated_visits use dwell-time assumptions: low=2h, mid=1.5h, high=1h; not a turnstile count',
        contextNotes ? `context_anchors=${contextNotes}` : null,
      ]
        .filter(Boolean)
        .join(' | '),
    ],
  );
  return { date, sampleCount: samples.length, coverageMinutes, qualityScore };
}

export async function deriveDailyFeatures(db, { startDate, endDate }) {
  const rows = await db.exec(
    `
      SELECT DISTINCT (observed_at AT TIME ZONE 'Asia/Shanghai')::date::text AS date
      FROM observations
      WHERE source_id = 'gov_tour'
        AND metric = 'in_park_count'
        AND observed_at >= $1::date
        AND observed_at < ($2::date + interval '1 day')
      ORDER BY date
    `,
    [startDate, endDate],
  );
  const dates = rows[0]?.values?.map(([date]) => date) || [];
  const results = [];
  for (const date of dates) {
    const result = await deriveDailyFeature(db, date);
    if (result) results.push(result);
  }
  return results;
}
