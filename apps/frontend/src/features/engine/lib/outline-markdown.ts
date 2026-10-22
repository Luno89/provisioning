const ID_IN_BRACKETS = / ?\(([A-Za-z0-9][\w.-]*)\)/g
const LIST_LINE = /^(\s*)- (.*)$/
const LABEL_ONLY = /^([A-Z][^:"]{0,48}):$/
const LABELLED = /^([A-Z][^:"]{0,48}): (.*)$/

const dropIds = (line: string): string =>
  line.replace(ID_IN_BRACKETS, (whole, id: string) => (/[-\d]/.test(id) ? '' : whole))

export function outlineMarkdown(text: string): string {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const listed = LIST_LINE.exec(line)
    if (listed) {
      out.push(`${listed[1]}- ${dropIds(listed[2] ?? '')}`)
      continue
    }
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
    if (line === '') continue
    const alone = LABEL_ONLY.exec(line)
    const labelled = LABELLED.exec(line)
    out.push(alone ? `**${alone[1]}**` : labelled ? `**${labelled[1]}:** ${dropIds(labelled[2] ?? '')}` : dropIds(line))
    out.push('')
  }
  while (out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

export const ID_INPUTS = new Set(['treeId', 'leafId', 'branchId', 'projectId'])

export const INPUT_TITLES: Record<string, string> = { chat: 'This chat', story: 'Story', feature: 'Feature', tree: 'Tree', project: 'Project' }

export const subjectOf = (given: Readonly<Record<string, string>>): string =>
  ['story', 'feature', 'tree', 'project'].find((name) => given[name]) ?? 'conversation'
