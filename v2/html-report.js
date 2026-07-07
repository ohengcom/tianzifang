import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function number(value, digits = 0) {
  if (value === null || value === undefined || value === '') return '';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function row(cells) {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

async function loadDailyRows(db, days) {
  const result = await db.exec(
    `
      SELECT
        date::text,
        sample_count,
        ROUND(avg_in_park::numeric, 1) AS avg_in_park,
        max_in_park,
        reported_visitors,
        activity_event_count,
        context_signal_count,
        weather_temp_max,
        weather_temp_min,
        is_holiday,
        weekday,
        ROUND(quality_score::numeric, 3) AS quality_score,
        notes
      FROM daily_features
      ORDER BY date DESC
      LIMIT $1
    `,
    [days],
  );
  return result[0]?.values || [];
}

async function loadAnchors(db) {
  const result = await db.exec(`
    WITH ranked AS (
      SELECT
        observed_at::text,
        metric,
        granularity,
        value_num,
        value_text,
        unit,
        confidence,
        raw,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(raw->>'anchor_id', metric || '|' || source_id || '|' || observed_at::text || '|' || COALESCE(value_num::text, value_text, ''))
          ORDER BY updated_at DESC, confidence DESC
        ) AS rn
      FROM observations
      WHERE entity_id = 'tianzifang'
        AND raw ? 'anchor_id'
        AND metric IN (
          'daily_total_visitors',
          'reported_daily_visitors',
          'reported_peak_daily_visitors',
          'period_total_visitors',
          'reported_instant_visitors',
          'reported_partial_day_visitors',
          'activity_event',
          'context_signal'
        )
    )
    SELECT observed_at, metric, granularity, value_num, value_text, unit, confidence, raw
    FROM ranked
    WHERE rn = 1
    ORDER BY observed_at DESC, confidence DESC
  `);
  return result[0]?.values || [];
}

function buildFactorSummary(dailyRows, anchors) {
  const factorCounts = new Map();
  for (const [, metric] of anchors) factorCounts.set(metric, (factorCounts.get(metric) || 0) + 1);
  const holidayDays = dailyRows.filter((rowValue) => Number(rowValue[9]) === 1).length;
  const rows = [
    ['Daily feature rows', dailyRows.length],
    ['Holiday rows in report window', holidayDays],
    ['Historical/event anchors', anchors.length],
    ...Array.from(factorCounts.entries()).map(([metric, count]) => [metric, count]),
  ];
  return rows.map(([label, value]) => row([escapeHtml(label), `<strong>${number(value)}</strong>`])).join('\n');
}

function buildDailyTable(dailyRows) {
  return dailyRows
    .map((item) =>
      row([
        escapeHtml(item[0]),
        number(item[1]),
        number(item[2], 1),
        number(item[3]),
        number(item[4]),
        number(item[5]),
        number(item[6]),
        item[7] || item[8] ? `${number(item[8])}-${number(item[7])} C` : '',
        Number(item[9]) === 1 ? 'holiday' : '',
        number(item[11], 3),
      ]),
    )
    .join('\n');
}

function buildAnchorTable(anchors) {
  return anchors
    .map(([observedAt, metric, granularity, valueNum, valueText, unit, confidence, raw]) => {
      const provenance = raw?.provenance || {};
      const value = valueNum != null ? `${number(valueNum)} ${escapeHtml(unit)}` : escapeHtml(valueText);
      const title = provenance.url
        ? `<a href="${escapeHtml(provenance.url)}">${escapeHtml(provenance.title || provenance.publisher || metric)}</a>`
        : escapeHtml(provenance.title || provenance.publisher || metric);
      return row([
        escapeHtml(observedAt.slice(0, 10)),
        escapeHtml(metric),
        escapeHtml(granularity),
        value,
        number(confidence, 2),
        title,
      ]);
    })
    .join('\n');
}

function strongestDay(dailyRows, columnIndex) {
  return dailyRows
    .filter((item) => item[columnIndex] != null)
    .sort((a, b) => Number(b[columnIndex]) - Number(a[columnIndex]))[0];
}

export async function generateHtmlReport(db, { outputPath = 'reports/tianzifang-crowd-report.html', days = 90 } = {}) {
  const dailyRows = await loadDailyRows(db, days);
  const anchors = await loadAnchors(db);
  const peakOccupancyDay = strongestDay(dailyRows, 3);
  const strongestReportedDay = strongestDay(dailyRows, 4);
  const generatedAt = new Date().toISOString();

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tianzifang Crowd Analysis Report</title>
  <style>
    .tzf-report { color: #17202a; font: 14px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .tzf-report h1, .tzf-report h2 { line-height: 1.2; margin: 0 0 12px; }
    .tzf-report h1 { font-size: 26px; }
    .tzf-report h2 { font-size: 18px; margin-top: 26px; }
    .tzf-report .meta { color: #5d6d7e; margin-bottom: 18px; }
    .tzf-report .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 16px 0; }
    .tzf-report .tile { border: 1px solid #d7dde4; border-radius: 6px; padding: 12px; background: #fff; }
    .tzf-report .tile b { display: block; font-size: 20px; margin-top: 4px; }
    .tzf-report table { border-collapse: collapse; width: 100%; margin: 10px 0 18px; }
    .tzf-report th, .tzf-report td { border: 1px solid #d7dde4; padding: 8px; text-align: left; vertical-align: top; }
    .tzf-report th { background: #f3f6f8; font-weight: 650; }
    .tzf-report a { color: #0b63ce; }
  </style>
</head>
<body>
<section class="tzf-report">
  <h1>Tianzifang Crowd Analysis Report</h1>
  <div class="meta">Generated at ${escapeHtml(generatedAt)}. Data source: Neon v2 observations / daily_features.</div>
  <div class="grid">
    <div class="tile">Recent feature days <b>${number(dailyRows.length)}</b></div>
    <div class="tile">Peak in-park count <b>${peakOccupancyDay ? `${number(peakOccupancyDay[3])} (${escapeHtml(peakOccupancyDay[0])})` : ''}</b></div>
    <div class="tile">Top reported daily visitors <b>${strongestReportedDay ? `${number(strongestReportedDay[4])} (${escapeHtml(strongestReportedDay[0])})` : ''}</b></div>
    <div class="tile">Historical/event anchors <b>${number(anchors.length)}</b></div>
  </div>

  <h2>Factor Model</h2>
  <p>The analysis keeps instant in-park occupancy, reported cumulative visitors, holidays, hourly/district weather, activity events, nearby transport and traffic context, venue/area control signals, school and office calendars, exhibitions and neighborhood events, inbound-tourism policy context, search/social media attention, and data-quality coverage separate. Reported anchors explain and calibrate the series; they are not summed from instant occupancy samples.</p>
  <table>
    <thead><tr><th>Factor</th><th>Count</th></tr></thead>
    <tbody>${buildFactorSummary(dailyRows, anchors)}</tbody>
  </table>

  <h2>Recent Daily Features</h2>
  <table>
    <thead><tr><th>Date</th><th>Samples</th><th>Avg in park</th><th>Max in park</th><th>Reported visitors</th><th>Activities</th><th>Context</th><th>Temp</th><th>Holiday</th><th>Quality</th></tr></thead>
    <tbody>${buildDailyTable(dailyRows)}</tbody>
  </table>

  <h2>Historical And Event Anchors</h2>
  <table>
    <thead><tr><th>Date</th><th>Metric</th><th>Granularity</th><th>Value</th><th>Confidence</th><th>Source</th></tr></thead>
    <tbody>${buildAnchorTable(anchors)}</tbody>
  </table>
</section>
</body>
</html>
`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return { outputPath, dailyRows: dailyRows.length, anchors: anchors.length };
}
