import type { HubRequestKind } from '../../../../types/hub'
import type { HubPlace } from '../../lib/work-source'

const DOING: Record<HubRequestKind, string> = {
  'approve-plan': 'approval',
  'reject-plan': 'rejection',
  'order-stories': 'new order',
  'order-features': 'new order',
  'accept-task': 'acceptance',
  'drop-task': 'drop',
  'ask-koala': 'question',
  'open-chat': 'new chat',
}

export const waitingLine = (hub: Pick<HubPlace, 'online' | 'ownerEmail'>, kind: HubRequestKind): string => {
  const owner = hub.ownerEmail ? `${hub.ownerEmail}'s instance` : 'the owner\'s instance'
  return hub.online
    ? `The ${DOING[kind]} is on its way to ${owner}.`
    : `The ${DOING[kind]} waits for ${owner}, which is offline; it is carried out when it is back.`
}

export function waitingOn(hub: HubPlace | undefined, kinds: readonly HubRequestKind[], field: string, id: string): string | undefined {
  const request = hub?.requests.find((entry) => entry.state === 'waiting' && kinds.includes(entry.kind) && entry.input[field] === id)
  return hub && request ? waitingLine(hub, request.kind) : undefined
}

export function refusedOn(hub: HubPlace | undefined, kinds: readonly HubRequestKind[], field: string, id: string): string | undefined {
  const request = [...(hub?.requests ?? [])].reverse().find((entry) => kinds.includes(entry.kind) && entry.input[field] === id)
  return request?.state === 'refused' ? `The owner's instance did not do it: ${request.why ?? 'it gave no reason'}.` : undefined
}
