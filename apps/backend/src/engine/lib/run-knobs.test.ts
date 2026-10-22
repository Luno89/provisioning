import { describe, it, expect } from 'vitest';
import { samplingAt, temperatureProblem, replyTokensProblem } from './run-knobs.js';
import { resolveSampling } from '@koala/agent-engine';

describe('run knobs', () => {
  it('builds a sampling config the model request actually reads on both kinds of turn', () => {
    const sampling = samplingAt(0.6);

    expect(resolveSampling(sampling, 'tool-turn', undefined).body).toMatchObject({ temperature: 0.6 });
    expect(resolveSampling(sampling, 'conversation', undefined).body).toMatchObject({ temperature: 0.6 });
  });

  it('accepts a missing temperature and refuses one out of range or not a number', () => {
    expect(temperatureProblem(undefined)).toBeUndefined();
    expect(temperatureProblem(0)).toBeUndefined();
    expect(temperatureProblem(2)).toBeUndefined();
    expect(temperatureProblem(2.1)).toMatch(/between 0 and 2/);
    expect(temperatureProblem(-0.1)).toMatch(/between 0 and 2/);
    expect(temperatureProblem('0.6')).toMatch(/between 0 and 2/);
    expect(temperatureProblem(Number.NaN)).toMatch(/between 0 and 2/);
  });

  it('accepts a missing reply cap and refuses fractions or values out of range', () => {
    expect(replyTokensProblem(undefined)).toBeUndefined();
    expect(replyTokensProblem(4096)).toBeUndefined();
    expect(replyTokensProblem(255)).toMatch(/between 256 and 32000/);
    expect(replyTokensProblem(32_001)).toMatch(/between 256 and 32000/);
    expect(replyTokensProblem(1024.5)).toMatch(/between 256 and 32000/);
  });
});
