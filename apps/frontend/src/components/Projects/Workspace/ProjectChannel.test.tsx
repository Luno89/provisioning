import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectChannel } from './ProjectChannel'
import * as channelApi from '../../../api/project-channel'

vi.mock('../../ChatSurface.js', () => ({
  default: ({ conversationId, channel, binding }: { conversationId: string; channel?: boolean; binding?: { projectId?: string } }) => (
    <div data-testid="chat">{`${conversationId} channel=${String(channel)} project=${binding?.projectId}`}</div>
  ),
}))

vi.mock('../../../api/project-channel', async (orig) => ({
  ...(await orig<typeof channelApi>()),
  getProjectChannel: vi.fn(async () => ({ channel: { id: 'channel-p1', title: 'Shop' }, threads: [{ id: 'side', title: 'About the discount', messageCount: 3 }] })),
}))

describe('a project\'s channel', () => {
  it('opens the project\'s own conversation as a channel', async () => {
    render(<QueryClientProvider client={new QueryClient()}><ProjectChannel projectId="p1" /></QueryClientProvider>)
    expect(await screen.findByTestId('chat')).toHaveTextContent('channel-p1 channel=true project=p1')
  })
})

describe('calling Koala in', () => {
  it('takes @koala on its own word, not in an address', () => {
    expect(channelApi.mentionsKoala('@koala how is it going?')).toBe(true)
    expect(channelApi.mentionsKoala('can you check, @Koala')).toBe(true)
    expect(channelApi.mentionsKoala('write to ops@koala.dev')).toBe(false)
    expect(channelApi.mentionsKoala('the shop opens at 9')).toBe(false)
  })
})
