import { describe, it, expect } from 'vitest';
import {
  calculateNgramEntropy,
  ThoughtFeatureExtractor,
  predictFailure,
  updateModelProfile,
  type ModelThinkingProfile,
} from './thinking-classifier.js';

describe('thinking-classifier', () => {
  it('calculates entropy and repetition density correctly', () => {
    const diverseText = 'The quick brown fox jumps over the lazy dog and runs into the forest';
    const stats1 = calculateNgramEntropy(diverseText);
    expect(stats1.entropy).toBeGreaterThan(0.7);
    expect(stats1.maxRepeat).toBe(1);

    const repetitiveText = "Wait I should check. Wait I should check. Wait I should check. Wait I should check.";
    const stats2 = calculateNgramEntropy(repetitiveText);
    expect(stats2.maxRepeat).toBeGreaterThanOrEqual(4);
    expect(stats2.repetitionDensity).toBeGreaterThan(0.4);
  });

  it('predicts failure for repetitive loop streams', () => {
    const extractor = new ThoughtFeatureExtractor('hows it going');
    for (let i = 0; i < 35; i++) {
      extractor.pushReasoning("Wait I should check if user needs leaves. ");
    }
    const features = extractor.extract();
    const prediction = predictFailure(features, undefined, 'high', 0.80);

    expect(prediction.shouldInterrupt).toBe(true);
    expect(prediction.reason).toContain('loop');
  });

  it('allows healthy reasoning stream on complex prompts', () => {
    const extractor = new ThoughtFeatureExtractor('Refactor the database schema and implement caching');
    extractor.pushReasoning('Analyzing existing index structures and schema dependencies for performance.');
    const features = extractor.extract();
    const prediction = predictFailure(features);

    expect(prediction.shouldInterrupt).toBe(false);
    expect(prediction.pFailure).toBeLessThan(0.80);
  });

  it('updates system-wide global model profiles correctly', () => {
    const extractor = new ThoughtFeatureExtractor('hows it going');
    extractor.pushReasoning('Checking user intention and prompt structure.');
    const features = extractor.extract();

    const profile1 = updateModelProfile(undefined, 'qwen3', features, 'success');
    expect(profile1.successSamples).toBe(1);
    expect(profile1.modelId).toBe('qwen3');

    const profile2 = updateModelProfile(profile1, 'qwen3', features, 'failure');
    expect(profile2.successSamples).toBe(1);
    expect(profile2.failureSamples).toBe(1);
  });
});
