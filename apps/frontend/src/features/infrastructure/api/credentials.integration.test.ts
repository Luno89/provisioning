import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Router } from 'express'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type LlmProviderStatus, deleteCredentials, deleteLlmCredentials, getCredentials, listDnsProviders, listLlmProviders, listProviders, runBackup, saveCredentials, validateCredentials } from './credentials'
import type { DnsProviderInfo, ProviderStatus } from '../types/credentials'
import { startBackend } from '../../../test/backend/site'
import { DATA_KEY } from '../../../test/backend/machines'
import type { Wire } from '../../../test/backend/wire'
import { credentialsRouter } from '../../../../../backend/src/infrastructure/routes/credentials'
import { dnsProvidersRouter } from '../../../../../backend/src/infrastructure/routes/dns-providers'
import { backupRouter } from '../../../../../backend/src/infrastructure/routes/backup'
import { llmCredentialsRouter } from '../../../../../backend/src/models/routes/llm-credentials'
import { CredentialService, type ProviderStatus as BackendProviderStatus } from '../../../../../backend/src/infrastructure/services/CredentialService'
import { DnsProviders } from '../../../../../backend/src/infrastructure/services/dns/DnsProviders'
import type { describeProvider } from '../../../../../backend/src/infrastructure/lib/dns-providers'
import { SESSION_KEY } from '../../../test/backend/site'
import { arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const backupFolder = mkdtempSync(join(tmpdir(), 'koala-backup-'))

const backend = await startBackend(({ api, db, origin, auth }) => {
  const credentials = new CredentialService(db, DATA_KEY)
  const operatorOnly = auth.requireOperator('administer')
  api.use('/credentials', llmCredentialsRouter({ db, dataKey: DATA_KEY, credentialService: credentials, publicUrl: origin, appUrl: origin }))
  api.use('/dns-providers', dnsProvidersRouter({ dns: new DnsProviders() }))
  api.use('/credentials', credentialsRouter({ credentialService: credentials, publicUrl: origin, appUrl: origin, sessionKey: SESSION_KEY }))
  api.use('/backup', Router().use(operatorOnly, backupRouter({ repoRoot: backupFolder })))
})

await backend.signIn()

expectTypeOf<Wire<BackendProviderStatus>>().toExtend<ProviderStatus>()
expectTypeOf<Wire<ReturnType<typeof describeProvider>>>().toExtend<DnsProviderInfo>()

describe('Cloud providers, as its page asks for them', () => {
  it('lists every provider with whether it is set up, and no cloud a cluster was once made on', async () => {
    const providers = await listProviders()
    expect(providers).toEqual(arrayWith([
      objectWith({ provider: 'huggingface', label: 'Hugging Face' }),
      objectWith({ provider: 'ovh', label: 'OVHcloud' }),
    ]))
    expect(providers.some((provider) => ['aws', 'gcp', 'azure', 'do', 'hetzner'].includes(provider.provider))).toBe(false)
    expect(providers.some((provider) => 'clusters' in provider)).toBe(false)
  })

  it('saves a Hugging Face token, shows it masked, and lists the provider as set up by the person', async () => {
    await saveCredentials('huggingface', { hfToken: 'hf_abcdefghijklmnopqrstuvwxyz' })
    const shown = await getCredentials('huggingface')
    expect(shown?.hfToken).not.toBe('hf_abcdefghijklmnopqrstuvwxyz')
    expect(shown?.hfToken).toMatch(/\*/)
    expect((await listProviders()).find((provider) => provider.provider === 'huggingface')).toMatchObject({ configured: true, source: 'user' })
  })

  it('deletes them, after which none are stored', async () => {
    await deleteCredentials('huggingface')
    expect(await getCredentials('huggingface')).toBeNull()
  })

  it('refuses a provider Koala does not know, saying which', async () => {
    await expect(getCredentials('nowhere')).rejects.toMatchObject({ response: { status: 400, data: { error: 'Invalid provider: nowhere' } } })
    await expect(validateCredentials('nowhere')).rejects.toMatchObject({ response: { status: 400, data: { error: 'Invalid provider: nowhere' } } })
  })

  it('lists the DNS providers with the fields each one asks for', async () => {
    const dns = await listDnsProviders()
    expect(dns.map((provider) => provider.name)).toEqual(arrayWith(['cloudflare', 'porkbun']))
    expect(dns.every((provider) => provider.fields.length > 0)).toBe(true)
  })
})

describe('model gateways, as Studio → Models asks for them', () => {
  it('lists each gateway with how many of the person\'s models it serves', async () => {
    const gateways = await listLlmProviders()
    expect(gateways).toEqual(arrayWith([objectWith({ provider: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelCount: 0, hasKey: false })]))
    expectTypeOf(gateways).toEqualTypeOf<LlmProviderStatus[]>()
  })

  it('removes a gateway\'s models and says how many went', async () => {
    const owner = (await backend.db.accounts.getUsers())[0]!
    await backend.db.models.saveModelEndpoint({ id: 'openrouter-1', ownerId: owner.id, name: 'OpenRouter · vendor/model', baseUrl: 'https://openrouter.ai/api/v1', model: 'vendor/model', createdAt: new Date().toISOString() })
    expect((await listLlmProviders()).find((gateway) => gateway.provider === 'openrouter')).toMatchObject({ modelCount: 1 })
    expect(await deleteLlmCredentials('openrouter')).toEqual({ removed: 1 })
  })

  it('refuses a gateway it does not know', async () => {
    await expect(deleteLlmCredentials('nowhere')).rejects.toMatchObject({ response: { status: 400, data: { error: 'Unknown provider: nowhere' } } })
  })
})

describe('a backup, for the operator', () => {
  it('is refused to someone who is not the operator', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(runBackup()).rejects.toMatchObject({ response: { status: 403 } })
  })
})
