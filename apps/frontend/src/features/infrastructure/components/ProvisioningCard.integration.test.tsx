import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProvisioningCard } from './ProvisioningCard'
import { startBackend } from '../../../test/backend/site'
import { pageSocketsOf, type PageSockets } from '../../../test/backend/sockets'
import { mountProvisioningStandIn, type ProvisioningStandIn } from '../../../test/backend/provisioning'
import { shown } from '../../../test/backend/hooks'
import { roleFromEnv } from '../../../../../backend/src/platform/lib/platform-role'
import { testIdentityKey } from '../../../../../backend/src/platform/testing/keys'
import { pieceProgress, setUpProgress } from '../../../../../backend/src/infrastructure/lib/provisioning'
import { PROVISION_PIECES } from '@koala/engine-core/koala-install'

let standIn: ProvisioningStandIn | undefined
let sockets: PageSockets | undefined

const backend = await startBackend((site) => {
  standIn = mountProvisioningStandIn(site)
  sockets = pageSocketsOf(site, roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() }))
})
const person = await backend.signIn()
await sockets!.open()
const setups = standIn!

const openCard = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ProvisioningCard /></QueryClientProvider>)
}

describe('the "Setting Koala up" card follows Koala setting itself up while it is open', () => {
  it('shows each piece as Koala reaches it, says where it stopped and why, sets up again, and collapses to one line once everything is up', async () => {
    const card = openCard()
    await shown(() => screen.queryByText('Koala has not started setting itself up yet.'))

    const opened = shown(() => screen.queryByText('Koala\'s own services and monitoring, revision 3'))
    let record = setups.open(person.id, { kind: 'koala', clusterId: 'desk' }, 3)
    await opened

    const egressLine = shown(() => screen.queryByText('waiting for deployment/egress in egress: 0 of 1 ready'))
    record = setups.heard(record.id, pieceProgress(record, 'egress', { state: 'started', line: 'waiting for deployment/egress in egress: 0 of 1 ready' }))
    await egressLine

    for (const key of ['egress', 'searxng', 'crawl4ai'] as const) record = setups.heard(record.id, pieceProgress(record, key, { state: 'done' }))
    const stopped = shown(() => screen.queryByRole('alert'))
    setups.heard(record.id, pieceProgress(record, 'gitea', { state: 'failed', why: 'pod gitea-0 is Init:Error' }))
    expect((await stopped).textContent).toContain('Stopped at Gitea, your repositories and images: pod gitea-0 is Init:Error')

    const again = shown(() => screen.queryByText('because you asked'))
    await userEvent.click(screen.getByRole('button', { name: 'Set up again' }))
    await again
    const asked = setups.asked()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ target: { kind: 'koala', clusterId: 'desk' }, revision: 3, reason: 'asked', state: 'running' })
    expect(screen.queryByRole('button', { name: 'Set up again' })).toBeNull()

    let rerun = asked[0]!
    for (const piece of PROVISION_PIECES) rerun = setups.heard(rerun.id, pieceProgress(rerun, piece.key, { state: 'done' }))
    const collapsed = shown(() => screen.queryByText('Koala\'s services and monitoring are set up (revision 3).'))
    setups.heard(rerun.id, setUpProgress())
    await collapsed
    expect(within(card.container).queryByText('The egress proxy')).toBeNull()
  })
})
