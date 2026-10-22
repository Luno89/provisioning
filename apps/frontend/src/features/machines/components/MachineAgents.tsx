import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, X } from 'lucide-react';
import {
  installMachineAdapter, localAgentKeys, setMachineAgents,
  type LocalAgentDevice, type MachineAgent, type MachineAgentState,
} from '../api';
import { errorMessage } from '../../../api/client';

const STATE_LABEL: Record<MachineAgentState, string> = {
  checking: 'checking…',
  ready: 'ready',
  'needs-adapter': 'needs its adapter',
  'not-answering': 'not answering',
};

const STATE_STYLE: Record<MachineAgentState, string> = {
  checking: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
  ready: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  'needs-adapter': 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  'not-answering': 'text-red-400 bg-red-500/10 border-red-500/20',
};

const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;

function AgentRow({ device, agent }: { device: LocalAgentDevice; agent: MachineAgent }) {
  const qc = useQueryClient();
  const install = useMutation({
    mutationFn: () => installMachineAdapter(device.id, agent.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: localAgentKeys.list() }),
  });
  const removeByHand = useMutation({
    mutationFn: () => setMachineAgents(device.id, device.manualAgents.filter((entry) => entry.id !== agent.id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: localAgentKeys.list() }),
  });
  return (
    <li className="py-2 border-t border-slate-700/40 first:border-t-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-slate-200">{agent.name ?? agent.title}</span>
        {agent.version && <span className="text-[10px] font-mono text-slate-500">{agent.version}</span>}
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${STATE_STYLE[agent.state]}`}>{STATE_LABEL[agent.state]}</span>
        {agent.source === 'by-hand' && <span className="text-[10px] text-slate-500">added by hand</span>}
        <span className="flex-1" />
        {agent.state === 'needs-adapter' && (
          <button
            onClick={() => install.mutate()}
            disabled={install.isPending || !device.online}
            title={device.online ? `Install ${agent.adapter} on ${device.name}` : `${device.name} is not connected`}
            className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-[11px] font-bold transition-colors"
          >
            {install.isPending ? <Loader2 className="animate-spin" size={12} /> : 'Install adapter'}
          </button>
        )}
        {agent.source === 'by-hand' && (
          <button onClick={() => removeByHand.mutate()} disabled={removeByHand.isPending} className="text-slate-600 hover:text-red-400 transition-colors" title="Remove this agent">
            <X size={13} />
          </button>
        )}
      </div>
      {agent.command && <div className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">{[agent.command, ...(agent.args ?? [])].join(' ')}</div>}
      {agent.reason && agent.state !== 'ready' && <div className="text-[11px] text-slate-400 mt-1">{agent.reason}</div>}
      {agent.signIn && agent.signIn.length > 0 && (
        <div className="text-[11px] text-slate-500 mt-1">Signs in with {agent.signIn.join(', ')}: sign in on {device.name} the first time it runs.</div>
      )}
      {install.data && (
        <pre className={`text-[10px] mt-2 p-2 rounded bg-slate-950 border whitespace-pre-wrap ${install.data.ok ? 'border-slate-800 text-slate-400' : 'border-red-500/30 text-red-300'}`}>
          {install.data.ok ? 'Installed. Looking for it again…\n' : 'The install did not work:\n'}{install.data.output}
        </pre>
      )}
      {install.isError && <div className="text-[11px] text-red-400 mt-1">{errorMessage(install.error) || 'Could not install it.'}</div>}
    </li>
  );
}

function AddByHand({ device }: { device: LocalAgentDevice }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const add = useMutation({
    mutationFn: () => setMachineAgents(device.id, [
      ...device.manualAgents.filter((entry) => entry.id !== id.trim()),
      { id: id.trim(), ...(title.trim() ? { title: title.trim() } : {}), command: command.trim(), args: args.split(/\s+/).filter(Boolean) },
    ]),
    onSuccess: () => {
      setOpen(false); setId(''); setTitle(''); setCommand(''); setArgs('');
      qc.invalidateQueries({ queryKey: localAgentKeys.list() });
    },
  });
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-2 text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1">
        <Plus size={12} /> Add an agent by hand
      </button>
    );
  }
  const input = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500';
  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input aria-label="Agent id" value={id} onChange={(e) => setId(e.target.value)} placeholder="id, e.g. antigravity" className={input} />
        <input aria-label="Agent name" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="name, e.g. Antigravity" className={input} />
        <input aria-label="Command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command, e.g. /opt/agy/agy_acp_server.par" className={`${input} sm:col-span-2 font-mono`} />
        <input aria-label="Arguments" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="arguments, e.g. --uid=" className={`${input} sm:col-span-2 font-mono`} />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || !AGENT_ID.test(id.trim()) || !command.trim()}
          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-[11px] font-bold transition-colors"
        >
          {add.isPending ? <Loader2 className="animate-spin" size={12} /> : 'Add it'}
        </button>
        <button onClick={() => setOpen(false)} className="text-[11px] text-slate-500 hover:text-slate-300">Cancel</button>
        {add.isError && <span className="text-[11px] text-red-400">{errorMessage(add.error) || 'Could not add it.'}</span>}
      </div>
    </div>
  );
}

export default function MachineAgents({ device }: { device: LocalAgentDevice }) {
  return (
    <div className="mt-3 pl-6">
      <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Coding agents</div>
      {device.agents.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          {device.agentsAt ? 'None found on this machine.' : device.online ? 'Looking…' : 'It has not said yet: it looks when it connects.'}
        </p>
      ) : (
        <ul>{device.agents.map((agent) => <AgentRow key={agent.id} device={device} agent={agent} />)}</ul>
      )}
      <AddByHand device={device} />
    </div>
  );
}
