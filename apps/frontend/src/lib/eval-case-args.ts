import type { ArgCheck } from '../api/evals'

export function argLine(check: ArgCheck): string {
  if ('is' in check) return `${check.arg} is ${check.is}`
  if ('contains' in check) return `${check.arg} contains ${check.contains}`
  if ('matches' in check) return `${check.arg} matches ${check.matches}`
  return `${check.arg} is not empty`
}

export function parseArgLine(line: string): ArgCheck | string {
  const match = /^\s*(\S+)\s+(is not empty|is|contains|matches)\s*(.*)$/.exec(line)
  if (!match) return `"${line.trim()}" has to read like: source contains tidy`

  const arg = match[1]!
  const how = match[2]!
  const rest = (match[3] ?? '').trim()

  if (how === 'is not empty') return { arg, nonEmpty: true }
  if (!rest) return `"${line.trim()}" says ${how} but does not say what`
  if (how === 'is') return { arg, is: rest }
  if (how === 'contains') return { arg, contains: rest }
  return { arg, matches: rest }
}

export function parseArgLines(text: string): { checks: ArgCheck[]; problems: string[] } {
  const parsed = text.split('\n').map((line) => line.trim()).filter(Boolean).map(parseArgLine)
  return {
    checks: parsed.filter((check): check is ArgCheck => typeof check !== 'string'),
    problems: parsed.filter((check): check is string => typeof check === 'string'),
  }
}
