import {
  draftId, type CustomStepDefinition, type ValidationCheckDefinition, type ValidationCheckType,
  type RecipeGroup, type RecipeLoop, type LoopType,
} from '../shared.js';

/** A working example per step type, not a blank form — the first draft of a step should already run.
 * `customSteps` lets a fresh "custom" step default to the first defined kind, if any exist yet. */
export function blankStep(type: ValidationCheckType, customSteps: readonly CustomStepDefinition[] = []): ValidationCheckDefinition {
  const id = draftId('check');
  switch (type) {
    case 'file-exists':
      return { id, name: 'A file exists', type, target: 'README.md' };
    case 'content-matches':
      return { id, name: 'File contains text', type, target: 'README.md', pattern: '## Usage' };
    case 'run-command':
      return { id, name: 'Run the test suite', type, command: 'npm test', timeoutMs: 60_000 };
    case 'http-probe':
      return { id, name: 'Health check responds', type, target: 'http://127.0.0.1:8080/health', expectedStatus: 200, timeoutMs: 10_000 };
    case 'mcp-probe':
      return { id, name: 'MCP initialize probe', type, target: 'http://127.0.0.1:8080/mcp', timeoutMs: 10_000 };
    case 'git-tracked':
      return { id, name: 'File is committed', type, target: 'acceptance-check.sh' };
    case 'k8s-probe':
      return { id, name: 'Deployment is ready', type, kind: 'deployment', namespace: 'default', target: 'my-app', timeoutMs: 15_000 };
    case 'wait-for':
      return {
        id, name: 'Wait for it to come up', type, waitForType: 'http-probe',
        target: 'http://127.0.0.1:8080/health', expectedStatus: 200, timeoutMs: 30_000, pollIntervalMs: 2_000,
      };
    case 'custom': {
      const first = customSteps[0];
      return {
        id, name: first?.name ?? 'Custom step', type,
        ...(first ? { customStepId: first.id, params: Object.fromEntries(first.fields.map((f) => [f.key, f.defaultValue ?? ''])) } : {}),
      };
    }
  }
}

export function blankGroup(): RecipeGroup {
  return { id: draftId('group'), name: 'New group', containerType: 'group', children: [] };
}

export function blankLoop(): RecipeLoop {
  return {
    id: draftId('loop'), name: 'New loop', containerType: 'loop', loopType: 'count', maxIterations: 3, children: [],
  };
}

export const LOOP_TYPE_LABELS: Record<LoopType, string> = {
  count: 'Repeat N times',
  until: 'Repeat until it passes',
  forEach: 'For each item',
};

export const LOOP_TYPE_HINTS: Record<LoopType, string> = {
  count: 'Runs its steps exactly this many times, regardless of outcome.',
  until: 'Retries its steps, up to a cap, until one full pass succeeds. A failed attempt before the last one is reported but doesn\'t block the recipe — only the final attempt\'s outcome does.',
  forEach: 'Runs a command once, splits its output into lines, then runs its steps once per line with {{item}} substituted in.',
};

export const STEP_TYPE_LABELS: Record<ValidationCheckType, string> = {
  'file-exists': 'File exists',
  'content-matches': 'File contains pattern',
  'run-command': 'Run a command',
  'http-probe': 'HTTP probe',
  'mcp-probe': 'MCP probe',
  'git-tracked': 'File is committed',
  'k8s-probe': 'Kubernetes resource ready',
  'wait-for': 'Wait for a condition',
  'custom': 'Custom step',
};

export const STEP_TYPE_HINTS: Record<ValidationCheckType, string> = {
  'file-exists': 'Passes when a path exists and is non-empty.',
  'content-matches': 'Passes when a file matches a regular expression.',
  'run-command': 'Passes when a shell command exits 0. The escape hatch for anything not covered by a typed step.',
  'http-probe': 'Passes when a URL returns the expected status. Final-verification only — a leaf\'s sandbox has no network reach to a deployed service.',
  'mcp-probe': 'Passes when an MCP server answers initialize. Final-verification only.',
  'git-tracked': 'Passes when a path is actually committed to git, not merely present on disk.',
  'k8s-probe': 'Passes when a pod/deployment/service is ready in the cluster. Final-verification only.',
  'wait-for': 'Repeatedly attempts another check type until it passes or times out, instead of guessing a fixed sleep.',
  'custom': 'A reusable step kind you define yourself — see "Custom step types" above.',
};
