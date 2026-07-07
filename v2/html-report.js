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
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function row(cells) {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function weekdayName(value) {
  const weekday = Number(value);
  return weekdayLabels[weekday] || '';
}

function dayType({ isHoliday, weekday }) {
  if (Number(isHoliday) === 1) return '节假日';
  const weekdayNum = Number(weekday);
  if (weekdayNum >= 5) return '周末';
  if (weekdayNum >= 0) return '工作日';
  return '';
}

function shanghaiGeneratedAt(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

async function loadDailyRows(db, days) {
  const result = await db.exec(
    `
      WITH measured_days AS (
        SELECT
          (observed_at AT TIME ZONE 'Asia/Shanghai')::date AS date,
          COUNT(*) AS sample_count,
          ROUND(AVG(value_num)::numeric, 1) AS avg_in_park,
          MAX(value_num) AS max_in_park
        FROM observations
        WHERE source_id = 'gov_tour'
          AND entity_id = 'tianzifang'
          AND metric = 'in_park_count'
          AND quality = 'measured'
          AND value_num IS NOT NULL
        GROUP BY 1
        ORDER BY date DESC
        LIMIT $1
      )
      SELECT
        measured_days.date::text,
        measured_days.sample_count,
        measured_days.avg_in_park,
        measured_days.max_in_park,
        daily_features.weather_temp_max,
        daily_features.weather_temp_min,
        daily_features.is_holiday,
        daily_features.weekday,
        ROUND(LEAST(1, measured_days.sample_count::numeric / 144)::numeric, 3) AS quality_score
      FROM measured_days
      LEFT JOIN daily_features ON daily_features.date = measured_days.date
      ORDER BY measured_days.date DESC
    `,
    [days],
  );
  return result[0]?.values || [];
}

async function loadHourlyRows(db, days) {
  const result = await db.exec(
    `
      WITH recent_days AS (
        SELECT DISTINCT (observed_at AT TIME ZONE 'Asia/Shanghai')::date AS date
        FROM observations
        WHERE source_id = 'gov_tour'
          AND entity_id = 'tianzifang'
          AND metric = 'in_park_count'
          AND quality = 'measured'
          AND value_num IS NOT NULL
        ORDER BY date DESC
        LIMIT $1
      ),
      measured AS (
        SELECT
          observed_at,
          value_num,
          (observed_at AT TIME ZONE 'Asia/Shanghai')::date AS date,
          EXTRACT(HOUR FROM observed_at AT TIME ZONE 'Asia/Shanghai')::int AS hour,
          LEAD(observed_at) OVER (
            PARTITION BY (observed_at AT TIME ZONE 'Asia/Shanghai')::date
            ORDER BY observed_at
          ) AS next_observed_at
        FROM observations
        WHERE source_id = 'gov_tour'
          AND entity_id = 'tianzifang'
          AND metric = 'in_park_count'
          AND quality = 'measured'
          AND value_num IS NOT NULL
          AND (observed_at AT TIME ZONE 'Asia/Shanghai')::date IN (SELECT date FROM recent_days)
      ),
      weighted AS (
        SELECT
          hour,
          value_num,
          CASE
            WHEN next_observed_at IS NULL THEN 5
            WHEN EXTRACT(EPOCH FROM (next_observed_at - observed_at)) / 60 <= 0 THEN 0
            WHEN EXTRACT(EPOCH FROM (next_observed_at - observed_at)) / 60 > 30 THEN 5
            ELSE EXTRACT(EPOCH FROM (next_observed_at - observed_at)) / 60
          END AS weight_minutes
        FROM measured
        WHERE hour BETWEEN 7 AND 19
      )
      SELECT
        hour,
        ROUND((SUM(value_num * weight_minutes) / NULLIF(SUM(weight_minutes), 0))::numeric, 0) AS weighted_avg,
        ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY value_num)::numeric, 0) AS p25,
        ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value_num)::numeric, 0) AS p75,
        COUNT(*) AS sample_count
      FROM weighted
      WHERE weight_minutes > 0
      GROUP BY hour
      ORDER BY hour
    `,
    [days],
  );
  return result[0]?.values || [];
}

function average(values) {
  const valid = values.filter((value) => value !== null && value !== undefined && value !== '');
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + Number(value), 0) / valid.length;
}

function strongestDay(dailyRows, columnIndex) {
  return dailyRows
    .filter((item) => item[columnIndex] != null)
    .sort((a, b) => Number(b[columnIndex]) - Number(a[columnIndex]))[0];
}

function summarizePeakDay(day) {
  if (!day) return '';
  return `${number(day[3])}（${escapeHtml(day[0])}，${weekdayName(day[7])}，${dayType({
    isHoliday: day[6],
    weekday: day[7],
  })}）`;
}

function summarizeAverage(dailyRows) {
  const avg = average(dailyRows.map((item) => item[2]));
  return avg == null ? '' : number(avg, 0);
}

function quietHours(hourlyRows) {
  return hourlyRows
    .filter((item) => item[1] !== null && item[1] !== undefined)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(0, 3);
}

function hourLabel(hour) {
  const start = String(hour).padStart(2, '0');
  const end = String(Number(hour) + 1).padStart(2, '0');
  return `${start}:00-${end}:00`;
}

function buildHourlyTable(hourlyRows) {
  const quietSet = new Set(quietHours(hourlyRows).map((item) => Number(item[0])));
  const byHour = new Map(hourlyRows.map((item) => [Number(item[0]), item]));
  return Array.from({ length: 13 }, (_, index) => index + 7)
    .map((hour) => {
      const item = byHour.get(hour);
      if (!item) {
        return row([hourLabel(hour), '暂无实测样本', '', '', '']);
      }
      return row([
        hourLabel(item[0]),
        number(item[1]),
        `${number(item[2])}-${number(item[3])}`,
        number(item[4]),
        quietSet.has(Number(item[0])) ? '<strong>较少</strong>' : '',
      ]);
    })
    .join('\n');
}

function summarizeQuietHours(hourlyRows) {
  const hours = quietHours(hourlyRows);
  if (!hours.length) return '';
  return hours.map((item) => `${hourLabel(item[0])}（约 ${number(item[1])} 人）`).join('、');
}

function chartPoint({ index, value, count, maxValue, width, height, pad }) {
  const x = pad.left + (count <= 1 ? 0 : (index / (count - 1)) * (width - pad.left - pad.right));
  const y = height - pad.bottom - (Number(value) / maxValue) * (height - pad.top - pad.bottom);
  return { x, y };
}

function pathFor(points) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');
}

