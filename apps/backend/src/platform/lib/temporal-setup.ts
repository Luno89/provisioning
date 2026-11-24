import { failureOf } from '@koala/engine-core/failures';
import { reopening, type Reopening } from '@koala/engine-core/reopening';
import { OWNER_ATTRIBUTE, PROJECT_ATTRIBUTE } from './workflow-owner.js';

export const TEMPORAL_SYSTEM_NAMESPACE = 'temporal-system';

export const KOALA_SEARCH_ATTRIBUTES = [OWNER_ATTRIBUTE, PROJECT_ATTRIBUTE] as const;

export interface TemporalSetUpAsks {
  workflowService: {
    describeNamespace(request: { namespace: string }): Promise<unknown>;
    listWorkflowExecutions(request: { namespace: string; query: string; pageSize: number }): Promise<unknown>;
  };
  operatorService: { listSearchAttributes(request: { namespace: string }): Promise<{ customAttributes?: Record<string, unknown> | null }> };
}

export type TemporalSetUp = { done: true } | { done: false; missing: string };

const GRPC_NOT_FOUND = 5;

const notFound = (err: unknown): boolean => (err as { code?: unknown } | undefined)?.code === GRPC_NOT_FOUND;

const GRPC_INVALID_ARGUMENT = 3;

const NOT_YET_MAPPED = ['has no mapping defined for search attribute', 'invalid search attribute'] as const;

const notYetMapped = (err: unknown): boolean => {
  const failed = err as { code?: unknown; details?: unknown } | undefined;
  const details = failed?.details;
  return failed?.code === GRPC_INVALID_ARGUMENT && typeof details === 'string' && NOT_YET_MAPPED.some((said) => details.includes(said));
};

export async function temporalSetUpState(asks: TemporalSetUpAsks, namespace: string): Promise<TemporalSetUp> {
  try {
    await asks.workflowService.describeNamespace({ namespace });
  } catch (err) {
    if (notFound(err)) return { done: false, missing: 'the namespace is not there yet' };
    throw err;
  }
  const { customAttributes } = await asks.operatorService.listSearchAttributes({ namespace });
  const unlisted = KOALA_SEARCH_ATTRIBUTES.map((attribute) => attribute.name).filter((name) => !(name in (customAttributes ?? {})));
  if (unlisted.length > 0) return { done: false, missing: `${unlisted.join(' and ')} ${unlisted.length === 1 ? 'is' : 'are'} not registered yet` };
  const names = KOALA_SEARCH_ATTRIBUTES.map((attribute) => attribute.name);
  try {
    await asks.workflowService.listWorkflowExecutions({ namespace, query: names.map((name) => `${name} = 'temporal-setup'`).join(' AND '), pageSize: 1 });
  } catch (err) {
    if (notYetMapped(err)) return { done: false, missing: `Temporal lists ${names.join(' and ')} but cannot use them in a query yet` };
    throw err;
  }
  return { done: true };
}

export async function onceNamespaceKnown(add: () => Promise<void>, namespace: string, say: (line: string) => void, again: Reopening = reopening()): Promise<void> {
  for (;;) {
    try {
      return await add();
    } catch (err) {
      if (!notFound(err)) throw err;
    }
    say(`waiting for Temporal's frontend to know the namespace ${namespace} it registered, to add the search attributes Koala uses`);
    await again.after();
  }
}

export async function untilConnected<T>(connect: () => Promise<T>, say: (line: string) => void, again: Reopening = reopening()): Promise<T> {
  for (;;) {
    try {
      return await connect();
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw new Error(`Temporal cannot be reached: ${failure.reason}`, { cause: err });
      say(`waiting for Temporal to answer: ${failure.reason}`);
    }
    await again.after();
  }
}

export async function untilTemporalSetUp(asks: TemporalSetUpAsks, namespace: string, say: (line: string) => void, again: Reopening = reopening()): Promise<void> {
  for (;;) {
    let missing: string;
    try {
      const state = await temporalSetUpState(asks, namespace);
      if (state.done) return;
      missing = state.missing;
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw new Error(`Temporal's namespace ${namespace} cannot be set up: ${failure.reason}`, { cause: err });
      missing = failure.reason;
    }
    say(`waiting for Temporal's namespace ${namespace} to be set up: ${missing}`);
    await again.after();
  }
}
