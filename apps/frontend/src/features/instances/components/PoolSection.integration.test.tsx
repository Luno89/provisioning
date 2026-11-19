import { testIdentityKey } from '../../../../../backend/src/platform/testing/keys'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { PoolSection } from './PoolSection'
import NoInstance from './NoInstance'
import { startBackend } from '../../../test/backend/site'
import { shown } from '../../../test/backend/hooks'
import { outsideThisTier } from '../../../test/backend/outside'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { IdentityService } from '../../../../../backend/src/instances/services/IdentityService'
import { InstanceService } from '../../../../../backend/src/instances/services/InstanceService'
import { roleFromEnv } from '../../../../../backend/src/platform/lib/platform-role'
import type { HeadscaleService } from '../../../../../backend/src/infrastructure/services/HeadscaleService'

const started: string[] = []
let instances: InstanceService | undefined

const backend = await startBackend(({ api, db, auth, origin }) => {
  const identity = new IdentityService(roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() }), db)
  instances = new InstanceService(db, {
    rootUrl: origin,
    rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
    registry: '',
    imageTag: 'dev',
    domain: 'people.koala.test',
    pool: { slots: 1, trialDays: 30 },
  }, outsideThisTier<HeadscaleService>('Headscale'), () => new Date(), () => undefined, {
    start: async (instanceId) => { started.push(instanceId) },
    trialChanged: async () => undefined,
    remove: async () => undefined,
    move: async () => undefined,
    moveStopped: async () => undefined,
  })
  api.use('/instances', instancesRouter({
    instances,
    chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') },
    operatorOnly: auth.requireOperator('manage-accounts'),
    administers: auth.requireOperator('administer'),
  }))
})
await backend.signIn()
const other = await backend.signInAnother('other@koala.test')
await backend.signIn()

const opened = (page: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{page}</QueryClientProvider>)

describe('the pool on Koala\'s servers, against root\'s own routes', () => {
  it('refuses a trial length of no days, and says so where the length was changed', async () => {
    const page = opened(<PoolSection />)
    const days = await shown(() => screen.queryByLabelText<HTMLInputElement>('How long a new trial lasts, in days'))
    expect(days.value).toBe('30')
    await userEvent.clear(days)
    await userEvent.type(days, '0')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('a trial is a whole number of days from 1 to 365')
    expect(screen.queryByText('Nobody is trying Koala here yet.')).not.toBeNull()
    page.unmount()
  })

  it('tells a person who asks for a trial after someone else took the last place that the servers are full', async () => {
    const page = opened(<NoInstance hasInstance={false} onLogout={() => undefined} />)
    const trial = await shown(() => screen.queryByRole('button', { name: /Try it on Koala's servers/ }))
    await shown(() => screen.queryByText(/Your instance will be at/))
    const taken = await instances!.createPoolInstance(other.id, 'wombat')
    expect(taken.ok).toBe(true)
    await userEvent.click(trial)
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('Koala\'s servers are full right now; use your own machine, or try again later')
    expect(started).toHaveLength(1)
    page.unmount()
  })
})
