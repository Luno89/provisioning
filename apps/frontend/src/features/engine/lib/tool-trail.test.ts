import { describe, expect, it } from 'vitest'
import { callFailed, callRunning, toolTrail } from './tool-trail'

const done = (id: string, name: string, ok = true) => ({ id, name, ok, running: false, digest: 'out' })
const going = (id: string, name: string) => ({ id, name, running: true })

describe('a run\'s tool calls, counted by tool', () => {
  it('counts each tool once, in the order it was first used, with its failures', () => {
    const trail = toolTrail([
      done('1', 'search_web'),
      done('2', 'fetch_web_page'),
      done('3', 'search_web'),
      done('4', 'fetch_web_page', false),
      done('5', 'fetch_web_page'),
    ], false)

    expect(trail.groups.map((group) => [group.name, group.calls.length, group.failed])).toEqual([
      ['search_web', 2, 0],
      ['fetch_web_page', 3, 1],
    ])
    expect(trail.current).toEqual([])
  })

  it('shows the step running now beside the counts, even when its tool is already counted', () => {
    const trail = toolTrail([done('1', 'search_web'), done('2', 'search_web'), going('3', 'search_web')], true)

    expect(trail.groups).toHaveLength(1)
    expect(trail.groups[0]?.calls).toHaveLength(3)
    expect(trail.groups[0]?.running).toBe(1)
    expect(trail.current.map((call) => call.id)).toEqual(['3'])
  })

  it('shows every call running at once as the current step', () => {
    const trail = toolTrail([going('1', 'search_web'), going('2', 'fetch_web_page')], true)

    expect(trail.current.map((call) => call.id)).toEqual(['1', '2'])
  })

  it('keeps the last step in view while the run thinks between calls, and none once it has ended', () => {
    const calls = [done('1', 'search_web'), done('2', 'fetch_web_page')]

    expect(toolTrail(calls, true).current.map((call) => call.id)).toEqual(['2'])
    expect(toolTrail(calls, false).current).toEqual([])
  })

  it('keeps a hand-off and a call that made files apart from the counts, since they hold what the person opens', () => {
    const handOff = { id: 'h', name: 'research', running: true, child: { steps: [] } }
    const wrote = { id: 'w', name: 'write_file', ok: true, digest: 'ok', artifacts: [{ kind: 'file' }] }
    const trail = toolTrail([done('1', 'search_web'), handOff, wrote], true)

    expect(trail.apart.map((call) => call.id)).toEqual(['h', 'w'])
    expect(trail.groups.map((group) => group.name)).toEqual(['search_web'])
    expect(trail.current.map((call) => call.id)).toEqual(['1'])
  })

  it('reads a call with no answer yet as running, and only a finished call that said no as failed', () => {
    expect(callRunning({ id: 'a', name: 'x' })).toBe(true)
    expect(callRunning({ id: 'a', name: 'x', digest: 'out' })).toBe(false)
    expect(callFailed({ id: 'a', name: 'x', ok: false, running: true })).toBe(false)
    expect(callFailed({ id: 'a', name: 'x', ok: false, digest: 'no' })).toBe(true)
  })
})
