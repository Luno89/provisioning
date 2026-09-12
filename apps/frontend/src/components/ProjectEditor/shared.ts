export type { RepoFileEntry, RepoFileContent } from '../../api/project-files.js'

export const card = 'bg-[var(--bark-800)] border border-[var(--bark-600)] rounded-xl'

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown',
  html: 'html', css: 'css', scss: 'scss', less: 'less',
  py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sql: 'sql', graphql: 'graphql', xml: 'xml',
  dockerfile: 'dockerfile',
}

export function languageFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile'
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : ''
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext'
}

export interface OpenFile {
  path: string
  content: string
  savedContent: string
  sha: string
  error?: string | undefined
}

export function isDirty(f: Pick<OpenFile, 'content' | 'savedContent'>): boolean {
  return f.content !== f.savedContent
}
