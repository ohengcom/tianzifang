import { describe, expect, it } from 'vitest';
import { validateDate } from './query.js';

describe('validateDate', () => {
  it('accepts YYYY-MM-DD dates', () => {
    expect(validateDate('2026-06-09')).toBe('2026-06-09');
  });

  it('rejects missing or malformed dates', () => {
    expect(() => validateDate()).toThrow('Invalid date format');
    expect(() => validateDate('2026/06/09')).toThrow('Invalid date format');
  });
});
