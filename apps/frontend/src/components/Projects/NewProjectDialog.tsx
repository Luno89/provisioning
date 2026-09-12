import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { createProject as createProjectApi } from '../../api/projects.js'
import { listLocalAgentDevices, localAgentKeys, type LocalAgentDevice } from '../../api/local-agents.js'

interface Cluster {
  id: string
  name: string
}

export function NewProjectDialog({ clusters, onClose, onCreated }: {
  clusters: Cluster[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const [deviceId, setDeviceId] = useState('')

  const { data: localAgents = [] } = useQuery<LocalAgentDevice[]>({
    queryKey: localAgentKeys.list(),
    queryFn: listLocalAgentDevices,
  })

  const createProject = useMutation({
    mutationFn: (payload: unknown) => createProjectApi(payload),
    onSuccess: (project: { id: string }) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      onCreated(project.id)
    },
  })

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-[var(--bark-900)] border border-[var(--bark-700)] rounded-lg p-6 w-full max-w-md shadow-2xl space-y-5">
        <div className="flex justify-between items-center pb-3 border-b border-[var(--bark-800)]">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Plus size={16} className="text-blue-400" /> Register Project Repository
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            const d = new FormData(e.currentTarget)
            createProject.mutate({
              name: d.get('name'),
              targetNamespace: d.get('name'),
              executionApproval: d.get('requireApproval') === 'on' ? 'plan' : 'auto',
              ...(deviceId
                ? {
                    executionTargetDeviceId: deviceId,
                    executionTargetPath: d.get('executionTargetPath') || undefined,
                  }
                : {
                    giteaRepo: d.get('giteaRepo'),
                    createRepo: d.get('createRepo') === 'on',
                    targetClusterId: d.get('targetClusterId') || undefined,
                    autoDeployOnBuild: d.get('autoDeployOnBuild') === 'on',
                  }),
            })
          }}
          className="space-y-4 text-xs"
        >
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Project Name</label>
            <input
              name="name" required
              className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="e.g. internal-dashboard"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Where Koala's leaves run</label>
            <select
              name="executionTargetDeviceId"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
            >
              <option value="">Sandboxed cluster (default)</option>
              {localAgents.map((d) => <option key={d.id} value={d.id}>{d.name}{d.online ? '' : ' (offline)'}</option>)}
            </select>
            {localAgents.length === 0 && (
              <p className="text-[11px] text-slate-500 mt-1">
                No machines registered yet — add one under My Machines to run leaves locally instead.
              </p>
            )}
          </div>

          {deviceId ? (
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Subfolder on that machine</label>
              <input
                name="executionTargetPath"
                className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors font-mono"
                placeholder="e.g. apps/second-thing (leave blank for the machine's root)"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                No Gitea repository needed — this project runs directly out of that folder.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Gitea Repository Name</label>
                <input
                  name="giteaRepo" required
                  className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors font-mono"
                  placeholder="e.g. internal-dashboard"
                />
              </div>

              <label className="flex items-center gap-2.5 text-slate-300 cursor-pointer pt-1">
                <input type="checkbox" name="createRepo" defaultChecked className="rounded accent-blue-600" />
                <span>Initialize new empty repository on Gitea</span>
              </label>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Target Cluster</label>
                <select
                  name="targetClusterId"
                  className="w-full bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-md px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
                >
                  <option value="">Default Management Cluster</option>
                  {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              <label className="flex items-center gap-2.5 text-slate-300 cursor-pointer">
                <input type="checkbox" name="autoDeployOnBuild" defaultChecked className="rounded accent-blue-600" />
                <span>Auto-deploy image on every successful push</span>
              </label>
            </>
          )}

          <label className="flex items-center gap-2.5 text-slate-300 cursor-pointer">
            <input type="checkbox" name="requireApproval" defaultChecked className="rounded accent-blue-600" />
            <span>Require my approval before each command on a local machine</span>
          </label>

          {createProject.isError && (
            <p className="text-rose-400 text-xs">
              {(createProject.error as any)?.response?.data?.error || 'Failed to create project'}
            </p>
          )}

          <div className="flex gap-2.5 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-[var(--bark-800)] hover:bg-[var(--bark-700)] text-slate-200 py-2 rounded-md font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createProject.isPending}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2 rounded-md font-medium transition-colors"
            >
              {createProject.isPending ? 'Registering...' : 'Register Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default NewProjectDialog
