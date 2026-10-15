import { Check, Laptop } from 'lucide-react'
import { useLocalAgentDevices } from '../api/local-agents'
import { machineRows } from '../lib/machine-rows'

interface MachineChoicesProps {
  selectedId: string | null | undefined
  onSelect: (id: string) => void
  query?: string
  onManage?: (() => void) | undefined
}

export function MachineChoices({ selectedId, onSelect, query = '', onManage }: MachineChoicesProps) {
  const { data: devices = [] } = useLocalAgentDevices()
  const rows = machineRows(devices, query)
  if (rows.length === 0) return null

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
      <div className="space-y-0.5">
        {rows.map((row) => {
          const isSelected = row.id === selectedId
          return (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              disabled={!row.ready}
              title={row.ready ? `${row.agentTitle} answers on ${row.deviceName}, with its own tools and model` : `${row.agentTitle} on ${row.deviceName}: ${row.note}`}
              onClick={() => onSelect(row.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                isSelected ? 'bg-amber-500/15 text-amber-100 font-medium' : 'text-slate-300 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-semibold">{row.agentTitle}</span>
                <span className="text-slate-500"> · {row.deviceName}</span>
              </span>
              {row.note && <span className="shrink-0 text-[10px] text-slate-500">{row.note}</span>}
              {isSelected && <Check size={14} className="shrink-0 text-amber-300" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
