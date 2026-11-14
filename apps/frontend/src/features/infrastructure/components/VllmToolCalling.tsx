import { errorMessage } from '../../../api/client'
import { useToolCallParsers } from '../../models'
import type { ToolCalling } from '../lib/vllm-tool-calling'

export interface VllmToolCallingProps {
  idPrefix: string
  calling: ToolCalling
  enabled: boolean
  picked: string
  onChange: (next: { enabled: boolean; picked: string }) => void
}

export function VllmToolCalling({ idPrefix, calling, enabled, picked, onChange }: VllmToolCallingProps) {
  const parsers = useToolCallParsers()
  const fromModel = 'fromModel' in calling ? calling.fromModel : undefined
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input type="checkbox" id={`${idPrefix}-tool-calling`} checked={enabled} onChange={(e) => onChange({ enabled: e.target.checked, picked })} className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-blue-500" />
        <label htmlFor={`${idPrefix}-tool-calling`} className="text-sm text-slate-300 cursor-pointer select-none">Serve tool calling</label>
        <span className="text-[10px] text-slate-500 ml-auto">Every Koala chat uses it</span>
      </div>
      {enabled ? (
        <div>
          <label htmlFor={`${idPrefix}-tool-call-parser`} className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Tool Call Parser</label>
          <select id={`${idPrefix}-tool-call-parser`} value={picked} onChange={(e) => onChange({ enabled, picked: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-3 text-sm">
            <option value="">{fromModel ?? 'Pick the parser for this model'}</option>
            {(parsers.data ?? []).map((entry) => <option key={entry.parser} value={entry.parser}>{entry.parser} — {entry.label}</option>)}
          </select>
          {parsers.isError && <p role="alert" className="text-[11px] text-amber-400/90 mt-2">Koala could not list the tool call parsers it knows: {errorMessage(parsers.error)}</p>}
          {'problem' in calling && <p role="alert" className="text-[11px] text-amber-400/90 mt-2">{calling.problem}</p>}
          {'waiting' in calling && <p className="text-[11px] text-slate-400 mt-2">{calling.waiting}</p>}
        </div>
      ) : (
        <p className="text-[11px] text-amber-400/90">Without tool calling, Koala's chats cannot run on this model.</p>
      )}
    </div>
  )
}
