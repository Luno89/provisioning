export type TrustProxy = 1 | 'loopback';

export function trustProxyFrom(raw: string | undefined): { trust: TrustProxy } | { problem: string } {
  const value = raw?.trim();
  if (value === '1') return { trust: 1 };
  if (value === 'loopback') return { trust: 'loopback' };
  const may = 'it is 1 where one proxy stands in front of this backend and names the visitor (root\'s Caddy, the pool\'s proxy), or loopback where only a proxy on this computer does (Vite on a dev box)';
  return { problem: value ? `TRUST_PROXY is "${value}": ${may}` : `TRUST_PROXY is not set: ${may}` };
}
