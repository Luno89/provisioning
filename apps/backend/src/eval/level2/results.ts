import type { Check } from './score.js';

export interface CheckAttempt {
  runId: string;
  conversationId?: string | undefined;
  passed: boolean;
  durationMs: number;
  checks: Check[];
  calls: { name: string; ok: boolean; digest: string }[];
  error?: string | undefined;
}

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  runId: string;
  conversationId?: string | undefined;
  procedure: { id: string; version: string };
  passed: boolean;
  outcome: string;
  reason?: string | undefined;
  answer: string;
  checks: Check[];
  calls: { name: string; ok: boolean; digest: string }[];
  counters: { rounds: number; toolCalls: number; totalTokens: number };
  tasks: { id: string; title: string; status: string; evidence?: string | undefined }[];
  durationMs: number;
  error?: string | undefined;
  repeats?: number | undefined;
  passAt?: number | undefined;
  passedAttempts?: number | undefined;
  attempts?: CheckAttempt[] | undefined;
}
