import { describe, expect, it } from 'vitest'
import { declaredKind, formOf, groupServers, isOffered, runsOf, serverLine, statusText, withOffered, withToolSaid } from './mcp-server-forms'

describe('a server in the Studio', () => {
  it('says how far it has got, and where it runs', () => {
    expect(statusText({ status: { state: 'captured', tools: 1 } })).toBe('1 tool')
    expect(statusText({ status: { state: 'failed', why: 'x' } })).toBe('capture failed')
    expect(serverLine({ runs: { where: 'hosted', url: 'http://x.test/mcp' }, status: { state: 'capturing', runId: 'r' } })).toBe('hosted · being captured…')
  })

  it('groups servers by where they run, by name', () => {
    const at = (name: string, runs: never) => ({ name, runs })
    expect(groupServers([
      at('zeta', { where: 'hosted', url: 'u' } as never),
      at('alpha', { where: 'hosted', url: 'u' } as never),
      at('mine', { where: 'hosted', deploymentId: 'd1' } as never),
      at('playwright', { where: 'workspace', install: [], start: 's', port: 1 } as never),
    ]).map((group) => [group.place, group.servers.map((server) => server.name)])).toEqual([
      ['workspace', ['playwright']], ['url', ['alpha', 'zeta']], ['deployment', ['mine']],
    ])
  })

  it('round-trips how a workspace server runs through its form', () => {
    const runs = { where: 'workspace' as const, languages: ['node'], needs: ['playwright-mcp'], start: 'playwright-mcp', port: 8931, path: '/mcp' }
    expect(runsOf(formOf(runs))).toEqual(runs)
    expect(runsOf({ ...formOf(runs), port: '9,000', path: '', needs: ['tickets-server'] })).toEqual({ where: 'workspace', languages: ['node'], needs: ['tickets-server'], start: 'playwright-mcp', port: 9000 })
  })

  it('offers a tool by leaving it out of what is omitted, or adding it to what is offered', () => {
    expect(isOffered({}, 'a')).toBe(true)
    expect(withOffered({}, 'a', false)).toEqual({ offer: null, omit: ['a'] })
    expect(withOffered({ omit: ['a'] }, 'a', true)).toEqual({ offer: null, omit: null })
    expect(withOffered({ offer: ['b'] }, 'a', true)).toEqual({ offer: ['b', 'a'], omit: null })
    expect(withOffered({ offer: ['a', 'b'] }, 'a', false)).toEqual({ offer: ['b'], omit: null })
  })

  it('keeps what the person says of a tool, and drops it when they say nothing', () => {
    expect(withToolSaid({}, 'click', { kind: 'safe-write' })).toEqual({ click: { kind: 'safe-write' } })
    expect(withToolSaid({ tools: { click: { kind: 'safe-write' } } }, 'click', { note: 'by ref' })).toEqual({ click: { kind: 'safe-write', note: 'by ref' } })
    expect(withToolSaid({ tools: { click: { kind: 'safe-write' } } }, 'click', { kind: '' })).toEqual({})
    expect(declaredKind({ readOnlyHint: true })).toBe('read-only')
    expect(declaredKind(undefined)).toBe('destructive')
  })
})
