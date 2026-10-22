import { useMemo } from 'react';
import { usePlanProposals } from './usePlanProposals.js';
import { useSecretRequests } from './useSecretRequests.js';
import { useConversationMcp } from './useMcp.js';
import { useActionProposals } from './useActionProposals.js';
import { useEgressRequests } from './useEgressRequests.js';
import { useAccessRequests } from './useAccessRequests.js';
import { listConversationSecretRequests, secretRequestKeys } from '../../projects';
import { egressKeys, listEgressRequests } from '../../infrastructure';
import { actionKeys, listConversationActions } from '../api/actions.js';
import { chatCards, type ToolApproval } from '../components/Chat/chat-cards.js';

export function useChatCards(conversationId: string | null, streaming: boolean, approvals: readonly ToolApproval[]) {
  const plans = usePlanProposals(conversationId, streaming);
  const secrets = useSecretRequests(
    secretRequestKeys.forConversation(conversationId ?? ''),
    () => listConversationSecretRequests(conversationId!),
    Boolean(conversationId),
    streaming,
  );
  const mcp = useConversationMcp(conversationId, streaming);
  const access = useAccessRequests(conversationId, streaming);
  const egress = useEgressRequests(
    egressKeys.requests('conversation', conversationId ?? ''),
    () => listEgressRequests('conversationId', conversationId!),
    Boolean(conversationId),
    streaming,
  );
  const actions = useActionProposals(
    actionKeys.forConversation(conversationId ?? ''),
    () => listConversationActions(conversationId!),
    Boolean(conversationId),
    streaming,
  );
  const cards = useMemo(() => chatCards({
    plans: plans.plans,
    actions: actions.proposals,
    secrets: secrets.requests,
    mcp: mcp.requests,
    egress: egress.requests,
    access: access.requests,
    approvals,
  }), [plans.plans, actions.proposals, secrets.requests, mcp.requests, egress.requests, access.requests, approvals]);
  return { plans, secrets, mcp, access, egress, actions, cards };
}

export type ChatCardSources = ReturnType<typeof useChatCards>;
