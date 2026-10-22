import { registryAuths, type RegistryHosts } from './registry-hosts.js';

export const REGISTRY_PULL_SECRET = 'koala-registry-pull';

export interface RegistryLogin {
  hosts: RegistryHosts;
  username: string;
  password: string;
}

export type RegistryLoginSource = () => Promise<RegistryLogin>;

export const POD_PULL_SECRETS: readonly { name: string }[] = [{ name: REGISTRY_PULL_SECRET }];

const base64 = (text: string): string => Buffer.from(text).toString('base64');

export function dockerConfigJson(hosts: RegistryHosts, login: { username: string; password: string }): string {
  return JSON.stringify({ auths: registryAuths(hosts, base64(`${login.username}:${login.password}`)) });
}

export function registryPullSecret(namespace: string, login: RegistryLogin): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: REGISTRY_PULL_SECRET, namespace },
    type: 'kubernetes.io/dockerconfigjson',
    data: { '.dockerconfigjson': base64(dockerConfigJson(login.hosts, login)) },
  };
}

export function pullingServiceAccount(namespace: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'default', namespace },
    imagePullSecrets: [...POD_PULL_SECRETS],
  };
}

export function registryPullManifests(namespace: string, login: RegistryLogin): Record<string, unknown>[] {
  return [registryPullSecret(namespace, login), pullingServiceAccount(namespace)];
}

export const manifestList = (items: readonly Record<string, unknown>[]): Record<string, unknown> =>
  ({ apiVersion: 'v1', kind: 'List', items: [...items] });
