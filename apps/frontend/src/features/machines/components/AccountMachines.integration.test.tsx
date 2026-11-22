import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AccountMachines from './AccountMachines'
import { startBackend } from '../../../test/backend/site'
import { rootSidesOf, type RootSides } from '../../../test/backend/machines'
import { pageSocketsOf, type PageSockets } from '../../../test/backend/sockets'
import { shown, type ShownPage } from '../../../test/backend/hooks'
import { koalaInstallActivities } from '../../../../../backend/src/activities/KoalaInstallActivities'
import { runSteps } from '@koala/provision'
import { joinArgsOf } from '../../../../../local-agent/src/join/args'
import { localJoinHost } from '../../../../../local-agent/src/join/host'
import { joinPins } from '../../../../../local-agent/src/join/pins'
import { joinRootStep } from '../../../../../local-agent/src/join/steps/join-root'
import { rootReporter } from '../../../../../local-agent/src/root-progress'

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
  const panel = render(
    <QueryClientProvider client={client}>
      <AccountMachines name="kangaroo" nameOk hasKoala={false} onPlacing={() => undefined} />
    </QueryClientProvider>,
  )
  const page: ShownPage = { client }
  return { panel, on: <T,>(find: () => T | null) => shown(find, page) }
}

const home = await mkdtemp(path.join(tmpdir(), 'koala-account-machines-'))
afterAll(() => rm(home, { recursive: true, force: true }))

describe('My Machines at root follows what happens to a person\'s machines while it is open', () => {
  it('shows a machine joining with the command made elsewhere as soon as the machine reports its step', async () => {
    const { panel, on } = openPanel()
    await on(() => screen.queryByRole('button', { name: /Add a machine/ }))
    expect(screen.queryByText('Installing k3s')).toBeNull()
    const { code } = await accounts.createJoinCode(person.id)
    const step = on(() => screen.queryByText('Installing k3s'))
    expect(await accounts.reportJoinProgress(code, { stage: 'k3s', title: 'Installing k3s', state: 'started' })).toEqual({ ok: true, value: { recorded: true } })
    expect((await step).closest('li')?.textContent).toContain('Joining:')
    panel.unmount()
  })

  it('shows the step its Koala\'s install has reached as the machine reports it', async () => {
    const joined = await accounts.join((await accounts.createJoinCode(person.id)).code, { hostname: 'tower', rootDir: '/home/me/tower' })
    if (!joined.ok) throw new Error(joined.error)
    await accounts.recordMeshIp(joined.value.deviceId, '100.64.0.9')
    const { on } = openPanel()
    const tower = (await on(() => screen.queryByText('tower'))).closest('li')!
    await userEvent.click(within(tower).getByRole('button', { name: 'Put Koala here' }))
    await on(() => within(tower).queryByText('Koala is put on it once it connects'))
    const installId = root!.started.at(-1)!
    const stage = koalaInstallActivities({ db: async () => ({ db: backend.db, close: async () => undefined }), now: () => new Date() })
    const reached = on(() => within(tower).queryByText('Installing Koala\'s chart'))
    expect(await stage.KoalaInstallStageActivity({ installId, progress: { stage: 'chart', title: 'Installing Koala\'s chart', state: 'started', line: 'helm upgrade --install' } })).toBe('installing')
    expect(await reached).toBeTruthy()
    expect(within(tower).getByText('helm upgrade --install')).toBeTruthy()
  })

  it('shows a join that stopped because the settings the machine kept are not the ones Koala writes, with where, why and what to do, and no new machine', async () => {
    const { panel, on } = openPanel()
    await on(() => screen.queryByRole('button', { name: /Add a machine/ }))
    const { code } = await accounts.createJoinCode(person.id)
    const settings = path.join(home, '.config', 'koala', 'machine.json')
    await mkdir(path.dirname(settings), { recursive: true })
    await writeFile(settings, 'not what Koala writes')
    const args = joinArgsOf([code, '--url', backend.origin, '--yes', '--folder', path.join(home, 'koala')])
    const host = localJoinHost({ env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, machineRoot: path.join(home, 'machine'), user: { uid: 1000, name: 'bo', group: 'bo', home }, hostname: 'stray' })
    const ctx = { args, host, commands: { run: async () => { throw new Error('the join step runs no command') } }, pins: joinPins(undefined), folder: path.join(home, 'koala'), agentDir: path.join(home, 'agent'), node: process.execPath }
    const reporter = rootReporter({
      tell: async (progress) => {
        const heard = await accounts.reportJoinProgress(code, progress)
        if (!heard.ok) throw new Error(heard.error)
      },
    })
    await expect(runSteps([joinRootStep(backend.origin)], ctx, reporter)).rejects.toThrow('is not the settings Koala writes')
    const alert = await on(() => screen.queryByText(/A machine could not join at/))
    const row = alert.closest('li')!
    expect(row.textContent).toContain(`Joining ${backend.origin}`)
    expect(row.textContent).toContain(`${settings} is not the settings Koala writes (`)
    expect(row.textContent).toContain(`If this machine is on My Machines already, remove it there; then delete ${settings} and run this command again.`)
    expect(screen.queryByText('stray')).toBeNull()
    panel.unmount()
  })
})
