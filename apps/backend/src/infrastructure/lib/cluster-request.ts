import { recordAt } from '../../platform/lib/json-shapes.js';

export interface RemoteHostRequest {
  host: string;
  username: string;
  privateKey: string;
  port?: number;
  k3sApiPort?: number;
}

export interface VmRequest {
  serverType?: string;
  location?: string;
  image?: string;
}

export interface ProvisionRequest {
  name: unknown;
  provider: string;
  remote?: RemoteHostRequest;
  vm?: VmRequest;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function provisionRequestOf(body: unknown): ProvisionRequest {
  const b = recordAt(body);
  const provider = String(b.provider);
  const remote: RemoteHostRequest | undefined = provider === 'remote'
    ? {
        host: text(b.remoteHost),
        username: text(b.remoteUsername),
        privateKey: text(b.remoteSshPrivateKey),
        ...(typeof b.remoteSshPort === 'number' ? { port: b.remoteSshPort } : {}),
        ...(typeof b.remoteK3sApiPort === 'number' ? { k3sApiPort: b.remoteK3sApiPort } : {}),
      }
    : undefined;
  const vm: VmRequest | undefined = provider === 'hetzner' || provider === 'do'
    ? {
        ...(b.hetznerServerType ? { serverType: String(b.hetznerServerType) } : {}),
        ...(b.hetznerLocation ? { location: String(b.hetznerLocation) } : {}),
        ...(b.hetznerImage ? { image: String(b.hetznerImage) } : {}),
      }
    : undefined;
  return { name: b.name, provider, ...(remote ? { remote } : {}), ...(vm ? { vm } : {}) };
}
