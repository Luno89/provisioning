import { useState } from 'react';
import {
  listLocalAgentDevices, createMachineJoinCode, deleteLocalAgentDevice, localAgentKeys,
  type LocalAgentDevice, type MachineJoinCode,
} from '../api';
import { errorMessage } from '../../../api/client';
import MachineAgents from './MachineAgents';
import ConfirmDelete from '../../../shared/components/ConfirmDelete';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, Copy, Check, Trash2, Circle, Terminal, ShieldCheck, ShieldAlert,
} from 'lucide-react';

export default function MyMachines() {
  const qc = useQueryClient();
  const [machineCode, setMachineCode] = useState<MachineJoinCode | null>(null);
  const [agentCopied, setAgentCopied] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const { data: localAgents } = useQuery<LocalAgentDevice[]>({
    queryKey: localAgentKeys.list(),
    queryFn: listLocalAgentDevices,
    refetchInterval: 5000,
  });

  const createCode = useMutation({
    mutationFn: createMachineJoinCode,
    onSuccess: (data) => { setMachineCode(data); setAgentCopied(false); },
  });

  const revokeAgent = useMutation({
    mutationFn: (id: string) => deleteLocalAgentDevice(id),
    onSuccess: () => { setRemoving(null); return qc.invalidateQueries({ queryKey: localAgentKeys.list() }); },
  });

  const copyAgentCommand = () => {
    if (!machineCode) return;
    navigator.clipboard.writeText(machineCode.command);
    setAgentCopied(true);
    setTimeout(() => setAgentCopied(false), 2000);
  };

  return (
    <section>
      <header className="mb-8">
        <h2 className="text-3xl font-bold flex items-center gap-3">
          <Terminal className="text-blue-500" size={28} /> My Machines
        </h2>
        <p className="text-slate-400 mt-2 text-sm">
          A computer of yours that Koala can run work on, in one folder you choose, with the coding
          agents installed there (Gemini CLI, Claude Code, Codex, Antigravity…). It dials out to
          Koala, so nothing needs opening on your router.
        </p>
      </header>

      <div className="bg-slate-800/50 border border-slate-700/50 rounded-3xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-bold text-sm">Add a machine</h3>
            <p className="text-[11px] text-slate-500 mt-1">
              Run the command on that machine, as yourself. It needs Node.js 20 or newer. It asks which
              folder Koala may work in, installs the machine agent and starts it, and looks for the
              coding agents you have.
            </p>
          </div>
          <button
            onClick={() => createCode.mutate()}
            disabled={createCode.isPending}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-bold transition-colors whitespace-nowrap"
          >
            {createCode.isPending ? <Loader2 className="animate-spin" size={16} /> : 'Get the command'}
          </button>
        </div>

        {machineCode && (
          <div className="mt-5">
            <div className="flex items-start gap-2 bg-slate-950 border border-slate-800 rounded-xl p-4">
              <code className="text-[11px] text-slate-300 font-mono break-all flex-1 leading-relaxed">{machineCode.command}</code>
              <button onClick={copyAgentCommand} className="text-slate-500 hover:text-white transition-colors flex-shrink-0" title="Copy">
                {agentCopied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-amber-400/80 mt-2 px-1">
              It works once, until {new Date(machineCode.expiresAt).toLocaleTimeString()}. Don't paste it anywhere public.
            </p>
          </div>
        )}

        {createCode.isError && (
          <p className="text-[11px] text-red-400 mt-3">
            {errorMessage(createCode.error) || 'Could not make the command.'}
          </p>
        )}
      </div>

      {localAgents && localAgents.length > 0 && (
        <div className="space-y-2">
          {localAgents.map((d) => (
            <div key={d.id} className="bg-slate-800/50 border border-slate-700/50 rounded-2xl px-5 py-4">
              <div className="flex items-center gap-4">
                <Circle size={9} className={d.online ? 'text-green-400 fill-green-400' : 'text-slate-600 fill-slate-600'} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-slate-200 truncate">{d.name}</span>
                    {d.online && (
                      d.containerMode ? (
                        <span
                          className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0"
                          title="Leaves run in an isolated Docker container, with enforced network egress"
                        >
                          <ShieldCheck size={10} /> isolated
                        </span>
                      ) : (
                        <span
                          className="text-[10px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0"
                          title="No Docker on this machine — leaves run directly on the host with no isolation"
                        >
                          <ShieldAlert size={10} /> raw access
                        </span>
                      )
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                    {d.rootDir}
                    {d.os && ` · ${d.os}`}
                    {!d.online && d.lastSeenAt && ` · last seen ${new Date(d.lastSeenAt).toLocaleString()}`}
                  </div>
                </div>
                <button
                  onClick={() => setRemoving(d.id)}
                  disabled={revokeAgent.isPending}
                  className="text-slate-600 hover:text-red-400 transition-colors"
                  title="Remove this machine"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {removing === d.id && (
                <div className="mt-3">
                  <ConfirmDelete
                    prompt={`Remove ${d.name}? Its token stops working, it leaves the private network, the agent on it stops and deletes its token, and the project it was added with goes. Files in ${d.rootDir} stay on the machine.`}
                    confirmLabel="Remove machine"
                    pending={revokeAgent.isPending}
                    onConfirm={() => revokeAgent.mutate(d.id)}
                    onCancel={() => setRemoving(null)}
                  />
                </div>
              )}
              <MachineAgents device={d} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
