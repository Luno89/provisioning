import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectRelease } from './ProjectRelease'
import { startBackend } from '../../../test/backend/site'
import { releaseSettingsRouter } from '../../../../../backend/src/releases/routes/release-settings'
import { releaseSettingsOver, releaseSettingsWorld } from '../../../../../backend/src/releases/testing/release-settings-behaviour'

const backend = await startBackend((site) => {
  site.api.use('/release-settings', releaseSettingsRouter({ settings: releaseSettingsOver(site.db) }))
})
const person = await backend.signIn()
await releaseSettingsWorld(backend.db, person.id)

describe('how a project\'s builds are released, against the real release settings routes', () => {
  it('says why a change was refused when the project went while its settings were open, and keeps showing how it releases', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectRelease projectId="p1" /></QueryClientProvider>)
    const user = userEvent.setup()
    const how = await screen.findByLabelText('How this project\'s builds are released')
    expect(await screen.findByRole('option', { name: 'Release by replacing' })).toBeTruthy()
    expect(screen.getByText(/as its tree type says/)).toBeTruthy()
    await backend.db.projects.removeProjectRecords('p1')
    await user.selectOptions(how, 'release-replace')
    expect(await screen.findByText('Project not found')).toBeTruthy()
    expect(screen.getByText(/as its tree type says/)).toBeTruthy()
  })
})
