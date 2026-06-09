#!/usr/bin/env node
import cron from 'node-cron';
import { AmapCollector } from './collectors/amap.js';
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
 *   node main.js --init       # 仅初始化数据库
 */
import { initDb, saveDb } from './config/db.js';
import { AMAP_API_KEY } from './config/settings.js';

function shanghaiDate(offsetDays = 0) {
  const now = new Date();
  const shNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  shNow.setDate(shNow.getDate() + offsetDays);
  return shNow.toLocaleDateString('sv-SE');
}

async function runReport(dateStr) {
  const db = await initDb();
  const date = dateStr || shanghaiDate(-1);

  const rows = await db.exec(
    `
    SELECT value, ts, confidence, raw_json FROM crowd_data
    WHERE source = $1 AND metric = $2
    AND ts LIKE $3
    ORDER BY ts
  `,
    ['gov_tour', 'in_park_count', `${date}%`],
  );

  if (!rows.length || !rows[0].values.length) {
    console.log(`📊 田子坊昨日统计（${date}）`);
    console.log('暂无采集数据。');
    return;
  }

  const samples = rows[0].values
    .filter(([value]) => value !== null)
    .map(([value, ts, confidence, raw]) => {
      let rawObj = {};
      try {
        rawObj = raw ? JSON.parse(raw) : {};
      } catch {}
      return { value: Number(value), ts, confidence, raw: rawObj };
    });

  if (!samples.length) {
    console.log(`📊 田子坊昨日统计（${date}）`);
    console.log('暂无有效在园人数样本。');
    return;
  }

  const values = samples.map((s) => s.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const peak = samples.reduce((best, cur) => (cur.value > best.value ? cur : best), samples[0]);
  const measured = samples.filter((s) => s.confidence === 'measured').length;
  const stale = samples.filter((s) => s.confidence === 'stale').length;
  const estimated = samples.filter((s) => s.confidence === 'estimated').length;
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

  console.log(`📊 田子坊昨日统计（${date}）`);
  console.log(`- 计划采集频率：06:00、07:00~18:55 每5分钟、20:00、22:00（cron: */5 7-18 + 0 6,7,20,22）`);
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
  // 找出最后一次真正 measured 的时间
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

function log(msg) {
  console.log(`[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}] ${msg}`);
}

async function runCollection(skipAmap = false) {
  const db = await initDb();
  log('=== 开始采集 ===');

  const collectors = [new GovTourCollector(), new WeatherCollector(), new HolidayCollector()];

  if (!skipAmap) {
    if (AMAP_API_KEY) {
      collectors.push(new AmapCollector());
    } else {
      log('AMAP_API_KEY 未配置，跳过高德地图数据');
    }
  } else {
    log('低频模式：跳过高德地图数据');
  }

  let total = 0;
  for (const c of collectors) {
    try {
      const records = await c.collect();
      const count = await c.save(db, records);
      total += count;
      log(`  [${c.name}] ${count} 条记录`);
    } catch (e) {
      log(`  [${c.name}] 失败: ${e.message}`);
    }
  }

  saveDb(db);
  log(`=== 采集完成，共 ${total} 条 ===`);
  return total;
}

async function runDailySummary(dateStr = null) {
  const db = await initDb();
  const today = dateStr || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  log(`生成 ${today} 日汇总...`);

  // 田子坊官方实时页经常不可抓取，gov_tour 会降级为 estimated。
  // 预测系统需要 daily_summary 做基线，因此这里保留所有 confidence，
  // 并在 notes 中记录 measured/scraped/estimated 的构成。
  const rows = await db.exec(
    `
    SELECT value, ts, confidence FROM crowd_data
    WHERE source = $1 AND metric = $2
    AND ts LIKE $3
    ORDER BY ts
  `,
    ['gov_tour', 'in_park_count', `${today}%`],
  );

  if (rows.length > 0 && rows[0].values.length > 0) {
    const samples = rows[0].values
      .filter(([value]) => value !== null)
      .map(([value, ts, confidence]) => ({ value: Number(value), ts, confidence }));
    if (samples.length > 0) {
      const values = samples.map((s) => s.value);
      const maxCrowd = Math.max(...values);
      const avgCrowd = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      const totalVisitors = Math.round(values.reduce((a, b) => a + b, 0));
      const peak = samples.reduce((best, cur) => (cur.value > best.value ? cur : best), samples[0]);
      const peakHour = peak.ts ? Number(peak.ts.substring(11, 13)) : null;
      const weekday = new Date(`${today}T12:00:00+08:00`).getDay();
      const wd = weekday === 0 ? 6 : weekday - 1;
      const confidenceCounts = samples.reduce((acc, s) => {
        acc[s.confidence || 'unknown'] = (acc[s.confidence || 'unknown'] || 0) + 1;
        return acc;
      }, {});
      const notes = `auto_summary; samples=${samples.length}; confidence=${JSON.stringify(confidenceCounts)}`;

      await db.run(
        `
        INSERT INTO daily_summary
        (date, weekday, max_crowd, avg_crowd, peak_hour, total_visitors, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (date) DO UPDATE SET
          weekday = EXCLUDED.weekday,
          max_crowd = EXCLUDED.max_crowd,
          avg_crowd = EXCLUDED.avg_crowd,
          peak_hour = EXCLUDED.peak_hour,
          total_visitors = EXCLUDED.total_visitors,
          notes = EXCLUDED.notes
      `,
        [today, wd, maxCrowd, avgCrowd, peakHour, totalVisitors, notes],
      );

      saveDb(db);
      log(`  汇总: 样本${samples.length} 最大${maxCrowd} 均值${avgCrowd} 峰值${peakHour}时`);
    }
  } else {
    log('  当天无在园人数数据');
  }
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
    cron.schedule('0,30 6-8 * * *', () => runCollection(true), { timezone: 'Asia/Shanghai' });
    // 基础采集：实测段09:00-21:55每5分钟
    cron.schedule('5-55/5 9-21 * * *', () => runCollection(true), { timezone: 'Asia/Shanghai' });
    // 基础采集：22:00单次
    cron.schedule('0 22 * * *', () => runCollection(true), { timezone: 'Asia/Shanghai' });
    // 高德数据（路况+POI）：每30分钟采集一次，节省API额度
    cron.schedule('0,30 9-21 * * *', () => runCollection(false), { timezone: 'Asia/Shanghai' });
    log('定时任务: 基础采集(官方+天气+节假日)每5分钟, 高德数据每30分钟');

    // 每天23:30生成日汇总
    cron.schedule('30 23 * * *', () => runDailySummary(), { timezone: 'Asia/Shanghai' });
    log('定时任务: 每天 23:30 生成汇总');
    log('定时任务已启动');

    // 保持进程运行
    setInterval(() => {}, 60000);
  } else {
    const skipAmap = args.includes('--skip-amap');
    await runCollection(skipAmap);
    await runDailySummary();
  }
}

main().catch(console.error);
