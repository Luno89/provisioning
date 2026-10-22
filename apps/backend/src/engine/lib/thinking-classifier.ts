
export interface ThoughtFeatureVector {
  reasoningTokens: number;
  promptTokens: number;
  ngramEntropy: number;
  repetitionDensity: number;
  uniqueNgramRatio: number;
  maxNgramRepeatCount: number;
}

export interface ModelThinkingProfile {
  modelId: string;
  successSamples: number;
  failureSamples: number;
  avgSuccessEntropy: number;
  avgFailureEntropy: number;
  avgSuccessRepetition: number;
  avgFailureRepetition: number;
  avgSuccessThoughtLength: number;
  avgFailureThoughtLength: number;
  updatedAt: string;
}

export function calculateNgramEntropy(text: string, n = 3): { entropy: number; repetitionDensity: number; maxRepeat: number; uniqueRatio: number } {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < n) {
    return { entropy: 1.0, repetitionDensity: 0, maxRepeat: 1, uniqueRatio: 1.0 };
  }

  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }

  const counts = new Map<string, number>();
  let maxRepeat = 1;
  for (const gram of ngrams) {
    const next = (counts.get(gram) ?? 0) + 1;
    counts.set(gram, next);
    if (next > maxRepeat) maxRepeat = next;
  }

  const total = ngrams.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  const maxPossibleEntropy = Math.log2(total || 1);
  const normalizedEntropy = maxPossibleEntropy > 0 ? entropy / maxPossibleEntropy : 1.0;

  const uniqueRatio = counts.size / total;
  const repetitionDensity = 1.0 - uniqueRatio;

  return {
    entropy: Number.isFinite(normalizedEntropy) ? Math.max(0, Math.min(1, normalizedEntropy)) : 1.0,
    repetitionDensity,
    maxRepeat,
    uniqueRatio,
  };
}

export class ThoughtFeatureExtractor {
  private reasoningText = '';
  private promptTokens = 0;

  constructor(promptText = '') {
    this.promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
  }

  pushReasoning(chunk: string): void {
    this.reasoningText += chunk;
  }

  extract(): ThoughtFeatureVector {
    const stats = calculateNgramEntropy(this.reasoningText, 3);
    const reasoningTokens = Math.ceil(this.reasoningText.length / 4);

    return {
      reasoningTokens,
      promptTokens: this.promptTokens,
      ngramEntropy: stats.entropy,
      repetitionDensity: stats.repetitionDensity,
      uniqueNgramRatio: stats.uniqueRatio,
      maxNgramRepeatCount: stats.maxRepeat,
    };
  }

  getText(): string {
    return this.reasoningText;
  }
}

export function predictFailure(
  features: ThoughtFeatureVector,
  profile?: ModelThinkingProfile,
  sensitivity: 'low' | 'medium' | 'high' = 'medium',
  /**
   * 0.85 made every formulaic path below unreachable at 'medium' sensitivity (its 0.85 multiplier
   * caps them at 0.7225/0.765/0.697) — verified live against a real repetition loop that this
   * function never flagged. 0.65 is the default callers actually rely on now.
   */
  threshold = 0.65,
  ngramRepeatCap = 5
): { pFailure: number; shouldInterrupt: boolean; reason?: string } {
  if (features.reasoningTokens < 250) {
    return { pFailure: 0.05, shouldInterrupt: false };
  }

  const sensitivityMultiplier = sensitivity === 'high' ? 1.2 : sensitivity === 'low' ? 0.6 : 0.85;

  if (features.maxNgramRepeatCount > ngramRepeatCap && features.repetitionDensity > 0.55) {
    const pFailure = Math.min(0.99, 0.85 * sensitivityMultiplier);
    return {
      pFailure,
      shouldInterrupt: pFailure >= threshold,
      reason: `N-gram repetition loop detected (sequence repeated ${features.maxNgramRepeatCount} times)`,
    };
  }

  if (features.reasoningTokens > 300 && features.ngramEntropy < 0.25) {
    const pFailure = Math.min(0.99, 0.90 * sensitivityMultiplier);
    return {
      pFailure,
      shouldInterrupt: pFailure >= threshold,
      reason: `Low reasoning entropy detected (${features.ngramEntropy.toFixed(2)})`,
    };
  }

  if (profile && (profile.successSamples + profile.failureSamples) >= 5) {
    const distToFailure = Math.abs(features.ngramEntropy - profile.avgFailureEntropy) +
      Math.abs(features.repetitionDensity - profile.avgFailureRepetition);
    const distToSuccess = Math.abs(features.ngramEntropy - profile.avgSuccessEntropy) +
      Math.abs(features.repetitionDensity - profile.avgSuccessRepetition);

    if (distToFailure < distToSuccess && (distToSuccess - distToFailure) > 0.3) {
      const pFailure = Math.min(0.95, (0.75 + (distToSuccess - distToFailure)) * sensitivityMultiplier);
      return {
        pFailure,
        shouldInterrupt: pFailure >= threshold,
        reason: `Trajectory matches known model failure profile (${profile.modelId})`,
      };
    }
  }

  if (features.promptTokens < 15 && features.reasoningTokens > 1200) {
    const pFailure = Math.min(0.95, 0.82 * sensitivityMultiplier);
    return {
      pFailure,
      shouldInterrupt: pFailure >= threshold,
      reason: `Overthinking loop detected (${features.reasoningTokens} reasoning tokens for simple prompt)`,
    };
  }

  return { pFailure: 0.1, shouldInterrupt: false };
}

export function updateModelProfile(
  existing: ModelThinkingProfile | undefined,
  modelId: string,
  features: ThoughtFeatureVector,
  outcome: 'success' | 'failure'
): ModelThinkingProfile {
  const current: ModelThinkingProfile = existing ?? {
    modelId,
    successSamples: 0,
    failureSamples: 0,
    avgSuccessEntropy: 0.85,
    avgFailureEntropy: 0.30,
    avgSuccessRepetition: 0.15,
    avgFailureRepetition: 0.60,
    avgSuccessThoughtLength: 300,
    avgFailureThoughtLength: 1200,
    updatedAt: new Date().toISOString(),
  };

  const isSuccess = outcome === 'success';
  const count = isSuccess ? current.successSamples : current.failureSamples;
  const newCount = count + 1;

  const updateAvg = (oldVal: number, newVal: number) => (oldVal * count + newVal) / newCount;

  return {
    ...current,
    modelId,
    successSamples: isSuccess ? newCount : current.successSamples,
    failureSamples: !isSuccess ? newCount : current.failureSamples,
    avgSuccessEntropy: isSuccess ? updateAvg(current.avgSuccessEntropy, features.ngramEntropy) : current.avgSuccessEntropy,
    avgFailureEntropy: !isSuccess ? updateAvg(current.avgFailureEntropy, features.ngramEntropy) : current.avgFailureEntropy,
    avgSuccessRepetition: isSuccess ? updateAvg(current.avgSuccessRepetition, features.repetitionDensity) : current.avgSuccessRepetition,
    avgFailureRepetition: !isSuccess ? updateAvg(current.avgFailureRepetition, features.repetitionDensity) : current.avgFailureRepetition,
    avgSuccessThoughtLength: isSuccess ? updateAvg(current.avgSuccessThoughtLength, features.reasoningTokens) : current.avgSuccessThoughtLength,
    avgFailureThoughtLength: !isSuccess ? updateAvg(current.avgFailureThoughtLength, features.reasoningTokens) : current.avgFailureThoughtLength,
    updatedAt: new Date().toISOString(),
  };
}
