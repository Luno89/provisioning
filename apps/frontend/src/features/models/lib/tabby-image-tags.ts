const TABBY_IMAGE_TAG_HINTS: Record<string, string> = {
  latest: 'CUDA 12.8',
  cu13: 'CUDA 13.x',
};

export interface TabbyImageTag {
  tag: string
  cached: boolean
  label: string
}

export function tabbyImageOptions(published: readonly string[], cached: readonly string[]): TabbyImageTag[] {
  const floating = Array.from(new Set([...published, ...cached])).map((tag) => ({
    tag,
    cached: cached.includes(tag),
    label: `${tag}${TABBY_IMAGE_TAG_HINTS[tag] ? ` — ${TABBY_IMAGE_TAG_HINTS[tag]}` : ''}, TabbyAPI's newest, not pinned`,
  }))
  return [{ tag: '', cached: false, label: `the build Koala pins — ${TABBY_IMAGE_TAG_HINTS.latest}` }, ...floating]
}
