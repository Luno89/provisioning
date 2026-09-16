export type EnvironmentKind = 'none' | 'sandbox' | 'machine';

export type EnvironmentLifecycle = 'invocation' | 'conversation' | 'persistent';

export interface EnvironmentCapabilities {
  terminal: boolean;
  filesystem: boolean;
  egress: boolean;
  git: boolean;
  languages: string[];
}

export interface EnvironmentSpec {
  kind: EnvironmentKind;
  lifecycle: EnvironmentLifecycle;
  languages?: string[] | undefined;
  packages?: string[] | undefined;
  egress?: boolean | undefined;
  egressAllowlist?: string[] | undefined;
  env?: Record<string, string> | undefined;
}

export interface EnvironmentScope {
  deviceId?: string | undefined;
  path?: string | undefined;
  worktree?: string | undefined;
}

export type ApprovalPolicy = 'none' | 'per-command';

export interface EnvironmentHandle {
  id: string;
  spec: EnvironmentSpec;
  capabilities: EnvironmentCapabilities;
  scope?: EnvironmentScope | undefined;
  approval: ApprovalPolicy;
}

export interface ExecRequest {
  command: string;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: Record<string, string> | undefined;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
}

export interface EnvironmentDriver {
  handle(): EnvironmentHandle;
  exec(request: ExecRequest): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  deleteFile(path: string): Promise<void>;
  checkpoint?(): Promise<string>;
  restore?(reference: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface EnvironmentRequirement {
  terminal?: boolean | undefined;
  filesystem?: boolean | undefined;
  egress?: boolean | undefined;
  git?: boolean | undefined;
  languages?: string[] | undefined;
  /**
   * Wants a working directory to stand in. Spec selection treats this as a request
   * for a machine-capable environment; unmetRequirements deliberately does not
   * check it — whether a runtime has a workspace is a property of its scope,
   * not of the spec's capabilities.
   */
  workspace?: boolean | undefined;
}

export const NO_CAPABILITIES: EnvironmentCapabilities = {
  terminal: false,
  filesystem: false,
  egress: false,
  git: false,
  languages: [],
};

export function capabilitiesOf(spec: EnvironmentSpec): EnvironmentCapabilities {
  if (spec.kind === 'none') {
    return { ...NO_CAPABILITIES, egress: spec.egress === true };
  }

  return {
    terminal: true,
    filesystem: true,
    egress: spec.egress !== false,
    git: true,
    languages: [...(spec.languages ?? [])],
  };
}

export function lifecycleFor(kind: EnvironmentKind): EnvironmentLifecycle {
  if (kind === 'machine') return 'persistent';
  if (kind === 'none') return 'invocation';
  return 'invocation';
}

export function approvalFor(kind: EnvironmentKind): ApprovalPolicy {
  return kind === 'machine' ? 'per-command' : 'none';
}

export interface RequirementMismatch {
  need: string;
  detail: string;
}

export function unmetRequirements(
  requirement: EnvironmentRequirement,
  capabilities: EnvironmentCapabilities,
): RequirementMismatch[] {
  const unmet: RequirementMismatch[] = [];

  if (requirement.terminal && !capabilities.terminal) {
    unmet.push({ need: 'terminal', detail: 'this environment cannot run commands' });
  }
  if (requirement.filesystem && !capabilities.filesystem) {
    unmet.push({ need: 'filesystem', detail: 'this environment has no files to read or write' });
  }
  if (requirement.egress && !capabilities.egress) {
    unmet.push({ need: 'egress', detail: 'this environment cannot reach the network' });
  }
  if (requirement.git && !capabilities.git) {
    unmet.push({ need: 'git', detail: 'this environment has no git' });
  }

  for (const language of requirement.languages ?? []) {
    if (!capabilities.languages.includes(language)) {
      unmet.push({ need: `language:${language}`, detail: `this environment does not have ${language}` });
    }
  }

  return unmet;
}

export function satisfies(
  requirement: EnvironmentRequirement,
  capabilities: EnvironmentCapabilities,
): boolean {
  return unmetRequirements(requirement, capabilities).length === 0;
}
