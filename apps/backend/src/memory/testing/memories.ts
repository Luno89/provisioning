import type { MemoryItem } from '../lib/memory-store.js';

export const dnsMemory = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', ownerId: 'u1', category: 'environment_facts', scope: 'global', status: 'active',
  title: 'DNS lives at Cloudflare', text: 'The person manages DNS for their domain at Cloudflare.', createdAt: 'then', updatedAt: 'then', ...over,
});
