import type { HubBoardView, HubChat } from '../types'
import type { HubRole } from '../types'
import { ROLE_SAID } from '../shared'
import type { BoardChat } from '../../projects'

export const HUB_CHAT_EVERY_MS = 3_000

export const chatFor = (view: Pick<HubBoardView, 'chats'>, chat: BoardChat): HubChat | undefined =>
  view.chats.find((entry) => chat.kind === 'channel'
    ? entry.kind === 'channel'
    : chat.kind === 'story' ? entry.leafId === chat.id : entry.branchId === chat.id && !entry.leafId)

export const hubPlaceOf = (view: HubBoardView) => ({
  online: view.online,
  ownerEmail: view.members.find((member) => member.personId === view.project.createdBy)?.email,
})

export const youAre = (role: HubRole): string => {
  const title = ROLE_SAID[role].title.toLowerCase()
  return `You are ${title === 'owner' ? 'an owner' : `a ${title}`} here: ${ROLE_SAID[role].can}`
}
