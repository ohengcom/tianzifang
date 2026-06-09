import { AMAP_API_KEY, TIANZIFANG_LAT, TIANZIFANG_LNG } from '../config/settings.js';
import { BaseCollector } from './base.js';

export class AmapCollector extends BaseCollector {
  constructor() {
    super();
    this.name = 'amap';
  }

  async collect() {
    if (!AMAP_API_KEY) {
      return [['congestion_index', null, 'index', 'unavailable', { reason: 'no_api_key' }]];
    }

    const records = [];

    try {
      const url = `https://restapi.amap.com/v3/traffic/status/road?key=${AMAP_API_KEY}&name=泰康路&city=上海&extensions=all`;
      const data = await this.fetchJSON(url);
      if (data.status === '1' && data.trafficinfo?.roads) {
        for (const road of data.trafficinfo.roads.slice(0, 3)) {
          records.push([
            'road_congestion',
            parseFloat(road.speed || 0),
            'km/h',
            'measured',
            { road: road.name, direction: road.direction },
          ]);
        }
      }
    } catch {}

    try {
      const url = `https://restapi.amap.com/v3/place/around?key=${AMAP_API_KEY}&location=${TIANZIFANG_LNG},${TIANZIFANG_LAT}&radius=500&types=050000&offset=25&page=1`;
      const data = await this.fetchJSON(url);
      if (data.status === '1') {
        records.push([
          'nearby_poi_count',
          parseInt(data.count || 0, 10),
          '个',
          'measured',
          { type: '餐饮', radius: '500m' },
        ]);
      }
    } catch {}

    return records.length ? records : [['amap_status', 0, 'no_data', 'unavailable', { reason: 'no_results' }]];
  }
}
