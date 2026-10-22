import { parse } from 'yaml';

export interface PipelineConfig {
  dockerfile?: string;
  context?: string;
  buildArgs?: Record<string, string>;
}

const BUILD_ARG_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isUnsafeRepoPath(p: string): boolean {
  return p.startsWith('/') || p.split(/[/\\]/).includes('..');
}

export function validatePipelineConfig(candidate: unknown): string | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'pipeline.yml must be a YAML mapping at the top level.';
  }
  const c = candidate as Record<string, unknown>;

  if (c.dockerfile !== undefined) {
    if (typeof c.dockerfile !== 'string' || !c.dockerfile.trim()) return 'dockerfile must be a non-empty string.';
    if (isUnsafeRepoPath(c.dockerfile)) return 'dockerfile must be a path inside the repository (no leading "/", no "..").';
  }
  if (c.context !== undefined) {
    if (typeof c.context !== 'string' || !c.context.trim()) return 'context must be a non-empty string.';
    if (isUnsafeRepoPath(c.context)) return 'context must be a path inside the repository (no leading "/", no "..").';
  }
  if (c.buildArgs !== undefined) {
    if (c.buildArgs === null || typeof c.buildArgs !== 'object' || Array.isArray(c.buildArgs)) {
      return 'buildArgs must be a mapping of name to value.';
    }
    for (const [key, value] of Object.entries(c.buildArgs as Record<string, unknown>)) {
      if (!BUILD_ARG_KEY.test(key)) {
        return `buildArgs key "${key}" must start with a letter or underscore and contain only letters, digits and underscores.`;
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return `buildArgs.${key} must be a string, number or boolean.`;
      }
    }
  }

  return null;
}

export interface ParsedPipelineConfig {
  config: PipelineConfig | null;
  error: string | null;
}

export function parsePipelineConfig(raw: string): ParsedPipelineConfig {
  let candidate: unknown;
  try {
    candidate = parse(raw);
  } catch (err) {
    return { config: null, error: `could not parse as YAML: ${(err as Error).message}` };
  }

  if (candidate === null || candidate === undefined) {
    return { config: {}, error: null };
  }

  const invalid = validatePipelineConfig(candidate);
  if (invalid) return { config: null, error: invalid };
  return { config: candidate as PipelineConfig, error: null };
}

export function buildArgEntries(config: PipelineConfig | null | undefined): [string, string][] {
  if (!config?.buildArgs) return [];
  return Object.entries(config.buildArgs).map(([key, value]) => [key, String(value)]);
}
