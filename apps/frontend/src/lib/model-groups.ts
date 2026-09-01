import type { ModelProvider } from '../api/models'

export interface ModelVendorGroup {
  key: string
  label: string
  models: ModelProvider[]
  /** True for the collected free group, which sorts ahead of the real vendors. */
  free?: boolean
}

export interface ModelGroup {
  key: string
  label: string
  /** Every model under this source, vendored or not — what the header counts. */
  models: ModelProvider[]
  /** Vendor sub-groups, alphabetical. Empty when nothing here carries a `vendor/model` id. */
  vendors: ModelVendorGroup[]
  /** Models under this source with no vendor prefix, listed after the vendors. */
  ungrouped: ModelProvider[]
  /** Runs on hardware you control. */
  local: boolean
  /** Something in the account points at one of these: the default, or the current choice. */
  inUse: boolean
}

export interface GroupRanking {
  /** The account default, so the engine everything already falls back to sorts up. */
  defaultModelId?: string | null | undefined
  /** What this conversation is pinned to, for the same reason. */
  selectedModelId?: string | null | undefined
}

/**
 * Where a model came from, as the backend labelled it.
 *
 * `sourceLabel` is written with the row — from the gateway preset for a registered key, from the
 * app spec for a deployment — so these headings are whatever the account actually holds. Nothing
 * here names a provider; the fallback only covers rows written before the field existed.
 */
export const sourceOf = (m: ModelProvider): string =>
  m.sourceLabel ?? (m.source === 'deployment' ? (m.kind === 'tabbyapi' ? 'TabbyAPI' : 'vLLM') : 'Custom')

/**
 * The vendor half of a `vendor/model` id.
 *
 * A deployment has none: there are only ever a handful and the box they run on is the useful
 * distinction, not whoever published the weights.
 */
export function vendorOf(m: ModelProvider): string | undefined {
  if (m.source === 'deployment') return undefined
  const slash = m.model.indexOf('/')
  return slash > 0 ? m.model.slice(0, slash) : undefined
}

/**
 * Runs on hardware the user controls: a deployment on one of their clusters, or an endpoint on a
 * machine that joined their mesh.
 *
 * Derived from the record, never from a provider name — a gateway this code has never heard of
 * must still sort correctly, and naming providers in the UI is how an ordering goes stale.
 */
export const isLocal = (m: ModelProvider): boolean =>
  m.source === 'deployment' || m.isMesh === true

/**
 * Costs nothing to call.
 *
 * Decided on the quoted price, never on the `:free` suffix some ids carry: against the live
 * OpenRouter catalogue 21 models price at zero while only 18 are named that way, so matching the
 * name would quietly miss three and could mark a paid model free if one were ever named so.
 * Pricing the gateway did not quote is unknown, not free.
 */
export const isFree = (m: ModelProvider): boolean =>
  m.pricing !== undefined && m.pricing.promptPerMTok === 0 && m.pricing.completionPerMTok === 0

/** `$10/$50` per million tokens in/out, `free`, or nothing when the gateway quoted no price. */
export function formatPrice(m: ModelProvider): string | undefined {
  if (!m.pricing) return undefined
  if (isFree(m)) return 'free'
  const money = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`)
  return `${money(m.pricing.promptPerMTok)}/${money(m.pricing.completionPerMTok)}`
}

export const FREE_GROUP_LABEL = 'Free'

/**
 * The Intelligence Index as a badge. Absent for anything their catalogue did not match, which is a
 * real gap on the long tail of a gateway's list rather than a zero.
 */
export function formatIntelligence(m: ModelProvider): string | undefined {
  if (m.intelligence === undefined) return undefined
  return Number.isInteger(m.intelligence) ? String(m.intelligence) : m.intelligence.toFixed(1)
}

/** `128k`, `1M`, `2M`. Millions matter now that the 200k clamp on stored windows is gone. */
export function formatContext(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  const millions = tokens / 1_000_000
  return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
}

export interface TieredModels {
  /** Runs on hardware you control. */
  local: ModelGroup[]
  /** A gateway you have set up, with rows to show. */
  provisioned: ModelGroup[]
}

/**
 * The two tiers that have models. What is NOT set up has no model rows at all and comes from the
 * gateway presets instead — see `listLlmProviders`.
 */
export function tierModels(
  models: readonly ModelProvider[],
  ranking: GroupRanking = {},
): TieredModels {
  const groups = groupModels(models, ranking)
  return {
    local: groups.filter((g) => g.local),
    provisioned: groups.filter((g) => !g.local),
  }
}

/**
 * Sources, most relevant first: what you control, then what you already use, then the rest
 * alphabetically. Each source holds its vendors.
 *
 * Registering one gateway key writes a row per model — hundreds of them — and none of that should
 * bury the one box you actually stood up. Collapsed, a gateway is a single line whatever its size;
 * opened, it is its vendors rather than a flat wall.
 */
export function groupModels(
  models: readonly ModelProvider[],
  ranking: GroupRanking = {},
): ModelGroup[] {
  const pinned = new Set(
    [ranking.defaultModelId, ranking.selectedModelId].filter((id): id is string => !!id),
  )
  const byLabel = new Map<string, ModelGroup>()
  const vendorsBySource = new Map<string, Map<string, ModelProvider[]>>()

  for (const m of models) {
    const label = sourceOf(m)
    if (!byLabel.has(label)) {
      byLabel.set(label, {
        key: label, label, models: [], vendors: [], ungrouped: [], local: false, inUse: false,
      })
      vendorsBySource.set(label, new Map())
    }
    const group = byLabel.get(label)!
    group.models.push(m)
    if (isLocal(m)) group.local = true
    if (pinned.has(m.id)) group.inUse = true

    const vendor = vendorOf(m)
    if (vendor === undefined) {
      group.ungrouped.push(m)
    } else {
      const vendors = vendorsBySource.get(label)!
      if (!vendors.has(vendor)) vendors.set(vendor, [])
      vendors.get(vendor)!.push(m)
    }
  }

  for (const [label, group] of byLabel) {
    const freeModels = group.models.filter(isFree)
    const vendors = [...vendorsBySource.get(label)!.entries()]
      .map(([vendor, vendorModels]) => ({
        key: `${label}/${vendor}`,
        label: vendor,
        models: vendorModels.filter((m) => !isFree(m)),
      }))
      .filter((v) => v.models.length > 0)
      .sort((a, b) => a.label.localeCompare(b.label))

    // Free first: it is the group most worth finding, and it cuts across every vendor.
    group.vendors = freeModels.length > 0
      ? [{ key: `${label}/__free`, label: FREE_GROUP_LABEL, models: freeModels, free: true }, ...vendors]
      : vendors
    group.ungrouped = group.ungrouped.filter((m) => !isFree(m))
  }

  const tier = (g: ModelGroup): number => (g.local ? 0 : g.inUse ? 1 : 2)

  return [...byLabel.values()].sort(
    (a, b) => tier(a) - tier(b) || a.label.localeCompare(b.label),
  )
}

/** Inside a vendor the vendor is the heading, so drop it; elsewhere the whole id is the label. */
export function modelRowLabel(m: ModelProvider, underVendor = false): string {
  const vendor = underVendor ? vendorOf(m) : undefined
  if (vendor && m.model.startsWith(`${vendor}/`)) return m.model.slice(vendor.length + 1)
  return m.model || m.name
}
