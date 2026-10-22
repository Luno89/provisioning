import type { Branch, Leaf } from './leaves.js';

export interface Ranked {
  id: string;
  priority?: number | undefined;
  createdAt?: string | undefined;
}

export function byRank(a: Ranked, b: Ranked): number {
  const first = (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY);
  if (first !== 0 && !Number.isNaN(first)) return first;
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

export function workOrder<T extends Ranked & Pick<Leaf, 'branchId'>>(leaves: readonly T[], branches: readonly (Ranked & Pick<Branch, 'id'>)[]): T[] {
  const rankOf = new Map([...branches].sort(byRank).map((branch, index) => [branch.id, index]));
  return [...leaves].sort((a, b) => (rankOf.get(a.branchId) ?? Number.MAX_SAFE_INTEGER) - (rankOf.get(b.branchId) ?? Number.MAX_SAFE_INTEGER) || byRank(a, b));
}

export function orderProblem(order: unknown, allowed: readonly string[], what: 'stories' | 'features'): string | undefined {
  if (!Array.isArray(order) || order.length === 0 || order.some((id) => typeof id !== 'string')) return `send the ${what} in their new order, as a list of ids`;
  if (new Set(order).size !== order.length) return `a ${what === 'stories' ? 'story' : 'feature'} appears twice in the order`;
  const outside = order.filter((id) => !allowed.includes(id as string));
  if (outside.length > 0) return `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not among the ${what} here`;
  return undefined;
}

export function ranked<T extends { id: string; priority?: number | undefined; updatedAt: string }>(items: readonly T[], order: readonly string[], at: string): T[] {
  return order.flatMap((id, index) => {
    const item = items.find((entry) => entry.id === id);
    return item && item.priority !== index ? [{ ...item, priority: index, updatedAt: at }] : [];
  });
}
