/**
 * Harness V2 Types — Shared Type Declarations for the Greenfield Distributed LLM Harness.
 *
 * Designed to be pure types (no runtime values) so Vite and Node/tsx can consume without bundling issues.
 */

export type TaskPhase = 'plan' | 'implement' | 'verify' | 'evaluate' | 'complete' | 'failed';

export type ActionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface HarnessBudget {
  maxTokens: number;
  tokensUsed: number;
  maxTurns: number;
  turnsCompleted: number;
  allowAdaptiveExtension?: boolean;
}

export interface TurnToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TurnToolResult {
  toolCallId: string;
  toolName: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  isError?: boolean;
}

export interface ActionGateVerdict {
  allowed: boolean;
  riskLevel: ActionRiskLevel;
  refusalReason?: string;
  sanitizedArgs?: Record<string, unknown>;
}

export interface TurnExecutionStep {
  turnIndex: number;
  phase: TaskPhase;
  timestamp: string;
  inference: {
    promptTokens: number;
    completionTokens: number;
    reasoning?: string;
    content?: string;
    toolCalls: TurnToolCall[];
  };
  actionGate: {
    passed: boolean;
    riskLevel: ActionRiskLevel;
    refusalReason?: string;
  };
  toolResults: TurnToolResult[];
}

export interface EvaluationCriterionResult {
  score: number; // 0 - 100
  weight: number;
  passed: boolean;
  feedback: string;
}

export interface TaskEvaluationVerdict {
  score: number; // 0 - 100
  passed: boolean;
  rubricBreakdown: Record<string, EvaluationCriterionResult>;
  evaluatorNotes: string;
  timestamp: string;
}

export interface TaskCheckpoint {
  turnIndex: number;
  phase: TaskPhase;
  timestamp: string;
  gitSha?: string;
  handoffArtifactPath?: string;
  summary: string;
}

export interface HarnessTask {
  id: string;
  projectId?: string;
  title: string;
  description: string;
  personaId: string;
  phase: TaskPhase;
  budget: HarnessBudget;
  status: 'pending' | 'running' | 'paused' | 'evaluating' | 'succeeded' | 'failed';
  checkpoints: TaskCheckpoint[];
  verdict?: TaskEvaluationVerdict;
  createdAt: string;
  updatedAt: string;
}
