import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from './StatusBar'
import * as releasesApi from '../../../api/releases'
import * as projectsApi from '../../../api/projects'

vi.mock('../../../api/releases', async (orig) => ({ ...(await orig<typeof releasesApi>()), listReleases: vi.fn() }))
vi.mock('../../../api/projects', async (orig) => ({ ...(await orig<typeof projectsApi>()), listProjectRuns: vi.fn() }))
vi.mock('../Workspace/OpenApp', () => ({ OpenApp: () => <button type="button">Open app</button> }))
vi.mock('../Workspace/SignInReveal', () => ({ SignInReveal: () => <button type="button">Show sign-in</button> }))
vi.mock('../Workspace/ReleasesPanel', () => ({ Decision: ({ release }: { release: { commit: string } }) => <div data-testid="decision">{release.commit}</div> }))

const release = (over: Partial<releasesApi.OdooRelease>): releasesApi.OdooRelease => ({ id: 'r', projectId: 'p1', pipelineRunId: 'x', commit: '6937bcf0aa', image: 'i', state: 'live', host: 'h', startedAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z', ...over })

const renderStatus = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StatusBar projectId="p1" /></QueryClientProvider>)

describe('what is going on with a project, at the top of its board', () => {
  it('says what is live with a way to open it and sign in, the last build, and puts a waiting preview\'s decision in reach', async () => {
    vi.mocked(releasesApi.listReleases).mockResolvedValue({ releases: [release({ slot: 'a' }), release({ id: 'n', state: 'preview', commit: 'beefbeef11', slot: 'b' })], addresses: {} })
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([{ id: 'b', projectId: 'p1', commitSha: 'beefbeef11', ref: 'main', status: 'succeeded', startedAt: '2026-10-09T11:00:00Z' }] as never)
    renderStatus()
    expect(await screen.findByText('6937bcf0')).toBeInTheDocument()
    expect(screen.getByText('slot a')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open app' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show sign-in' })).toBeInTheDocument()
    expect(await screen.findByText('succeeded')).toBeInTheDocument()
    expect(screen.getByTestId('decision')).toHaveTextContent('beefbeef11')
  })

  it('says it is reading rather than that nothing is live, until it knows', async () => {
    let answer = (_: { releases: never[]; addresses: Record<string, never> }) => {}
    vi.mocked(releasesApi.listReleases).mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    renderStatus()
    expect(await screen.findByRole('status')).toHaveTextContent('Reading what is live and the last build…')
    expect(screen.queryByText('Nothing live yet')).not.toBeInTheDocument()
    answer({ releases: [], addresses: {} })
    expect(await screen.findByText('Nothing live yet')).toBeInTheDocument()
  })

  it('says nothing is live yet, with nothing to open', async () => {
    vi.mocked(releasesApi.listReleases).mockResolvedValue({ releases: [], addresses: {} })
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([])
    renderStatus()
    expect(await screen.findByText('Nothing live yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open app' })).not.toBeInTheDocument()
  })
})
