import { describe, expect, it } from 'vitest'
import { PROVISION_PIECES, type ProvisioningView, type ProvisionPieceView } from '@koala/engine-core/koala-install'
import { provisioningShown } from './provisioning'

const waiting = (): ProvisionPieceView[] => PROVISION_PIECES.map((piece) => ({ key: piece.key, title: piece.title, state: 'waiting' }))

const koala = (over: Partial<ProvisioningView> = {}): ProvisioningView => ({
  id: 'provision-desk~1', target: { kind: 'koala', clusterId: 'desk' }, revision: 7, reason: 'revision', state: 'running', pieces: waiting(), startedAt: '2026-11-18T10:00:00.000Z', ...over,
})

const collector = (over: Partial<ProvisioningView> = {}): ProvisioningView => ({
  id: 'provision-desk-2~1', target: { kind: 'machine', clusterId: 'desk-2', machine: 'desk-2', deviceId: 'device-desk-2' }, revision: 7, reason: 'missing', state: 'running',
  pieces: [{ key: 'monitoring', title: 'desk-2\'s collector', state: 'waiting' }], startedAt: '2026-11-18T10:05:00.000Z', ...over,
})

const allUp = (): ProvisionPieceView[] => waiting().map((piece) => ({ ...piece, state: 'up' }))

