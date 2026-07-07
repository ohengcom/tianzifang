#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { GovTourCollector } from './collectors/gov_tour.js';
import { HolidayCollector } from './collectors/holiday.js';
import { WeatherCollector } from './collectors/weather.js';
/**
 * 田子坊人流数据采集 - 主入口
 *
 * 用法:
 *   node main.js              # 采集一次
 *   node main.js --schedule   # 启动定时采集 (06:00-22:00 分时段频率)
 *   node main.js --summary    # 生成当天汇总
 *   node main.js --report-yesterday  # 输出昨日统计报告
 *   node main.js --init       # 仅初始化数据库（建表）
 */
import { getDb, initDb } from './config/db.js';
import {
  shanghaiDate,
  toShanghaiDateString,
  toShanghaiIsoString,
  toShanghaiLogTimestamp,
  weekdayFromShanghaiDate,
} from './utils/time.js';

function log(msg) {
  console.log(`[${toShanghaiLogTimestamp()}] ${msg}`);
}

/**
 * 计算样本集的聚合统计，供 runReport 和 runDailySummary 共用。
 * @param {{ value: number, ts: string, confidence: string }[]} samples
 * @returns {{ max, min, avg, peak, measured, stale, estimated, sampleValueSum, peakHour, wd, confidenceCounts }}
 */
export function computeCrowdStats(samples, today) {
  const values = samples.map((s) => s.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const sampleValueSum = Math.round(values.reduce((a, b) => a + b, 0));
  const peak = samples.reduce((best, cur) => (cur.value > best.value ? cur : best), samples[0]);
  const peakHour = peak.ts ? Number(String(peak.ts).substring(11, 13)) : null;
  const measured = samples.filter((s) => s.confidence === 'measured').length;
  const stale = samples.filter((s) => s.confidence === 'stale').length;
  const estimated = samples.filter((s) => s.confidence === 'estimated').length;
  const confidenceCounts = samples.reduce((acc, s) => {
    acc[s.confidence || 'unknown'] = (acc[s.confidence || 'unknown'] || 0) + 1;
    return acc;
  }, {});
  const wd = today ? weekdayFromShanghaiDate(today) : weekdayFromShanghaiDate(peak.ts);
  return { max, min, avg, sampleValueSum, peak, peakHour, measured, stale, estimated, confidenceCounts, wd };
}

/**
 * 从 crowd_data 加载指定日期的 gov_tour in_park_count 样本。
 * 返回 { value, ts, confidence, raw } 对象数组，已过滤掉 value=null 的行。
 *
 * @param {object} db
 * @param {string} date  YYYY-MM-DD
 */
async function loadGovTourSamples(db, date) {
  const rows = await db.exec(
    `
    SELECT value, ts, confidence, raw_json FROM crowd_data
    WHERE source = $1 AND metric = $2
      AND ts >= $3::timestamptz AND ts < ($3::timestamptz + interval '1 day')
    ORDER BY ts
  `,
    ['gov_tour', 'in_park_count', `${date}T00:00:00+08:00`],
  );

  if (!rows.length || !rows[0].values.length) return [];

  return rows[0].values
    .filter(([value]) => value !== null)
    .map(([value, ts, confidence, raw]) => {
      let rawObj = {};
      try {
        rawObj = raw ? JSON.parse(raw) : {};
      } catch {}
      return { value: Number(value), ts: String(ts), confidence, raw: rawObj };
    });
}

async function runReport(dateStr) {
  const db = await getDb();
  const date = dateStr || shanghaiDate(-1);
  const samples = await loadGovTourSamples(db, date);

  console.log(`📊 田子坊昨日统计（${date}）`);

  if (!samples.length) {
    console.log('暂无有效在园人数样本。');
    return;
  }

  const { max, min, avg, peak, measured, stale, estimated } = computeCrowdStats(samples, date);

  const officialUpdates = samples
    .filter(
      (s) =>
        (s.confidence === 'measured' || s.confidence === 'stale') &&
        s.raw?.source === 'sh_a_scenic_realtime' &&
        s.raw?.time,
    )
    .map((s) => ({ collectTs: s.ts, officialTime: s.raw.time, value: s.value }))
    .filter((item, index, arr) => arr.findIndex((x) => x.officialTime === item.officialTime) === index)
    .sort((a, b) => a.officialTime.localeCompare(b.officialTime));
  const firstOfficialUpdate = officialUpdates[0];

  console.log(`- 计划采集频率：06:00-08:30 每30分钟（估算段）；09:00-21:55 每5分钟（实测段）；22:00 单次`);
  console.log(`- 实际样本数：${samples.length} 条（实测 ${measured}，API冻结 ${stale}，估算 ${estimated}）`);
  if (firstOfficialUpdate) {
    console.log(
      `- 官方首次更新：${firstOfficialUpdate.officialTime.substring(11, 16)}（采集于 ${firstOfficialUpdate.collectTs.substring(11, 16)}，${Math.round(firstOfficialUpdate.value)} 人）`,
    );
  } else {
    console.log('- 官方首次更新：昨日未采到有效官方实时数据');
  }
  console.log(`- 最高在园：${Math.round(max)} 人（${peak.ts.substring(11, 16)}）`);
  console.log(`- 平均在园：${avg} 人`);
  console.log(`- 最低在园：${Math.round(min)} 人`);

  const hourly = new Map();
  for (const sample of samples) {
    const hour = sample.ts.substring(11, 13);
    if (!hourly.has(hour)) hourly.set(hour, []);
    hourly.get(hour).push(sample.value);
  }
  const lastMeasured = samples.filter((s) => s.confidence === 'measured').slice(-1)[0];
  if (lastMeasured) {
    console.log(`- 官方实时数据窗口：首次更新至 ${lastMeasured.ts.substring(11, 16)}`);
  }
  if (stale > 0) {
    console.log(`- ⚠️ 18:00后API数据冻结，${stale}条样本标记为 stale，仅供参考`);
  }

  const hourlyAvg = [...hourly.entries()].map(([hour, vals]) => [
    hour,
    Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
  ]);
  const topHours = hourlyAvg.sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`- 高峰小时：${topHours.map(([hour, value]) => `${Number(hour)}点≈${value}人`).join('；')}`);

  const last = samples[samples.length - 1];
  const comfort = last.raw?.comfort ? `，舒适度：${last.raw.comfort}` : '';
  console.log(`- 最后采样：${last.ts.substring(11, 16)}，${Math.round(last.value)} 人${comfort}`);
}

