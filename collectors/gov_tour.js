import { BaseCollector } from './base.js';

const TOURIST_API = 'https://tourist.whlyj.sh.gov.cn/api/statistics/getViewTourist';
const TIANZIFANG_NAMES = ['上海田子坊景区', '田子坊'];

export class GovTourCollector extends BaseCollector {
  constructor() {
    super();
    this.name = 'gov_tour';
  }

  async collect() {
    const now = new Date();
    const _hour = parseInt(
      now.toLocaleTimeString('en-US', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit' }),
      10,
    );
    const weekday = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();
    const _month = now.toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric' }) * 1;
    const _wd = weekday === 0 ? 6 : weekday - 1;

    // 官方数据源：上海市A级景区实时发布系统。
    // 页面实际调用 /api/statistics/getViewTourist，返回全市A级景区实时客流；
    // 其中田子坊记录 NAME=上海田子坊景区，字段 NUM=在园人数，MAX_NUM=瞬时最大承载量，SSD=舒适度。
    try {
      const resp = await fetch(TOURIST_API, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
          Referer: 'https://tourist.whlyj.sh.gov.cn/MobileWebSite/Tourist_Main.html',
        },
      });

      if (resp.ok) {
        const data = await resp.json();
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        const spot = rows.find((r) => TIANZIFANG_NAMES.some((name) => String(r.NAME || '').includes(name)));
        if (spot && spot.NUM !== undefined && spot.NUM !== null) {
          // 检查官方 TIME 是否过期（与当前时间差 > 30 分钟）
          const _confidence = 'measured';
          const meta = {
            source: 'sh_a_scenic_realtime',
            api: TOURIST_API,
            code: spot.CODE,
            name: spot.NAME,
            time: spot.TIME,
            grade: spot.GRADE,
            comfort: spot.SSD,
            max_num: spot.MAX_NUM,
            type: spot.TYPE,
            district: spot.DNAME,
          };
          if (spot.TIME) {
            const apiTime = new Date(`${spot.TIME.replace(' ', 'T')}+08:00`);
            const diffMin = (Date.now() - apiTime.getTime()) / 60000;
            if (diffMin > 30) {
              // API数据已过期（官方停止更新），不存储
              return [];
            }
          }
          return [['in_park_count', Number(spot.NUM), '人', 'measured', meta]];
        }
      }
    } catch (_e) {
      // 失败时进入估算降级，避免采集中断。
    }

    // API数据不可用时不存储
    return [];
  }
}
