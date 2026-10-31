export type ReverseDnsState = 'set' | 'already' | 'waiting' | 'refused';

export interface ServerReverseDns {
  ip: string;
  name: string;
  state: ReverseDnsState;
  said: string;
  at: string;
}

export const ptrValue = (name: string): string => `${name.replace(/\.$/, '')}.`;

const bare = (name: string | undefined): string => (name ?? '').trim().toLowerCase().replace(/\.$/, '');

export const samePtr = (found: string | undefined, name: string): boolean => bare(found) === bare(name);

export function ipBlockFor(blocks: unknown, ip: string): string | undefined {
  const listed = (Array.isArray(blocks) ? blocks : []).filter((block): block is string => typeof block === 'string');
  return listed.find((block) => block === `${ip}/32` || block === ip) ?? listed[0];
}

export const reverseDnsPath = (block: string, ip?: string): string =>
  `/ip/${encodeURIComponent(block)}/reverse${ip ? `/${encodeURIComponent(ip)}` : ''}`;

export const forwardNotSeen = (ovhMessage: string): boolean => /resolv|does not point|doesn't point/i.test(ovhMessage);

export const reverseDnsByHand = (ip: string, name: string): string =>
  `set the reverse DNS (PTR) of ${ip} to ${name} in OVHcloud's control panel (the address's "Modify the reverse path"); many mailbox providers refuse mail from an address without it`;

export function reverseDnsSaid(state: ReverseDnsState, ip: string, name: string, why?: string): string {
  switch (state) {
    case 'set': return `OVHcloud set the reverse DNS of ${ip} to ${name}`;
    case 'already': return `the reverse DNS of ${ip} is already ${name}`;
    case 'waiting': return `waiting for OVHcloud to see ${name} point at ${ip} before it sets the reverse DNS${why ? ` (${why})` : ''}`;
    case 'refused': return `the reverse DNS of ${ip} is not set${why ? `: ${why}` : ''}; ${reverseDnsByHand(ip, name)}`;
  }
}
