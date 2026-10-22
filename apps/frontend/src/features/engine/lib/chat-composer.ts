export type SendKind = 'none' | 'post' | 'turn'

export interface SendSituation {
  text: string
  attachments: number
  streaming: boolean
  uploading: boolean
  channel: boolean
  conversationId: string | null | undefined
  toKoala: boolean
}

export function sendKind(situation: SendSituation): SendKind {
  if ((!situation.text && !situation.attachments) || situation.streaming || situation.uploading) return 'none'
  if (situation.channel && situation.conversationId && !situation.toKoala) return 'post'
  return 'turn'
}

export interface PackOption {
  id: string
  name: string
  label: string
  desc: string
}

export function packOption(agent: { slug: string; name: string; description?: string | undefined } | undefined): PackOption | undefined {
  return agent
    ? { id: agent.slug, name: agent.name, label: agent.name.toUpperCase(), desc: agent.description ?? '' }
    : undefined
}

export function composerModelLabel(machineLabel: string | undefined, modelLabel: string | undefined, pinnedModelId: string | null | undefined): string {
  return machineLabel ?? modelLabel ?? pinnedModelId ?? 'No model'
}

export function channelPlaceholder(askingKoala: boolean): string {
  return askingKoala ? 'Ask Koala — it answers in the channel' : 'Post to the channel — start with @koala to ask Koala'
}
