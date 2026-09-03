import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wrench, CheckCircle2, Code2, Plus, Edit3, Trash2, Save, X, Terminal, AlertTriangle, RotateCcw } from 'lucide-react';
import { card } from '../lib/pack-editor.js';
import { listTools, createTool, updateTool, deleteTool } from '../api/harness';

interface ToolRepositoryItem {
  id: string;
  name: string;
  category: 'sandbox' | 'planning' | 'database' | 'git' | 'http' | 'linter' | 'custom';
  description: string;
  requiresBinaries: string[];
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
  scriptCommand?: string;
  isBuiltIn?: boolean;
}

const CATEGORY_BADGES: Record<string, string> = {
  sandbox: 'bg-cyan-950/60 text-cyan-300 border-cyan-800',
  planning: 'bg-teal-950/60 text-teal-300 border-teal-800',
  database: 'bg-emerald-950/60 text-emerald-300 border-emerald-800',
  git: 'bg-amber-950/60 text-amber-300 border-amber-800',
  http: 'bg-purple-950/60 text-purple-300 border-purple-800',
  linter: 'bg-rose-950/60 text-rose-300 border-rose-800',
  custom: 'bg-orange-950/60 text-orange-300 border-orange-800',
};

export function ToolRepoPanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>('all');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingTool, setDeletingTool] = useState<ToolRepositoryItem | null>(null);

  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('custom');
  const [description, setDescription] = useState('');
  const [requiresBinaries, setRequiresBinaries] = useState('node');
  const [scriptCommand, setScriptCommand] = useState('');
  const [paramsJson, setParamsJson] = useState('{\n  "path": { "type": "string", "description": "Target file path" }\n}');
  const [jsonError, setJsonError] = useState('');

  const { data: tools, isLoading } = useQuery<ToolRepositoryItem[]>({
    queryKey: ['tools-repository'],
    queryFn: listTools,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tools-repository'] });

  const createMut = useMutation({
    mutationFn: (payload: unknown) => createTool(payload),
    onSuccess: () => {
      setAdding(false);
      resetForm();
      invalidate();
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) =>
      updateTool(id, payload),
    onSuccess: () => {
      setEditingId(null);
      resetForm();
      invalidate();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteTool(id),
    onSuccess: invalidate,
  });

  const resetForm = () => {
    setName('');
    setCategory('custom');
    setDescription('');
    setRequiresBinaries('node');
    setScriptCommand('');
    setParamsJson('{\n  "path": { "type": "string", "description": "Target file path" }\n}');
    setJsonError('');
  };

  const startEdit = (t: ToolRepositoryItem) => {
    setEditingId(t.id);
    setName(t.name);
    setCategory(t.category);
    setDescription(t.description);
    setRequiresBinaries((t.requiresBinaries ?? []).join(', '));
    setScriptCommand(t.scriptCommand ?? '');
    setParamsJson(JSON.stringify(t.parameters?.properties ?? {}, null, 2));
    setJsonError('');
  };

  const handleSaveNew = () => {
    try {
      const parsedProps = JSON.parse(paramsJson);
      setJsonError('');
      createMut.mutate({
        name,
        category,
        description,
        requiresBinaries: requiresBinaries.split(',').map((b) => b.trim()).filter(Boolean),
        scriptCommand: scriptCommand.trim() || undefined,
        parameters: { type: 'object', properties: parsedProps },
      });
    } catch {
      setJsonError('Invalid JSON properties object');
    }
  };

  const handleSaveUpdate = (id: string) => {
    try {
      const parsedProps = JSON.parse(paramsJson);
      setJsonError('');
      updateMut.mutate({
        id,
        payload: {
          name,
          category,
          description,
          requiresBinaries: requiresBinaries.split(',').map((b) => b.trim()).filter(Boolean),
          scriptCommand: scriptCommand.trim() || undefined,
          parameters: { type: 'object', properties: parsedProps },
        },
      });
    } catch {
      setJsonError('Invalid JSON properties object');
    }
  };

  const categories = ['all', 'sandbox', 'planning', 'database', 'git', 'http', 'linter', 'custom'];
  const filtered = (tools ?? []).filter((t) => filter === 'all' || t.category === filter);

  return (
    <div className="space-y-4 relative">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
            <Wrench size={18} className="text-[var(--leaf-light)]" />
            Tool Repository Catalog & Editor
          </h3>
          <p className="text-[12px] text-slate-400">
            Discover, define, and customize execution tools surfaced to agents and sandbox leaves.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setAdding((a) => !a); setEditingId(null); resetForm(); }}
            className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white"
          >
            <Plus size={14} />
            Add Tool
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 bg-[var(--bark-900)] p-1 rounded-lg border border-[var(--bark-600)] overflow-x-auto">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`text-[11px] px-2.5 py-1 rounded-md transition-colors capitalize whitespace-nowrap ${
              filter === cat
                ? 'bg-[var(--leaf-stem)] text-white font-medium'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {deletingTool && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className={`${card} max-w-md w-full p-5 space-y-4 border-rose-800 shadow-2xl animate-in fade-in zoom-in-95`}>
            <div className="flex items-center gap-2.5 text-rose-400">
              <AlertTriangle size={20} />
              <h4 className="font-semibold text-slate-100">Confirm Delete Tool</h4>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Are you sure you want to delete tool <strong className="font-mono text-amber-300">{deletingTool.name}</strong>?
              {deletingTool.isBuiltIn
                ? ' This is a built-in tool. Deleting custom overrides will reset it to its default definition.'
                : ' This custom tool will be removed.'}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDeletingTool(null)}
                className="text-xs px-3.5 py-1.5 rounded-md bg-[var(--bark-800)] hover:bg-[var(--bark-700)] text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  deleteMut.mutate(deletingTool.id);
                  setDeletingTool(null);
                }}
                className="text-xs px-3.5 py-1.5 rounded-md bg-rose-700 hover:bg-rose-600 text-white font-medium flex items-center gap-1.5"
              >
                <Trash2 size={13} />
                Delete Tool
              </button>
            </div>
          </div>
        </div>
      )}

      {adding && (
        <div className={`${card} p-4 space-y-3 border-[var(--leaf)]`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">Define New Tool</span>
            <button onClick={() => setAdding(false)} className="text-slate-500 hover:text-slate-300">
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Tool Function Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. run_custom_linter"
                className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)] font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200"
              >
                <option value="sandbox">sandbox</option>
                <option value="database">database</option>
                <option value="git">git</option>
                <option value="http">http</option>
                <option value="linter">linter</option>
                <option value="custom">custom</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Required Container Binaries</label>
              <input
                type="text"
                value={requiresBinaries}
                onChange={(e) => setRequiresBinaries(e.target.value)}
                placeholder="node, git, curl"
                className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)] font-mono"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this tool does and when the agent should call it"
              className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)]"
            />
          </div>
          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Optional Execution Script / Command Template</label>
            <input
              type="text"
              value={scriptCommand}
              onChange={(e) => setScriptCommand(e.target.value)}
              placeholder="e.g. eslint {{path}} --format json"
              className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)] font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Parameters Properties Schema (JSON)</label>
            <textarea
              value={paramsJson}
              onChange={(e) => setParamsJson(e.target.value)}
              rows={4}
              className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-[var(--leaf)]"
            />
            {jsonError ? <p className="text-[11px] text-rose-400 mt-1">{jsonError}</p> : null}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="text-xs px-3 py-1.5 text-slate-400 hover:text-slate-200">
              Cancel
            </button>
            <button
              onClick={handleSaveNew}
              disabled={!name.trim() || !description.trim() || createMut.isPending}
              className="text-xs px-3 py-1.5 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white rounded-md disabled:opacity-40"
            >
              Create Tool
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-8 text-slate-500 text-xs">Loading Tool Repository...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((t) => {
            const isEditing = editingId === t.id;

            if (isEditing) {
              return (
                <div key={t.id} className={`${card} p-4 space-y-3 border-[var(--leaf)] md:col-span-2`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200">Edit Tool Definition — {t.name}</span>
                    <button onClick={() => setEditingId(null)} className="text-slate-500 hover:text-slate-300">
                      <X size={14} />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Tool Function Name</label>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)] font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Category</label>
                      <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200"
                      >
                        <option value="sandbox">sandbox</option>
                        <option value="database">database</option>
                        <option value="git">git</option>
                        <option value="http">http</option>
                        <option value="linter">linter</option>
                        <option value="custom">custom</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Required Container Binaries</label>
                      <input
                        type="text"
                        value={requiresBinaries}
                        onChange={(e) => setRequiresBinaries(e.target.value)}
                        className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)] font-mono"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Description</label>
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Execution Script Command Template</label>
                    <input
                      type="text"
                      value={scriptCommand}
                      onChange={(e) => setScriptCommand(e.target.value)}
                      className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[var(--leaf)] font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Parameters Properties Schema (JSON)</label>
                    <textarea
                      value={paramsJson}
                      onChange={(e) => setParamsJson(e.target.value)}
                      rows={4}
                      className="w-full bg-[var(--bark-900)] border border-[var(--bark-600)] rounded px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-[var(--leaf)]"
                    />
                    {jsonError ? <p className="text-[11px] text-rose-400 mt-1">{jsonError}</p> : null}
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditingId(null)} className="text-xs px-3 py-1.5 text-slate-400 hover:text-slate-200">
                      Cancel
                    </button>
                    <button
                      onClick={() => handleSaveUpdate(t.id)}
                      disabled={!name.trim() || !description.trim() || updateMut.isPending}
                      className="flex items-center gap-1 text-xs px-3 py-1.5 bg-[var(--leaf-stem)] hover:bg-[var(--leaf)] text-white rounded-md disabled:opacity-40"
                    >
                      <Save size={12} />
                      Save Changes
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div key={t.id} className={`${card} p-4 flex flex-col justify-between`}>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-mono text-sm font-semibold text-[var(--leaf-light)] flex items-center gap-1.5">
                      <Code2 size={14} />
                      {t.name}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${
                          CATEGORY_BADGES[t.category] ?? 'bg-slate-800 text-slate-300 border-slate-700'
                        }`}
                      >
                        {t.category}
                      </span>
                      <button
                        onClick={() => startEdit(t)}
                        title="Edit tool definition"
                        className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[var(--bark-700)]"
                      >
                        <Edit3 size={13} />
                      </button>
                      <button
                        onClick={() => setDeletingTool(t)}
                        title={t.isBuiltIn ? 'Reset built-in tool to default' : 'Delete tool'}
                        className="p-1 rounded text-slate-400 hover:text-red-400 hover:bg-[var(--bark-700)]"
                      >
                        {t.isBuiltIn ? <RotateCcw size={13} className="text-amber-400 hover:text-amber-300" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </div>
                  <p className="text-[12px] text-slate-300 mb-3 leading-relaxed">{t.description}</p>
                </div>

                <div className="pt-3 border-t border-[var(--bark-600)] space-y-2">
                  {(t.requiresBinaries ?? []).length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest">Required Binaries:</span>
                      <div className="flex flex-wrap gap-1">
                        {t.requiresBinaries.map((bin) => (
                          <span
                            key={bin}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--bark-900)] text-slate-300 border border-[var(--bark-600)] flex items-center gap-1"
                          >
                            <CheckCircle2 size={10} className="text-emerald-400" />
                            {bin}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {t.scriptCommand && (
                    <div className="flex items-center gap-1.5 text-[11px] font-mono bg-[var(--bark-900)] text-amber-300 p-1.5 rounded border border-[var(--bark-600)]">
                      <Terminal size={12} className="text-amber-400 shrink-0" />
                      <span className="truncate">{t.scriptCommand}</span>
                    </div>
                  )}

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Parameters:</span>
                    <div className="bg-[var(--bark-900)]/80 rounded p-2 text-[11px] font-mono space-y-1 max-h-28 overflow-y-auto">
                      {Object.entries(t.parameters?.properties ?? {}).map(([k, v]) => (
                        <div key={k} className="flex items-start gap-1">
                          <span className="text-amber-400">{k}</span>
                          <span className="text-slate-500">:</span>
                          <span className="text-slate-300">{v.type}</span>
                          <span className="text-slate-500 truncate">— {v.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
