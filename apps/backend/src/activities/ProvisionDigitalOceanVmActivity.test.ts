import { describe, expect, it } from 'vitest';
import { sshKeyFor } from './ProvisionDigitalOceanVmActivity.js';

function digitalOcean(keys: Array<{ id: number; name: string; public_key: string }>) {
  const made: Array<{ name: string; public_key: string }> = [];
  const api = async (pathname: string, init: RequestInit = {}) => {
    if (pathname.startsWith('/account/keys?')) return { ssh_keys: keys };
    if (pathname === '/account/keys' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string; public_key: string };
      made.push(body);
      return { ssh_key: { id: 100 + made.length, ...body } };
    }
    throw new Error(`DigitalOcean was asked ${init.method ?? 'GET'} ${pathname}`);
  };
  return { api, made };
}

describe('the SSH key a droplet is made with', () => {
  it('is a new one when a key of the same name holds another public key, as after the cluster was made once before', async () => {
    const { api, made } = digitalOcean([{ id: 7, name: 'provisioning-shop', public_key: 'ssh-ed25519 AAAAold koala' }]);
    expect(await sshKeyFor(api, 'shop', 'ssh-ed25519 AAAAnew koala\n')).toBe(101);
    expect(made).toEqual([{ name: 'provisioning-shop', public_key: 'ssh-ed25519 AAAAnew koala\n' }]);
  });

  it('is the account\'s own when it already holds this public key, whatever it is called', async () => {
    const { api, made } = digitalOcean([{ id: 9, name: 'my laptop', public_key: 'ssh-ed25519 AAAAsame someone@laptop' }]);
    expect(await sshKeyFor(api, 'shop', 'ssh-ed25519 AAAAsame koala')).toBe(9);
    expect(made).toEqual([]);
  });
});
