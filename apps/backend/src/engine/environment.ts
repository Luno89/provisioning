import { createHash } from 'crypto';

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
  cleanRoom?: boolean | undefined;
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

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function specFingerprint(spec: EnvironmentSpec): string {
  const normalised = stable({
    kind: spec.kind,
    languages: [...(spec.languages ?? [])].sort(),
    packages: [...(spec.packages ?? [])].sort(),
    egress: spec.egress !== false,
    egressAllowlist: [...(spec.egressAllowlist ?? [])].sort(),
    env: spec.env ?? {},
  });

  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex').slice(0, 32);
}

export function poolable(spec: EnvironmentSpec): boolean {
  return spec.kind === 'sandbox' && spec.cleanRoom !== true;
}
