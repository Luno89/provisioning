import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NoInstance from './NoInstance'
import { startBackend } from '../../../test/backend/site'
import { rootSidesOf, type RootSides } from '../../../test/backend/machines'
import { pageSocketsOf, type PageSockets } from '../../../test/backend/sockets'
import { openPage } from '../../../test/backend/hooks'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { koalaPlacedAndUp } from '../../../../../backend/src/instances/testing/placed-koala'

let root: RootSides | undefined
let sockets: PageSockets | undefined

const backend = await startBackend(async (site) => {
  root = await rootSidesOf(site)
  sockets = pageSocketsOf(site, root.role)
  site.api.use('/instances', instancesRouter({ instances: root.places, chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') } }))
})
const person = await backend.signIn()
await sockets!.open()

const gitea = { stage: 'gitea', title: 'Gitea, your repositories and images' }

describe('root\'s page when the owner\'s Koala stopped setting itself up', () => {
  it('offers Set up again only once the setup stopped, and follows the new attempt as the Koala reports it', async () => {
    const koala = await koalaPlacedAndUp(root!.places, backend.db, person.id, { id: 'desk', name: 'desk', meshIp: '100.64.0.9' }, 'kangaroo')
    const report = async (provision: unknown) => {
      const told = await root!.places.report(koala.instanceId, koala.token, { provision })
      if (!told.ok) throw new Error(told.error)
    }
    await report({ revision: 2, run: 'run-1', progress: { ...gitea, state: 'started', line: 'waiting for gitea-0' } })
    const { on } = openPage(<NoInstance hasInstance={false} onLogout={() => undefined} />, { followsSocket: true })
    await on(() => screen.queryByText('Koala on desk is setting itself up: Gitea, your repositories and images, waiting for gitea-0'))
    expect(screen.queryByRole('button', { name: /Set up again/ })).toBeNull()

    await report({ revision: 2, run: 'run-1', progress: { ...gitea, state: 'failed', why: 'the volume is full' } })
    const again = await on(() => screen.queryByRole('button', { name: /Set up again/ }))
    expect(screen.getByRole('alert').textContent).toContain('Koala on desk stopped setting itself up at Gitea, your repositories and images: the volume is full')

    await userEvent.click(again)
    await on(() => screen.queryByText('Koala on desk sets itself up again from Gitea, your repositories and images once it connects to root'))
    expect(screen.queryByRole('button', { name: /Set up again/ })).toBeNull()

    await report({ revision: 2, run: 'run-2', progress: { ...gitea, state: 'started', line: 'waiting for gitea-0 again' } })
    await on(() => screen.queryByText('Koala on desk is setting itself up: Gitea, your repositories and images, waiting for gitea-0 again'))

    await report({ revision: 2, run: 'run-2', progress: { ...gitea, state: 'failed', why: 'the volume is still full' } })
    await on(() => screen.queryByText(/the volume is still full/))
    expect(screen.getByRole('button', { name: /Set up again/ })).toBeTruthy()
  })
})
