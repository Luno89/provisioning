// ── DUPLICATED, KNOWINGLY ── apps/backend/src/infrastructure/lib/chart-sources.ts wins; cdktf imports no app, and the backend's chart-sources test holds the two to the same answers.
export const chartRepository = (pinned: string, sources: string | undefined = process.env.CHART_SOURCES): string =>
  sources === undefined || sources === "" ? pinned : `${sources.replace(/\/+$/, "")}/${pinned.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
