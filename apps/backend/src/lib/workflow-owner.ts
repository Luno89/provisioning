import { defineSearchAttributeKey, SearchAttributeType, type SearchAttributePair, type TypedSearchAttributes } from '@temporalio/common';

export const OWNER_ATTRIBUTE = defineSearchAttributeKey('KoalaOwner', SearchAttributeType.KEYWORD);
export const PLATFORM_OWNER = 'platform';

export const startedFor = (owner: string): { typedSearchAttributes: SearchAttributePair[] } => ({
  typedSearchAttributes: [{ key: OWNER_ATTRIBUTE, value: owner }],
});

export function ownerIn(attributes: TypedSearchAttributes | readonly SearchAttributePair[] | undefined): string | undefined {
  if (!attributes) return undefined;
  const pairs = Array.isArray(attributes) ? attributes : (attributes as TypedSearchAttributes).getAll();
  const found = pairs.find((pair) => pair.key.name === OWNER_ATTRIBUTE.name);
  return typeof found?.value === 'string' && found.value ? found.value : undefined;
}

export const ownedQuery = (owner: string): string => `${OWNER_ATTRIBUTE.name} = "${owner.replace(/["\\]/g, '')}"`;

export const withinQuery = (scope: string | undefined, query: string | undefined): string | undefined => {
  const parts = [scope, query].filter((part): part is string => Boolean(part?.trim()));
  if (parts.length < 2) return parts[0];
  return parts.map((part) => `(${part})`).join(' AND ');
};

export class UnownedWorkflowError extends Error {
  constructor(workflowType: string, workflowId: string) {
    super(`every workflow has to say whose it is: ${workflowType} ${workflowId} was started without ${OWNER_ATTRIBUTE.name}`);
    this.name = 'UnownedWorkflowError';
  }
}

export interface WorkflowViewer {
  id: string;
  isAdmin?: boolean | undefined;
}

export const seesEverything = (viewer: WorkflowViewer, instanceOwner: string | undefined): boolean =>
  viewer.isAdmin === true || (instanceOwner !== undefined && viewer.id === instanceOwner);

export const startsWithEverything = (viewer: WorkflowViewer, instanceOwner: string | undefined): boolean =>
  instanceOwner !== undefined && viewer.id === instanceOwner;

export const mayTouch = (viewer: WorkflowViewer, owner: string | undefined, instanceOwner: string | undefined): boolean =>
  seesEverything(viewer, instanceOwner) || (owner !== undefined && owner === viewer.id);

export function workflowScope(viewer: WorkflowViewer, asked: string | undefined, instanceOwner: string | undefined): { all: boolean; query: string | undefined } {
  const everything = seesEverything(viewer, instanceOwner);
  const all = everything && (asked === 'all' || (asked === undefined && startsWithEverything(viewer, instanceOwner)));
  return { all, query: all ? undefined : ownedQuery(viewer.id) };
}