function buildLineChart(dailyRows) {
  const rows = [...dailyRows].reverse();
  if (!rows.length) return '';

  const width = 860;
  const height = 360;
  const pad = { top: 28, right: 28, bottom: 58, left: 58 };
  const maxValue = Math.max(...rows.map((item) => Number(item[3] || 0)), 1);
  const avgPoints = rows.map((item, index) =>
    chartPoint({ index, value: item[2] || 0, count: rows.length, maxValue, width, height, pad }),
  );
  const maxPoints = rows.map((item, index) =>
    chartPoint({ index, value: item[3] || 0, count: rows.length, maxValue, width, height, pad }),
  );
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxValue * ratio));
  const labelIndexes = [0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter(
    (value, index, list) => list.indexOf(value) === index,
  );

  const weekendBands = rows
    .map((item, index) => {
      const type = dayType({ isHoliday: item[6], weekday: item[7] });
      if (type === '工作日') return '';
      const point = chartPoint({ index, value: 0, count: rows.length, maxValue, width, height, pad });
      const bandWidth = Math.max(4, (width - pad.left - pad.right) / Math.max(rows.length - 1, 1) / 1.5);
      return `<rect x="${(point.x - bandWidth / 2).toFixed(1)}" y="${pad.top}" width="${bandWidth.toFixed(1)}" height="${height - pad.top - pad.bottom}" fill="${type === '节假日' ? '#fde8cc' : '#edf4ff'}" />`;
    })
    .join('\n');

  const gridLines = yTicks
    .map((tick) => {
      const y = chartPoint({ index: 0, value: tick, count: rows.length, maxValue, width, height, pad }).y;
      return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(
        1,
      )}" stroke="#e4e9ef" /><text x="${pad.left - 10}" y="${(y + 4).toFixed(
        1,
      )}" text-anchor="end" font-size="12" fill="#5d6d7e">${number(tick)}</text>`;
    })
    .join('\n');

  const xLabels = labelIndexes
    .map((index) => {
      const point = chartPoint({ index, value: 0, count: rows.length, maxValue, width, height, pad });
      return `<text x="${point.x.toFixed(1)}" y="${height - 20}" text-anchor="middle" font-size="12" fill="#5d6d7e">${escapeHtml(
        rows[index][0].slice(5),
      )}</text>`;
    })
    .join('\n');

  return `<svg class="tzf-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="田子坊近期平均在园和最高在园人数折线图">
  <rect width="${width}" height="${height}" fill="#ffffff" />
  ${weekendBands}
  ${gridLines}
  <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#9aa7b4" />
  <path d="${pathFor(maxPoints)}" fill="none" stroke="#d64545" stroke-width="2.5" />
  <path d="${pathFor(avgPoints)}" fill="none" stroke="#1f7a68" stroke-width="2.5" />
  ${xLabels}
  <g transform="translate(${pad.left}, 18)" font-size="12" fill="#17202a">
    <line x1="0" y1="0" x2="22" y2="0" stroke="#1f7a68" stroke-width="2.5" /><text x="30" y="4">平均在园</text>
    <line x1="120" y1="0" x2="142" y2="0" stroke="#d64545" stroke-width="2.5" /><text x="150" y="4">最高在园</text>
    <rect x="250" y="-8" width="18" height="12" fill="#edf4ff" /><text x="275" y="4">周末</text>
    <rect x="330" y="-8" width="18" height="12" fill="#fde8cc" /><text x="355" y="4">节假日</text>
  </g>
</svg>`;
}

