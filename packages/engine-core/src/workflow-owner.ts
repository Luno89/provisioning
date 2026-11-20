import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';

export const OWNER_ATTRIBUTE = defineSearchAttributeKey('KoalaOwner', SearchAttributeType.KEYWORD);
