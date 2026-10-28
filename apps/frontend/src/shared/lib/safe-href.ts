const OPENED = new Set(['http:', 'https:'])

export function safeHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    return OPENED.has(new URL(value, 'https://koala.invalid/').protocol) ? value : undefined
  } catch {
    return undefined
  }
}
