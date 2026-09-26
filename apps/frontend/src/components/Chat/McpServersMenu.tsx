import { useState } from 'react'
import { ChevronDown, Plug } from 'lucide-react'
import type { McpServerSummary } from '../../api/mcp'

export interface McpServersMenuProps {
  servers: McpServerSummary[]
  enabled: string[]
  busy: boolean
  onChoose: (servers: string[]) => void
}

export default function McpServersMenu({ servers, enabled, busy, onChoose }: McpServersMenuProps) {
  const [open, setOpen] = useState(false)
  if (servers.length === 0) return null
  const toggle = (name: string) => onChoose(enabled.includes(name) ? enabled.filter((entry) => entry !== name) : [...enabled, name])

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bark-950,#090d0b)] hover:bg-[var(--bark-800,#1b2620)] border border-[var(--bark-700,#24332b)] text-xs text-slate-200 cursor-pointer"
        aria-label="MCP servers for this conversation"
      >
        <Plug size={12} className={enabled.length ? 'text-sky-400' : 'text-slate-400'} />
        <span>Services{enabled.length ? ` (${enabled.length})` : ''}</span>
        <ChevronDown size={12} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-72 rounded-md bg-[var(--bark-900,#111814)] border border-[var(--bark-700,#24332b)] p-2 flex flex-col gap-1 text-xs">
          {servers.map((server) => (
            <label key={server.name} className="flex items-start gap-2 px-1 py-1 rounded hover:bg-[var(--bark-800,#1b2620)]">
              <input type="checkbox" disabled={busy} checked={enabled.includes(server.name)} onChange={() => toggle(server.name)} />
              <span className="min-w-0">
                <span className="text-slate-200">{server.name}</span>
                <span className="block text-slate-500">
                  {server.unreachable ? `not answering — ${server.unreachable}` : `${server.tools.length} tools`}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
