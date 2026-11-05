import { recordAt } from '../../platform/lib/json-shapes.js';

export interface VmRequest {
  serverType?: string;
  location?: string;
  image?: string;
}

export interface ProvisionRequest {
  name: unknown;
  provider: string;
  vm?: VmRequest;
}

export function provisionRequestOf(body: unknown): ProvisionRequest {
  const b = recordAt(body);
  const provider = String(b.provider);
  const vm: VmRequest | undefined = provider === 'hetzner' || provider === 'do'
    ? {
        ...(b.hetznerServerType ? { serverType: String(b.hetznerServerType) } : {}),
        ...(b.hetznerLocation ? { location: String(b.hetznerLocation) } : {}),
        ...(b.hetznerImage ? { image: String(b.hetznerImage) } : {}),
      }
    : undefined;
  return { name: b.name, provider, ...(vm ? { vm } : {}) };
}
