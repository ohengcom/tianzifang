import { describe, expect, it } from 'vitest';
import { estimateFromHistory, validateDate, weatherBucket } from './query.js';

describe('validateDate', () => {
  it('accepts YYYY-MM-DD dates', () => {
    expect(validateDate('2026-06-09')).toBe('2026-06-09');
  });

  it('rejects missing or malformed dates', () => {
    expect(() => validateDate()).toThrow('Invalid date format');
    expect(() => validateDate('2026/06/09')).toThrow('Invalid date format');
  });
});

describe('weatherBucket', () => {
  it('groups common weather descriptions', () => {
    expect(weatherBucket('小雨')).toBe('rain');
    expect(weatherBucket('Sunny')).toBe('clear');
    expect(weatherBucket('多云')).toBe('cloudy');
    expect(weatherBucket('雾')).toBe('poor_visibility');
  });
});

describe('estimateFromHistory', () => {
  it('uses historical averages when samples exist', () => {
    expect(estimateFromHistory([[5100.4, 9800.8, 3]], 'weekday')).toEqual({
      avg: 5100,
      max: 9801,
      sampleCount: 3,
    });
  });

  it('falls back to the configured default without samples', () => {
    expect(estimateFromHistory([[null, null, 0]], 'weekend')).toEqual({
      avg: 7000,
      max: 12250,
      sampleCount: 0,
    });
  });
});
