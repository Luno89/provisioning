import { afterAll, describe, expect, it } from 'vitest'
import { Router } from 'express'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProvisioningCard } from './ProvisioningCard'
import { startBackend, type Site } from '../../../test/backend/site'
import { pageSocketsOf, type PageSockets } from '../../../test/backend/sockets'
import { temporalOnPaper } from '../../../test/backend/projects'
import { openPage } from '../../../test/backend/hooks'
import { roleFromEnv } from '../../../../../backend/src/platform/lib/platform-role'
import { testIdentityKey } from '../../../../../backend/src/platform/testing/keys'
import { createAgentRegistry } from '../../../../../backend/src/engine-host/registries/registry'
import { createRunStarter } from '../../../../../backend/src/engine-host/registries/run-starter'
import { Provisioning } from '../../../../../backend/src/infrastructure/services/Provisioning'
import { provisioningRouter } from '../../../../../backend/src/infrastructure/routes/provisioning'
import { engineProvisionRuns } from '../../../../../backend/src/engine-host/provision-runs'
import { userRoom } from '../../../../../backend/src/engine-host/temporal/stream-worker'
import { PROVISION_AGENT } from '../../../../../backend/src/extensions/provision/names'
import { pieceHeard, pieceProgress, recordedOn, runEnded, setUpProgress, type PieceChange, type ProvisioningRecord } from '../../../../../backend/src/infrastructure/lib/provisioning'
import { PROVISIONING_CHANGED, type ProvisionPieceKey } from '@koala/engine-core/koala-install'
import { runsActingAsTheirOwner } from '../../../../../backend/src/engine/testing/run-grants'

let site: Site | undefined
let sockets: PageSockets | undefined
const mounted = Router()

const backend = await startBackend((given) => {
  site = given
  given.api.use(mounted)
  sockets = pageSocketsOf(given, roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() }))
})
const person = await backend.signIn()
await sockets!.open()

const temporal = temporalOnPaper()
const db = site!.db

const openCard = () => {
  const { page, on } = openPage(<ProvisioningCard />, { followsSocket: true })
  return { card: page, on }
}

const provisioning = new Provisioning({
  store: db.infrastructure,
  runs: engineProvisionRuns({ runs: createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => temporal.starter }), client: () => temporal.client.workflow, connected: async () => undefined, agent: PROVISION_AGENT }),
  root: { setup: async () => ({ ok: true }), setupAsked: async () => undefined },
  koala: { ownerId: person.id, clusterId: 'desk', revision: 3 },
  changed: (ownerId, view) => { site!.io.to(userRoom(ownerId)).emit(PROVISIONING_CHANGED, view) },
  log: (line) => { console.warn(line) },
})
mounted.use('/infrastructure/provisioning', provisioningRouter({ provisioning }))
afterAll(() => provisioning.close())

const say = async (recordId: string, key: ProvisionPieceKey | 'set-up', change?: PieceChange): Promise<ProvisioningRecord> => {
  const said = await recordedOn(db.infrastructure, recordId, (record) => pieceHeard(record, key === 'set-up' ? setUpProgress() : pieceProgress(record, key, change!), new Date().toISOString()))
  if (!('recorded' in said)) throw new Error(`the setup ${recordId} took no more lines`)
  return said.recorded
}

const setups = async () => db.infrastructure.getProvisioning('desk')

const pieceRow = (key: ProvisionPieceKey) => screen.queryByTestId(`provisioning-piece-${key}`)

const NOT_UP = 'Gitea, your repositories and images: pod gitea-0 is Init:Error; Infisical, your secrets: the chart could not be read'

describe('the "Setting Koala up" card follows Koala setting itself up while it is open', () => {
  it('shows each piece as Koala reaches it, names every piece that did not come up and why once all have ended, sets up again only those, and collapses to one line once everything is up', async () => {
    const { card, on } = openCard()
    await on(() => screen.queryByText('Koala has not started setting itself up yet.'))

    await on(() => screen.queryByText('Koala\'s own services and monitoring, revision 3'), () => provisioning.start())
    const [first] = await setups()
    expect(first).toMatchObject({ reason: 'revision', state: 'running', ownerId: person.id })
    expect(temporal.workflows.get(first!.workflowId!)).toMatchObject({ workflowType: 'AgentRunWorkflow', status: 'RUNNING' })

    await on(() => screen.queryByText('waiting for deployment/egress in egress: 0 of 1 ready'), () => say(first!.id, 'egress', { state: 'started', line: 'waiting for deployment/egress in egress: 0 of 1 ready' }))

    const giteaFailed = await on(() => (pieceRow('gitea')?.textContent?.includes('pod gitea-0 is Init:Error') ? pieceRow('gitea') : null), () => say(first!.id, 'gitea', { state: 'failed', why: 'pod gitea-0 is Init:Error' }))
    expect(giteaFailed.textContent).toContain('Gitea, your repositories and images')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set up again' })).toBeNull()

    for (const key of ['egress', 'searxng', 'crawl4ai', 'quickwit', 'qdrant', 'tei', 'verdaccio', 'monitoring'] as const) await say(first!.id, key, { state: 'done' })
    await say(first!.id, 'infisical', { state: 'failed', why: 'the chart could not be read' })
    const stopped = await on(() => screen.queryByRole('alert'), async () => {
      const said = await recordedOn(db.infrastructure, first!.id, (record) => runEnded(record, NOT_UP, new Date().toISOString()))
      if (!('recorded' in said)) throw new Error(`the setup ${first!.id} could not be ended`)
    })
    expect(stopped.textContent).toBe(`Stopped at ${NOT_UP}`)

    await on(() => screen.queryByText('because you asked'), () => userEvent.click(screen.getByRole('button', { name: 'Set up again' })))
    const asked = (await setups()).filter((record) => record.reason === 'asked')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ target: { kind: 'koala', clusterId: 'desk' }, revision: 3, reason: 'asked', state: 'running' })
    expect(asked[0]!.pieces.filter((piece) => piece.state !== 'up').map((piece) => piece.key)).toEqual(['gitea', 'infisical'])
    expect(screen.queryByRole('button', { name: 'Set up again' })).toBeNull()

    for (const key of ['gitea', 'infisical'] as const) await say(asked[0]!.id, key, { state: 'done' })
    await on(() => screen.queryByText('Koala\'s services and monitoring are set up (revision 3).'), () => say(asked[0]!.id, 'set-up'))
    expect(within(card.container).queryByText('The egress proxy')).toBeNull()
  })
})
