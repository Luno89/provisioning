import { describe, expect, expectTypeOf, it } from 'vitest'
import { type RootSignInProvider, type ServerOrder, cancelServerOrder, checkZones, getServerOrder, listRootSignInProviders, listServerOrders, quoteServer, revealSetupCode, revealSshKey } from './server-orders'
import { getVpsCatalog, refreshVpsCatalog } from './vps-catalog'
import { startBackend } from '../../../test/backend/site'
import { DATA_KEY } from '../../../test/backend/machines'
import { outsideThisTier } from '../../../test/backend/outside'
import type { Wire } from '../../../test/backend/wire'
import { serverOrdersRouter } from '../../../../../backend/src/infrastructure/routes/server-orders'
import { vpsCatalogRouter } from '../../../../../backend/src/infrastructure/routes/vps-catalog'
import { ServerOrderService, type ServerOrderView } from '../../../../../backend/src/infrastructure/services/ServerOrderService'
import { VpsCatalogService } from '../../../../../backend/src/infrastructure/services/VpsCatalogService'
import { CredentialService } from '../../../../../backend/src/infrastructure/services/CredentialService'
import type { RootSignInProvider as BackendRootSignInProvider } from '../../../../../backend/src/infrastructure/lib/root-sign-in'
import { arrayWith, containing, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const backend = await startBackend(({ api, db, auth }) => {
  const credentials = new CredentialService(db, DATA_KEY)
  const operatorOnly = auth.requireOperator('administer')
  api.use('/server-orders', serverOrdersRouter({
    operatorOnly,
    serverOrders: new ServerOrderService({
      store: db.infrastructure,
      dataKey: DATA_KEY,
      ovhAccountOf: async () => undefined,
      dnsCredentialsOf: (ownerId, provider) => credentials.dnsCredentialsOf(ownerId, provider),
      startFollowing: outsideThisTier('Temporal'),
      stopFollowing: outsideThisTier('Temporal'),
    }),
  }))
  api.use('/vps-catalog', vpsCatalogRouter({ operatorOnly, vpsCatalogService: new VpsCatalogService(db, DATA_KEY, outsideThisTier('the VPS providers\' price lists')) }))
})

await backend.signIn()

const ASK = { planCode: 'vps-2025-model1', planLabel: 'VPS-1', datacenter: 'GRA', domain: 'koala-root.dev', ingressDomain: 'koala-people.app', acmeEmail: 'ops@koala-root.dev', domainDns: 'cloudflare', ingressDns: 'porkbun' }

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads a server order and a sign-in provider as the backend describes them', () => {
    expectTypeOf<Wire<ServerOrderView>>().toExtend<ServerOrder>()
    expectTypeOf<Wire<BackendRootSignInProvider>>().toExtend<RootSignInProvider>()
  })
})

describe('Host Koala on a server, as its page asks for it', () => {
  it('has no orders to begin with', async () => {
    expect(await listServerOrders()).toEqual([])
  })

  it('lists the sign-in providers root can offer, each with its redirect address for the domain typed', async () => {
    const providers = await listRootSignInProviders('koala-root.dev')
    expect(providers).toEqual(arrayWith([objectWith({ id: 'google', label: 'Google', redirectUri: 'https://app.koala-root.dev/api/auth/provider/google/callback' })]))
    expect(providers.every((provider) => provider.fields.length > 0)).toBe(true)
  })

  it('refuses a quote whose domains, email or plan are missing, saying what to fix', async () => {
    await expect(quoteServer({ ...ASK, ingressDomain: ASK.domain })).rejects.toMatchObject({ response: { status: 400 } })
    await expect(quoteServer({ ...ASK, acmeEmail: 'nobody' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'Give an email address for the certificate authority and root\'s mail.' } } })
    await expect(quoteServer({ ...ASK, planCode: '' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'Pick a plan and a datacenter.' } } })
  })

  it('refuses a quote until the DNS provider\'s credentials are stored, saying where to add them', async () => {
    await expect(quoteServer(ASK)).rejects.toMatchObject({ response: { status: 409, data: { error: containing('Add your Cloudflare DNS credentials under Cloud providers first.') } } })
  })

  it('answers 404 for an order that does not exist, whatever is asked of it', async () => {
    const missing = { response: { status: 404, data: { error: 'No such server order' } } }
    await expect(getServerOrder('none')).rejects.toMatchObject(missing)
    await expect(cancelServerOrder('none')).rejects.toMatchObject(missing)
    await expect(revealSetupCode('none')).rejects.toMatchObject(missing)
    await expect(revealSshKey('none')).rejects.toMatchObject(missing)
  })

  it('refuses a zone check that names no zone, or too many', async () => {
    await expect(checkZones([])).rejects.toMatchObject({ response: { status: 400, data: { error: 'Name one or two zones as ?zone=' } } })
    await expect(checkZones(['a.dev', 'b.dev', 'c.dev'])).rejects.toMatchObject({ response: { status: 400 } })
  })
})

describe('the VPS catalog, as Compare plans asks for it', () => {
  it('refuses filters it cannot read, saying which', async () => {
    await expect(getVpsCatalog('provider=ovh&sort=cheapest')).rejects.toMatchObject({ response: { status: 400, data: { error: containing('sort must be one of price') } } })
    await expect(getVpsCatalog('arch=risc')).rejects.toMatchObject({ response: { status: 400, data: { error: 'arch must be one of x86, arm, unknown' } } })
  })

  it('lets the operator refresh it', async () => {
    expect(await refreshVpsCatalog()).toEqual({ ok: true })
  })
})

describe('what only the operator may do', () => {
  it('refuses server orders and a catalog refresh to someone who is not the operator', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(listServerOrders()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(quoteServer(ASK)).rejects.toMatchObject({ response: { status: 403 } })
    await expect(refreshVpsCatalog()).rejects.toMatchObject({ response: { status: 403 } })
  })
})
