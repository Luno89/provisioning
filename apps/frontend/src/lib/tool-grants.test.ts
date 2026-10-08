import { describe, it, expect } from 'vitest'
import { toolChoices } from './tool-grants'
import type { GrantableTool } from '../api/agents'

const tool = (name: string, binding: string, effect: GrantableTool['effect'], summary = ''): GrantableTool => ({ name, binding, effect, summary, needs: [] })
const CATALOGUE = [
  tool('read_file', 'environment', 'read', 'Read a file'),
  tool('write_file', 'environment', 'write', 'Write a file'),
  tool('get_logs', 'platform', 'read', 'Recent logs of a deployment'),
  tool('propose_plan', 'platform', 'propose', 'Propose a plan'),
]

describe('choosing an agent\'s tools', () => {
  it('splits the catalogue into what it holds and what it could be given, both grouped the way the tools page groups them', () => {
    const choices = toolChoices(['write_file', 'get_logs'], CATALOGUE)
    expect(choices.granted.map((group) => [group.title, group.items.map((one) => one.name)])).toEqual([
      ['Work in the workspace', ['write_file']],
      ['Look things up', ['get_logs']],
    ])
    expect(choices.available.map((group) => [group.title, group.items.map((one) => one.name)])).toEqual([
      ['Work in the workspace', ['read_file']],
      ['Propose and ask you', ['propose_plan']],
    ])
  })

  it('finds what it could be given by name or by what it does', () => {
    expect(toolChoices([], CATALOGUE, 'logs').available.flatMap((group) => group.items.map((one) => one.name))).toEqual(['get_logs'])
    expect(toolChoices([], CATALOGUE, 'PLAN').available.flatMap((group) => group.items.map((one) => one.name))).toEqual(['propose_plan'])
  })

  it('names a granted tool the catalogue no longer has, so it can be taken away', () => {
    expect(toolChoices(['write_file', 'gone_tool'], CATALOGUE).unknown).toEqual(['gone_tool'])
  })
})
