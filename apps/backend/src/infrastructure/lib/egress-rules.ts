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
    if (hasCidr && (!CIDR.test(String(r.cidr)) || String(r.cidr).split(/[./]/).slice(0, 4).some((part) => Number(part) > 255) || Number(String(r.cidr).split('/')[1]) > 32)) {
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

export const INTERNAL_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
] as const;

interface Block { base: number; bits: number }

function blockOf(cidr: string): Block {
  const [address = '', size = ''] = cidr.split('/');
  const bits = Number(size);
  const base = address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
  return { base: bits === 0 ? 0 : base - (base % 2 ** (32 - bits)), bits };
}

const inside = (inner: Block, outer: Block): boolean =>
  inner.bits >= outer.bits && Math.floor(inner.base / 2 ** (32 - outer.bits)) === Math.floor(outer.base / 2 ** (32 - outer.bits));

export const internalRangeHolding = (cidr: string): string | undefined =>
  INTERNAL_RANGES.find((range) => inside(blockOf(cidr), blockOf(range)));

export const internalRangesWithin = (cidr: string): string[] =>
  INTERNAL_RANGES.filter((range) => inside(blockOf(range), blockOf(cidr)) && blockOf(range).bits > blockOf(cidr).bits);

export function publicIpBlock(cidr: string): { ipBlock: { cidr: string; except?: string[] } } {
  const holding = internalRangeHolding(cidr);
  if (holding) throw new Error(`${cidr} is inside ${holding}, an internal range, and a workspace may open only public addresses`);
  const except = internalRangesWithin(cidr);
  return { ipBlock: { cidr, ...(except.length > 0 ? { except } : {}) } };
}

export function egressReachProblem(egress: unknown, ownNamespaces: ReadonlySet<string>): string | undefined {
  const malformed = validateEgressRules(egress);
  if (malformed) return malformed;
  for (const rule of (egress ?? []) as { namespace?: string; cidr?: string }[]) {
    if (rule.namespace && !ownNamespaces.has(rule.namespace)) {
      return `"${rule.namespace}" is not one of your apps' namespaces, and a rule may open only those: Koala's own services and other people's apps stay closed`;
    }
    const holding = rule.cidr ? internalRangeHolding(rule.cidr) : undefined;
    if (holding) return `${rule.cidr} is inside ${holding}, an internal range, and a rule may open only public addresses`;
  }
  return undefined;
}
