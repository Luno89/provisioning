/**
 * Artificial Analysis' Intelligence Index, matched onto the models a gateway offers.
 *
 * Their catalogue and a gateway's are two different namings of the same models, so matching is
 * fuzzy by construction: `anthropic/claude-opus-5-fast` on OpenRouter is `claude-opus-5-fast`
 * there. Everything below is pure so the guesswork is visible and testable rather than buried in
 * a fetch.
 */

/** The field names their v2 payload has used for the headline index, most specific first. */
const INDEX_FIELDS = [
  'artificial_analysis_intelligence_index',
  'artificialAnalysisIntelligenceIndex',
  'intelligence_index',
  'intelligenceIndex',
] as const;

export interface AaModel {
  id?: string;
  slug?: string;
  name?: string;
  evaluations?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

/**
 * The index off one of their records, wherever they put it this time.
 *
 * Checked on the record and on `evaluations`, because the payload has carried it in both. A
 * non-numeric or negative value is treated as absent rather than shown as a score.
 */
export function indexOf(model: AaModel): number | undefined {
  const wells: (Record<string, unknown> | undefined)[] = [model, model.evaluations];
  for (const well of wells) {
    if (!well) continue;
    for (const field of INDEX_FIELDS) {
      const raw = well[field];
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

/**
 * A model id reduced to what two catalogues are likely to agree on: no vendor prefix, no
 * punctuation, no case. `anthropic/Claude-Opus-5_fast` and `claude opus 5 fast` both become
 * `claudeopus5fast`.
 */
export function normalizeModelKey(id: string): string {
  const slash = id.indexOf('/');
  const bare = slash > 0 ? id.slice(slash + 1) : id;
  return bare.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Their catalogue keyed for lookup. A key already taken keeps the FIRST score seen — two of their
 * records normalising to one key means we cannot tell them apart, and overwriting would make the
 * result depend on their ordering.
 */
export function buildIntelligenceIndex(models: readonly AaModel[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const model of models) {
    const score = indexOf(model);
    if (score === undefined) continue;
    for (const naming of [model.slug, model.id, model.name]) {
      if (!naming) continue;
      const key = normalizeModelKey(naming);
      if (key && !index.has(key)) index.set(key, score);
    }
  }
  return index;
}

/** The score for a gateway's model id, or nothing when their catalogue has no match. */
export function intelligenceFor(
  gatewayModelId: string,
  index: ReadonlyMap<string, number>,
): number | undefined {
  return index.get(normalizeModelKey(gatewayModelId));
}
