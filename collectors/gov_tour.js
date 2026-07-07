import { BaseCollector } from './base.js';

const TOURIST_API = 'https://tourist.whlyj.sh.gov.cn/api/statistics/getViewTourist';
const TIANZIFANG_NAMES = ['上海田子坊景区', '田子坊'];

export class GovTourCollector extends BaseCollector {
  constructor() {
    super();
    this.name = 'gov_tour';
  }

  async collect() {
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

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      let data;
      try {
        data = await resp.json();
      } catch (error) {
        throw new Error(`Invalid JSON: ${error.message}`);
      }

      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const spot = rows.find((r) => TIANZIFANG_NAMES.some((name) => String(r.NAME || '').includes(name)));
      if (spot && spot.NUM !== undefined && spot.NUM !== null) {
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
    } catch (e) {
      console.error(`[gov_tour] 请求失败: ${e.message}`);
      throw e;
    }

    // API正常响应但未包含田子坊新鲜数据时不存储。
    return [];
  }
}
