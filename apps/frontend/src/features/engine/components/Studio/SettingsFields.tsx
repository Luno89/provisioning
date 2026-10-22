import { Plus, X } from 'lucide-react'
import type { GroupSetting, SettingSchema } from '@koala/agent-engine/procedure'
import { defaultFor } from '../../lib/procedure-drafts'

const field = 'w-full rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)] px-2 py-1 text-xs text-slate-200 outline-none focus:border-[var(--leaf-stem)] disabled:opacity-60'

const titleOf = (name: string, schema: SettingSchema) => schema.title ?? name

interface ValueEditorProps {
  name: string
  schema: SettingSchema
  value: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}

function ValueEditor({ name, schema, value, disabled, onChange }: ValueEditorProps) {
  switch (schema.type) {
    case 'string':
      if (schema.enum) {
        return (
          <select aria-label={titleOf(name, schema)} className={field} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
            {!schema.enum.includes(String(value ?? '')) && <option value={String(value ?? '')}>{String(value ?? '(not set)')}</option>}
            {schema.enum.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        )
      }
      return schema.multiline ? (
        <textarea aria-label={titleOf(name, schema)} className={`${field} min-h-24 font-mono`} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input aria-label={titleOf(name, schema)} className={field} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      )

    case 'number':
    case 'integer':
      return (
        <input
          aria-label={titleOf(name, schema)}
          type="number"
          className={field}
          step={schema.type === 'integer' ? 1 : 'any'}
          min={schema.minimum}
          max={schema.maximum}
          value={typeof value === 'number' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
      )

    case 'boolean':
      return (
        <input aria-label={titleOf(name, schema)} type="checkbox" className="h-3.5 w-3.5 accent-[var(--leaf)]" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      )

    case 'array': {
      const list = Array.isArray(value) ? value : []
      return (
        <div className="space-y-1.5">
          {list.map((item, index) => (
            <div key={index} className="flex items-start gap-1">
              <div className="flex-1">
                <ValueEditor
                  name={`${name} ${index + 1}`}
                  schema={schema.items}
                  value={item}
                  disabled={disabled}
                  onChange={(next) => onChange(list.map((entry, at) => (at === index ? next : entry)))}
                />
              </div>
              {!disabled && (
                <button type="button" aria-label={`Remove ${name} ${index + 1}`} onClick={() => onChange(list.filter((_entry, at) => at !== index))} className="mt-1 text-slate-500 hover:text-red-300">
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          {!disabled && (schema.maxItems === undefined || list.length < schema.maxItems) && (
            <button type="button" onClick={() => onChange([...list, defaultFor(schema.items)])} className="flex items-center gap-1 text-[11px] text-[var(--leaf-light)] hover:underline">
              <Plus size={11} /> Add {schema.items.title?.toLowerCase() ?? 'one'}
            </button>
          )}
        </div>
      )
    }

    case 'object':
      return (
        <div className="space-y-2 rounded-md border border-[var(--bark-700)] p-2">
          <SettingsFields schema={schema} value={value} disabled={disabled} onChange={onChange} />
        </div>
      )
  }
}

export interface SettingsFieldsProps {
  schema: GroupSetting
  value: unknown
  disabled: boolean
  onChange: (value: Record<string, unknown>) => void
}

export default function SettingsFields({ schema, value, disabled, onChange }: SettingsFieldsProps) {
  const current = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const entries = Object.entries(schema.properties)
  if (entries.length === 0) return <p className="text-[11px] text-slate-500">This node has nothing to set.</p>

  return (
    <>
      {entries.map(([name, property]) => (
        <div key={name} className={property.type === 'boolean' ? 'flex items-start gap-2' : 'space-y-1'}>
          {property.type === 'boolean' && (
            <ValueEditor name={name} schema={property} value={current[name]} disabled={disabled} onChange={(next) => onChange({ ...current, [name]: next })} />
          )}
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-slate-300">
              {titleOf(name, property)}
              {schema.required?.includes(name) && <span className="text-red-300"> *</span>}
            </div>
            {property.describe && <p className="text-[10px] leading-snug text-slate-500">{property.describe}</p>}
          </div>
          {property.type !== 'boolean' && (
            <ValueEditor
              name={name}
              schema={property}
              value={current[name]}
              disabled={disabled}
              onChange={(next) => {
                const { [name]: _old, ...rest } = current
                onChange(next === undefined ? rest : { ...rest, [name]: next })
              }}
            />
          )}
        </div>
      ))}
    </>
  )
}
