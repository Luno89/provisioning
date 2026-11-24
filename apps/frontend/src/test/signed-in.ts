import { vi } from 'vitest'
import { listClusters, listDeployments, listProviders } from '../features/infrastructure'
import { getMe } from '../features/platform'

export const signedInShell = (): void => {
  vi.clearAllMocks()
  vi.mocked(listClusters).mockResolvedValue([])
  vi.mocked(listDeployments).mockResolvedValue([])
  vi.mocked(listProviders).mockResolvedValue([])
  vi.mocked(getMe).mockResolvedValue({ id: 'u1', email: 'u@example.com' })
}
