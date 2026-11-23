interface Container { name: string; securityContext?: { privileged?: boolean } }
interface Volume { name: string; hostPath?: { path: string } }
interface PodSpec {
  serviceAccountName?: string;
  serviceAccount?: string;
  automountServiceAccountToken?: boolean;
  containers?: Container[];
  initContainers?: Container[];
  volumes?: Volume[];
  container?: Container[];
  initContainer?: Container[];
  volume?: Volume[];
}
interface Manifest { kind?: string; metadata?: { name?: string }; spec?: PodSpec & { template?: { spec?: PodSpec } } }

const POD_TEMPLATES = new Set(['Job', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);

export interface PodAllowances {
  account?: string;
  hostFolder?: string;
}

export function koalaRightsIn(manifests: readonly unknown[], allowed: PodAllowances = {}): string[] {
  const pods = (manifests as Manifest[]).flatMap((manifest) => {
    const name = `${manifest.kind}/${manifest.metadata?.name}`;
    if (manifest.kind === 'Pod' && manifest.spec) return [{ name, pod: manifest.spec }];
    if (POD_TEMPLATES.has(manifest.kind ?? '') && manifest.spec?.template?.spec) return [{ name, pod: manifest.spec.template.spec }];
    return [];
  });
  if (pods.length === 0) return ['no pod in what was built'];
  return pods.flatMap(({ name, pod }) => {
    const account = pod.serviceAccountName ?? pod.serviceAccount;
    return [
      ...(account === undefined || account === allowed.account ? [] : [`${name} runs as service account ${account}`]),
      ...(pod.automountServiceAccountToken === false ? [] : [`${name} mounts a service account token`]),
      ...[...(pod.containers ?? pod.container ?? []), ...(pod.initContainers ?? pod.initContainer ?? [])].filter((c) => c.securityContext?.privileged).map((c) => `${name}'s ${c.name} is privileged`),
      ...(pod.volumes ?? pod.volume ?? []).filter((v) => v.hostPath && v.hostPath.path !== allowed.hostFolder).map((v) => `${name} mounts the host's ${v.hostPath!.path}`),
    ];
  });
}
