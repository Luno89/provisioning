/**
 * Action Gate — Pre-Execution Policy Enforcement Layer for Harness V2.
 *
 * Sits directly between LLM Tool Call emission and Sandbox / MCP execution.
 */
import type { ActionGateVerdict, ActionRiskLevel } from '@koala/harness-types';
import { AstValidator } from './ast-validator.js';

export interface ActionGateContext {
  taskId: string;
  personaId: string;
  personaRole?: 'planner' | 'coder' | 'researcher' | 'evaluator' | 'reviewer' | string;
  workspacePath: string;
}

export interface ActionGateRequest {
  toolName: string;
  args: Record<string, unknown>;
  context: ActionGateContext;
}

export class ActionGate {
  /**
   * Evaluates an incoming tool call against persona capabilities, filesystem bounds, and command AST safety.
   */
  static evaluate(request: ActionGateRequest): ActionGateVerdict {
    const { toolName, args, context } = request;
    const role = context.personaRole?.toLowerCase() || 'coder';
    const workspaceRoot = context.workspacePath || '/work';

    // 1. Persona Role Restrictions
    if (role === 'researcher') {
      const writeTools = ['write_file', 'edit_file', 'replace_file_content', 'delete_file'];
      if (writeTools.includes(toolName)) {
        return {
          allowed: false,
          riskLevel: 'medium',
          refusalReason: `Persona role '${role}' is restricted to read-only tools and cannot invoke '${toolName}'.`,
        };
      }
    }

    if (role === 'evaluator') {
      const modifyingTools = ['run_command', 'write_file', 'edit_file', 'delete_file'];
      // Evaluator can only run read commands or inspection
      if (toolName === 'run_command') {
        const cmd = String(args.command || '');
        const isInspection = /^(npm\s+test|vitest|pytest|git\s+diff|git\s+status|cat|ls|find)\b/i.test(cmd.trim());
        if (!isInspection) {
          return {
            allowed: false,
            riskLevel: 'high',
            refusalReason: `Evaluator persona can only run non-mutating test/inspection commands. Command was: '${cmd}'.`,
          };
        }
      }
    }

    // 2. Tool-Specific Policy Checks
    if (toolName === 'run_command') {
      const command = String(args.command || '');
      const inspection = AstValidator.inspectCommand(command, workspaceRoot);

      if (!inspection.safe) {
        return {
          allowed: false,
          riskLevel: inspection.riskLevel,
          refusalReason: `Action Gate Refusal: ${inspection.violations.join('; ')}`,
        };
      }

      return {
        allowed: true,
        riskLevel: inspection.riskLevel,
      };
    }

    if (toolName === 'write_file' || toolName === 'read_file' || toolName === 'edit_file') {
      const filePath = String(args.path || args.targetFile || '');
      const pathCheck = AstValidator.validatePath(filePath, workspaceRoot);

      if (!pathCheck.valid) {
        return {
          allowed: false,
          riskLevel: 'high',
          refusalReason: `Action Gate Refusal: ${pathCheck.reason}`,
        };
      }

      return {
        allowed: true,
        riskLevel: 'low',
      };
    }

    // Default Allow for safe utility tools (web_search, fetch_web_page, finish, list_mcp_tools, etc.)
    return {
      allowed: true,
      riskLevel: 'low',
    };
  }

  /**
   * Formats a structured synthetic tool result for the LLM when an action is rejected by the gate,
   * enabling the model to immediately understand the constraint and self-correct without crashing.
   */
  static formatRefusalResult(toolName: string, verdict: ActionGateVerdict): string {
    return [
      `[ACTION GATE REFUSAL]`,
      `The action '${toolName}' was blocked by safety policy (${verdict.riskLevel} risk).`,
      `Reason: ${verdict.refusalReason || 'Operation not permitted in current scope.'}`,
      `Please revise your approach and use alternative tools within the workspace boundaries.`,
    ].join('\n');
  }
}
