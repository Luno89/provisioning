import { parser } from '@prometheus-io/lezer-promql';

export const CLUSTER_LABEL = 'koala_cluster';

const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function inCluster(query: string, cluster: string): string {
  const matcher = `${CLUSTER_LABEL}=${quoted(cluster)}`;
  const inserts: Array<{ at: number; text: string }> = [];
  parser.parse(query).iterate({
    enter: (node) => {
      if (node.type.isError) throw new Error(`not a query Koala asks: ${query}`);
      if (node.name !== 'VectorSelector') return;
      const matchers = node.node.getChild('LabelMatchers');
      if (!matchers) inserts.push({ at: node.to, text: `{${matcher}}` });
      else inserts.push({ at: matchers.from + 1, text: query.slice(matchers.from + 1, matchers.to - 1).trim() ? `${matcher},` : matcher });
    },
  });
  return inserts.sort((a, b) => b.at - a.at).reduce((scoped, insert) => `${scoped.slice(0, insert.at)}${insert.text}${scoped.slice(insert.at)}`, query);
}

export const OWN_SERIES = '';
