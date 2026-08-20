/**
 * Durable Turn Runner for Harness V2.
 *
 * Executes a single discrete agent turn with Action Gate policy evaluation,
 * sandbox tool execution, and structured trace recording.
 */
import type { TurnExecutionStep, TurnToolCall, TurnToolResult, TaskPhase } from '@koala/harness-types';
import { ActionGate, type ActionGateContext } from '../safety/action-gate.js';
import { ContextManager } from './context-manager.js';

export interface SandboxDriver {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface SingleTurnOptions {
  taskId: string;
  turnIndex: number;
  phase: TaskPhase;
  personaId: string;
  personaRole?: string;
  workspacePath: string;
  sandbox: SandboxDriver;
  modelResponse: {
    promptTokens: number;
    completionTokens: number;
    reasoning?: string;
    content?: string;
    toolCalls: TurnToolCall[];
  };
}

export interface SingleTurnResult {
  step: TurnExecutionStep;
  finished: boolean;
  needsContextReset: boolean;
  finishSummary?: string;
}

export class DurableRunner {
  /**
   * Processes a single turn: intercepts tool calls through Action Gate and executes approved actions.
   */
  static async processTurn(opts: SingleTurnOptions): Promise<SingleTurnResult> {
    const gateContext: ActionGateContext = {
      taskId: opts.taskId,
      personaId: opts.personaId,
      personaRole: opts.personaRole,
      workspacePath: opts.workspacePath,
    };

    const toolResults: TurnToolResult[] = [];
    let finished = false;
    let finishSummary = '';
    let highestRisk: 'low' | 'medium' | 'high' | 'critical' = 'low';
    let anyRefusal = false;
    let refusalMsg = '';

    for (const call of opts.modelResponse.toolCalls) {
      if (call.name === 'finish') {
        finished = true;
        finishSummary = String(call.args.summary || opts.modelResponse.content || 'Task marked complete.');
        toolResults.push({
          toolCallId: call.id,
          toolName: 'finish',
          stdout: 'Finished successfully.',
          exitCode: 0,
        });
        continue;
      }

      // 1. Evaluate through Action Gate
      const verdict = ActionGate.evaluate({
        toolName: call.name,
        args: call.args,
        context: gateContext,
      });

      if (!verdict.allowed) {
        anyRefusal = true;
        refusalMsg = verdict.refusalReason || 'Blocked by Action Gate';
        if (verdict.riskLevel === 'critical' || (verdict.riskLevel === 'high' && highestRisk !== 'critical')) {
          highestRisk = verdict.riskLevel;
        }

        toolResults.push({
          toolCallId: call.id,
          toolName: call.name,
          stderr: ActionGate.formatRefusalResult(call.name, verdict),
          isError: true,
          exitCode: 1,
        });
        continue;
      }

      // 2. Execute Approved Tool
      try {
        if (call.name === 'run_command') {
          const cmd = String(call.args.command || '');
          const res = await opts.sandbox.exec(cmd);
          toolResults.push({
            toolCallId: call.id,
            toolName: 'run_command',
            stdout: res.stdout,
            stderr: res.stderr,
            exitCode: res.exitCode,
            isError: res.exitCode !== 0,
          });
        } else if (call.name === 'read_file') {
          const filePath = String(call.args.path || call.args.targetFile || '');
          const content = await opts.sandbox.readFile(filePath);
          toolResults.push({
            toolCallId: call.id,
            toolName: 'read_file',
            stdout: content,
            exitCode: 0,
          });
        } else if (call.name === 'write_file') {
          const filePath = String(call.args.path || call.args.targetFile || '');
          const content = String(call.args.content || '');
          await opts.sandbox.writeFile(filePath, content);
          toolResults.push({
            toolCallId: call.id,
            toolName: 'write_file',
            stdout: `Successfully wrote ${content.length} characters to ${filePath}`,
            exitCode: 0,
          });
        } else {
          toolResults.push({
            toolCallId: call.id,
            toolName: call.name,
            stdout: `Executed ${call.name}`,
            exitCode: 0,
          });
        }
      } catch (err: any) {
        toolResults.push({
          toolCallId: call.id,
          toolName: call.name,
          stderr: `Execution error: ${err.message}`,
          isError: true,
          exitCode: 1,
        });
      }
    }

    const step: TurnExecutionStep = {
      turnIndex: opts.turnIndex,
      phase: opts.phase,
      timestamp: new Date().toISOString(),
      inference: opts.modelResponse,
      actionGate: {
        passed: !anyRefusal,
        riskLevel: highestRisk,
        ...(anyRefusal ? { refusalReason: refusalMsg } : {}),
      },
      toolResults,
    };

    const needsContextReset = ContextManager.shouldResetContext(
      opts.turnIndex % 15,
      opts.modelResponse.promptTokens + opts.modelResponse.completionTokens,
    );

    return {
      step,
      finished,
      needsContextReset,
      finishSummary,
    };
  }
}
