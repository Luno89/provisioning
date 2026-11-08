
export const CLUSTER_NAME_MAX_LENGTH = 40;

export const machineClusterId = (deviceId: string): string => `machine-${deviceId}`;

export const poolClusterId = (instanceName: string): string => `pool-${instanceName}`;

export const signsInAsPlatform = (serviceKey: string, onKoalasCluster: boolean): boolean =>
  serviceKey === 'grafana' || ((serviceKey === 'gitea' || serviceKey === 'infisical') && onKoalasCluster);

const VALID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface ClusterNameCheck {
  ok: boolean;
  error?: string;
  suggestion?: string;
}

export function suggestClusterName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CLUSTER_NAME_MAX_LENGTH)
    .replace(/-+$/, '');
}

export function validateClusterName(raw: unknown): ClusterNameCheck {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'A cluster name is required.' };
  }

  const name = raw.trim();
  const suggestion = suggestClusterName(name);
  const withSuggestion = (error: string): ClusterNameCheck =>
    suggestion && suggestion !== name ? { ok: false, error, suggestion } : { ok: false, error };

  if (name.length > CLUSTER_NAME_MAX_LENGTH) {
    return withSuggestion(`Cluster names must be ${CLUSTER_NAME_MAX_LENGTH} characters or fewer (this one is ${name.length}).`);
  }
  if (/\s/.test(name)) {
    return withSuggestion('Cluster names cannot contain spaces.');
  }
  if (!VALID.test(name)) {
    return withSuggestion(
      'Cluster names may use only lowercase letters, numbers and hyphens, and must start and end with a letter or number.',
    );
  }
  return { ok: true };
}
