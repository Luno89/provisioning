import { machineChoice, machineChoiceId } from '@koala/agent-engine/procedure'
import type { LocalAgentDevice } from '../api/local-agents'

export interface MachineRow {
  id: string
  agentTitle: string
  deviceName: string
  label: string
  ready: boolean
  note?: string
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
      }
    })
  })).filter((row) => !wanted || row.label.toLowerCase().includes(wanted))
}

export function machineChoiceLabel(id: string | null | undefined, devices: readonly LocalAgentDevice[]): string | undefined {
  const chosen = machineChoice(id)
  if (!chosen) return undefined
  const device = devices.find((one) => one.id === chosen.deviceId)
  const agent = device?.agents.find((one) => one.id === chosen.agent)
  const model = chosen.model ? ` · ${agent?.models?.find((one) => one.id === chosen.model)?.name ?? chosen.model}` : ''
  return device ? `${agent?.title ?? chosen.agent}${model} · ${device.name}` : `${chosen.agent}${model} · a machine that is gone`
}
