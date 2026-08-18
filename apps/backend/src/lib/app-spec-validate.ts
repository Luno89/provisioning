import type { AppSpec } from './app-spec.js';

/**
 * What a spec is not allowed to do.
 *
 * ── WHY THIS IS THE LOAD-BEARING PART ──
 * A spec is data, which is what makes it safe for Koala to author — but only because something
 * checks it. The whole argument for a closed schema over "point at a Helm chart" was that a chart
 * can do anything and cannot be validated before it runs. This is where that claim is either true
 * or a slogan.
 *
 * ── WHAT IT REFUSES, AND WHAT IT CANNOT ──
 * Three structural escapes, each of which leaves the namespace the spec is supposed to live in:
 * privileged containers and host mounts read the node; cluster-scoped resources affect every other
 * tenant; a missing memory limit lets one app evict everything on its node.
 *
 * It does NOT restrict which images may run — a deliberate choice, this being a local-first tool
 * where the cluster is the user's own. So this stops a spec doing something structurally dangerous
 * and cannot stop it running a dangerous image. That boundary is worth being explicit about rather
 * than implying more safety than is here.
 */

export interface SpecProblem {
  field: string;
  problem: string;
}

/** Fields that would take a container out of its namespace. None has an ordinary use in a spec. */
const FORBIDDEN_FIELDS = [
  'hostPath', 'hostNetwork', 'hostPID', 'hostIPC', 'privileged',
  'securityContext', 'serviceAccount', 'serviceAccountName',
  'nodeSelector', 'tolerations', 'hostAliases',
];

/** Resource kinds that reach past one namespace, whatever they are attached to. */
const CLUSTER_SCOPED = [
  'ClusterRole', 'ClusterRoleBinding', 'CustomResourceDefinition',
  'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration',
  'PersistentVolume', 'Namespace', 'APIService',
];

const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Kubernetes quantities: `512Mi`, `2Gi`, `100m`, `1`. */
const QUANTITY = /^\d+(\.\d+)?(m|Mi|Gi|Ki|Ti|M|G|K|T)?$/;

/**
 * Every reason this spec may not be stored, or `[]` when it may.
 *
 * Returns ALL problems rather than the first: a spec rejected one line at a time takes as many
 * round trips as it has mistakes, and the thing authoring it is a language model.
 */
export function validateSpec(raw: unknown): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const say = (field: string, problem: string) => problems.push({ field, problem });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ field: '', problem: 'A spec must be an object.' }];
  }
  const spec = raw as Partial<AppSpec> & Record<string, unknown>;

  if (typeof spec.id !== 'string' || !K8S_NAME.test(spec.id)) {
    // The id becomes a namespace, a Service name and a DNS label. An invalid one fails at apply
    // time with a message about none of those.
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
      // Services reference ports by name, so an unnamed one cannot be targeted.
      if (!p || typeof p.name !== 'string' || !K8S_NAME.test(p.name)) {
        say(`ports[${i}].name`, 'must be a valid lowercase name.');
      }
    }
  }

  /**
   * Resource limits are required, not defaulted.
   *
   * A default would be silently wrong for every app it did not fit, and the failure — a node
   * evicting unrelated pods because one container grew — arrives nowhere near the spec that caused
   * it. Making it explicit costs one line and makes the author think about it once.
   */
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
    // A generated value has no literal, and a literal is not generated. Both would be ambiguous
    // about which the container actually receives.
    if (e.generate && e.value !== undefined) {
      say(`env[${i}]`, 'cannot be both generated and given a value.');
    }
    if (e.generate && !e.fromSecret) {
      say(`env[${i}].fromSecret`, 'a generated value must name the secret key it is read from.');
    }
  }

  /**
   * The structural escapes, found anywhere at any depth.
   *
   * Scanned over the whole object rather than checked field by field: the schema is what is
   * ALLOWED, so anything unrecognised is already suspect, and a nested `securityContext` smuggled
   * into a resources block would pass a field-by-field check.
   */
  for (const found of findKeys(spec, FORBIDDEN_FIELDS)) {
    say(found, 'is not allowed — a spec runs in its own namespace and may not reach the node.');
  }
  for (const found of findValues(spec, CLUSTER_SCOPED)) {
    say(found.at, `"${found.value}" is cluster-scoped and would affect every other app.`);
  }

  return problems;
}

/** Human-readable refusal, listing every problem so a fix takes one round trip. */
export function explainSpecProblems(problems: readonly SpecProblem[]): string {
  if (!problems.length) return '';
  const lines = problems.map((p) => `  · ${p.field ? `${p.field}: ` : ''}${p.problem}`);
  return `This spec cannot be stored:\n${lines.join('\n')}`;
}

/** Every path at which one of `keys` appears, at any depth. */
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

/** Every path whose STRING value is one of `values`, at any depth. */
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