async function runCollection() {
  const db = await getDb();
  log('=== 开始采集 ===');

  const collectors = [new GovTourCollector(), new WeatherCollector(), new HolidayCollector()];

  let total = 0;
  const statuses = [];
  for (const c of collectors) {
    try {
      const records = await c.collect();
      const count = await c.save(db, records);
      total += count;
      statuses.push({ source: c.name, status: 'ok', rows: count });
      log(`  [${c.name}] ${count} 条记录`);
    } catch (e) {
      statuses.push({ source: c.name, status: 'error', rows: 0, error: e.message });
      log(`  [${c.name}] 失败: ${e.message}`);
    }
  }

  const hasError = statuses.some((item) => item.status === 'error');
  await saveCollectionStatus(db, statuses);
  if (hasError) {
    log(`=== 采集完成，共 ${total} 条；存在失败采集源 ===`);
  } else {
    log(`=== 采集完成，共 ${total} 条 ===`);
  }
  return { total, statuses, hasError };
}

async function saveCollectionStatus(db, statuses) {
  const ts = toShanghaiIsoString();
  for (const item of statuses) {
    await db.run(
      `
        INSERT INTO crowd_data (ts, source, metric, value, text_value, unit, confidence, raw_json, created_at)
        VALUES ($1, $2, 'collector_status', $3, $4, '', $5, $6, NOW())
        ON CONFLICT (ts, source, metric) DO UPDATE SET
          value = EXCLUDED.value,
          text_value = EXCLUDED.text_value,
          confidence = EXCLUDED.confidence,
          raw_json = EXCLUDED.raw_json,
          created_at = NOW()
        WHERE crowd_data.value IS DISTINCT FROM EXCLUDED.value
          OR crowd_data.text_value IS DISTINCT FROM EXCLUDED.text_value
          OR crowd_data.confidence IS DISTINCT FROM EXCLUDED.confidence
          OR crowd_data.raw_json IS DISTINCT FROM EXCLUDED.raw_json
      `,
      [
        ts,
        `collector:${item.source}`,
        item.status === 'ok' ? 1 : 0,
        item.status,
        item.status === 'ok' ? 'measured' : 'unavailable',
        JSON.stringify({ rows: item.rows, error: item.error || null }),
      ],
    );
  }
}

