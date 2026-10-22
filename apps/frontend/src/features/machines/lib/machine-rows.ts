import { machineChoice, machineChoiceId } from '@koala/agent-engine/procedure'
import type { LocalAgentDevice } from '../api'

export interface MachineRow {
  id: string
  agentTitle: string
  deviceName: string
  label: string
  ready: boolean
  note?: string
  modelName?: string
}

const STATE_NOTES: Record<string, string> = {
  checking: 'being checked',
  'needs-adapter': 'needs its adapter',
  'not-answering': 'not answering',
}

export function machineRows(devices: readonly LocalAgentDevice[], query = ''): MachineRow[] {
  const wanted = query.trim().toLowerCase()
  return devices.flatMap((device) => device.agents.flatMap((agent): MachineRow[] => {
    const ready = agent.state === 'ready' && device.online
    const note = agent.state !== 'ready' ? STATE_NOTES[agent.state] ?? agent.state : device.online ? undefined : 'machine not connected'
    const models = agent.models?.length ? agent.models : [undefined]
    return models.map((model) => {
      const agentTitle = model ? `${agent.title} · ${model.name}` : agent.title
      return {
        id: machineChoiceId({ deviceId: device.id, agent: agent.id, ...(model ? { model: model.id } : {}) }),
        agentTitle,
        deviceName: device.name,
        label: `${agentTitle} · ${device.name}`,
        ready,
        ...(note ? { note } : {}),
        ...(model ? { modelName: model.name } : {}),
      }
    })
  })).filter((row) => !wanted || row.label.toLowerCase().includes(wanted))
}

export interface MachineAgentGroup {
  agentId: string
  title: string
  ready: boolean
  note?: string
  rows: MachineRow[]
}

export interface MachineGroup {
  deviceId: string
  deviceName: string
  online: boolean
  agents: MachineAgentGroup[]
}

export function machineGroups(devices: readonly LocalAgentDevice[], query = ''): MachineGroup[] {
  const rows = machineRows(devices, query)
  return devices.flatMap((device): MachineGroup[] => {
    const agents = device.agents.flatMap((agent): MachineAgentGroup[] => {
      const prefix = machineChoiceId({ deviceId: device.id, agent: agent.id })
      const own = rows.filter((row) => row.id === prefix || row.id.startsWith(`${prefix}:`))
      if (own.length === 0) return []
      const first = own[0]!
      return [{ agentId: agent.id, title: agent.title, ready: first.ready, ...(first.note ? { note: first.note } : {}), rows: own }]
    })
    return agents.length ? [{ deviceId: device.id, deviceName: device.name, online: device.online, agents }] : []
  })
}

export function machineChoiceLabel(id: string | null | undefined, devices: readonly LocalAgentDevice[]): string | undefined {
  const chosen = machineChoice(id)
  if (!chosen) return undefined
  const device = devices.find((one) => one.id === chosen.deviceId)
  const agent = device?.agents.find((one) => one.id === chosen.agent)
  const model = chosen.model ? ` · ${agent?.models?.find((one) => one.id === chosen.model)?.name ?? chosen.model}` : ''
  return device ? `${agent?.title ?? chosen.agent}${model} · ${device.name}` : `${chosen.agent}${model} · a machine that is gone`
}
