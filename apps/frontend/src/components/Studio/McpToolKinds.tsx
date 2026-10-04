import type { McpHintChoice, McpToolKind } from '../../api/mcp'
import { errorMessage, useMcpServerList, useMcpToolHint } from './shared'

const KIND: Record<McpToolKind, string> = {
  'read-only': 'reads only',
  'safe-write': 'changes things, safely',
  destructive: 'can destroy — asks you first',
}

export default function McpToolKinds() {
  const servers = useMcpServerList()
  const hint = useMcpToolHint()
  const reachable = (servers.data ?? []).filter((server) => !server.unreachable && server.tools.length > 0)
  if (reachable.length === 0) return null

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-200">From your services</h3>
      <p className="max-w-2xl text-xs text-slate-400">
        An MCP server can say which of its tools only read and which can destroy something. A tool it says nothing about is treated as able to destroy, so every call to it asks you first. Say what a tool really does to stop it asking.
      </p>
      {hint.error && <p className="text-xs text-red-300">{errorMessage(hint.error)}</p>}
      {reachable.map((server) => (
        <div key={server.name} className="rounded-md border border-[var(--bark-700)]">
          <div className="border-b border-[var(--bark-800)] px-3 py-1.5 text-xs font-semibold text-slate-300">{server.name}</div>
          <ul className="divide-y divide-[var(--bark-800)]">
            {server.tools.map((tool) => (
              <li key={tool.name} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                <span className="font-mono text-xs text-slate-200">{tool.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{tool.description}</span>
                <select
                  aria-label={`What ${tool.name} does`}
                  disabled={hint.busy}
                  className="rounded border border-[var(--bark-700)] bg-[var(--bark-900)] px-1.5 py-0.5 text-[11px] text-slate-200"
                  value={tool.choice}
                  onChange={(event) => hint.choose(server.name, tool.name, event.target.value as McpHintChoice)}
                >
                  <option value="server">as the server says: {KIND[tool.declared]}</option>
                  <option value="read-only">{KIND['read-only']}</option>
                  <option value="safe-write">{KIND['safe-write']}</option>
                  <option value="destructive">{KIND.destructive}</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
