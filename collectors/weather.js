import { BaseCollector } from './base.js';

export class WeatherCollector extends BaseCollector {
  constructor() {
    super();
    this.name = 'weather';
  }

  async collect() {
    const records = [];
    try {
      const data = await this.fetchJSON('https://wttr.in/Shanghai?format=j1');
      const current = data.current_condition?.[0] || {};
      const temp = parseFloat(current.temp_C || 0);
      const feelsLike = parseFloat(current.FeelsLikeC || 0);
      const humidity = parseInt(current.humidity || 0, 10);
      const windSpeed = parseFloat(current.windspeedKmph || 0);
      const desc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || '';

      records.push(['temperature', temp, '℃', 'measured', { feels_like: feelsLike }]);
      records.push(['humidity', humidity, '%', 'measured', {}]);
      records.push(['wind_speed', windSpeed, 'km/h', 'measured', {}]);

      const today = data.weather?.[0] || {};
      if (today.maxtempC) {
        records.push(['temperature_max', parseFloat(today.maxtempC), '℃', 'measured', {}]);
        records.push(['temperature_min', parseFloat(today.mintempC), '℃', 'measured', {}]);
      }

      records.push(['weather_desc', 0, desc, 'measured', { raw: current }]);
    } catch (e) {
      records.push(['weather_status', 0, 'error', 'unavailable', { error: e.message }]);
    }
    return records;
  }
}
