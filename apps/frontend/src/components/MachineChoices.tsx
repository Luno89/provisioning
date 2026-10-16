import { useState } from 'react'
import { Check, ChevronRight, Laptop } from 'lucide-react'
import { useLocalAgentDevices } from '../api/local-agents'
import { machineGroups, type MachineAgentGroup, type MachineRow } from '../lib/machine-rows'

interface MachineChoicesProps {
  selectedId: string | null | undefined
  onSelect: (id: string) => void
  query?: string
  onManage?: (() => void) | undefined
}

const choiceClass = (selected: boolean) =>
  `flex w-full items-center gap-2 py-1 pr-3 text-left text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    selected ? 'bg-amber-500/15 text-amber-100 font-medium' : 'text-slate-300 hover:bg-slate-900 hover:text-slate-100'
  }`

export function MachineChoices({ selectedId, onSelect, query = '', onManage }: MachineChoicesProps) {
  const { data: devices = [] } = useLocalAgentDevices()
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const groups = machineGroups(devices, query)
  if (groups.length === 0) return null

  const toggle = (key: string) => setOpened((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const holds = (rows: readonly MachineRow[]) => rows.some((row) => row.id === selectedId)
  const isOpen = (key: string, rows: readonly MachineRow[]) => opened.has(key) || Boolean(query) || holds(rows)

  const choice = (row: MachineRow, label: string, indent: string, deviceName: string) => (
    <button
      key={row.id}
      type="button"
      role="option"
      aria-selected={row.id === selectedId}
      disabled={!row.ready}
      title={row.ready ? `${row.agentTitle} answers on ${deviceName}, with its own tools` : `${row.agentTitle} on ${deviceName}: ${row.note ?? ''}`}
      onClick={() => onSelect(row.id)}
      className={`${choiceClass(row.id === selectedId)} ${indent}`}
    >
      {row.id === selectedId && <Check size={11} className="shrink-0 text-amber-300" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {row.note && <span className="shrink-0 text-[10px] text-slate-500">{row.note}</span>}
    </button>
  )

  const agentBlock = (deviceId: string, deviceName: string, agent: MachineAgentGroup) => {
    if (agent.rows.length === 1 && !agent.rows[0]!.modelName) return choice(agent.rows[0]!, agent.title, 'pl-7', deviceName)
    const key = `${deviceId}:${agent.agentId}`
    const open = isOpen(key, agent.rows)
    return (
      <div key={key}>
        <button
          type="button"
          onClick={() => toggle(key)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${agent.title} on ${deviceName}`}
          className="flex w-full items-center gap-2 py-1.5 pl-7 pr-3 text-left text-[11px] text-slate-300 hover:bg-slate-900"
        >
          {holds(agent.rows) && <Check size={10} className="shrink-0 text-amber-300" />}
          <span className="truncate">{agent.title}</span>
          {agent.note && <span className="text-[10px] text-slate-500">{agent.note}</span>}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-600">{agent.rows.length}</span>
          <ChevronRight size={11} className={`shrink-0 text-slate-600 transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        {open && agent.rows.map((row) => choice(row, row.modelName ?? agent.title, 'pl-12', deviceName))}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300/90">
        <Laptop size={12} /> My machines
        {onManage && (
          <button type="button" onClick={onManage} className="ml-auto normal-case tracking-normal font-normal text-slate-500 hover:text-amber-300">
            manage
          </button>
        )}
      </div>
      {groups.map((group) => {
        const rows = group.agents.flatMap((agent) => agent.rows)
        const open = isOpen(group.deviceId, rows)
        return (
          <div key={group.deviceId}>
            <button
              type="button"
              onClick={() => toggle(group.deviceId)}
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${group.deviceName}`}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-900"
            >
              {holds(rows) && <Check size={11} className="shrink-0 text-amber-300" />}
              <span className="truncate text-[11px] font-bold text-slate-200">{group.deviceName}</span>
              {!group.online && <span className="text-[10px] text-slate-500">not connected</span>}
              <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">{rows.filter((row) => row.ready).length}</span>
              <ChevronRight size={12} className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
            </button>
            {open && <div className="pb-1">{group.agents.map((agent) => agentBlock(group.deviceId, group.deviceName, agent))}</div>}
          </div>
        )
      })}
    </div>
  )
}
