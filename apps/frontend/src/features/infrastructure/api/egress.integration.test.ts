import { describe, expect, it } from 'vitest'
import type { EgressGrantRecord } from '@koala/harness-types'
import { allowEgress, dismissEgress, listEgressGrants, listEgressRequests, revokeEgress } from './egress'
import { dismissAccess, grantAccess, listAccessRequests } from './cluster-access'
import { startBackend } from '../../../test/backend/site'
import { egressRouter } from '../../../../../backend/src/infrastructure/routes/egress'
import { clusterAccessRouter } from '../../../../../backend/src/infrastructure/routes/cluster-access'
import { EgressService } from '../../../../../backend/src/infrastructure/services/EgressService'
import { AccessService } from '../../../../../backend/src/infrastructure/services/AccessService'
import { anyOf } from '../../../../../backend/src/platform/lib/test-matchers'

const proxied: EgressGrantRecord[][] = []

const backend = await startBackend(({ api, db }) => {
  api.use('/egress', egressRouter({ egress: new EgressService({ store: db.infrastructure, proxy: { sync: async (grants) => { proxied.push([...grants]) } } }) }))
  api.use('/cluster-access', clusterAccessRouter({ access: new AccessService({ store: db }) }))
})

const owner = await backend.signIn()
const at = new Date().toISOString()
await backend.db.engine.saveConversation({ id: 'chat-1', ownerId: owner.id, title: 'Reaching out', messages: [], createdAt: at, updatedAt: at })
for (const id of ['egress-1', 'egress-2']) {
  await backend.db.infrastructure.saveEgressRequest({ id, ownerId: owner.id, agentSlug: 'research', host: `${id}.example.org`, ports: [443], why: 'to read the docs', status: 'requested', conversationId: 'chat-1', createdAt: at, updatedAt: at })
}
for (const id of ['access-1', 'access-2', 'access-3']) {
  await backend.db.infrastructure.saveAccessRequest({ id, ownerId: owner.id, conversationId: 'chat-1', namespaces: ['monitoring'], why: 'to read the alerts', status: 'requested', createdAt: at, updatedAt: at })
}

describe('a run asking to reach a host, as the chat\'s card answers it', () => {
  it('lists the requests of a conversation', async () => {
    expect((await listEgressRequests('conversationId', 'chat-1')).map((request) => request.id).sort()).toEqual(['egress-1', 'egress-2'])
    expect(await listEgressRequests('treeId', 'no-tree')).toEqual([])
  })

  it('allows one, which grants its agent the host, tells the proxy and answers with both', async () => {
    expect(await allowEgress('egress-1')).toMatchObject({ request: { id: 'egress-1', status: 'allowed' }, grant: { agentSlug: 'research', host: 'egress-1.example.org', ports: [443], id: anyOf(String) } })
    expect(proxied.at(-1)?.map((grant) => grant.host)).toEqual(['egress-1.example.org'])
    expect((await listEgressGrants('research')).map((grant) => grant.host)).toEqual(['egress-1.example.org'])
  })

  it('refuses to answer a request twice', async () => {
    await expect(allowEgress('egress-1')).rejects.toMatchObject({ response: { status: 409, data: { error: 'This request is already allowed.' } } })
  })

  it('dismisses one, granting nothing', async () => {
    expect(await dismissEgress('egress-2')).toMatchObject({ request: { id: 'egress-2', status: 'dismissed' } })
    expect(await listEgressGrants('research')).toHaveLength(1)
  })

  it('revokes a grant, after which the agent no longer holds it', async () => {
    const [grant] = await listEgressGrants('research')
    expect(await revokeEgress(grant!.id)).toMatchObject({ grant: { id: grant!.id, revokedAt: anyOf(String) } })
    expect(await listEgressGrants('research')).toEqual([])
  })

  it('answers 404 for a request or grant that is not the person\'s', async () => {
    await expect(allowEgress('nobody')).rejects.toMatchObject({ response: { status: 404, data: { error: 'Request not found' } } })
    await expect(revokeEgress('nobody')).rejects.toMatchObject({ response: { status: 404 } })
  })
})

describe('a run asking to see the platform\'s namespaces, as the chat\'s card answers it', () => {
  it('lists the requests of a conversation', async () => {
    expect((await listAccessRequests('chat-1')).map((request) => request.id).sort()).toEqual(['access-1', 'access-2', 'access-3'])
  })

  it('grants one to the operator, opening those namespaces to the conversation', async () => {
    expect(await grantAccess('access-1')).toMatchObject({ id: 'access-1', status: 'granted', namespaces: ['monitoring'] })
    expect((await backend.db.engine.getConversation(owner.id, 'chat-1'))?.platformNamespaces).toEqual(['monitoring'])
  })

  it('dismisses one, and refuses to answer it again', async () => {
    expect(await dismissAccess('access-2')).toMatchObject({ id: 'access-2', status: 'dismissed' })
    await expect(dismissAccess('access-2')).rejects.toMatchObject({ response: { status: 409, data: { error: 'This request is already dismissed.' } } })
  })

  it('refuses a person who is not the operator, and shows them none of the operator\'s requests', async () => {
    await backend.signInAnother('second@koala.test')
    await expect(grantAccess('access-3')).rejects.toMatchObject({ response: { status: 403 } })
    expect(await listAccessRequests('chat-1')).toEqual([])
    expect(await listEgressRequests('conversationId', 'chat-1')).toEqual([])
  })
})
