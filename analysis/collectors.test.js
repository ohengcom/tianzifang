import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHolidayInfoForDate, HolidayCollector } from '../collectors/holiday.js';
import { computeCrowdStats } from '../main.js';

// ---------------------------------------------------------------------------
// HolidayCollector
// ---------------------------------------------------------------------------

describe('HolidayCollector', () => {
  let collector;

  beforeEach(() => {
    collector = new HolidayCollector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeNow(isoShanghai) {
    // isoShanghai: '2026-05-01T10:00:00+08:00'
    vi.useFakeTimers({ now: new Date(isoShanghai).getTime() });
  }

  it('劳动节（5/1）应标记为 holiday，非 workday', async () => {
    fakeNow('2026-05-01T10:00:00+08:00');
    const records = await collector.collect();
    const holiday = records.find(([m]) => m === 'is_holiday');
    const workday = records.find(([m]) => m === 'is_workday');
    expect(holiday[1]).toBe(1);
    expect(workday[1]).toBe(0);
  });

  it('普通周一（2026-03-02）应标记为非 holiday、是 workday', async () => {
    fakeNow('2026-03-02T10:00:00+08:00'); // Monday
    const records = await collector.collect();
    const holiday = records.find(([m]) => m === 'is_holiday');
    const workday = records.find(([m]) => m === 'is_workday');
    expect(holiday[1]).toBe(0);
    expect(workday[1]).toBe(1);
  });

  it('周六（2026-03-07）应标记为非 holiday、非 workday', async () => {
    fakeNow('2026-03-07T10:00:00+08:00'); // Saturday
    const records = await collector.collect();
    const holiday = records.find(([m]) => m === 'is_holiday');
    const workday = records.find(([m]) => m === 'is_workday');
    expect(holiday[1]).toBe(0);
    expect(workday[1]).toBe(0);
  });

  it('调休上班日（2026-05-09）应标记为 workday', async () => {
    fakeNow('2026-05-09T10:00:00+08:00'); // Saturday, 劳动节调休上班
    const records = await collector.collect();
    const workday = records.find(([m]) => m === 'is_workday');
    expect(workday[1]).toBe(1);
  });

  it('同一天第二次调用应返回空数组（去重）', async () => {
    fakeNow('2026-06-15T10:00:00+08:00');
    await collector.collect();
    const second = await collector.collect();
    expect(second).toHaveLength(0);
  });

  it('严格假日查询在未配置年份应抛出错误', () => {
    expect(() => getHolidayInfoForDate('2027-01-01')).toThrow('HolidayCollector');
  });

  it('采集器遇到未配置年份时应降级为 weekday/workday fallback', async () => {
    fakeNow('2027-01-01T10:00:00+08:00');
    const records = await collector.collect();
    const holiday = records.find(([m]) => m === 'is_holiday');
    const workday = records.find(([m]) => m === 'is_workday');
    const weekday = records.find(([m]) => m === 'weekday');
    expect(holiday[1]).toBe(0);
    expect(holiday[3]).toBe('unavailable');
    expect(workday[1]).toBe(1);
    expect(workday[4].configured).toBe(false);
    expect(weekday[1]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// computeCrowdStats
// ---------------------------------------------------------------------------

describe('computeCrowdStats', () => {
  const samples = [
    { value: 1000, ts: '2026-06-01T09:00:00+08:00', confidence: 'measured' },
    { value: 3000, ts: '2026-06-01T12:00:00+08:00', confidence: 'measured' },
    { value: 2000, ts: '2026-06-01T15:00:00+08:00', confidence: 'stale' },
    { value: 500, ts: '2026-06-01T18:00:00+08:00', confidence: 'estimated' },
  ];

  it('max/min/avg 计算正确', () => {
    const { max, min, avg } = computeCrowdStats(samples, '2026-06-01');
    expect(max).toBe(3000);
    expect(min).toBe(500);
    expect(avg).toBe(Math.round((1000 + 3000 + 2000 + 500) / 4));
  });

  it('peak 指向最大值样本', () => {
    const { peak } = computeCrowdStats(samples, '2026-06-01');
    expect(peak.value).toBe(3000);
  });

  it('peakHour 从 ts 字符串第 11-13 位解析', () => {
    const { peakHour } = computeCrowdStats(samples, '2026-06-01');
    expect(peakHour).toBe(12);
  });

  it('confidence 计数正确', () => {
    const { measured, stale, estimated } = computeCrowdStats(samples, '2026-06-01');
    expect(measured).toBe(2);
    expect(stale).toBe(1);
    expect(estimated).toBe(1);
  });

  it('keeps in-park sample sum separate from total visitors', () => {
    const { sampleValueSum, totalVisitors } = computeCrowdStats(samples, '2026-06-01');
    expect(sampleValueSum).toBe(1000 + 3000 + 2000 + 500);
    expect(totalVisitors).toBeUndefined();
  });

  it('weekday (wd) 与日期对应：2026-06-01 是周一 → wd=0', () => {
    const { wd } = computeCrowdStats(samples, '2026-06-01');
    expect(wd).toBe(0); // Monday
  });
});
