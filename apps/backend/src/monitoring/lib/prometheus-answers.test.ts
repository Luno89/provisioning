import { describe, expect, it } from 'vitest';
import { answeredHistory, answeredPoints, answeredSamples, firstRange, instantSamples, promAlerts, promAnswer } from './prometheus-answers.js';

describe('what Prometheus answers', () => {
  it('is its data when it says success, and its error when it does not', () => {
    expect(promAnswer(true, 200, { status: 'success', data: { result: [] } })).toEqual({ result: [] });
    expect(() => promAnswer(false, 400, { status: 'error', error: 'parse error at char 3' })).toThrow('Prometheus answered 400: parse error at char 3');
    expect(() => promAnswer(true, 200, {})).toThrow('Prometheus answered 200');
  });

  it('reads instant samples and a range, leaving out points that are not numbers', () => {
    expect(instantSamples({ result: [{ metric: { service: 'web' }, value: [1, '0.5'] }] })).toEqual([{ metric: { service: 'web' }, value: 0.5 }]);
    expect(firstRange({ result: [{ values: [[1, '2'], [2, 'NaN'], [3, '4']] }] })).toEqual([[1, 2], [3, 4]]);
    expect(firstRange({ result: [] })).toEqual([]);
  });

  it('refuses a sample that is not a time and a value rather than reading it as zero', () => {
    expect(() => instantSamples({ result: [{ metric: {} }] })).toThrow('not a time and a value');
    expect(() => instantSamples({ result: [{ metric: 'web', value: [1, '1'] }] })).toThrow('not a set of labels');
  });

  it('reads alerts with only the fields they carry', () => {
    expect(promAlerts({ alerts: [{ labels: { alertname: 'Koala_down' }, state: 'firing', activeAt: 'then' }, { labels: {}, annotations: { summary: 's' }, state: 'pending', value: '1' }] })).toEqual([
      { labels: { alertname: 'Koala_down' }, state: 'firing', activeAt: 'then' },
      { labels: {}, annotations: { summary: 's' }, state: 'pending', value: '1' },
    ]);
  });

  it('reads what root answers for a pool instance', () => {
    expect(answeredSamples({ samples: [{ metric: {}, value: 1 }] })).toEqual([{ metric: {}, value: 1 }]);
    expect(answeredPoints({ points: [[1, 2]] })).toEqual([[1, 2]]);
    expect(answeredHistory({ days: 10, kept: 4 })).toEqual({ days: 10, kept: 4 });
    expect(answeredHistory({ days: 10 })).toEqual({ days: 10 });
    expect(() => answeredHistory({})).toThrow('without saying how many days');
  });
});
