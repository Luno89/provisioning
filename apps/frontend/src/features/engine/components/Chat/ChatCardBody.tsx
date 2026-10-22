import PlanProposalCard from './PlanProposalCard.js';
import AccessRequestCard from './AccessRequestCard.js';
import EgressRequestCard from './EgressRequestCard.js';
import ActionProposalCard from './ActionProposalCard.js';
import McpRequestCard from './McpRequestCard.js';
import SecretRequestCard from './SecretRequestCard.js';
import ChatApprovalCard from './ChatApprovalCard.js';
import type { StoryAddress } from './ChatNotice.js';
import type { ChatCard, ToolApproval } from './chat-cards.js';
import type { ChatCardSources } from '../../hooks/useChatCards.js';
import type { ApprovalDecision } from '../../hooks/useConversationTurn.js';

export interface ChatCardBodyProps {
  card: ChatCard;
  from: ChatCardSources;
  onOpenTree?: ((treeId: string) => void) | undefined;
  onOpenStory?: ((story: StoryAddress) => void) | undefined;
  onApproval: (approval: ToolApproval, decision: ApprovalDecision | 'auto-chat') => void;
}

export function ChatCardBody({ card, from, onOpenTree, onOpenStory, onApproval }: ChatCardBodyProps) {
  const { plans, access, egress, actions, mcp, secrets } = from;
  switch (card.kind) {
    case 'plan':
      return (
        <PlanProposalCard
          proposal={card.item}
          deciding={plans.deciding}
          onApprove={() => plans.approve(card.id)}
          onReject={(reason) => plans.reject(card.id, reason)}
          onOpenTree={onOpenTree}
          onOpenStory={onOpenStory}
        />
      );
    case 'access':
      return <AccessRequestCard request={card.item} busy={access.busy} error={access.error} onGrant={() => access.grant(card.id)} onDismiss={() => access.dismiss(card.id)} />;
    case 'egress':
      return <EgressRequestCard request={card.item} busy={egress.busy} error={egress.error} onAllow={() => egress.allow(card.id)} onDismiss={() => egress.dismiss(card.id)} />;
    case 'action':
      return <ActionProposalCard proposal={card.item} busy={actions.busy} error={actions.error} onApply={() => actions.apply(card.id)} onReject={() => actions.reject(card.id)} />;
    case 'mcp':
      return <McpRequestCard request={card.item} busy={mcp.busy} error={mcp.error} onEnable={() => mcp.enable(card.id)} onDismiss={() => mcp.dismiss(card.id)} />;
    case 'secret':
      return (
        <SecretRequestCard
          request={card.item}
          busy={secrets.busy}
          error={secrets.error}
          onSubmit={(value, done) => secrets.submit(card.id, value, done)}
          onDismiss={() => secrets.dismiss(card.id)}
        />
      );
    case 'approval':
      return (
        <ChatApprovalCard
          reason={card.item.reason}
          {...(card.item.toolName ? { toolName: card.item.toolName } : {})}
          {...(card.item.args ? { args: card.item.args } : {})}
          onDecide={(decision) => onApproval(card.item, decision)}
        />
      );
  }
}
