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
  return devices.flatMap((device) => device.agents.map((agent): MachineRow => {
    const ready = agent.state === 'ready' && device.online
    const note = agent.state !== 'ready' ? STATE_NOTES[agent.state] ?? agent.state : device.online ? undefined : 'machine not connected'
    return {
      id: machineChoiceId({ deviceId: device.id, agent: agent.id }),
      agentTitle: agent.title,
      deviceName: device.name,
      label: `${agent.title} · ${device.name}`,
      ready,
      ...(note ? { note } : {}),
    }
  })).filter((row) => !wanted || row.label.toLowerCase().includes(wanted))
}

export function machineChoiceLabel(id: string | null | undefined, devices: readonly LocalAgentDevice[]): string | undefined {
  const chosen = machineChoice(id)
  if (!chosen) return undefined
  const device = devices.find((one) => one.id === chosen.deviceId)
  const agent = device?.agents.find((one) => one.id === chosen.agent)
  return device ? `${agent?.title ?? chosen.agent} · ${device.name}` : `${chosen.agent} · a machine that is gone`
}
