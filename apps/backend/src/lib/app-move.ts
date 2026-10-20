export const COPIED_KINDS = [
  'serviceaccounts', 'configmaps', 'secrets', 'persistentvolumeclaims', 'services', 'deployments', 'statefulsets', 'daemonsets',
  'cronjobs', 'ingresses.networking.k8s.io', 'networkpolicies.networking.k8s.io', 'roles.rbac.authorization.k8s.io',
  'rolebindings.rbac.authorization.k8s.io', 'ingressroutes.traefik.io', 'middlewares.traefik.io',
  'probes.monitoring.coreos.com', 'servicemonitors.monitoring.coreos.com', 'podmonitors.monitoring.coreos.com', 'prometheusrules.monitoring.coreos.com',
] as const;

export const SCALED_KINDS = ['deployments', 'statefulsets'] as const;
export const REPLICAS_ANNOTATION = 'koala.dev/moved-replicas';

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [key: string]: unknown };
  spec?: Record<string, unknown>;
  type?: string;
  data?: Record<string, string>;
  [key: string]: unknown;
}

export interface MovedVolume {
  claim: string;
}

export interface MovedNamespace {
  namespace: string;
  labels: Record<string, string>;
  objects: KubeObject[];
  volumes: MovedVolume[];
}

export interface AppsManifest {
  pullHost: string;
  namespaces: MovedNamespace[];
}

const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const NAMESPACE_KEPT = /^(kube-|vcluster|default$|monitoring$|traefik$|gitea$|infisical$|nowrinkles$|verdaccio$|searxng$|crawl4ai$)/;

export const isMovedNamespace = (namespace: string): boolean => NAME.test(namespace) && !NAMESPACE_KEPT.test(namespace);

export const volumePart = (namespace: string, claim: string): string => `volume:${namespace}:${claim}`;

export function volumeOfPart(part: string): { namespace: string; claim: string } | undefined {
  const [kind, namespace, claim, ...rest] = part.split(':');
  if (kind !== 'volume' || rest.length || !namespace || !claim || !NAME.test(namespace) || !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(claim)) return undefined;
  return { namespace, claim };
}

const LEFT_OUT_SECRETS = new Set(['kubernetes.io/service-account-token']);
const LEFT_OUT_NAMES = new Set(['kube-root-ca.crt', 'default']);

export function copied(object: KubeObject): boolean {
  const name = object.metadata?.name ?? '';
  if (object.kind === 'Secret' && LEFT_OUT_SECRETS.has(object.type ?? '')) return false;
  if (object.kind === 'ConfigMap' && name === 'kube-root-ca.crt') return false;
  if (object.kind === 'ServiceAccount' && LEFT_OUT_NAMES.has(name)) return false;
  if (object.metadata && Array.isArray((object.metadata as { ownerReferences?: unknown[] }).ownerReferences) && object.kind !== 'Secret') return false;
  return true;
}

export const rewriteImage = (image: string, from: string, to: string): string =>
  (from && image.startsWith(`${from}/`) ? `${to}/${image.slice(from.length + 1)}` : image);

function rewriteContainers(spec: Record<string, unknown> | undefined, from: string, to: string): void {
  if (!spec) return;
  for (const key of ['containers', 'initContainers']) {
    const list = spec[key];
    if (!Array.isArray(list)) continue;
    for (const container of list as Array<{ image?: string }>) {
      if (typeof container.image === 'string') container.image = rewriteImage(container.image, from, to);
    }
  }
}

function podSpecOf(object: KubeObject): Record<string, unknown> | undefined {
  const spec = object.spec as { template?: { spec?: Record<string, unknown> }; jobTemplate?: { spec?: { template?: { spec?: Record<string, unknown> } } } } | undefined;
  return spec?.template?.spec ?? spec?.jobTemplate?.spec?.template?.spec;
}

function rewriteDockerConfig(object: KubeObject, from: string, to: string): void {
  if (object.type !== 'kubernetes.io/dockerconfigjson' || !object.data?.['.dockerconfigjson'] || !from) return;
  const config = JSON.parse(Buffer.from(object.data['.dockerconfigjson'], 'base64').toString('utf8')) as { auths?: Record<string, unknown> };
  if (!config.auths?.[from]) return;
  config.auths[to] = config.auths[from];
  delete config.auths[from];
  object.data['.dockerconfigjson'] = Buffer.from(JSON.stringify(config)).toString('base64');
}

const DROPPED_METADATA = ['ownerReferences', 'uid', 'resourceVersion', 'creationTimestamp', 'managedFields', 'generation', 'selfLink', 'deletionTimestamp', 'deletionGracePeriodSeconds'];
const DROPPED_ANNOTATIONS = /^(pv\.kubernetes\.io\/|volume\.beta\.kubernetes\.io\/|volume\.kubernetes\.io\/|kubectl\.kubernetes\.io\/last-applied-configuration$|deployment\.kubernetes\.io\/revision$)/;

export function cleaned(object: KubeObject, from: string, to: string): KubeObject {
  const copy = JSON.parse(JSON.stringify(object)) as KubeObject;
  delete copy.status;
  const metadata = copy.metadata ?? {};
  for (const key of DROPPED_METADATA) delete metadata[key];
  if (metadata.annotations) {
    for (const key of Object.keys(metadata.annotations)) if (DROPPED_ANNOTATIONS.test(key)) delete metadata.annotations[key];
  }
  if (copy.kind === 'Service' && copy.spec) {
    delete copy.spec.clusterIP;
    delete copy.spec.clusterIPs;
    if (copy.spec.type === 'NodePort' || copy.spec.type === 'LoadBalancer') {
      for (const port of (copy.spec.ports as Array<{ nodePort?: number }> | undefined) ?? []) delete port.nodePort;
    }
  }
  if (copy.kind === 'PersistentVolumeClaim' && copy.spec) {
    delete copy.spec.volumeName;
    delete copy.spec.storageClassName;
    delete copy.spec.volumeMode;
    delete copy.spec.dataSource;
    delete copy.spec.dataSourceRef;
  }
  if (copy.kind === 'Deployment' || copy.kind === 'StatefulSet') {
    const kept = metadata.annotations?.[REPLICAS_ANNOTATION];
    if (kept !== undefined && copy.spec) copy.spec.replicas = Number(kept);
    if (metadata.annotations) delete metadata.annotations[REPLICAS_ANNOTATION];
  }
  rewriteContainers(podSpecOf(copy), from, to);
  rewriteDockerConfig(copy, from, to);
  return copy;
}

export const volumesOf = (objects: readonly KubeObject[]): MovedVolume[] =>
  objects.filter((object) => object.kind === 'PersistentVolumeClaim' && object.metadata?.name).map((object) => ({ claim: object.metadata!.name! }));

export const restoreOrder = (objects: readonly KubeObject[]): KubeObject[] => {
  const rank = (object: KubeObject) => {
    switch (object.kind) {
      case 'ServiceAccount': case 'ConfigMap': case 'Secret': case 'PersistentVolumeClaim': return 0;
      case 'Role': case 'RoleBinding': case 'Service': case 'NetworkPolicy': return 1;
      case 'Deployment': case 'StatefulSet': case 'DaemonSet': case 'CronJob': return 2;
      default: return 3;
    }
  };
  return [...objects].sort((a, b) => rank(a) - rank(b));
};