describe('the "Setting Koala up" card', () => {
  it('says Koala has not started setting itself up when no setup has run', () => {
    expect(provisioningShown([], true)).toEqual({ kind: 'not-started', line: 'Koala has not started setting itself up yet.' })
  })

  it('lists each piece as waiting, working with the line it is on, up, or failed with why', () => {
    const pieces = waiting()
    pieces[0] = { ...pieces[0]!, state: 'up' }
    pieces[1] = { ...pieces[1]!, state: 'working', line: 'waiting for deployment/searxng in searxng: 0 of 1 ready' }
    pieces[2] = { ...pieces[2]!, state: 'working' }
    const shown = provisioningShown([koala({ pieces })], true)
    expect(shown).toEqual({
      kind: 'setting-up',
      setups: [{
        kind: 'open',
        key: 'desk',
        heading: 'Koala\'s own services and monitoring, revision 7',
        because: 'for the new revision of Koala\'s chart',
        pieces: [
          { key: 'egress', title: 'The egress proxy', state: 'up', words: 'up' },
          { key: 'searxng', title: 'SearXNG, web search', state: 'working', words: 'waiting for deployment/searxng in searxng: 0 of 1 ready' },
          { key: 'crawl4ai', title: 'Crawl4AI, page reading', state: 'working', words: 'under way' },
          { key: 'quickwit', title: 'Quickwit, the memory index\'s words', state: 'waiting', words: 'waiting to start' },
          { key: 'qdrant', title: 'Qdrant, the memory index\'s meanings', state: 'waiting', words: 'waiting to start' },
          { key: 'tei', title: 'TEI, the memory index\'s embeddings', state: 'waiting', words: 'waiting to start' },
          { key: 'gitea', title: 'Gitea, your repositories and images', state: 'waiting', words: 'waiting to start' },
          { key: 'verdaccio', title: 'The npm registry mirror', state: 'waiting', words: 'waiting to start' },
          { key: 'infisical', title: 'Infisical, your secrets', state: 'waiting', words: 'waiting to start' },
          { key: 'monitoring', title: 'Monitoring', state: 'waiting', words: 'waiting to start' },
        ],
        again: false,
      }],
    })
  })

  it('says where a failed setup stopped and why, and offers "Set up again" only to whoever may ask for it', () => {
    const pieces = waiting()
    const gitea = pieces.findIndex((piece) => piece.key === 'gitea')
    pieces[gitea] = { ...pieces[gitea]!, state: 'failed', why: 'pod gitea-0 is Init:Error' }
    const failed = koala({ state: 'failed', why: 'Gitea, your repositories and images: pod gitea-0 is Init:Error', pieces, endedAt: '2026-11-18T10:09:00.000Z' })
    const shown = provisioningShown([failed], true)
    if (shown.kind !== 'setting-up' || shown.setups[0]?.kind !== 'open') throw new Error(`expected an open setup, got ${JSON.stringify(shown)}`)
    expect(shown.setups[0].failed).toBe('Stopped at Gitea, your repositories and images: pod gitea-0 is Init:Error')
    expect(shown.setups[0].pieces[gitea]).toEqual({ key: 'gitea', title: 'Gitea, your repositories and images', state: 'failed', words: 'pod gitea-0 is Init:Error' })
    expect(shown.setups[0].again).toBe(true)
    const someoneElse = provisioningShown([failed], false)
    expect(someoneElse.kind === 'setting-up' && someoneElse.setups[0]?.kind === 'open' && someoneElse.setups[0].again).toBe(false)
  })

  it('names every piece that did not come up, when several failed at once', () => {
    const pieces = waiting().map((piece) => (piece.key === 'gitea' ? { ...piece, state: 'failed' as const, why: 'the volume is full' } : piece.key === 'tei' ? { ...piece, state: 'failed' as const, why: 'the model could not be downloaded' } : { ...piece, state: 'up' as const }))
    const shown = provisioningShown([koala({ state: 'failed', why: 'two pieces failed', pieces, endedAt: '2026-11-18T10:09:00.000Z' })], true)
    expect(shown.kind === 'setting-up' && shown.setups[0]?.kind === 'open' && shown.setups[0].failed)
      .toBe('Stopped at TEI, the memory index\'s embeddings: the model could not be downloaded; Gitea, your repositories and images: the volume is full')
  })

  it('says why a run stopped when it ended with no piece failing', () => {
    const shown = provisioningShown([koala({ state: 'failed', why: 'the setup was cancelled before it finished' })], true)
    expect(shown.kind === 'setting-up' && shown.setups[0]?.kind === 'open' && shown.setups[0].failed).toBe('Stopped: the setup was cancelled before it finished')
  })

  it('says why a run started', () => {
    const because = (reason: ProvisioningView['reason']) => {
      const shown = provisioningShown([koala({ reason })], true)
      return shown.kind === 'setting-up' && shown.setups[0]?.kind === 'open' ? shown.setups[0].because : undefined
    }
    expect(because('missing')).toBe('because a piece was found missing')
    expect(because('asked')).toBe('because you asked')
  })

  it('collapses to one line once everything is up', () => {
    expect(provisioningShown([koala({ state: 'up', pieces: allUp(), endedAt: '2026-11-18T10:20:00.000Z' })], true))
      .toEqual({ kind: 'set-up', line: 'Koala\'s services and monitoring are set up (revision 7).' })
    expect(provisioningShown([collector({ state: 'up', pieces: [{ key: 'monitoring', title: 'desk-2\'s collector', state: 'up' }] }), koala({ state: 'up', pieces: allUp() })], true))
      .toEqual({ kind: 'set-up', line: 'Koala\'s services and monitoring are set up (revision 7). desk-2\'s collector is set up.' })
  })

  it('keeps a setup that is up to its one line while another machine\'s collector is still being set up, Koala\'s own first', () => {
    const shown = provisioningShown([collector(), koala({ state: 'up', pieces: allUp() })], true)
    if (shown.kind !== 'setting-up') throw new Error(`expected the card open, got ${JSON.stringify(shown)}`)
    expect(shown.setups[0]).toEqual({ kind: 'up', key: 'desk', line: 'Koala\'s services and monitoring are set up (revision 7).' })
    expect(shown.setups[1]).toMatchObject({ kind: 'open', key: 'desk-2', heading: 'desk-2\'s collector', because: 'because a piece was found missing', pieces: [{ key: 'monitoring', title: 'desk-2\'s collector', state: 'waiting', words: 'waiting to start' }] })
  })

  it('says root refused hearing the setup, with why, and stays open for it even once everything is up', () => {
    const root = { why: 'root refused hearing that Koala is set up: this Koala is moving (409)', at: '2026-11-18T10:21:00.000Z' }
    const rootSaid = 'My Machines does not show this yet: root refused hearing that Koala is set up: this Koala is moving (409)'
    expect(provisioningShown([koala({ state: 'up', pieces: allUp(), root })], true))
      .toEqual({ kind: 'setting-up', setups: [{ kind: 'up', key: 'desk', line: 'Koala\'s services and monitoring are set up (revision 7).', root: rootSaid }] })
    const shown = provisioningShown([koala({ root })], true)
    expect(shown.kind === 'setting-up' && shown.setups[0]).toMatchObject({ kind: 'open', root: rootSaid })
  })
})
