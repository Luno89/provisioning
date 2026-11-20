import { testIdentityKey } from '../../../../../backend/src/platform/testing/keys'
import { afterAll, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DependenciesSection } from './DependenciesSection'
import { MailSection } from './MailSection'
import { getMailReputation, mailReputationKeys } from '../api/mail-reputation'
import { logout } from '../../platform'
import { startBackend } from '../../../test/backend/site'
import { shown } from '../../../test/backend/hooks'
import { outsideThisTier } from '../../../test/backend/outside'
import { instancesRouter } from '../../../../../backend/src/instances/routes/instances'
import { IdentityService } from '../../../../../backend/src/instances/services/IdentityService'
import { InstanceService } from '../../../../../backend/src/instances/services/InstanceService'
import { DependencyWatch } from '../../../../../backend/src/instances/services/DependencyWatch'
import { MailReputation } from '../../../../../backend/src/platform/services/MailReputation'
import { roleFromEnv } from '../../../../../backend/src/platform/lib/platform-role'
import { dependencySourcesAt } from '../../../../../backend/src/platform/lib/osv'
import { startDependencySourcesStandIn } from '../../../../../backend/src/platform/testing/dependency-sources-stand-in'
import type { HeadscaleService } from '../../../../../backend/src/infrastructure/services/HeadscaleService'

const osv = await startDependencySourcesStandIn({ down: ['/osv'] })
afterAll(() => osv.close())

const leftPad = { 'bom-ref': 'koala:pkg:npm/left-pad@1.3.0', name: 'left-pad', version: '1.3.0', properties: [{ name: 'koala:kind', value: 'npm' }, { name: 'koala:in', value: 'koala' }] }

const backend = await startBackend(({ api, db, auth, origin }) => {
  const identity = new IdentityService(roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() }), db)
  const instances = new InstanceService(db, {
    rootUrl: origin,
    rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
    registry: '',
    imageTag: 'dev',
    domain: 'people.koala.test',
  }, outsideThisTier<HeadscaleService>('Headscale'))
  api.use('/instances', instancesRouter({
    instances,
    chart: async () => { throw new Error('the instance chart is packed by helm on the host, outside this tier') },
    operatorOnly: auth.requireOperator('manage-accounts'),
    administers: auth.requireOperator('administer'),
    dependencies: new DependencyWatch({
      store: db.instances,
      inventoryOf: async () => ({ components: [leftPad] }),
      currentRelease: 'dev',
      fetchImpl: fetch,
      sources: dependencySourcesAt(osv.url),
      tell: async () => undefined,
      rootUrl: origin,
    }),
    mailReputation: new MailReputation({ domain: 'koala.test' }),
  }))
})
await backend.signIn()

const opened = (section: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{section}</QueryClientProvider>)

describe('root\'s admin sections, as an operator reads them against root\'s own routes', () => {
  it('says the check of Koala\'s dependencies could not finish while OSV is down', async () => {
    const page = opened(<DependenciesSection />)
    await shown(() => screen.queryByText('Not checked yet'))
    await userEvent.click(screen.getByRole('button', { name: /Check now/ }))
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toMatch(/^the check could not finish: .*\/osv\/querybatch answered 503$/)
    page.unmount()
  })

  it('says why root\'s mail cannot be checked once the session has ended elsewhere', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
    await client.prefetchQuery({ queryKey: mailReputationKeys.root(), queryFn: getMailReputation })
    const page = render(<QueryClientProvider client={client}><MailSection /></QueryClientProvider>)
    expect(screen.getByText('Not checked yet')).toBeTruthy()
    await logout()
    await userEvent.click(screen.getByRole('button', { name: /Check now/ }))
    expect((await shown(() => screen.queryByRole('alert'))).textContent).toBe('Unauthorized: Session missing')
    page.unmount()
  })

  it('says why the dependencies and the mail cannot be read once signed out', async () => {
    const page = opened(<><DependenciesSection /><MailSection /></>)
    const dependencies = await shown(() => within(screen.getByRole('region', { name: 'Koala\'s dependencies' })).queryByRole('alert'))
    const mail = await shown(() => within(screen.getByRole('region', { name: 'Root\'s mail' })).queryByRole('alert'))
    expect(dependencies.textContent).toBe('Unauthorized: Session missing')
    expect(mail.textContent).toBe('Unauthorized: Session missing')
    page.unmount()
    await backend.signIn()
  })
})
