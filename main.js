#!/usr/bin/env node
/**
 * 田子坊人流数据采集 - 主入口
 *
 * 用法:
 *   node main.js              # 采集一次
 *   node main.js --schedule   # 启动定时采集 (每天4次)
 *   node main.js --init       # 仅初始化数据库
 */
import { initDb, saveDb } from './config/db.js';
import { COLLECT_HOURS, AMAP_API_KEY } from './config/settings.js';
import { GovTourCollector } from './collectors/gov_tour.js';
import { WeatherCollector } from './collectors/weather.js';
import { HolidayCollector } from './collectors/holiday.js';
import { AmapCollector } from './collectors/amap.js';
import cron from 'node-cron';

function log(msg) {
  console.log(`[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}] ${msg}`);
}

async function runCollection() {
  const db = await initDb();
  log('=== 开始采集 ===');

  const collectors = [
    new GovTourCollector(),
    new WeatherCollector(),
    new HolidayCollector(),
  ];

  if (AMAP_API_KEY) {
    collectors.push(new AmapCollector());
  } else {
    log('AMAP_API_KEY 未配置，跳过高德地图数据');
  }

  let total = 0;
  for (const c of collectors) {
    try {
      const records = await c.collect();
      const count = c.save(db, records);
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

async function runDailySummary() {
  const db = await initDb();
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  log(`生成 ${today} 日汇总...`);

  const rows = db.exec(`
    SELECT value, ts FROM crowd_data
    WHERE source = 'gov_tour' AND metric = 'in_park_count'
    AND date(ts) = '${today}'
    AND confidence IN ('measured', 'scraped')
    ORDER BY ts
  `);

  if (rows.length > 0 && rows[0].values.length > 0) {
    const values = rows[0].values.map(r => r[0]).filter(v => v !== null);
    if (values.length > 0) {
      const maxCrowd = Math.max(...values);
      const avgCrowd = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      const totalVisitors = Math.round(values.reduce((a, b) => a + b, 0));

      db.run(`
        INSERT OR REPLACE INTO daily_summary (date, weekday, max_crowd, avg_crowd, total_visitors)
        VALUES (?, ?, ?, ?, ?)
      `, [today, new Date().getDay(), maxCrowd, avgCrowd, totalVisitors]);

      saveDb(db);
      log(`  汇总: 最大${maxCrowd} 均值${avgCrowd}`);
    }
  } else {
    log('  当天无实测数据');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--init')) {
    await initDb();
    log('数据库已初始化');
    return;
  }

  if (args.includes('--schedule')) {
    await runCollection();

    // 每天4次采集
    for (const hour of COLLECT_HOURS) {
      const expr = `0 ${hour} * * *`;
      cron.schedule(expr, () => runCollection(), { timezone: 'Asia/Shanghai' });
      log(`定时任务: 每天 ${hour}:00 采集`);
    }

    // 每天23:30生成日汇总
    cron.schedule('30 23 * * *', () => runDailySummary(), { timezone: 'Asia/Shanghai' });
    log('定时任务: 每天 23:30 生成汇总');
    log('定时任务已启动');

    // 保持进程运行
    setInterval(() => {}, 60000);
  } else {
    await runCollection();
  }
}

main().catch(console.error);
