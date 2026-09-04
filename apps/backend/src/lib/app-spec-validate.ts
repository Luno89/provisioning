import type { AppSpec } from './app-spec.js';

export interface SpecProblem {
  field: string;
  problem: string;
}

// securityContext itself is NOT banned — AppSpec.securityContext only ever exposes
// runAsUser/runAsGroup/fsGroup (pod-level UID/GID, harmless), and every field that would actually
// escape the namespace or reach the node (hostNetwork, hostPID, hostIPC, privileged, capabilities)
// is still caught below regardless of what object it's nested inside.
const FORBIDDEN_FIELDS = [
  'hostPath', 'hostNetwork', 'hostPID', 'hostIPC', 'privileged', 'capabilities',
  'serviceAccount', 'serviceAccountName',
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

  if (spec.command !== undefined && (!Array.isArray(spec.command) || spec.command.some((c) => typeof c !== 'string'))) {
    say('command', 'must be an array of strings.');
  }

  for (const [i, f] of (spec.configFiles ?? []).entries()) {
    if (!f || typeof f.name !== 'string' || !f.name.trim()) say(`configFiles[${i}].name`, 'is required.');
    if (!f || typeof f.content !== 'string') say(`configFiles[${i}].content`, 'must be a string.');
    if (!f || typeof f.mountPath !== 'string' || !f.mountPath.startsWith('/')) {
      say(`configFiles[${i}].mountPath`, 'must be an absolute path inside the container.');
    }
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

  // Whitelist, not just the FORBIDDEN_FIELDS blacklist below — this validates raw, unknown JSON
  // (a custom spec someone proposed via chat), so a field the TS type never mentions (
  // allowPrivilegeEscalation, seLinuxOptions, seccompProfile, ...) would otherwise pass through
  // unchecked. Only pod-level UID/GID, which cannot escape the namespace, is allowed.
  const SAFE_SECURITY_CONTEXT_KEYS = new Set(['runAsUser', 'runAsGroup', 'fsGroup']);
  if (spec.securityContext !== undefined) {
    if (typeof spec.securityContext !== 'object' || spec.securityContext === null || Array.isArray(spec.securityContext)) {
      say('securityContext', 'must be an object.');
    } else {
      for (const key of Object.keys(spec.securityContext)) {
        if (!SAFE_SECURITY_CONTEXT_KEYS.has(key)) {
          say(`securityContext.${key}`, 'is not allowed — only runAsUser, runAsGroup and fsGroup may be set.');
        }
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
    if (v?.type !== undefined && v.type !== 'persistent' && v.type !== 'ephemeral') {
      say(`volumes[${i}].type`, 'must be "persistent" or "ephemeral".');
    }
    if (v?.medium !== undefined && v.medium !== 'Memory') {
      say(`volumes[${i}].medium`, 'must be "Memory".');
    }
    // Required for a persistent volume (real PVC size) and for a Memory-backed ephemeral one
    // (sizeLimit — an unbounded RAM-backed emptyDir can take a node down same as no memory
    // limit can). A plain ephemeral volume (no medium) has no size concept at all.
    const needsSize = v?.type !== 'ephemeral' || v?.medium === 'Memory';
    if (needsSize && (!v || !QUANTITY.test(String(v.size)))) {
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
