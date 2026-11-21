import { defineSearchAttributeKey, SearchAttributeType, TypedSearchAttributes, type SearchAttributePair } from '@temporalio/common';

export const OWNER_ATTRIBUTE = defineSearchAttributeKey('KoalaOwner', SearchAttributeType.KEYWORD);

export const PROJECT_ATTRIBUTE = defineSearchAttributeKey('KoalaProject', SearchAttributeType.KEYWORD);

export function withProjectAttribute(attributes: TypedSearchAttributes | readonly SearchAttributePair[] | undefined, project: string): SearchAttributePair[] {
  const own = attributes instanceof TypedSearchAttributes ? attributes.getAll() : [...(attributes ?? [])];
  return [...own.filter((pair) => pair.key.name !== PROJECT_ATTRIBUTE.name), { key: PROJECT_ATTRIBUTE, value: project }];
}
