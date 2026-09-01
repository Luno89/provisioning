import type { ModelProvider } from '../api/models'

/**
 * How one model reads in a picker: `[OpenRouter] anthropic/claude-opus-4`.
 *
 * The backend supplies `sourceLabel`; the fallback covers rows written before it existed. This was
 * copied out in two components, which is how the two dropdowns came to disagree about deployments.
 */
export function modelOptionLabel(m: ModelProvider): string {
  const source = m.sourceLabel
    ?? (m.source === 'deployment' ? (m.kind === 'tabbyapi' ? 'TabbyAPI' : 'vLLM') : 'Custom')
  return `[${source}] ${m.model || m.name}`
}
