import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NoInstance from './NoInstance'
import { startPoolInstance } from '../api/instances'
import { startBackend } from '../../../test/backend/site'
import { rootSidesOf, type RootSides } from '../../../test/backend/machines'
import { pageSocketsOf, type PageSockets } from '../../../test/backend/sockets'
import { shown } from '../../../test/backend/hooks'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { koalaInstallActivities } from '../../../../../backend/src/activities/KoalaInstallActivities'

let root: RootSides | undefined
let sockets: PageSockets | undefined
const poolWork: string[] = []

const backend = await startBackend(async (site) => {
  root = await rootSidesOf(site, {
    pool: {
      start: async (instanceId) => { poolWork.push(`start ${instanceId}`) },
      trialChanged: async () => undefined,
      remove: async () => undefined,
      move: async (instanceId) => { poolWork.push(`move ${instanceId}`) },
      moveStopped: async (instanceId, reason) => { poolWork.push(`stop ${instanceId}: ${reason}`) },
    },
  })
  site.api.use('/instances', instancesRouter({ instances: root.places, chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') } }))
  sockets = pageSocketsOf(site, root.role)
})
const person = await backend.signIn()
await sockets!.open()
const accounts = root!.sides.accounts!
const stage = koalaInstallActivities({ db: async () => ({ db: backend.db, close: async () => undefined }), now: () => new Date() })

const started = await startPoolInstance('kangaroo')
const [trial] = await backend.db.instances.getInstances(person.id)
await backend.db.instances.saveInstance({ ...trial!, status: 'paused', detail: 'The trial has ended' })

const openPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NoInstance hasInstance={false} onLogout={() => undefined} /></QueryClientProvider>)

describe('root\'s page moving a trial that ended onto the person\'s own machine', () => {
  it('gives the machine join command, and follows the machine that joins with it as root hears of it', async () => {
    openPage()
    await shown(() => screen.queryByText('Your trial has ended'))
    await userEvent.click(await shown(() => screen.queryByRole('button', { name: 'Move to my own machine' })))
    const command = (await shown(() => screen.queryByText(/machine\.sh \| sh -s -- /))).textContent!
    expect(command).toMatch(new RegExp(`^curl -fsSL ${backend.origin}/machine\\.sh \\| sh -s -- \\S+$`))
    expect(screen.getByText('Run this on your machine as yourself; it asks for sudo once:')).toBeTruthy()
    expect(poolWork).toEqual([`start ${started.id}`, `move ${started.id}`])

    const joined = await accounts.join(command.split(' ').at(-1)!, { hostname: 'desk', rootDir: '/home/me/desk' })
    if (!joined.ok) throw new Error(joined.error)
    await accounts.recordMeshIp(joined.value.deviceId, '100.64.0.9')
    expect(await accounts.deliverKoala(joined.value.deviceId)).toEqual({ ok: true, value: { placing: true } })
    const desk = (await shown(() => screen.queryByText('Koala moves onto it once it connects'))).closest('li')!
    expect(within(desk).getByText('desk')).toBeTruthy()
    expect(await shown(() => screen.queryByText('Your machine is setting itself up (desk)'))).toBeTruthy()
    expect(within(desk).queryByRole('button', { name: 'Move here' })).toBeNull()

    expect(await stage.KoalaInstallStageActivity({ installId: root!.started.at(-1)!, progress: { stage: 'keys', title: 'Bringing your keys over', state: 'started', line: 'fetching the keys' } })).toBe('installing')
    await shown(() => within(desk).queryByText('fetching the keys'))
    expect(within(desk).getByText('Bringing your keys over')).toBeTruthy()
  })

  it('keeps the machine when the move stops there, says where and why, and Move here moves it again with no new command', async () => {
    openPage()
    const desk = (await shown(() => screen.queryByText('Bringing your keys over'))).closest('li')!
    expect(await stage.KoalaInstallStageActivity({ installId: root!.started.at(-1)!, progress: { stage: 'koala', title: 'Bringing Koala over', state: 'failed', why: 'the pool copy\'s data could not be read' } })).toEqual({ ended: 'failed', instanceId: started.id, why: 'Moving Koala to desk stopped at Bringing Koala over: the pool copy\'s data could not be read' })
    await shown(() => within(desk).queryByText('Moving Koala here stopped at Bringing Koala over', { exact: false }))
    expect(within(desk).getByText('the pool copy\'s data could not be read')).toBeTruthy()
    expect(await shown(() => screen.queryByText('The move stopped (desk)'))).toBeTruthy()

    const installs = root!.started.length
    await userEvent.click(within(desk).getByRole('button', { name: 'Move here' }))
    await shown(() => within(desk).queryByText('Koala moves onto it once it connects'))
    expect(root!.started).toHaveLength(installs + 1)
    expect(poolWork.at(-1)).toBe(`move ${started.id}`)
    expect(await shown(() => screen.queryByText('Your machine is setting itself up (desk)'))).toBeTruthy()
  })
})
