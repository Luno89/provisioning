import { useEffect, useRef, useState } from 'react'
import Editor, { type Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { Procedure } from '@koala/agent-engine/procedure'
import {
  BUILDER_DECLARATIONS,
  BUILDER_MODULE,
  builderCodeToProcedure,
  placeUnplaced,
  procedureToBuilderCode,
  type BuilderProblem,
} from '@koala/agent-engine/procedure-builder'
import '../ProjectEditor/monaco-setup'
import { STUDIO_CONTEXT } from './shared'

const DECLARATIONS_PATH = `file:///node_modules/${BUILDER_MODULE}/index.d.ts`
const MARKER_OWNER = 'procedure-builder'

const options = { catalogue: STUDIO_CONTEXT.catalogue, groups: STUDIO_CONTEXT.shared }
const same = (a: Procedure, b: Procedure) => JSON.stringify(a) === JSON.stringify(b)

function read(code: string, current: Procedure): { procedure: Procedure } | { problems: BuilderProblem[] } {
  const parsed = builderCodeToProcedure(code, options)
  if (!parsed.ok) return { problems: parsed.problems }
  if (parsed.procedure.id !== current.id) {
    return { problems: [{ line: 1, column: 1, message: `the id stays "${current.id}" here — to make a procedure with another id, use Save as copy` }] }
  }
  return { procedure: placeUnplaced(parsed.procedure, parsed.unplaced, current) }
}

function prepare(monaco: Monaco) {
  const typescript = monaco.languages.typescript
  typescript.typescriptDefaults.setCompilerOptions({
    strict: true,
    noEmit: true,
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
  })
  const loaded = typescript.typescriptDefaults.getExtraLibs()
  if (loaded[DECLARATIONS_PATH]?.content !== BUILDER_DECLARATIONS) {
    typescript.typescriptDefaults.addExtraLib(BUILDER_DECLARATIONS, DECLARATIONS_PATH)
  }
}

export interface CodeViewProps {
  procedure: Procedure
  onChange: (next: Procedure, mergeKey?: string) => void
}

export default function CodeView({ procedure, onChange }: CodeViewProps) {
  const [text, setText] = useState(() => procedureToBuilderCode(procedure, options))
  const [problems, setProblems] = useState<BuilderProblem[]>([])
  const typed = useRef(text)
  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    const current = read(typed.current, procedure)
    if ('procedure' in current && same(current.procedure, procedure)) return
    typed.current = procedureToBuilderCode(procedure, options)
    setText(typed.current)
    setProblems([])
  }, [procedure])

  useEffect(() => {
    const monaco = monacoRef.current
    const model = editorRef.current?.getModel()
    if (!monaco || !model) return
    monaco.editor.setModelMarkers(model, MARKER_OWNER, problems.map((problem) => ({
      severity: monaco.MarkerSeverity.Error,
      message: problem.message,
      startLineNumber: problem.line,
      startColumn: problem.column,
      endLineNumber: problem.line,
      endColumn: problem.column + 1,
    })))
  }, [problems])

  const edit = (next: string) => {
    typed.current = next
    setText(next)
    const result = read(next, procedure)
    if ('problems' in result) {
      setProblems(result.problems)
      return
    }
    setProblems([])
    if (!same(result.procedure, procedure)) onChange(result.procedure, 'code')
  }

  return (
    <div className="flex h-full flex-col">
      <div className={`border-b px-3 py-1.5 text-[11px] ${problems.length ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-[var(--bark-700)] text-slate-500'}`}>
        {problems.length
          ? problems.map((problem) => `Not applied yet — line ${problem.line}, column ${problem.column}: ${problem.message}`).join(' · ')
          : 'The procedure as builder code. Edits apply to the canvas as soon as they read cleanly. The code is read, never run.'}
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          language="typescript"
          path="file:///procedure.ts"
          theme="vs-dark"
          value={text}
          beforeMount={prepare}
          onMount={(mounted, monaco) => {
            editorRef.current = mounted
            monacoRef.current = monaco
          }}
          onChange={(value) => edit(value ?? '')}
          options={{ minimap: { enabled: false }, fontSize: 12, tabSize: 2, scrollBeyondLastLine: false, automaticLayout: true }}
        />
      </div>
    </div>
  )
}
