import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Router } from 'express'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { type LlmProviderStatus, deleteCredentials, deleteLlmCredentials, getCredentials, listDnsProviders, listLlmProviders, listProviders, runBackup, saveCredentials, validateCredentials } from './credentials'
import { getNginxConfig, saveNginxConfig } from './nginx'
import type { DnsProviderInfo, ProviderStatus } from '../types/credentials'
import { startBackend } from '../../../test/backend/site'
import { DATA_KEY } from '../../../test/backend/machines'
import type { Wire } from '../../../test/backend/wire'
import { credentialsRouter } from '../../../../../backend/src/infrastructure/routes/credentials'
import { dnsProvidersRouter } from '../../../../../backend/src/infrastructure/routes/dns-providers'
import { nginxRouter } from '../../../../../backend/src/infrastructure/routes/nginx'
import { backupRouter } from '../../../../../backend/src/infrastructure/routes/backup'
import { llmCredentialsRouter } from '../../../../../backend/src/models/routes/llm-credentials'
import { CredentialService, type ProviderStatus as BackendProviderStatus } from '../../../../../backend/src/infrastructure/services/CredentialService'
import { DnsProviders } from '../../../../../backend/src/infrastructure/services/dns/DnsProviders'
import type { describeProvider } from '../../../../../backend/src/infrastructure/lib/dns-providers'
import { SESSION_KEY } from '../../../test/backend/site'
import { arrayWith, objectWith } from '../../../../../backend/src/platform/lib/test-matchers'

const nginxFolder = mkdtempSync(join(tmpdir(), 'koala-nginx-'))
const nginxConf = join(nginxFolder, 'nginx.conf')
writeFileSync(nginxConf, 'events {}\n')
const reloads: string[] = []

const backend = await startBackend(({ api, db, origin, auth }) => {
  const credentials = new CredentialService(db, DATA_KEY)
  const operatorOnly = auth.requireOperator('administer')
  api.use('/credentials', llmCredentialsRouter({ db, dataKey: DATA_KEY, credentialService: credentials, publicUrl: origin, appUrl: origin }))
  api.use('/dns-providers', dnsProvidersRouter({ dns: new DnsProviders() }))
  api.use('/credentials', credentialsRouter({ credentialService: credentials, publicUrl: origin, appUrl: origin, sessionKey: SESSION_KEY }))
  api.use('/nginx', Router().use(operatorOnly, nginxRouter({ nginxConfPath: nginxConf, shell: async (command) => { reloads.push(command); return { stdout: '', stderr: '' } } })))
  api.use('/backup', Router().use(operatorOnly, backupRouter({ repoRoot: nginxFolder })))
})

await backend.signIn()

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads a provider\'s status and a DNS provider as the backend describes them', () => {
    expectTypeOf<Wire<BackendProviderStatus>>().toExtend<ProviderStatus>()
    expectTypeOf<Wire<ReturnType<typeof describeProvider>>>().toExtend<DnsProviderInfo>()
  })
})

describe('Cloud providers, as its page asks for them', () => {
  it('lists every provider with whether it is set up, and what each offers for clusters', async () => {
    const providers = await listProviders()
    expect(providers).toEqual(arrayWith([
      objectWith({ provider: 'huggingface', label: 'Hugging Face' }),
      objectWith({ provider: 'hetzner', label: 'Hetzner Cloud', clusters: 'available' }),
      objectWith({ provider: 'aws', clusters: 'mock-only' }),
    ]))
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

describe('the local router\'s nginx config, for the operator', () => {
  it('reads the config and saves a new one, reloading nginx', async () => {
    expect(await getNginxConfig()).toEqual({ content: 'events {}\n' })
    await saveNginxConfig('events {}\nhttp {}\n')
    expect(readFileSync(nginxConf, 'utf8')).toBe('events {}\nhttp {}\n')
    expect(reloads).toEqual(['docker exec provisioner-nginx nginx -s reload'])
  })

  it('refuses the config and a backup to someone who is not the operator', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(getNginxConfig()).rejects.toMatchObject({ response: { status: 403 } })
    await expect(saveNginxConfig('events {}\n')).rejects.toMatchObject({ response: { status: 403 } })
    await expect(runBackup()).rejects.toMatchObject({ response: { status: 403 } })
  })
})
