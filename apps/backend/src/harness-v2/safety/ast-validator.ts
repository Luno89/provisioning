/**
 * AST Validator & Command Security Inspector for Harness V2.
 *
 * Enforces pre-execution policy checks on shell commands and file paths.
 */
import path from 'path';
import type { ActionRiskLevel } from '@koala/harness-types';

export interface CommandInspectionResult {
  safe: boolean;
  riskLevel: ActionRiskLevel;
  violations: string[];
  sanitizedCommand?: string;
}

// Critical patterns that indicate catastrophic or malicious shell operations
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(\/|\/\*|~\/|\.\.\/)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\b(shutdown|reboot|poweroff|init\s+0)\b/i,
  /\bchmod\s+(-R\s+)?(000|777)\s+\//i,
  /\bchown\s+(-R\s+)?root\s+\//i,
  /\b(curl|wget)\s+.*\|\s*(bash|sh|zsh)\b/i,
  /\bgit\s+push\s+.*(-f|--force).*\b(main|master|prod|production)\b/i,
];

// Sensitive system files and directories that must never be targeted by write/delete operations
const SENSITIVE_PATH_PATTERNS = [
  /^\/(etc|boot|sys|proc|dev|root)\b/,
  /^\/var\/(run|log|lib\/kubelet|lib\/rancher)/,
  /\.ssh(\/|$)/,
  /\.git\/config$/,
  /\.git\/hooks(\/|$)/,
  /\.env(\.production)?$/,
];

export class AstValidator {
  /**
   * Validates whether a file path stays strictly within the designated workspace boundary.
   */
  static validatePath(targetPath: string, workspaceRoot: string = '/work'): { valid: boolean; reason?: string } {
    if (!targetPath || typeof targetPath !== 'string') {
      return { valid: false, reason: 'Invalid path supplied' };
    }

    const normalizedTarget = path.normalize(targetPath);

    // Check sensitive path blacklist
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(normalizedTarget)) {
        return { valid: false, reason: `Access to sensitive path '${normalizedTarget}' is strictly prohibited` };
      }
    }

    // If path is relative, resolving against workspaceRoot is safe
    const resolved = path.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : path.resolve(workspaceRoot, normalizedTarget);

    const normalizedRoot = path.normalize(workspaceRoot);
    if (!resolved.startsWith(normalizedRoot) && !resolved.startsWith('/tmp/')) {
      return {
        valid: false,
        reason: `Path '${resolved}' escapes the designated workspace boundary '${normalizedRoot}'`,
      };
    }

    return { valid: true };
  }

  /**
   * Inspects a raw shell command for destructive patterns, out-of-bounds writes, and dangerous flags.
   */
  static inspectCommand(command: string, workspaceRoot: string = '/work'): CommandInspectionResult {
    const trimmed = command.trim();
    if (!trimmed) {
      return { safe: true, riskLevel: 'low', violations: [] };
    }

    const violations: string[] = [];
    let riskLevel: ActionRiskLevel = 'low';

    // 1. Check for destructive command patterns
    for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        violations.push(`Command matches blocked catastrophic pattern: ${pattern.toString()}`);
        riskLevel = 'critical';
      }
    }

    // 2. Check for suspicious path references within the command
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(trimmed)) {
        violations.push(`Command targets protected system path pattern: ${pattern.toString()}`);
        if (riskLevel !== 'critical') riskLevel = 'high';
      }
    }

    // 3. Assess relative risk based on command type
    if (violations.length === 0) {
      if (/\b(rm|rmdir|kill|pkill|iptables|systemctl)\b/i.test(trimmed)) {
        riskLevel = 'medium';
      } else {
        riskLevel = 'low';
      }
    }

    return {
      safe: violations.length === 0,
      riskLevel,
      violations,
    };
  }
}
