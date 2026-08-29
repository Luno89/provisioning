import type { AppSpec } from './app-spec.js';

export interface SpecProblem {
  field: string;
  problem: string;
}

const FORBIDDEN_FIELDS = [
  'hostPath', 'hostNetwork', 'hostPID', 'hostIPC', 'privileged',
  'securityContext', 'serviceAccount', 'serviceAccountName',
  'nodeSelector', 'tolerations', 'hostAliases',
];

const CLUSTER_SCOPED = [
  'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition',
  'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration',
  'PersistentVolume', 'Namespace', 'APIService',
];

const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const QUANTITY = /^\d+(\.\d+)?(m|Mi|Gi|Ki|Ti|M|G|K|T)?$/;

export function validateSpec(raw: unknown): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const say = (field: string, problem: string) => problems.push({ field, problem });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ field: '', problem: 'A spec must be an object.' }];
  }
  const spec = raw as Partial<AppSpec> & Record<string, unknown>;

  if (typeof spec.id !== 'string' || !K8S_NAME.test(spec.id)) {
    say('id', 'must be lowercase letters, digits and hyphens, starting and ending with alphanumeric.');
  }
  if (typeof spec.image !== 'string' || !spec.image.trim()) {
    say('image', 'is required.');
  }

  if (!Array.isArray(spec.ports) || spec.ports.length === 0) {
    say('ports', 'at least one port is required — a Service with none routes nowhere.');
  } else {
    for (const [i, p] of spec.ports.entries()) {
      if (!p || typeof p.port !== 'number' || p.port < 1 || p.port > 65535) {
        say(`ports[${i}].port`, 'must be a number between 1 and 65535.');
      }
      if (!p || typeof p.name !== 'string' || !K8S_NAME.test(p.name)) {
        say(`ports[${i}].name`, 'must be a valid lowercase name.');
      }
    }
  }

  const limits = spec.resources?.limits;
  if (!limits?.memory) say('resources.limits.memory', 'is required — an app with no memory limit can take a node down.');
  if (!limits?.cpu) say('resources.limits.cpu', 'is required.');
  for (const [key, value] of Object.entries({ ...limits, ...spec.resources?.requests })) {
    if (value !== undefined && !QUANTITY.test(String(value))) {
      say(`resources.${key}`, `"${value}" is not a Kubernetes quantity (512Mi, 2Gi, 100m).`);
    }
  }

  for (const [i, v] of (spec.volumes ?? []).entries()) {
    if (!v || typeof v.path !== 'string' || !v.path.startsWith('/')) {
      say(`volumes[${i}].path`, 'must be an absolute path inside the container.');
    }
    if (!v || !QUANTITY.test(String(v.size))) {
      say(`volumes[${i}].size`, 'must be a size like 10Gi.');
    }
  }

  for (const [i, e] of (spec.env ?? []).entries()) {
    if (!e || typeof e.name !== 'string' || !e.name.trim()) {
      say(`env[${i}].name`, 'is required.');
      continue;
    }
    if (e.generate && e.value !== undefined) {
      say(`env[${i}]`, 'cannot be both generated and given a value.');
    }
    if (e.generate && !e.fromSecret) {
      say(`env[${i}].fromSecret`, 'a generated value must name the secret key it is read from.');
    }
  }

  const seen = new Map<string, string>();
  for (const [i, e] of (spec.env ?? []).entries()) {
    if (!e?.fromSecret) continue;
    const prior = seen.get(e.fromSecret);
    if (prior) {
      say(`env[${i}].fromSecret`, `"${e.fromSecret}" is already used by ${prior} — two values sharing a key overwrite each other.`);
    }
    seen.set(e.fromSecret, e.name);
  }

  for (const found of findKeys(spec, FORBIDDEN_FIELDS)) {
    say(found, 'is not allowed — a spec runs in its own namespace and may not reach the node.');
  }
  for (const found of findValues(spec, CLUSTER_SCOPED)) {
    say(found.at, `"${found.value}" is cluster-scoped and would affect every other app.`);
  }

  return problems;
}

export function explainSpecProblems(problems: readonly SpecProblem[]): string {
  if (!problems.length) return '';
  const lines = problems.map((p) => `  · ${p.field ? `${p.field}: ` : ''}${p.problem}`);
  return `This spec cannot be stored:\n${lines.join('\n')}`;
}

function findKeys(value: unknown, keys: readonly string[], path = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (keys.includes(key)) out.push(here);
    out.push(...findKeys(child, keys, here));
  }
  return out;
}

function findValues(value: unknown, values: readonly string[], path = ''): { at: string; value: string }[] {
  if (typeof value === 'string') {
    return values.includes(value) ? [{ at: path, value }] : [];
  }
  if (typeof value !== 'object' || value === null) return [];
  const out: { at: string; value: string }[] = [];
  for (const [key, child] of Object.entries(value)) {
    out.push(...findValues(child, values, path ? `${path}.${key}` : key));
  }
  return out;
}
