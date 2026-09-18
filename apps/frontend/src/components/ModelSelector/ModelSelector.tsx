import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Cpu, Globe, Search, Server } from 'lucide-react'
import { listModels, providerKeys, useDefaultModel, type ModelProvider } from '../../api/models'
import { isLocal, sourceOf } from '../../lib/model-groups'

export interface ModelSelectorProps {
  value: string | null | undefined
  onChange: (modelId: string, model: ModelProvider | undefined) => void
  className?: string
  placeholder?: string
  showAccountDefault?: boolean
  disabled?: boolean
  id?: string
}

export default function ModelSelector({
  value,
  onChange,
  className = '',
  placeholder = 'Select model…',
  showAccountDefault = true,
  disabled = false,
  id,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const { data: models = [], isLoading } = useQuery<ModelProvider[]>({
    queryKey: providerKeys.list(),
    queryFn: listModels,
  })

  const { data: defaultSetting } = useDefaultModel()
  const defaultModelId = defaultSetting?.defaultModelId ?? null
  const defaultModel = models.find((m) => m.id === defaultModelId)

  // Current selected model object
  const selectedModel = models.find((m) => m.id === value)

  const close = () => {
    setOpen(false)
    setSearch('')
  }

  useEffect(() => {
    if (!open) return
    const focusTimer = setTimeout(() => searchInputRef.current?.focus(), 50)
    return () => clearTimeout(focusTimer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // Filtered & grouped models
  const { localDeployments, gatewayModels } = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matches = (m: ModelProvider) => {
      if (!q) return true
      return (
        m.name.toLowerCase().includes(q)
        || m.model.toLowerCase().includes(q)
        || (m.sourceLabel && m.sourceLabel.toLowerCase().includes(q))
        || (m.kind && m.kind.toLowerCase().includes(q))
      )
    }

    const filtered = models.filter(matches)
    return {
      localDeployments: filtered.filter(isLocal),
      gatewayModels: filtered.filter((m) => !isLocal(m)),
    }
  }, [models, search])

  const handleSelect = (modelId: string, modelObj?: ModelProvider) => {
    onChange(modelId, modelObj)
    close()
  }

  // Label to show on the closed trigger button
  const triggerLabel = useMemo(() => {
    if (!value) {
      if (showAccountDefault) {
        return defaultModel
          ? `Account default · ${defaultModel.name}`
          : 'Account default'
      }
      return placeholder
    }
    if (selectedModel) {
      return `${selectedModel.name}${selectedModel.model ? ` · ${selectedModel.model}` : ''}`
    }
    return value
  }, [value, selectedModel, defaultModel, showAccountDefault, placeholder])

  const triggerBadge = selectedModel
    ? isLocal(selectedModel)
      ? 'Cluster'
      : sourceOf(selectedModel)
    : null

  return (
    <div ref={containerRef} className={`relative inline-block text-left ${className}`}>
      <button
        type="button"
        id={id}
        aria-label="Model"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:border-slate-600 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {selectedModel ? (
            isLocal(selectedModel) ? (
              <Server size={13} className="shrink-0 text-emerald-400" />
            ) : (
              <Globe size={13} className="shrink-0 text-sky-400" />
            )
          ) : (
            <Cpu size={13} className="shrink-0 text-slate-400" />
          )}

          <span className="truncate font-medium">{triggerLabel}</span>

          {triggerBadge && (
            <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
              {triggerBadge}
            </span>
          )}
        </span>

        <ChevronDown size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-50 mt-1 max-h-96 w-80 sm:w-96 overflow-hidden rounded-xl border border-slate-700/80 bg-slate-950 shadow-2xl shadow-black/80 animate-in fade-in zoom-in-95 duration-100"
        >
          {/* Search Header */}
          <div className="border-b border-slate-800 p-2.5">
            <div className="relative flex items-center">
              <Search size={14} className="absolute left-2.5 text-slate-500" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models, clusters, providers…"
                className="w-full rounded-md border border-slate-800 bg-slate-900/80 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          {/* List content */}
          <div className="max-h-72 overflow-y-auto p-1.5 space-y-2">
            {/* Option: Account Default */}
            {showAccountDefault && (
              <div className="space-y-0.5">
                <button
                  type="button"
                  role="option"
                  aria-selected={!value}
                  onClick={() => handleSelect('', undefined)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                    !value
                      ? 'bg-sky-500/15 text-sky-200 font-semibold'
                      : 'text-slate-300 hover:bg-slate-900 hover:text-slate-100'
                  }`}
                >
                  <Cpu size={14} className={!value ? 'text-sky-400' : 'text-slate-500'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span>Account Default</span>
                      <span className="rounded bg-slate-800 px-1.5 py-0.2 text-[9px] text-slate-400 font-mono">
                        Fallback
                      </span>
                    </div>
                    {defaultModel && (
                      <p className="truncate text-[11px] text-slate-400 mt-0.5">
                        {defaultModel.name} · {defaultModel.model ?? 'system'}
                      </p>
                    )}
                  </div>
                  {!value && <Check size={14} className="shrink-0 text-sky-400" />}
                </button>
              </div>
            )}

            {/* Local & Cluster Deployments */}
            {localDeployments.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400/90">
                  <Server size={12} /> Local & Cluster Deployments ({localDeployments.length})
                </div>
                <div className="space-y-0.5">
                  {localDeployments.map((model) => {
                    const isSelected = value === model.id
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => handleSelect(model.id, model)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                          isSelected
                            ? 'bg-emerald-500/15 text-emerald-200 font-medium'
                            : 'text-slate-300 hover:bg-slate-900 hover:text-slate-100'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 truncate">
                            <span className="truncate font-semibold">{model.name}</span>
                            <span className="rounded bg-emerald-950/80 border border-emerald-800/60 px-1.5 py-0.2 text-[9px] font-mono text-emerald-400">
                              {model.kind ?? model.sourceLabel ?? 'k8s'}
                            </span>
                            {model.sourceLabel && model.sourceLabel !== model.kind ? (
                              <span className="rounded bg-slate-800 px-1 py-0.2 text-[9px] text-slate-400 font-mono">
                                {model.sourceLabel}
                              </span>
                            ) : null}
                            {model.gpuCount ? (
                              <span className="rounded bg-slate-800 px-1 py-0.2 text-[9px] text-slate-400 font-mono">
                                {model.gpuCount} GPU
                              </span>
                            ) : null}
                          </div>
                          <p className="truncate text-[11px] font-mono text-slate-500">
                            {model.model}
                          </p>
                        </div>
                        {isSelected && <Check size={14} className="shrink-0 text-emerald-400" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Connected Gateways */}
            {gatewayModels.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-sky-400/90">
                  <Globe size={12} /> Connected Gateways ({gatewayModels.length})
                </div>
                <div className="space-y-0.5">
                  {gatewayModels.map((model) => {
                    const isSelected = value === model.id
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => handleSelect(model.id, model)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                          isSelected
                            ? 'bg-sky-500/15 text-sky-200 font-medium'
                            : 'text-slate-300 hover:bg-slate-900 hover:text-slate-100'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 truncate">
                            <span className="truncate font-semibold">{model.name}</span>
                            {model.sourceLabel && (
                              <span className="rounded bg-slate-800 px-1.5 py-0.2 text-[9px] font-mono text-slate-400">
                                {model.sourceLabel}
                              </span>
                            )}
                          </div>
                          <p className="truncate text-[11px] font-mono text-slate-500">
                            {model.model}
                          </p>
                        </div>
                        {isSelected && <Check size={14} className="shrink-0 text-sky-400" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Empty States */}
            {models.length === 0 && !isLoading && (
              <p className="p-4 text-center text-xs text-amber-400">
                No models connected yet — deploy a model or add an endpoint in Cloud Accounts.
              </p>
            )}

            {models.length > 0 && localDeployments.length === 0 && gatewayModels.length === 0 && (
              <p className="p-4 text-center text-xs text-slate-500">
                No models match "{search}"
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
