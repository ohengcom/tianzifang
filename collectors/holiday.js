import { BaseCollector } from './base.js';

// 2026年国务院办公厅放假安排（国办发明电〔2025〕7号）
const CN_HOLIDAYS_2026 = [
  // 元旦 1/1-3
  [1, 1, '元旦'],
  [1, 2, '元旦假期'],
  [1, 3, '元旦假期'],
  // 春节 2/15-23（腊月二十八至正月初七）
  [2, 15, '春节假期'],
  [2, 16, '除夕'],
  [2, 17, '春节'],
  [2, 18, '春节假期'],
  [2, 19, '春节假期'],
  [2, 20, '春节假期'],
  [2, 21, '春节假期'],
  [2, 22, '春节假期'],
  [2, 23, '春节假期'],
  // 清明 4/4-6
  [4, 4, '清明节'],
  [4, 5, '清明假期'],
  [4, 6, '清明假期'],
  // 劳动节 5/1-5
  [5, 1, '劳动节'],
  [5, 2, '劳动节假期'],
  [5, 3, '劳动节假期'],
  [5, 4, '劳动节假期'],
  [5, 5, '劳动节假期'],
  // 端午 6/19-21
  [6, 19, '端午节'],
  [6, 20, '端午假期'],
  [6, 21, '端午假期'],
  // 中秋 9/25-27
  [9, 25, '中秋节'],
  [9, 26, '中秋假期'],
  [9, 27, '中秋假期'],
  // 国庆 10/1-7
  [10, 1, '国庆节'],
  [10, 2, '国庆假期'],
  [10, 3, '国庆假期'],
  [10, 4, '国庆假期'],
  [10, 5, '国庆假期'],
  [10, 6, '国庆假期'],
  [10, 7, '国庆假期'],
];

// 调休上班日
const CN_WORKDAYS_2026 = [
  [1, 4, '元旦调休上班'],
  [2, 14, '春节调休上班'],
  [2, 28, '春节调休上班'],
  [5, 9, '劳动节调休上班'],
  [9, 20, '国庆调休上班'],
  [10, 10, '国庆调休上班'],
];

export class HolidayCollector extends BaseCollector {
  constructor() {
    super();
    this.name = 'holiday';
    this._lastCollectedDate = null;
  }

  async collect() {
    const today = this.todayStr();

    // 每天只采集一次，避免重复写入相同的节假日数据
    if (this._lastCollectedDate === today) {
      return []; // 返回空数组，save 会跳过
    }
    this._lastCollectedDate = today;

    const now = new Date();
    const month = now.toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric' }) * 1;
    const day = now.toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai', day: 'numeric' }) * 1;
    const weekday = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();
    // Convert: JS Sunday=0 → Monday=0
    const wd = weekday === 0 ? 6 : weekday - 1;

    let isHoliday = 0;
    let holidayName = '';

    for (const [m, d, name] of CN_HOLIDAYS_2026) {
      if (m === month && d === day) {
        isHoliday = 1;
        holidayName = name;
        break;
      }
    }

    let isWorkdayOverride = false;
    for (const [m, d, name] of CN_WORKDAYS_2026) {
      if (m === month && d === day) {
        isWorkdayOverride = true;
        holidayName = name;
        break;
      }
    }

    const isWorkday = (wd < 5 && !isHoliday) || isWorkdayOverride ? 1 : 0;

    return [
      ['is_holiday', isHoliday, 'bool', 'measured', { holiday_name: holidayName }],
      ['is_workday', isWorkday, 'bool', 'measured', { weekday: wd, override: isWorkdayOverride }],
      ['weekday', wd, 'day', 'measured', {}],
    ];
  }
}
