const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function validateEgressRules(egress: unknown): string | undefined {
  if (egress === undefined) return undefined;
  if (!Array.isArray(egress)) return 'Egress must be a list of rules.';
  for (const rule of egress) {
    if (typeof rule !== 'object' || rule === null) return 'Each egress rule must be an object.';
    const r = rule as Record<string, unknown>;
    const hasNamespace = typeof r.namespace === 'string' && r.namespace !== '';
    const hasCidr = typeof r.cidr === 'string' && r.cidr !== '';
    if (hasNamespace === hasCidr) return 'Each egress rule needs exactly one of namespace or cidr.';
    if (hasNamespace && !K8S_NAME.test(String(r.namespace))) {
      return `"${String(r.namespace)}" is not a valid namespace name.`;
    }
    if (hasCidr && !CIDR.test(String(r.cidr))) {
      return `"${String(r.cidr)}" is not a valid CIDR — it needs the form 10.0.0.0/8.`;
    }
    if (r.ports !== undefined) {
      if (!Array.isArray(r.ports)) return 'Ports must be a list of numbers.';
      for (const port of r.ports) {
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          return `"${String(port)}" is not a valid port.`;
        }
      }
    }
  }
  return undefined;
}

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/;

export function validateLocalEgressRules(egress: unknown): string | undefined {
  if (egress === undefined) return undefined;
  if (!Array.isArray(egress)) return 'Egress must be a list of rules.';
  for (const rule of egress) {
    if (typeof rule !== 'object' || rule === null) return 'Each egress rule must be an object.';
    const r = rule as Record<string, unknown>;
    if (typeof r.host !== 'string' || r.host === '') return 'Each egress rule needs a host.';
    if (!HOSTNAME.test(r.host)) return `"${r.host}" is not a valid hostname.`;
    if (r.ports !== undefined) {
      if (!Array.isArray(r.ports)) return 'Ports must be a list of numbers.';
      for (const port of r.ports) {
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          return `"${String(port)}" is not a valid port.`;
        }
      }
    }
  }
  return undefined;
}
