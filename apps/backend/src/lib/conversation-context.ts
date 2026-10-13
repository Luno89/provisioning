import { openingWith } from '@koala/agent-engine/procedure';

export interface ConversationContext {
  given: Record<string, string>;
  text: string;
}

export function conversationContext(bound: Readonly<Record<string, string>> | undefined): ConversationContext {
  const given = Object.fromEntries(Object.entries(bound ?? {}).filter(([name, value]) => name !== 'message' && value !== ''));
  return { given, text: openingWith('', given) };
}
