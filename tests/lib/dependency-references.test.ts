import { describe, expect, it } from 'vitest';
import { referencesIn, unrecorded } from './dependency-references.js';

const refs = (file: string, text: string) => referencesIn(file, text).map((reference) => reference.ref);

describe('the images and chart repositories a file names', () => {
  it('finds images by tag or digest, the ones an app builds from its defaults, and chart repositories', () => {
    expect(refs('a.ts', "const image = 'busybox:1.37';")).toEqual(['busybox:1.37']);
    expect(refs('a.yaml', 'image: docker.io/ubuntu/squid@sha256:' + 'a'.repeat(64))).toEqual([`docker.io/ubuntu/squid@sha256:${'a'.repeat(64)}`]);
    expect(refs('a.ts', 'const web = `${config.webRepo || "jellyfin/jellyfin"}:${config.webTag || "latest"}`;')).toEqual(['jellyfin/jellyfin:latest']);
    expect(refs('a.ts', "native: { webRepo: 'library/odoo', webTag: 'latest', dbRepo: 'library/postgres', dbTag: 'latest' },")).toEqual(['library/odoo:latest', 'library/postgres:latest']);
    expect(refs('a.ts', 'repository: "https://open-telemetry.github.io/opentelemetry-helm-charts",')).toEqual(['https://open-telemetry.github.io/opentelemetry-helm-charts']);
    expect(refs('a.sh', '"$HELM" repo add gitea-charts https://dl.gitea.com/charts/ >/dev/null')).toEqual(['https://dl.gitea.com/charts/']);
  });

  it('leaves out addresses, ports, styles, comments, Koala\'s own images, Node\'s modules and the files tests and checks hold', () => {
    expect(refs('a.ts', "const at = '127.0.0.1:7233'; const svc = 'temporal:7233'; const k = 'kube-prometheus-stack-prometheus:9090';")).toEqual([]);
    expect(refs('a.ts', "res.send('<body style=\"margin:0;padding:2rem\">')")).toEqual([]);
    expect(refs('a.ts', ' * a record that says `mongo:7` and a port number.')).toEqual([]);
    expect(refs('a.yml', 'image: nowrinkles/mail:1')).toEqual([]);
    expect(refs('a.ts', "import { readFile } from 'node:fs/promises';")).toEqual([]);
    expect(refs('a.ts', "native: { webRepo: 'text', webTag: 'text', dbRepo: 'text', dbTag: 'text' },")).toEqual([]);
    expect(refs('apps/backend/src/x.test.ts', "image: 'busybox:1.37'")).toEqual([]);
    expect(refs('apps/backend/src/eval/level2/mechanics.ts', "contain: 'FROM odoo:20'")).toEqual([]);
  });
});

describe('which of them the pins file does not account for', () => {
  const file = 'a.ts';
  const text = 'new Release(this, "x", {\n  repository: "https://charts.example.com",\n  chart: "widgets",\n});\nconst image = \'tool:1.0\';\nconst other = \'thing:latest\';\n';
  const found = referencesIn(file, text);

  it('counts one recorded by a use whose value sits on its line, a pattern spanning lines included, or listed unpinned for that file', () => {
    expect(unrecorded(found, [{ file, pattern: 'repository: "([^"]+)",\\s+chart: "widgets"' }, { file, pattern: "image = 'tool:([0-9.]+)'" }], [{ name: 'thing', usedIn: [file] }], () => text)).toEqual([]);
  });

  it('names each one that no use records, nor an unpinned entry for its own file', () => {
    expect(unrecorded(found, [{ file, pattern: "image = 'tool:([0-9.]+)'" }], [{ name: 'thing', usedIn: ['b.ts'] }], () => text).map((reference) => reference.ref))
      .toEqual(['https://charts.example.com', 'thing:latest']);
  });
});
