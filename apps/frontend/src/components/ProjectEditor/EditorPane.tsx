import Editor from '@monaco-editor/react'
import { languageFromPath, type OpenFile } from './shared.js'
import './monaco-setup.js'

export function EditorPane({ file, onChange }: {
  file: OpenFile
  onChange: (path: string, content: string) => void
}) {
  return (
    <Editor
      key={file.path}
      path={file.path}
      language={languageFromPath(file.path)}
      value={file.content}
      theme="vs-dark"
      onChange={(value) => onChange(file.path, value ?? '')}
      options={{ minimap: { enabled: true }, fontSize: 13, automaticLayout: true, tabSize: 2 }}
    />
  )
}

export default EditorPane
