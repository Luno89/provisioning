import { describe, it, expect } from 'vitest'
import type { ActionProposal, EgressRequest, McpRequest, PlanProposal, SecretRequest } from '@koala/harness-types'
import { APPROVAL_CARD_ID, cardLine, cardMarkers, chatCards, type CardSources } from './chat-cards'

const none: CardSources = { plans: [], actions: [], secrets: [], mcp: [], egress: [], access: [] }
const plan = (id: string, status: PlanProposal['status'], createdAt: string): PlanProposal => ({
  id, ownerId: 'u', status, createdAt, updatedAt: createdAt, leafPlan: { treeId: 't1', leafId: 'l1', leafTitle: 'Labels', mode: 'breakdown', why: 'w', brief: 'b', tasks: [] },
})
const action = (status: ActionProposal['status'], createdAt: string): ActionProposal => ({
  id: 'a1', ownerId: 'u', kind: 'deploy_project', summary: 'Deploy the shop', detail: [], params: {}, status, createdAt, updatedAt: createdAt,
})
const secret: SecretRequest = { id: 's1', ownerId: 'u', projectId: 'p', key: 'SMTP_PASSWORD', description: 'd', secretReference: 'r', status: 'provided', createdAt: '2026-10-14T09:00:00Z', updatedAt: 'x' }
const mcp: McpRequest = { id: 'm1', ownerId: 'u', conversationId: 'c', server: 'playwright', why: 'w', status: 'requested', createdAt: '2026-10-14T11:00:00Z', updatedAt: 'x' }
const egress: EgressRequest = { id: 'e1', ownerId: 'u', agentSlug: 'executor', host: 'pypi.org', why: 'w', status: 'dismissed', createdAt: '2026-10-14T08:00:00Z', updatedAt: 'x' }

describe('the cards of a chat', () => {
  it('puts what waits for you first, oldest first and the tool call last, then the rest newest first', () => {
    const cards = chatCards({
      ...none,
      plans: [plan('p-old', 'adopted', '2026-10-14T07:00:00Z'), plan('p-new', 'proposed', '2026-10-14T10:00:00Z')],
      actions: [action('failed', '2026-10-14T12:00:00Z')],
      secrets: [secret],
      mcp: [mcp],
      egress: [egress],
      approval: { reason: 'r', toolName: 'run_command' },
    })
    expect(cards.map((card) => card.id)).toEqual(['p-new', 'm1', 'a1', APPROVAL_CARD_ID, 's1', 'e1', 'p-old'])
  })

  it('says in one line what each card is and where it stands', () => {
    const [waiting, approval, decided, dismissed] = chatCards({ ...none, plans: [plan('p', 'proposed', 'a')], secrets: [secret], egress: [egress], approval: { reason: 'Koala wants to run it' } })
    expect(waiting && cardLine(waiting)).toBe('Plan: Break down “Labels” · waits for you')
    expect(approval && cardLine(approval)).toBe('Tool call: Koala wants to run it · waits for you')
    expect(decided && cardLine(decided)).toBe('Secret: SMTP_PASSWORD · provided')
    expect(dismissed && cardLine(dismissed)).toBe('Network access: executor wants to reach pypi.org · dismissed')
  })

  it('places each card after the last message before it was raised, and ones raised since the last message at the end', () => {
    const messages = [{ at: '2026-10-14T10:00:00Z' }, { at: '2026-10-14T10:00:05Z' }, {}, { at: '2026-10-14T10:05:00Z' }]
    const cards = chatCards({ ...none, plans: [plan('p1', 'adopted', '2026-10-14T10:00:03Z'), plan('p0', 'adopted', '2026-10-14T09:00:00Z'), plan('p2', 'proposed', '2026-10-14T10:06:00Z')], approval: { reason: 'r' } })
    const at = cardMarkers(messages, cards)
    expect([...at.entries()].map(([index, placed]) => [index, placed.map((card) => card.id)])).toEqual([
      [-1, ['p0']],
      [0, ['p1']],
      [3, ['p2', APPROVAL_CARD_ID]],
    ])
  })
})
