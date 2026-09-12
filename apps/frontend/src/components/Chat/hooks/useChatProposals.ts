import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  acceptTreeProposal,
  dismissTreeProposal,
  acceptSpecProposal,
  dismissSpecProposal,
  acceptEscalationProposal,
  denyEscalationProposal,
  submitSecretRequest,
  dismissSecretRequest,
  chatPackKeys,
  type ChatConversation,
} from '../../../api/chat-pack.js';
import { pendingProposalsCount } from '../../ProposalsSidebar.js';
import { errorMessage } from '../../../api/client.js';
import type { ChatRenderState } from '../../../lib/chat-unified-reducer.js';

export interface UseChatProposalsOptions {
  activeConversation?: ChatConversation | null | undefined;
  liveState: ChatRenderState;
  onOpenTree?: ((treeId: string) => void) | undefined;
  onError: (msg: string | null) => void;
}

export function useChatProposals({
  activeConversation,
  liveState,
  onOpenTree,
  onError,
}: UseChatProposalsOptions) {
  const qc = useQueryClient();

  const acceptTreeMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptTreeProposal(convId, proposalId),
    onSuccess: (res: any, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
      qc.invalidateQueries({ queryKey: ['trees'] });
      if (res?.tree?.id) {
        onOpenTree?.(res.tree.id);
      }
    },
    onError: (err) => onError(`Could not accept the proposal: ${errorMessage(err)}`),
  });

  const dismissTreeMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      dismissTreeProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => onError(`Could not dismiss the proposal: ${errorMessage(err)}`),
  });

  const acceptSpecMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptSpecProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => onError(`Could not add to the catalogue: ${errorMessage(err)}`),
  });

  const dismissSpecMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      dismissSpecProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => onError(`Could not dismiss the proposal: ${errorMessage(err)}`),
  });

  const acceptEscalationMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      acceptEscalationProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => onError(`Could not grant access: ${errorMessage(err)}`),
  });

  const denyEscalationMutation = useMutation({
    mutationFn: ({ convId, proposalId }: { convId: string; proposalId: string }) =>
      denyEscalationProposal(convId, proposalId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => onError(`Could not deny access: ${errorMessage(err)}`),
  });

  const submitSecretMutation = useMutation({
    mutationFn: ({ convId, requestId, value }: { convId: string; requestId: string; value: string }) =>
      submitSecretRequest(convId, requestId, value),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => onError(`Could not save the secret: ${errorMessage(err)}`),
  });

  const dismissSecretMutation = useMutation({
    mutationFn: ({ convId, requestId }: { convId: string; requestId: string }) =>
      dismissSecretRequest(convId, requestId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: chatPackKeys.conversation(variables.convId) });
      qc.invalidateQueries({ queryKey: chatPackKeys.conversations() });
    },
    onError: (err) => onError(`Could not dismiss the secret request: ${errorMessage(err)}`),
  });

  const liveTrees = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'tree').map((p) => p.payload),
    [liveState.proposals],
  );
  const liveSpecs = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'spec').map((p) => p.payload),
    [liveState.proposals],
  );
  const liveEscalations = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'escalation').map((p) => p.payload),
    [liveState.proposals],
  );
  const liveSecretRequests = useMemo(
    () => liveState.proposals.filter((p) => p.kind === 'secretRequest').map((p) => p.payload),
    [liveState.proposals],
  );

  const pendingCount = useMemo(() => pendingProposalsCount({
    liveTrees, persistedTrees: activeConversation?.proposedTrees,
    liveSpecs, persistedSpecs: activeConversation?.proposedSpecs,
    liveEscalations, persistedEscalations: activeConversation?.proposedEscalations,
    liveSecretRequests, persistedSecretRequests: activeConversation?.proposedSecretRequests,
  }), [liveTrees, liveSpecs, liveEscalations, liveSecretRequests, activeConversation]);

  return {
    acceptTreeMutation,
    dismissTreeMutation,
    acceptSpecMutation,
    dismissSpecMutation,
    acceptEscalationMutation,
    denyEscalationMutation,
    submitSecretMutation,
    dismissSecretMutation,
    liveTrees,
    liveSpecs,
    liveEscalations,
    liveSecretRequests,
    pendingCount,
  };
}
