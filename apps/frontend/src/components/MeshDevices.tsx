import { useState } from 'react';
import {
  getMeshConfig, listMeshDevices, createPreauthKey, deleteMeshDevice, meshKeys,
  type MeshConfig, type MeshDevice,
} from '../api/mesh';
import {
  listLocalAgentDevices, createLocalAgentDevice, deleteLocalAgentDevice, localAgentKeys,
  type LocalAgentDevice,
} from '../api/local-agents';
import { errorMessage, API_BASE } from '../api/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Network, Loader2, AlertTriangle, Copy, Check, Trash2, Circle, RefreshCw, Terminal, ShieldCheck, ShieldAlert,
} from 'lucide-react';

export default function MeshDevices() {
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const qc = useQueryClient();
  const [agentName, setAgentName] = useState('');
  const [agentRootDir, setAgentRootDir] = useState('');
  const [issuedAgentCommand, setIssuedAgentCommand] = useState<string | null>(null);
  const [agentCopied, setAgentCopied] = useState(false);

  const { data: localAgents } = useQuery<LocalAgentDevice[]>({
    queryKey: localAgentKeys.list(),
    queryFn: listLocalAgentDevices,
    refetchInterval: 5000,
  });

  const createAgent = useMutation({
    mutationFn: () => createLocalAgentDevice({ name: agentName.trim(), rootDir: agentRootDir.trim() }),
    onSuccess: (data) => {
      const backendUrl = API_BASE.replace(/\/api\/?$/, '');
      setIssuedAgentCommand(
        `KOALA_BACKEND_URL=${backendUrl} KOALA_DEVICE_TOKEN=${data.token} KOALA_ROOT_DIR=${data.rootDir} npm run start -w apps/local-agent`,
      );
      setAgentCopied(false);
      setAgentName('');
      setAgentRootDir('');
      qc.invalidateQueries({ queryKey: localAgentKeys.list() });
    },
  });

  const revokeAgent = useMutation({
    mutationFn: (id: string) => deleteLocalAgentDevice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: localAgentKeys.list() }),
  });

  const copyAgentCommand = () => {
    if (!issuedAgentCommand) return;
    navigator.clipboard.writeText(issuedAgentCommand);
    setAgentCopied(true);
    setTimeout(() => setAgentCopied(false), 2000);
  };

  const { data: config } = useQuery<MeshConfig>({
    queryKey: meshKeys.config(),
    queryFn: getMeshConfig,
  });

  const { data: devices, isLoading, error, refetch, isFetching } = useQuery<MeshDevice[]>({
    queryKey: meshKeys.devices(),
    queryFn: listMeshDevices,
    refetchInterval: 15000,
  });

  const mintKey = useMutation({
    mutationFn: () => createPreauthKey({ reusable: false, expirySeconds: 3600 }),
    onSuccess: (data) => { setIssuedKey(data.key); setCopied(false); },
  });

  const revoke = useMutation({
    mutationFn: (nodeId: string) => deleteMeshDevice(nodeId),
    onSuccess: () => refetch(),
  });

  const joinCommand = issuedKey && config?.loginServer
    ? `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --login-server=${config.loginServer} --authkey=${issuedKey}`
    : null;

  const copy = () => {
    if (!joinCommand) return;
    navigator.clipboard.writeText(joinCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section>
      <header className="mb-8">
        <h2 className="text-3xl font-bold flex items-center gap-3">
          <Network className="text-blue-500" size={28} /> My Machines
        </h2>
        <p className="text-slate-400 mt-2 text-sm">
          Attach your own hardware — a GPU workstation, a spare server — and deploy to it like any
          other cluster. The machine connects outward, so nothing needs opening on your router.
        </p>
      </header>

      {config && !config.configured && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 mb-6 flex items-start gap-3">
          <AlertTriangle className="text-amber-500 flex-shrink-0 mt-0.5" size={16} />
          <p className="text-[12px] text-slate-400 leading-relaxed">
            <strong className="text-amber-300">The mesh isn't reachable yet.</strong> This platform
            has no public address configured for its coordination server, so a machine outside this
            network can't join. Joining will work once the platform is hosted at a public domain.
          </p>
        </div>
      )}

      <div className="bg-slate-800/50 border border-slate-700/50 rounded-3xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-bold text-sm">Add a machine</h3>
            <p className="text-[11px] text-slate-500 mt-1">
              Generates a single-use key valid for one hour, then run the command on that machine.
            </p>
          </div>
          <button
            onClick={() => mintKey.mutate()}
            disabled={mintKey.isPending || !config?.configured}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-bold transition-colors"
          >
            {mintKey.isPending ? <Loader2 className="animate-spin" size={16} /> : 'Generate join command'}
          </button>
        </div>

        {joinCommand && (
          <div className="mt-5">
            <div className="flex items-start gap-2 bg-slate-950 border border-slate-800 rounded-xl p-4">
              <code className="text-[11px] text-slate-300 font-mono break-all flex-1 leading-relaxed">{joinCommand}</code>
              <button onClick={copy} className="text-slate-500 hover:text-white transition-colors flex-shrink-0" title="Copy">
                {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-amber-400/80 mt-2 px-1">
              Contains a live credential — it's shown once and expires in an hour. Don't paste it anywhere public.
            </p>
          </div>
        )}

        {mintKey.isError && (
          <p className="text-[11px] text-red-400 mt-3">
            {errorMessage(mintKey.error) || 'Could not generate a key.'}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Connected machines</h3>
        <button onClick={() => refetch()} className="text-slate-500 hover:text-white transition-colors" title="Refresh">
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-10 text-slate-500 text-sm"><Loader2 className="animate-spin inline mr-2" size={16} /> Loading…</div>
      ) : error ? (
        <div className="bg-slate-800/30 border border-dashed border-slate-700 rounded-2xl py-8 text-center text-slate-500 text-sm">
          {errorMessage(error) || 'Mesh unavailable.'}
        </div>
      ) : !devices?.length ? (
        <div className="bg-slate-800/30 border border-dashed border-slate-700 rounded-2xl py-10 text-center text-slate-500 text-sm">
          No machines yet. Generate a join command above to add one.
        </div>
      ) : (
        <div className="space-y-2">
          {devices.map((d) => (
            <div key={d.id} className="bg-slate-800/50 border border-slate-700/50 rounded-2xl px-5 py-4 flex items-center gap-4">
              <Circle size={9} className={d.online ? 'text-green-400 fill-green-400' : 'text-slate-600 fill-slate-600'} />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm text-slate-200 truncate">{d.name}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {d.ipAddresses?.[0] ?? 'no address'}
                  {!d.online && d.lastSeen && ` · last seen ${new Date(d.lastSeen).toLocaleString()}`}
                </div>
              </div>
              <button
                onClick={() => revoke.mutate(d.id)}
                disabled={revoke.isPending}
                className="text-slate-600 hover:text-red-400 transition-colors"
                title="Remove this machine from the mesh"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      <header className="mt-10 mb-8">
        <h2 className="text-3xl font-bold flex items-center gap-3">
          <Terminal className="text-blue-500" size={28} /> Local execution agents
        </h2>
        <p className="text-slate-400 mt-2 text-sm">
          A small process you run on one of your own machines so a project's leaves can execute
          commands directly on it, instead of in a sandboxed cluster. Runs autonomously, with no
          container isolation — only register a machine you're comfortable with Koala running
          commands on.
        </p>
      </header>

      <div className="bg-slate-800/50 border border-slate-700/50 rounded-3xl p-6 mb-6">
        <h3 className="font-bold text-sm mb-3">Register a machine</h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Name, e.g. My Laptop"
            className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
          />
          <input
            value={agentRootDir}
            onChange={(e) => setAgentRootDir(e.target.value)}
            placeholder="Root directory, e.g. /home/me/koala-work"
            className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => createAgent.mutate()}
            disabled={createAgent.isPending || !agentName.trim() || !agentRootDir.trim()}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-bold transition-colors whitespace-nowrap"
          >
            {createAgent.isPending ? <Loader2 className="animate-spin" size={16} /> : 'Generate command'}
          </button>
        </div>

        {issuedAgentCommand && (
          <div className="mt-5">
            <div className="flex items-start gap-2 bg-slate-950 border border-slate-800 rounded-xl p-4">
              <code className="text-[11px] text-slate-300 font-mono break-all flex-1 leading-relaxed">{issuedAgentCommand}</code>
              <button onClick={copyAgentCommand} className="text-slate-500 hover:text-white transition-colors flex-shrink-0" title="Copy">
                {agentCopied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-amber-400/80 mt-2 px-1">
              Contains a live credential — it's shown once. Run it on the machine you want leaves
              executing on, from inside this repo.
            </p>
          </div>
        )}

        {createAgent.isError && (
          <p className="text-[11px] text-red-400 mt-3">
            {errorMessage(createAgent.error) || 'Could not register that machine.'}
          </p>
        )}
      </div>

      {localAgents && localAgents.length > 0 && (
        <div className="space-y-2">
          {localAgents.map((d) => (
            <div key={d.id} className="bg-slate-800/50 border border-slate-700/50 rounded-2xl px-5 py-4 flex items-center gap-4">
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
                  {!d.online && d.lastSeenAt && ` · last seen ${new Date(d.lastSeenAt).toLocaleString()}`}
                </div>
              </div>
              <button
                onClick={() => revokeAgent.mutate(d.id)}
                disabled={revokeAgent.isPending}
                className="text-slate-600 hover:text-red-400 transition-colors"
                title="Revoke this machine's access"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
