import type { MemoryItem } from '../lib/memory-store.js';

export const SAID_NOW = new Date().toISOString();

export const daysBeforeNow = (n: number): string => new Date(Date.parse(SAID_NOW) - n * 86_400_000).toISOString();

export const saidMemory = (id: string, title: string, days: number, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id, ownerId: 'u1', category: 'environment_facts', scope: 'global', status: 'active', title, text: `${title}, as the person said.`,
  createdAt: daysBeforeNow(days), updatedAt: daysBeforeNow(days), ...over,
});

export const practiceMemory =(over: Partial<MemoryItem>): MemoryItem => ({
  id: 'p1', ownerId: 'u1', category: 'practice', agent: 'koala', status: 'trial', title: 'Check before answering', text: 'Call list_infrastructure first.', createdAt: 'then', updatedAt: 'then', ...over,
});

export const toolNoteMemory = (over: Partial<MemoryItem>): MemoryItem => ({ id: 'n1', ownerId: 'u1', category: 'tool_note', status: 'trial', title: 'Note', text: 'A note.', createdAt: 'then', updatedAt: 'then', ...over });

export const dnsMemory =(over: Partial<MemoryItem>): MemoryItem => ({
  id: 'm1', ownerId: 'u1', category: 'environment_facts', scope: 'global', status: 'active',
  title: 'DNS lives at Cloudflare', text: 'The person manages DNS for their domain at Cloudflare.', createdAt: 'then', updatedAt: 'then', ...over,
});