async function runDailySummary(dateStr = null) {
  const db = await getDb();
  const today = dateStr || toShanghaiDateString();
  log(`生成 ${today} 日汇总...`);

  // 田子坊官方实时页经常不可抓取，gov_tour 会降级为 estimated。
  // 预测系统需要 daily_summary 做基线，因此这里保留所有 confidence，
  // 并在 notes 中记录 measured/scraped/estimated 的构成。
  const samples = await loadGovTourSamples(db, today);

  if (!samples.length) {
    log('  当天无在园人数数据');
    return;
  }

  const {
    max: maxCrowd,
    avg: avgCrowd,
    sampleValueSum,
    peakHour,
    wd,
    confidenceCounts,
  } = computeCrowdStats(samples, today);
  const weatherData = await loadDailyWeatherSummary(db, today);
  const holidayData = await loadDailyHolidaySummary(db, today);
  const notes = [
    'auto_summary',
    `samples=${samples.length}`,
    `in_park_sample_sum=${sampleValueSum}`,
    'total_visitors=null_without_cumulative_source',
    `confidence=${JSON.stringify(confidenceCounts)}`,
    weatherData.description ? `weather=${weatherData.description}` : null,
    holidayData.holidayName ? `holiday=${holidayData.holidayName}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  await db.run(
    `
    INSERT INTO daily_summary
    (date, weekday, max_crowd, avg_crowd, peak_hour, total_visitors, notes, weather_desc, temperature_high, temperature_low, is_holiday, holiday_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (date) DO UPDATE SET
      weekday = EXCLUDED.weekday,
      max_crowd = EXCLUDED.max_crowd,
      avg_crowd = EXCLUDED.avg_crowd,
      peak_hour = EXCLUDED.peak_hour,
      total_visitors = EXCLUDED.total_visitors,
      notes = EXCLUDED.notes,
      weather_desc = EXCLUDED.weather_desc,
      temperature_high = EXCLUDED.temperature_high,
      temperature_low = EXCLUDED.temperature_low,
      is_holiday = EXCLUDED.is_holiday,
      holiday_name = EXCLUDED.holiday_name
  `,
    [
      today,
      wd,
      maxCrowd,
      avgCrowd,
      peakHour,
      null,
      notes,
      weatherData.description,
      weatherData.maxTemp,
      weatherData.minTemp,
      holidayData.isHoliday,
      holidayData.holidayName,
    ],
  );

  log(`  汇总: 样本${samples.length} 最大${maxCrowd} 均值${avgCrowd} 峰值${peakHour}时`);
}

async function loadDailyWeatherSummary(db, date) {
  const dateStart = `${date}T00:00:00+08:00`;
  const weatherRows = await db.exec(
    `
      SELECT metric, value, text_value, unit
      FROM crowd_data
      WHERE source = 'weather'
        AND ts >= $1::timestamptz AND ts < ($1::timestamptz + interval '1 day')
    `,
    [dateStart],
  );

  if (!weatherRows.length || !weatherRows[0].values.length) {
    return { description: null, maxTemp: null, minTemp: null, isHolidayOverride: null };
  }

  let weatherDesc = null;
  let maxTemp = null;
  let minTemp = null;
  for (const [metric, value, textValue, unit] of weatherRows[0].values) {
    if (metric === 'weather_desc') {
      weatherDesc = textValue || unit || null;
    }
    if (metric === 'temperature_max' && value !== null) {
      maxTemp = Number(value);
    }
    if (metric === 'temperature_min' && value !== null) {
      minTemp = Number(value);
    }
  }

  return {
    description: weatherDesc,
    maxTemp: Number.isFinite(maxTemp) ? maxTemp : null,
    minTemp: Number.isFinite(minTemp) ? minTemp : null,
  };
}

async function loadDailyHolidaySummary(db, date) {
  const holidayRows = await db.exec(
    `
      SELECT metric, value, raw_json
      FROM crowd_data
      WHERE source = 'holiday'
        AND ts >= $1::timestamptz AND ts < ($1::timestamptz + interval '1 day')
      ORDER BY ts DESC
    `,
    [`${date}T00:00:00+08:00`],
  );

  let isHoliday = 0;
  let holidayName = null;
  for (const [metric, value, raw] of holidayRows[0]?.values || []) {
    if (metric !== 'is_holiday') continue;
    isHoliday = Number(value || 0);
    try {
      const rawObj = raw ? JSON.parse(raw) : {};
      holidayName = rawObj.holiday_name || null;
    } catch {
      holidayName = null;
    }
    break;
  }
  return { isHoliday, holidayName };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--init')) {
    await initDb();
    log('数据库已初始化');
    return;
  }

  if (args.includes('--summary')) {
    await runDailySummary();
    return;
  }

  if (args.includes('--report-yesterday')) {
    const yesterday = shanghaiDate(-1);
    await runDailySummary(yesterday);
    await runReport(yesterday);
    return;
  }

  if (args.includes('--schedule')) {
    await runCollection();

    // 基础采集（官方人流+天气+节假日）：估算段06:00-08:30每30分钟
    cron.schedule('0,30 6-8 * * *', () => runCollection(), {
      name: 'basic-collect-est',
      timezone: 'Asia/Shanghai',
      noOverlap: true,
    });
    // 基础采集：实测段09:00-21:55每5分钟
    cron.schedule('5-55/5 9-21 * * *', () => runCollection(), {
      name: 'basic-collect-measured',
      timezone: 'Asia/Shanghai',
      noOverlap: true,
    });
    // 基础采集：22:00单次
    cron.schedule('0 22 * * *', () => runCollection(), {
      name: 'basic-collect-night',
      timezone: 'Asia/Shanghai',
      noOverlap: true,
    });
    log('定时任务: 官方人流+天气+节假日 每5分钟（估算段每30分钟）');

    // 每天23:30生成日汇总
    cron.schedule('30 23 * * *', () => runDailySummary(), {
      name: 'daily-summary',
      timezone: 'Asia/Shanghai',
      noOverlap: true,
    });
    log('定时任务: 每天 23:30 生成汇总');
    log('定时任务已启动');
  } else {
    const result = await runCollection();
    await runDailySummary();
    if (result.hasError) {
      throw new Error('One or more collectors failed');
    }
  }
}

// 仅作为直接入口运行时才执行，Vitest 导入时不触发。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
