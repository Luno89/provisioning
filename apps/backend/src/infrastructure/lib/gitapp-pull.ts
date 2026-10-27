export const GITAPP_PULL_SECRET = 'gitea-registry';

export interface PullLogin {
  username: string;
  password: string;
}

export const gitappPullSecretArgs = (namespace: string, server: string, login: PullLogin): string[] => [
  'create', 'secret', 'docker-registry', GITAPP_PULL_SECRET, '-n', namespace,
  `--docker-server=${server}`, `--docker-username=${login.username}`, `--docker-password=${login.password}`,
  '--dry-run=client', '-o', 'yaml',
];
