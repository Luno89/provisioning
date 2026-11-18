import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AccountMachines from './AccountMachines'
import { startBackend } from '../../../test/backend/site'
import { rootSidesOf, type RootSides } from '../../../test/backend/machines'
import { pageSocketsOf, type PageSockets } from '../../../test/backend/sockets'
import { shown } from '../../../test/backend/hooks'
import { koalaInstallActivities } from '../../../../../backend/src/activities/KoalaInstallActivities'

let root: RootSides | undefined
let sockets: PageSockets | undefined

const backend = await startBackend(async (site) => {
  root = await rootSidesOf(site)
  sockets = pageSocketsOf(site, root.role)
})
const person = await backend.signIn()
await sockets!.open()
const accounts = root!.sides.accounts!

const openPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AccountMachines name="kangaroo" nameOk hasKoala={false} onPlacing={() => undefined} />
    </QueryClientProvider>,
  )
}

describe('My Machines at root follows what happens to a person\'s machines while it is open', () => {
  it('shows a machine joining with the command made elsewhere as soon as the machine reports its step', async () => {
    const panel = openPanel()
    await shown(() => screen.queryByRole('button', { name: /Add a machine/ }))
    expect(screen.queryByText('Installing k3s')).toBeNull()
    const { code } = await accounts.createJoinCode(person.id)
    const step = shown(() => screen.queryByText('Installing k3s'))
    expect(await accounts.reportJoinProgress(code, { stage: 'k3s', title: 'Installing k3s', state: 'started' })).toEqual({ ok: true, value: { recorded: true } })
    expect((await step).closest('li')?.textContent).toContain('Joining:')
    panel.unmount()
  })

  it('shows the step its Koala\'s install has reached as the machine reports it', async () => {
    const joined = await accounts.join((await accounts.createJoinCode(person.id)).code, { hostname: 'tower', rootDir: '/home/me/tower' })
    if (!joined.ok) throw new Error(joined.error)
    await accounts.recordMeshIp(joined.value.deviceId, '100.64.0.9')
    openPanel()
    const tower = (await shown(() => screen.queryByText('tower'))).closest('li')!
    await userEvent.click(within(tower).getByRole('button', { name: 'Put Koala here' }))
    await shown(() => within(tower).queryByText('Koala is put on it once it connects'))
    const installId = root!.started.at(-1)!
    const stage = koalaInstallActivities({ db: async () => ({ db: backend.db, close: async () => undefined }), now: () => new Date() })
    const reached = shown(() => within(tower).queryByText('Installing Koala\'s chart'))
    expect(await stage.KoalaInstallStageActivity({ installId, progress: { stage: 'chart', title: 'Installing Koala\'s chart', state: 'started', line: 'helm upgrade --install' } })).toBe('installing')
    expect(await reached).toBeTruthy()
    expect(within(tower).getByText('helm upgrade --install')).toBeTruthy()
  })
})
