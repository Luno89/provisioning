import { mentionsKoala } from '../api/project-channel'

type Store = Pick<Storage, 'getItem' | 'setItem'>

const keyFor = (channelId: string): string => `koala-channel-asks:${channelId}`

const browserStore = (): Store | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function channelAsksKoala(channelId: string, storage: Store | undefined = browserStore()): boolean {
  try {
    return storage?.getItem(keyFor(channelId)) === 'yes'
  } catch {
    return false
  }
}

export function rememberChannelAsks(channelId: string, on: boolean, storage: Store | undefined = browserStore()): void {
  try {
    storage?.setItem(keyFor(channelId), on ? 'yes' : 'no')
  } catch {
    return
  }
}

export const goesToKoala = (text: string, askingKoala: boolean): boolean => askingKoala || mentionsKoala(text)

export type ChannelAddress = 'koala' | 'channel'

export function addressOf(message: { role: string; runId?: string | undefined }, local: boolean): ChannelAddress | undefined {
  if (message.role !== 'user') return undefined
  return local || message.runId ? 'koala' : 'channel'
}
