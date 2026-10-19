import type { AccessRequest, ActionProposal, EgressRequest, McpRequest, PlanProposal, SecretRequest } from '@koala/harness-types'
import { changeHeading } from '../../lib/item-change'

export interface ToolApproval {
  runId: string
  callId: string
  reason: string
  toolName?: string | undefined
  args?: string | undefined
}

export type ChatCard =
  | { kind: 'plan'; id: string; at: string; item: PlanProposal }
  | { kind: 'action'; id: string; at: string; item: ActionProposal }
  | { kind: 'secret'; id: string; at: string; item: SecretRequest }
  | { kind: 'mcp'; id: string; at: string; item: McpRequest }
  | { kind: 'egress'; id: string; at: string; item: EgressRequest }
  | { kind: 'access'; id: string; at: string; item: AccessRequest }
  | { kind: 'approval'; id: string; at?: undefined; item: ToolApproval }

export interface CardSources {
  plans: readonly PlanProposal[]
  actions: readonly ActionProposal[]
  secrets: readonly SecretRequest[]
  mcp: readonly McpRequest[]
  egress: readonly EgressRequest[]
  access: readonly AccessRequest[]
  approvals?: readonly ToolApproval[] | undefined
}

export const approvalCardId = (approval: Pick<ToolApproval, 'runId' | 'callId'>): string => `tool-approval ${approval.runId} ${approval.callId}`

const LAST = '~'

const raisedAt = (card: ChatCard): string => card.at ?? LAST
const earlier = (a: ChatCard, b: ChatCard): number => (raisedAt(a) < raisedAt(b) ? -1 : raisedAt(a) > raisedAt(b) ? 1 : 0)

const KIND_WORD: Record<ChatCard['kind'], string> = {
  plan: 'Plan',
  action: 'Action',
  secret: 'Secret',
  mcp: 'MCP server',
  egress: 'Network access',
  access: 'Cluster access',
  approval: 'Tool call',
}

const STATUS_WORD: Record<string, string> = {
  superseded: 'replaced',
  adopting: 'being applied',
  adopted: 'approved',
  applying: 'being applied',
  applied: 'applied',
  rejected: 'rejected',
  dismissed: 'dismissed',
  enabled: 'turned on',
  allowed: 'allowed',
  granted: 'granted',
  provided: 'provided',
  provisioned: 'provided',
}

export function planHeading({ plan, leafPlan, change }: PlanProposal): string {
  if (change) return changeHeading(change)
  if (leafPlan) return `${leafPlan.mode === 'replan' ? 'Replan' : 'Break down'} “${leafPlan.leafTitle}”`
  return plan?.tree ? `New ${plan.tree.type} tree “${plan.tree.name}”` : 'Grows the current tree'
}

export function cardTitle(card: ChatCard): string {
  switch (card.kind) {
    case 'plan': return planHeading(card.item)
    case 'action': return card.item.summary
    case 'secret': return card.item.key
    case 'mcp': return `Turn on ${card.item.server}`
    case 'egress': return `${card.item.agentSlug} wants to reach ${card.item.host}`
    case 'access': return card.item.namespaces.join(', ')
    case 'approval': return card.item.toolName ? `Run ${card.item.toolName}` : card.item.reason
  }
}

export function isWaiting(card: ChatCard): boolean {
  switch (card.kind) {
    case 'plan':
    case 'action':
      return card.item.status === 'proposed' || card.item.status === 'failed'
    case 'approval':
      return true
    default:
      return card.item.status === 'requested'
  }
}

export function cardLine(card: ChatCard): string {
  const state = isWaiting(card) ? 'waits for you' : card.kind === 'approval' ? '' : STATUS_WORD[card.item.status] ?? card.item.status
  return `${KIND_WORD[card.kind]}: ${cardTitle(card)}${state ? ` · ${state}` : ''}`
}

export function chatCards(sources: CardSources): ChatCard[] {
  const cards: ChatCard[] = [
    ...sources.plans.map((item) => ({ kind: 'plan' as const, id: item.id, at: item.createdAt, item })),
    ...sources.actions.map((item) => ({ kind: 'action' as const, id: item.id, at: item.createdAt, item })),
    ...sources.secrets.map((item) => ({ kind: 'secret' as const, id: item.id, at: item.createdAt, item })),
    ...sources.mcp.map((item) => ({ kind: 'mcp' as const, id: item.id, at: item.createdAt, item })),
    ...sources.egress.map((item) => ({ kind: 'egress' as const, id: item.id, at: item.createdAt, item })),
    ...sources.access.map((item) => ({ kind: 'access' as const, id: item.id, at: item.createdAt, item })),
    ...(sources.approvals ?? []).map((item) => ({ kind: 'approval' as const, id: approvalCardId(item), item })),
  ]
  const waiting = cards.filter(isWaiting).sort(earlier)
  const settled = cards.filter((card) => !isWaiting(card)).sort((a, b) => earlier(b, a))
  return [...waiting, ...settled]
}

export function cardMarkers(messages: readonly { at?: string | undefined }[], cards: readonly ChatCard[]): Map<number, ChatCard[]> {
  const markers = new Map<number, ChatCard[]>()
  const raised = [...cards].sort(earlier)
  for (const card of raised) {
    const next = card.at ? messages.findIndex((message) => message.at !== undefined && message.at > card.at!) : -1
    const after = next === -1 ? messages.length - 1 : next - 1
    markers.set(after, [...(markers.get(after) ?? []), card])
  }
  return markers
}
