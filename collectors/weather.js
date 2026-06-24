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
      const temp = current.temp_C != null ? parseFloat(current.temp_C) : null;
      const feelsLike = current.FeelsLikeC != null ? parseFloat(current.FeelsLikeC) : null;
      const humidity = current.humidity != null ? parseInt(current.humidity, 10) : null;
      const windSpeed = current.windspeedKmph != null ? parseFloat(current.windspeedKmph) : null;
      const desc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || '';

      records.push(['temperature', temp, '℃', 'measured', { feels_like: feelsLike }]);
      records.push(['humidity', humidity, '%', 'measured', {}]);
      records.push(['wind_speed', windSpeed, 'km/h', 'measured', {}]);

      const today = data.weather?.[0] || {};
      if (today.maxtempC != null) {
        records.push(['temperature_max', parseFloat(today.maxtempC), '℃', 'measured', {}]);
        records.push(['temperature_min', parseFloat(today.mintempC), '℃', 'measured', {}]);
      }

      records.push(['weather_desc', null, desc, 'measured', { raw: current }]);
    } catch (e) {
      records.push(['weather_status', null, 'error', 'unavailable', { error: e.message }]);
    }
    return records;
  }
}
