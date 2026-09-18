import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { readProcedure, type Procedure } from '@koala/agent-engine/procedure'
import '../ProjectEditor/monaco-setup'

const pretty = (procedure: Procedure) => JSON.stringify(procedure, null, 2)

export interface JsonViewProps {
  procedure: Procedure
  onChange: (next: Procedure, mergeKey?: string) => void
}

export default function JsonView({ procedure, onChange }: JsonViewProps) {
  const [text, setText] = useState(() => pretty(procedure))
  const [refusal, setRefusal] = useState<string | null>(null)
  const typed = useRef(text)

  useEffect(() => {
    const read = readProcedure(typed.current)
    if (!read.ok || pretty(read.procedure) !== pretty(procedure)) {
      typed.current = pretty(procedure)
      setText(typed.current)
      setRefusal(null)
    }
  }, [procedure])

  const edit = (next: string) => {
    typed.current = next
    setText(next)
    const read = readProcedure(next)
    if (!read.ok) {
      setRefusal(read.problems.map((problem) => problem.message).join('; '))
      return
    }
    if (read.procedure.id !== procedure.id) {
      setRefusal(`the id stays "${procedure.id}" here — to make a procedure with another id, use Save as copy`)
      return
    }
    setRefusal(null)
    onChange(read.procedure, 'json')
  }

  return (
    <div className="flex h-full flex-col">
      <div className={`border-b px-3 py-1.5 text-[11px] ${refusal ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-[var(--bark-700)] text-slate-500'}`}>
        {refusal ? `Not applied yet: ${refusal}` : 'Edits here apply to the canvas as soon as they read as a procedure.'}
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          language="json"
          theme="vs-dark"
          value={text}
          onChange={(value) => edit(value ?? '')}
          options={{ minimap: { enabled: false }, fontSize: 12, tabSize: 2, scrollBeyondLastLine: false, automaticLayout: true }}
        />
      </div>
    </div>
  )
}
