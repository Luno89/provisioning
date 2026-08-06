/**
 * System-Wide ML Thinking Cycle Classifier & Failure Predictor.
 *
 * Evaluates streaming model reasoning in real-time using model-specific probabilistic features:
 *   - N-Gram Entropy: Shannon entropy of reasoning tokens (measures vocabulary diversity vs loops).
 *   - Repetition Density: Ratio of repeated n-gram sequences to total sequence length.
 *   - Reasoning Token Count & Velocity: Total tokens spent thinking.
 *   - Prompt-to-Thought Complexity Ratio: Ratio of thought length to prompt length.
 *
 * Profiles are saved system-wide in MongoDB without user partitioning, enabling shared learning
 * across all users on the platform.
 */

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

/**
 * Calculates Shannon entropy of n-grams in a text string.
 */
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

  // Normalised entropy (0 to 1)
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

/**
 * Extracts streaming feature vector from reasoning text.
 */
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

/**
 * Parses SSE chunks to extract raw reasoning text string without JSON wrapper tokens.
 */
export class ReasoningScanner {
  private buffer = '';
  private text = '';

  push(chunk: string): string {
    let added = '';
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoning =
          (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') ||
          (typeof delta.reasoning === 'string' ? delta.reasoning : '') ||
          (typeof delta.thinking === 'string' ? delta.thinking : '');
        if (reasoning) {
          added += reasoning;
          this.text += reasoning;
        }
      } catch {
        // Partial or non-JSON frames are normal mid-stream.
      }
    }
    return added;
  }

  result(): string {
    return this.text;
  }
}

/**
 * Predicts the probability of reasoning failure (0.0 to 1.0) using streaming features & global profile.
 */
export function predictFailure(
  features: ThoughtFeatureVector,
  profile?: ModelThinkingProfile,
  sensitivity: 'low' | 'medium' | 'high' = 'medium',
  threshold = 0.85,
  ngramRepeatCap = 5
): { pFailure: number; shouldInterrupt: boolean; reason?: string } {
  // Never interrupt short reasoning streams under 250 tokens — give the model ample room to think naturally
  if (features.reasoningTokens < 250) {
    return { pFailure: 0.05, shouldInterrupt: false };
  }

  // Sensitivity multipliers adjust probability scaling
  const sensitivityMultiplier = sensitivity === 'high' ? 1.2 : sensitivity === 'low' ? 0.6 : 0.85;

  // 1. Extreme N-Gram Loop check (e.g. repeated sequence 6+ times with > 55% repetition density)
  if (features.maxNgramRepeatCount > ngramRepeatCap && features.repetitionDensity > 0.55) {
    const pFailure = Math.min(0.99, 0.85 * sensitivityMultiplier);
    return {
      pFailure,
      shouldInterrupt: pFailure >= threshold,
      reason: `N-gram repetition loop detected (sequence repeated ${features.maxNgramRepeatCount} times)`,
    };
  }

  // 2. Severe Entropy Loss check (vocab diversity collapses after 300+ reasoning tokens)
  if (features.reasoningTokens > 300 && features.ngramEntropy < 0.25) {
    const pFailure = Math.min(0.99, 0.90 * sensitivityMultiplier);
    return {
      pFailure,
      shouldInterrupt: pFailure >= threshold,
      reason: `Low reasoning entropy detected (${features.ngramEntropy.toFixed(2)})`,
    };
  }

  // 3. System-Wide Profile Distance Check
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

  // 4. Overthinking on Simple Prompt (e.g., > 1200 reasoning tokens on a < 15 prompt token input)
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

/**
 * Updates a model's system-wide global thinking profile with new turn sample data.
 */
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
