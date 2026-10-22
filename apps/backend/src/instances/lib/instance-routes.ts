import { nameProblem } from './instance-names.js';

export const INSTANCE_BACKEND_PORT = 30320;
export const INSTANCE_EDGE_PORT = 30321;

export interface RoutedInstance {
  name: string;
  meshIp: string;
  nested: boolean;
  ports?: { backend: number; edge: number } | undefined;
  groups?: readonly string[] | undefined;
}

export interface InstanceRouteFiles {
  handles: string;
  site: string | null;
}

const MESH_IP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const proxy = (target: string, indent: string): string => [
  `${indent}reverse_proxy ${target} {`,
  `${indent}\ttransport http {`,
  `${indent}\t\tread_timeout 0`,
  `${indent}\t\twrite_timeout 0`,
  `${indent}\t}`,
  `${indent}}`,
].join('\n');

export function routeProblem(instance: RoutedInstance): string | null {
  return MESH_IP.test(instance.meshIp) ? null : `"${instance.meshIp}" is not a mesh address`;
}

export const nestedSiteOf = (name: string, domain: string): string => `*.${name}.${domain}`;

export function instanceRouteFiles(instance: RoutedInstance, domain: string): InstanceRouteFiles {
  const problem = routeProblem(instance);
  if (problem) throw new Error(problem);
  const backend = `${instance.meshIp}:${instance.ports?.backend ?? INSTANCE_BACKEND_PORT}`;
  const edge = `${instance.meshIp}:${instance.ports?.edge ?? INSTANCE_EDGE_PORT}`;
  const appsUnder = (name: string): string[] => [
    `@apps_${name} header_regexp Host ^[a-z0-9-]+-${escaped(name)}\\.${escaped(domain)}(:[0-9]+)?$`,
    `handle @apps_${name} {`,
    proxy(edge, '\t'),
    '}',
  ];
  const groups = (instance.groups ?? []).filter((group) => group !== instance.name && !nameProblem(group));
  const handles = [
    `@instance_${instance.name} host ${instance.name}.${domain}`,
    `handle @instance_${instance.name} {`,
    proxy(backend, '\t'),
    '}',
    ...appsUnder(instance.name),
    ...groups.flatMap(appsUnder),
    '',
  ].join('\n');
  const site = instance.nested
    ? [`${nestedSiteOf(instance.name, domain)} {`, '\timport koala_tls', proxy(edge, '\t'), '}', ''].join('\n')
    : null;
  return { handles, site };
}

export interface RoutableRecord {
  name?: string | undefined;
  meshIp?: string | undefined;
  status?: string | undefined;
  addresses?: { nested: boolean } | undefined;
  pool?: { ports: { backend: number; edge: number } } | undefined;
  groups?: readonly { projectId: string; name: string }[] | undefined;
}

export interface WantedRoutes {
  handles: Map<string, string>;
  sites: Map<string, string>;
}

export function wantedRoutes(records: readonly RoutableRecord[], domain: string): WantedRoutes {
  const handles = new Map<string, string>();
  const sites = new Map<string, string>();
  for (const record of records) {
    if (!record.name || !record.meshIp || record.status !== 'ready') continue;
    const instance = { name: record.name, meshIp: record.meshIp, nested: record.addresses?.nested ?? false, ...(record.pool ? { ports: record.pool.ports } : {}), ...(record.groups?.length ? { groups: record.groups.map((group) => group.name) } : {}) };
    if (routeProblem(instance)) continue;
    const files = instanceRouteFiles(instance, domain);
    handles.set(`${record.name}.caddy`, files.handles);
    if (files.site) sites.set(`${record.name}.caddy`, files.site);
  }
  return { handles, sites };
}

export function certificateCovers(subjectAltName: string | undefined, name: string, domain: string): boolean {
  return (subjectAltName ?? '').split(',').map((entry) => entry.trim()).includes(`DNS:${nestedSiteOf(name, domain)}`);
}

export function issuingProblem(caddyLog: string, name: string, domain: string): string | undefined {
  const site = nestedSiteOf(name, domain);
  let found: string | undefined;
  for (const line of caddyLog.split('\n')) {
    if (!line.includes(site)) continue;
    let entry: { level?: string; error?: string; msg?: string };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.level !== 'error') continue;
    const said = entry.error ?? entry.msg ?? '';
    found = /rateLimited|too many certificates/i.test(said)
      ? `Let's Encrypt is refusing new certificates for now (its weekly limit); Caddy keeps asking and the addresses switch once one is issued. It said: ${said.slice(0, 300)}`
      : `Getting the certificate failed for now; Caddy keeps trying. It said: ${said.slice(0, 300)}`;
  }
  return found;
}
