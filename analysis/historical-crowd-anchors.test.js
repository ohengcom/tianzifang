import { describe, expect, it } from 'vitest';
import { parseHistoricalCrowdAnchors, toHistoricalCrowdObservation } from '../v2/historical-crowd-anchors.js';

describe('historical crowd anchors', () => {
  const anchor = {
    id: 'example-anchor',
    observedAt: '2025-05-01',
    metric: 'reported_peak_daily_visitors',
    granularity: 'period',
    valueNum: 40000,
    unit: 'person-visits/day',
    quality: 'reported',
    confidence: 0.72,
    comparator: 'gte',
    source: {
      sourceId: 'reported_crowd_test',
      sourceType: 'government_report',
      displayName: 'Test reported crowd source',
      reliability: 0.7,
    },
    period: { start: '2025-05-01', end: '2025-05-05', precision: 'holiday period' },
    provenance: {
      title: 'Reported crowd source',
      url: 'https://example.com/report',
      publisher: 'Example publisher',
      publishedAt: '2025-05-08',
      quote: 'Visitors exceeded 40000 per day.',
      retrievedAt: '2026-07-07',
      verification: 'Fixture verified by test.',
    },
  };

  it('validates anchors and preserves source metadata', () => {
    const [parsed] = parseHistoricalCrowdAnchors([anchor]);
    expect(parsed.source.sourceId).toBe('reported_crowd_test');
    expect(parsed.valueNum).toBe(40000);
  });

  it('normalizes day-only timestamps and keeps provenance in raw payload', () => {
    const observation = toHistoricalCrowdObservation(anchor, { runId: 12 });
    expect(observation.observedAt).toBe('2025-05-01T00:00:00+08:00');
    expect(observation.granularity).toBe('period');
    expect(observation.runId).toBe(12);
    expect(observation.raw.provenance.url).toBe('https://example.com/report');
  });

  it('supports activity anchors without inventing numeric crowd values', () => {
    const activity = {
      ...anchor,
      id: 'activity-anchor',
      metric: 'activity_event',
      valueNum: undefined,
      valueText: 'large-crowd volunteer service',
      unit: undefined,
    };
    const [parsed] = parseHistoricalCrowdAnchors([activity]);
    const observation = toHistoricalCrowdObservation(parsed);
    expect(observation.valueNum).toBeNull();
    expect(observation.valueText).toBe('large-crowd volunteer service');
    expect(observation.metric).toBe('activity_event');
  });
});
