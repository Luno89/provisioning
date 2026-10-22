import type { ConversationNotice } from '../../engine/lib/conversations.js';
import type { AlertEpisode } from './monitoring-records.js';

export interface AlertWhere {
  projectId?: string | undefined;
  conversationId?: string | undefined;
}

export function alertNotice(episode: AlertEpisode, change: 'fired' | 'resolved'): ConversationNotice {
  const deploymentId = episode.about.kind === 'app' ? episode.about.deploymentId : undefined;
  const text = change === 'fired'
    ? `Alert: ${episode.summary}.`
    : `Resolved: ${episode.summary} (since ${episode.startedAt}).`;
  return {
    key: `alert:${episode.id}:${change}`,
    kind: change === 'fired' ? 'alert-firing' : 'alert-resolved',
    text,
    refs: { clusterId: episode.clusterId, ...(deploymentId ? { deploymentId } : {}) },
    actions: ['open-monitoring'],
  };
}

export function alertWhere(projectId: string | undefined, ruleConversation: string | undefined): AlertWhere {
  if (projectId) return { projectId };
  if (ruleConversation) return { conversationId: ruleConversation };
  return {};
}
