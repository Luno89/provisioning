type AttributeValue = string | number | boolean;

export interface TraceSpan {
  service: string;
  name: string;
  spanId: string;
  parentSpanId?: string | undefined;
  failed: boolean;
  attributes: Record<string, AttributeValue>;
  events: { name: string; attributes: Record<string, AttributeValue> }[];
}

export interface CodeSite { function: string | undefined; filepath: string; lineno: number | undefined }

export interface Failure { path: TraceSpan[]; sites: CodeSite[] }

interface OtlpValue { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
interface OtlpAttribute { key: string; value: OtlpValue }
interface OtlpSpan { spanId: string; parentSpanId?: string; name: string; attributes?: OtlpAttribute[]; events?: { name: string; attributes?: OtlpAttribute[] }[]; status?: { code?: string | number } }
interface OtlpTrace { batches?: { resource: { attributes: OtlpAttribute[] }; scopeSpans?: { spans: OtlpSpan[] }[] }[] }

const hexId = (id: string | undefined): string | undefined => {
  if (!id) return undefined;
  if (/^[0-9a-f]{16}$|^[0-9a-f]{32}$/.test(id)) return id;
  return Buffer.from(id, 'base64').toString('hex');
};

const valueOf = (value: OtlpValue): AttributeValue =>
  value.stringValue ?? (value.intValue !== undefined ? Number(value.intValue) : undefined) ?? value.doubleValue ?? value.boolValue ?? '';

const attributesOf = (list: OtlpAttribute[] | undefined): Record<string, AttributeValue> =>
  Object.fromEntries((list ?? []).map((attr) => [attr.key, valueOf(attr.value)]));

export function spansOf(trace: OtlpTrace): TraceSpan[] {
  return (trace.batches ?? []).flatMap((batch) => {
    const service = String(attributesOf(batch.resource.attributes)['service.name'] ?? 'unknown');
    return (batch.scopeSpans ?? []).flatMap((scope) => scope.spans.map((span): TraceSpan => {
      const attributes = attributesOf(span.attributes);
      const status = Number(attributes['http.response.status_code'] ?? 0);
      return {
        service,
        name: span.name,
        spanId: hexId(span.spanId)!,
        parentSpanId: hexId(span.parentSpanId),
        failed: span.status?.code === 'STATUS_CODE_ERROR' || span.status?.code === 2 || status >= 400 || attributes['error.type'] !== undefined,
        attributes,
        events: (span.events ?? []).map((event) => ({ name: event.name, attributes: attributesOf(event.attributes) })),
      };
    }));
  });
}

const siteOf = (attributes: Record<string, AttributeValue>): CodeSite | undefined =>
  typeof attributes['code.filepath'] === 'string'
    ? { function: typeof attributes['code.function'] === 'string' ? attributes['code.function'] : undefined, filepath: attributes['code.filepath'], lineno: typeof attributes['code.lineno'] === 'number' ? attributes['code.lineno'] : undefined }
    : undefined;

export function failuresUnder(spans: readonly TraceSpan[], rootSpanId: string): Failure[] {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) if (span.parentSpanId) children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
  const root = byId.get(rootSpanId);
  if (!root) return [];
  const found: Failure[] = [];
  const walk = (span: TraceSpan, path: TraceSpan[]): boolean => {
    const below = children.get(span.spanId) ?? [];
    let deeper = false;
    for (const child of below) deeper = walk(child, [...path, child]) || deeper;
    if (span.failed && !deeper && span !== root) {
      const sites = [siteOf(span.attributes), ...span.events.filter((event) => event.name === 'koala.refused').map((event) => siteOf(event.attributes))].filter((site): site is CodeSite => site !== undefined);
      found.push({ path, sites });
    }
    return deeper || (span.failed && span !== root);
  };
  walk(root, [root]);
  return found;
}

const at = (site: CodeSite | undefined): string =>
  site ? `${site.function ? `${site.function} (` : ''}${site.filepath}${site.lineno ? `:${site.lineno}` : ''}${site.function ? ')' : ''}` : '';

export function whereLines(failures: readonly Failure[]): string[] {
  return failures.flatMap((failure) => failure.path.flatMap((span, depth) => {
    const status = span.attributes['http.response.status_code'];
    const threw = span.attributes['error.type'];
    const site = siteOf(span.attributes);
    const head = `${depth === 0 ? '' : `${'    '.repeat(depth - 1)}  └ `}${span.service}: ${span.name}`
      + (span.failed && depth > 0 ? `${status ? ` answered ${status}` : ' failed'}${threw ? `, threw ${threw}${site ? ` at ${at(site)}` : ''}` : ''}` : '');
    const refusals = depth === failure.path.length - 1
      ? span.events.filter((event) => event.name === 'koala.refused').map((event) =>
        `${'    '.repeat(depth)}  refused ${event.attributes['koala.action']} on a ${event.attributes['koala.resource']}${event.attributes['koala.claims'] ? ` (claims: ${event.attributes['koala.claims']})` : ''}${siteOf(event.attributes) ? ` at ${at(siteOf(event.attributes))}` : ''}`)
      : [];
    return [head, ...refusals];
  }));
}

export interface FlowSnapshot { flows: Record<string, { title?: string; files: { files: { file: string }[] } }> }

export const flowsThrough = (snapshot: FlowSnapshot, filepath: string): string[] =>
  Object.entries(snapshot.flows).filter(([, flow]) => flow.files.files.some((entry) => entry.file === filepath)).map(([name]) => name);

export const callerLines = (refsOutput: string): string[] =>
  refsOutput.split('\n')
    .filter((line) => /^\S+:\d+:\d+\s+read\s/.test(line) && !/\.test\.ts:|\/testing\/|^tests\//.test(line))
    .map((line) => line.replace(/\s+read\s+/, '  ').trim());
