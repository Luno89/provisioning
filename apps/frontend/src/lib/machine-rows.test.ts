import { describe, it, expect } from 'vitest'
import { machineChoiceLabel, machineRows } from './machine-rows'
import type { LocalAgentDevice } from '../api/local-agents'

const desk: LocalAgentDevice = {
  id: 'd1', name: 'desk', rootDir: '/home/me/koala', createdAt: 't', online: true, manualAgents: [],
  agents: [
    { id: 'antigravity', title: 'Antigravity', state: 'ready', source: 'found' },
    { id: 'claude-code', title: 'Claude Code', state: 'needs-adapter', source: 'found' },
  ],
}

describe('the agents on your machines, as choices', () => {
  it('lists every agent on every machine, ready only when it answers on a connected machine', () => {
    expect(machineRows([desk])).toEqual([
      { id: 'machine:d1:antigravity', agentTitle: 'Antigravity', deviceName: 'desk', label: 'Antigravity · desk', ready: true },
      { id: 'machine:d1:claude-code', agentTitle: 'Claude Code', deviceName: 'desk', label: 'Claude Code · desk', ready: false, note: 'needs its adapter' },
    ])
    expect(machineRows([{ ...desk, online: false }])[0]).toMatchObject({ ready: false, note: 'machine not connected' })
  })

  it('offers each model an agent has, and names the picked one by its model', () => {
    const withModels: LocalAgentDevice = { ...desk, agents: [{ ...desk.agents[0]!, models: [{ id: 'flash', name: 'Gemini 3.8 Flash' }, { id: 'pro', name: 'Gemini 3.8 Pro' }], model: 'flash' }] }
    expect(machineRows([withModels]).map((row) => [row.id, row.label])).toEqual([
      ['machine:d1:antigravity:flash', 'Antigravity · Gemini 3.8 Flash · desk'],
      ['machine:d1:antigravity:pro', 'Antigravity · Gemini 3.8 Pro · desk'],
    ])
    expect(machineChoiceLabel('machine:d1:antigravity:pro', [withModels])).toBe('Antigravity · Gemini 3.8 Pro · desk')
  })

  it('narrows to what the search matches', () => {
    expect(machineRows([desk], 'claude').map((row) => row.id)).toEqual(['machine:d1:claude-code'])
  })

  it('names a picked agent by its machine, and says when that machine is gone', () => {
    expect(machineChoiceLabel('machine:d1:antigravity', [desk])).toBe('Antigravity · desk')
    expect(machineChoiceLabel('machine:d9:antigravity', [desk])).toBe('antigravity · a machine that is gone')
    expect(machineChoiceLabel('tabby-qwen', [desk])).toBeUndefined()
  })
})
