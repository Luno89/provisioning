import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ArtifactStoragePrompt from './ArtifactStoragePrompt'
import * as artifactsApi from '../api/artifacts'
import { useShellStore } from '../stores/shell'

vi.mock('../api/artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof artifactsApi>()),
  getArtifactStorage: vi.fn(),
}))

const show = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <ArtifactStoragePrompt />
  </QueryClientProvider>,
)

beforeEach(() => {
  window.localStorage.clear()
  useShellStore.setState({ appDeploy: null })
})

describe('the MinIO prompt beside browser test files', () => {
  it('offers to deploy MinIO to someone without one, opening the app deploy for it', async () => {
    vi.mocked(artifactsApi.getArtifactStorage).mockResolvedValue({ minio: false })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy MinIO' }))
    expect(useShellStore.getState().appDeploy).toEqual({ appType: 'minio', name: 'minio' })
  })

  it('stays away once dismissed', async () => {
    vi.mocked(artifactsApi.getArtifactStorage).mockResolvedValue({ minio: false })
    const first = show()
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('note')).toBeNull()
    first.unmount()
    show()
    await new Promise((done) => setTimeout(done, 20))
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('says nothing to someone who has MinIO', async () => {
    vi.mocked(artifactsApi.getArtifactStorage).mockResolvedValue({ minio: true })
    show()
    await new Promise((done) => setTimeout(done, 20))
    expect(screen.queryByRole('note')).toBeNull()
  })
})