export async function generateHtmlReport(db, { outputPath = 'reports/tianzifang-crowd-report.html', days = 90 } = {}) {
  const dailyRows = await loadDailyRows(db, days);
  const hourlyRows = await loadHourlyRows(db, days);
  const peakOccupancyDay = strongestDay(dailyRows, 3);
  const generatedAt = shanghaiGeneratedAt(new Date());

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>田子坊近期客流观察</title>
  <style>
    .tzf-report { color: #17202a; font: 14px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 880px; }
    .tzf-report h1, .tzf-report h2 { line-height: 1.25; margin: 0 0 12px; }
    .tzf-report h1 { font-size: 26px; }
    .tzf-report h2 { font-size: 18px; margin-top: 24px; }
    .tzf-report .meta, .tzf-report .note { color: #5d6d7e; }
    .tzf-report .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 16px 0; }
    .tzf-report .tile { border: 1px solid #d7dde4; border-radius: 6px; padding: 12px; background: #fff; }
    .tzf-report .tile b { display: block; font-size: 20px; margin-top: 4px; }
    .tzf-report .chart-wrap { overflow-x: auto; margin: 12px 0 6px; }
    .tzf-report .tzf-chart { width: 100%; min-width: 620px; height: auto; display: block; }
    .tzf-report table { border-collapse: collapse; width: 100%; margin: 10px 0 16px; }
    .tzf-report th, .tzf-report td { border: 1px solid #d7dde4; padding: 8px; text-align: left; vertical-align: top; }
    .tzf-report th { background: #f3f6f8; font-weight: 650; }
    .tzf-report .compact td:first-child { width: 42%; }
  </style>
</head>
<body>
<section class="tzf-report">
  <h1>田子坊近期客流观察</h1>
  <div class="meta">生成时间：${escapeHtml(generatedAt)}（Asia/Shanghai）。仅使用官方实时在园人数的实测样本。</div>

  <div class="summary">
    <div class="tile">观察天数 <b>${number(dailyRows.length)}</b></div>
    <div class="tile">平均在园人数 <b>${summarizeAverage(dailyRows)}</b></div>
    <div class="tile">最高在园人数 <b>${summarizePeakDay(peakOccupancyDay)}</b></div>
  </div>

  <div class="chart-wrap">${buildLineChart(dailyRows)}</div>
  <p class="note">绿色为平均在园人数，红色为最高在园人数；浅蓝背景为周末，浅橙背景为节假日。</p>

  <h2>什么时候人少</h2>
  <p>按最近 ${number(dailyRows.length)} 个有实测样本的日期统计，7:00-19:00 中相对人少的时段通常是：${escapeHtml(summarizeQuietHours(hourlyRows))}。</p>
  <table>
    <thead><tr><th>时段</th><th>加权平均在园</th><th>常见范围</th><th>样本数</th><th>建议</th></tr></thead>
    <tbody>${buildHourlyTable(hourlyRows)}</tbody>
  </table>

  <p class="note">说明：平均/最高在园人数是某一时刻景区内人数的统计，不是当天累计接待量。小时表使用 7:00-19:00 官方实测样本，按相邻采样间隔做时间加权；历史模型估算值和新闻累计客流不会进入本报告。</p>
</section>
</body>
</html>
`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return { outputPath, dailyRows: dailyRows.length, hourlyRows: hourlyRows.length };
}
