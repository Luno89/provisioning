import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, Circle, Copy, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { createPreauthKey, deleteMeshDevice, getMeshConfig, listMeshDevices, meshKeys, type MeshConfig, type MeshDevice } from '../../api/mesh'
import { errorMessage } from '../../api/client'
import { Section } from '../Monitoring/Parts'
import { QuietButton } from './Parts'

export function OwnHardwareSection() {
  const [issuedKey, setIssuedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const config = useQuery<MeshConfig>({ queryKey: meshKeys.config(), queryFn: getMeshConfig })
  const devices = useQuery<MeshDevice[]>({ queryKey: meshKeys.devices(), queryFn: listMeshDevices, refetchInterval: 15_000 })
  const mintKey = useMutation({
    mutationFn: () => createPreauthKey({ reusable: false, expirySeconds: 3600 }),
    onSuccess: (data) => { setIssuedKey(data.key); setCopied(false) },
  })
  const revoke = useMutation({ mutationFn: (nodeId: string) => deleteMeshDevice(nodeId), onSuccess: () => { void devices.refetch() } })
  const reachable = config.data?.configured === true
  const joinCommand = issuedKey && config.data?.loginServer
    ? `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --login-server=${config.data.loginServer} --authkey=${issuedKey}`
    : null

  const copy = () => {
    if (!joinCommand) return
    void navigator.clipboard.writeText(joinCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Section
      id="infrastructure-hardware"
      title="Your own hardware"
      right={(
        <button type="button" onClick={() => mintKey.mutate()} disabled={mintKey.isPending || !reachable} className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-500 disabled:bg-[var(--bark-700)] disabled:text-slate-500">
          {mintKey.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Generate join command'}
        </button>
      )}
    >
      <p className="text-[11px] text-slate-500">A GPU workstation or a spare server joins the mesh, then becomes a cluster through Provision a cluster. It connects outward, so nothing needs opening on your router. The key lasts an hour and works once.</p>
      {config.data && !reachable && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 text-[12px] text-slate-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <span><strong className="text-amber-300">The mesh isn't reachable yet.</strong> This platform has no public address for its coordination server, so a machine outside this network can't join. Joining will work once the platform is hosted at a public domain.</span>
        </p>
      )}
      {joinCommand && (
        <div className="space-y-1">
          <div className="flex items-start gap-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] p-3">
            <code className="flex-1 break-all font-mono text-[11px] leading-relaxed text-slate-300">{joinCommand}</code>
            <button type="button" onClick={copy} className="shrink-0 text-slate-500 hover:text-white" aria-label="Copy the join command">
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            </button>
          </div>
          <p className="text-[11px] text-amber-300/80">It holds a live credential, is shown once and ends in an hour. Don't paste it anywhere public.</p>
        </div>
      )}
      {mintKey.isError && <p className="text-[11px] text-rose-300">{errorMessage(mintKey.error) || 'Could not generate a key.'}</p>}

      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">On the mesh</h4>
        <QuietButton onClick={() => { void devices.refetch() }} label="Refresh the machines on the mesh"><RefreshCw size={11} className={devices.isFetching ? 'animate-spin' : ''} /></QuietButton>
      </div>
      {devices.isPending ? <p className="flex items-center gap-2 text-[12px] text-slate-500"><Loader2 size={12} className="animate-spin" /> Loading…</p>
        : devices.isError ? <p className="text-[12px] text-slate-500">{errorMessage(devices.error) || 'Mesh unavailable.'}</p>
        : !devices.data.length ? <p className="text-[12px] text-slate-500">No machines yet.</p>
        : (
          <ul className="space-y-1.5">
            {devices.data.map((device) => (
              <li key={device.id} className="flex items-center gap-3 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 px-3 py-2 text-[12px]" data-testid="mesh-device">
                <Circle size={8} className={device.online ? 'fill-emerald-400 text-emerald-400' : 'fill-slate-600 text-slate-600'} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-slate-200">{device.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {device.ipAddresses?.[0] ?? 'no address'}
                    {!device.online && device.lastSeen && ` · last seen ${new Date(device.lastSeen).toLocaleString()}`}
                  </div>
                </div>
                <QuietButton danger onClick={() => revoke.mutate(device.id)} disabled={revoke.isPending} label={`Remove ${device.name} from the mesh`}><Trash2 size={11} /></QuietButton>
              </li>
            ))}
          </ul>
        )}
    </Section>
  )
}

export default OwnHardwareSection
