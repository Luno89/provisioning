import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listAgents, agentKeys, type Agent } from '../api/agents';
import { chatPackKeys, type ConversationBinding } from '../api/chat-pack.js';
import { listModels, providerKeys, useDefaultModel, modelOptionLabel, type ModelProvider } from '../../models';
import { useMachineChoiceLabel } from '../../machines';
import { postChannelMessage, channelAsksKoala, goesToKoala, rememberChannelAsks, listProjects, projectKeys } from '../../projects';
import { sentAttachment } from '../../files';
import { errorMessage } from '../../../api/client.js';
import { useConversationAutoMode } from './useAutoMode.js';
import { useChatAttachments } from './useChatAttachments.js';
import type { useConversationTurn } from './useConversationTurn.js';
import type { ChatMessageRecord } from '../components/Chat/chat-stream.js';
import { composerModelLabel, packOption, sendKind } from '../lib/chat-composer';

export interface ChatComposerState {
  conv: ReturnType<typeof useConversationTurn>;
  binding?: ConversationBinding | undefined;
  channel: boolean;
  externalConvId?: string | undefined;
  autoSend?: { text: string; onSent?: (() => void) | undefined } | undefined;
  jumpToLatest: () => void;
}

export function useChatComposer({ conv, binding, channel, externalConvId, autoSend, jumpToLatest }: ChatComposerState) {
  const { streaming, setError } = conv;
  const qc = useQueryClient();

  const chatProjectId = binding?.projectId ?? conv.activeConversation?.projectId;
  const projects = useQuery({ queryKey: projectKeys.list(), queryFn: () => listProjects<{ id: string; name: string }>(), enabled: Boolean(chatProjectId) });
  const chatProject = chatProjectId ? projects.data?.find((project) => project.id === chatProjectId) : undefined;
  const attachments = useChatAttachments(chatProject ? { id: chatProject.id, name: chatProject.name } : undefined);

  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: agentKeys.all,
    queryFn: listAgents,
  });
  const { data: defaultSetting } = useDefaultModel();
  const accountDefaultId = defaultSetting?.defaultModelId ?? null;
  const { data: models = [] } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
    staleTime: 5 * 60_000,
  });

  const machineLabel = useMachineChoiceLabel(conv.pinnedModelId);
  const selectedAgent = agents.find((a) => a.slug === conv.selectedAgentSlug);
  const activePack = packOption(selectedAgent);
  const effectiveModel = models.find((m) => m.id === (conv.pinnedModelId ?? accountDefaultId));
  const modelLabel = composerModelLabel(machineLabel, effectiveModel ? modelOptionLabel(effectiveModel) : undefined, conv.pinnedModelId);
  const toolCount = selectedAgent?.tools.length;

  const [askingKoala, setAskingKoala] = useState(() => Boolean(channel && externalConvId && channelAsksKoala(externalConvId)));
  const toggleAskingKoala = () => {
    const next = !askingKoala;
    setAskingKoala(next);
    if (conv.selectedConvId) rememberChannelAsks(conv.selectedConvId, next);
  };

  const askKoalaAbout = (message: ChatMessageRecord) => {
    if (streaming || !message.at) return;
    setError(null);
    jumpToLatest();
    void conv.sendConversationTurn(message.content, { asks: message.at });
  };

  const handleSend = (rawText: string) => {
    const text = rawText.trim();
    const ready = attachments.ready;
    const kind = sendKind({
      text,
      attachments: ready.length,
      streaming,
      uploading: attachments.uploading,
      channel,
      conversationId: conv.selectedConvId,
      toKoala: goesToKoala(text, askingKoala),
    });
    if (kind === 'none') return;
    attachments.clear();

    setError(null);
    jumpToLatest();
    if (kind === 'post' && conv.selectedConvId) {
      const id = conv.selectedConvId;
      void postChannelMessage(id, text, ready.map(sentAttachment))
        .then(() => qc.invalidateQueries({ queryKey: chatPackKeys.conversation(id) }))
        .catch((err: unknown) => setError(errorMessage(err)));
      return;
    }
    void conv.sendConversationTurn(text, { attachments: ready });
  };

  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || streaming || !conv.selectedConvId) return;
    const key = `${conv.selectedConvId}:${autoSend.text}`;
    if (autoSentRef.current === key) return;
    autoSentRef.current = key;
    handleSend(autoSend.text);
    autoSend.onSent?.();
  }, [autoSend, conv.selectedConvId, streaming, handleSend]);

  const autoMode = useConversationAutoMode(conv.selectedConvId, conv.activeConversation);
  const switchAutoMode = async (on: boolean) => {
    try {
      await autoMode.turnTo(on);
    } catch (err) {
      setError(`Auto mode could not be switched ${on ? 'on' : 'off'}: ${errorMessage(err)}`);
      return;
    }
    if (on) await Promise.all(conv.pendingApprovals.map((approval) => conv.decideApproval(approval, 'allow')));
  };

  return {
    attachments,
    activePack,
    modelLabel,
    toolCount,
    askingKoala,
    toggleAskingKoala,
    askKoalaAbout,
    handleSend,
    autoMode,
    switchAutoMode,
  };
}
