import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUNTIME } from '../apps/local-agent/scripts/machine-runtime.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const purlName = (name) => (name.startsWith('@') ? `%40${name.slice(1)}` : name);

const nameAt = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);

const property = (name, value) => ({ name, value: String(value) });

const hashesOf = (component) => [
  ...(component.sha256 ? [{ alg: 'SHA-256', content: component.sha256 }] : []),
  ...(component.sha512 ? [{ alg: 'SHA-512', content: component.sha512 }] : []),
  ...Object.values(component.sha256s ?? {}).map((content) => ({ alg: 'SHA-256', content })),
];

function npmComponent(name, version, group, dev) {
  const purl = `pkg:npm/${purlName(name)}@${version}`;
  return {
    type: 'library',
    'bom-ref': `${group}:${purl}`,
    name,
    version,
    purl,
    scope: dev ? 'excluded' : 'required',
    properties: [property('koala:in', group), property('koala:kind', 'npm'), ...(dev ? [property('koala:dev', true)] : [])],
  };
}

export function npmComponents(lock, group) {
  const seen = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.includes('node_modules/') || entry.link || !entry.version) continue;
    const name = nameAt(path);
    const key = `${name}@${entry.version}`;
    const dev = Boolean(entry.dev);
    const known = seen.get(key);
    if (!known || (known.dev && !dev)) seen.set(key, { name, version: entry.version, dev });
  }
  return [...seen.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)).map((found) => npmComponent(found.name, found.version, group, found.dev));
}

function resolveFrom(packages, from, name) {
  const segments = from ? from.split('/') : [];
  for (let length = segments.length; length >= 0; length -= 1) {
    if (length > 0 && segments[length - 1] === 'node_modules') continue;
    const dir = segments.slice(0, length).join('/');
    const candidate = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
  }
  return undefined;
}

export function closureOf(lock, roots, from = '') {
  const packages = lock.packages ?? {};
  const kept = {};
  const queue = roots.map((name) => resolveFrom(packages, from, name)).filter(Boolean);
  while (queue.length > 0) {
    const path = queue.shift();
    if (kept[path]) continue;
    const entry = packages[path];
    kept[path] = { version: entry.version };
    for (const name of Object.keys({ ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) })) {
      const found = resolveFrom(packages, path, name);
      if (found && !kept[found]) queue.push(found);
    }
  }
  return { packages: kept };
}

function pinPurl(component) {
  if (component.kind === 'npm') return `pkg:npm/${purlName(component.name)}@${component.version}`;
  if (component.kind === 'action') return `pkg:github/${component.name}@${component.version}`;
  if (component.kind === 'go') return `pkg:golang/${component.name}@${component.version}`;
  if (component.kind === 'image') {
    const [namespace, name] = component.name.includes('/') ? component.name.split('/') : ['library', component.name];
    return `pkg:docker/${namespace}/${name}@${component.version}`;
  }
  return `pkg:generic/${component.name}@${component.version}`;
}

export function pinComponents(pins) {
  const pinned = pins.components.map((component) => {
    const purl = pinPurl(component);
    return {
      type: component.kind === 'image' ? 'container' : component.kind === 'binary' ? 'application' : 'library',
      'bom-ref': `${component.kind}:${purl}${component.where ? `#${component.where}` : ''}`,
      name: component.name,
      version: component.version,
      purl,
      ...(hashesOf(component).length ? { hashes: hashesOf(component) } : {}),
      properties: [
        property('koala:kind', component.kind),
        property('koala:source', component.source),
        ...(component.where ? [property('koala:where', component.where)] : []),
        ...(component.github ? [property('koala:github', component.github)] : []),
        ...(component.osv ? [property('koala:osv-ecosystem', component.osv.ecosystem), property('koala:osv-name', component.osv.name)] : []),
        ...(component.commit ? [property('koala:commit', component.commit)] : []),
        ...(component.floating ? [property('koala:floating', true)] : []),
      ],
    };
  });
  const unpinned = (pins.unpinned ?? []).map((entry) => ({
    type: 'application',
    'bom-ref': `unpinned:${entry.name}`,
    name: entry.name,
    properties: [property('koala:kind', 'unpinned'), property('koala:how', entry.how), property('koala:used-in', entry.usedIn.join(' '))],
  }));
  return [...pinned, ...unpinned];
}

export function inventory({ lock, machineLock, pins, release, now = new Date(), serial = randomUUID() }) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      component: { type: 'application', 'bom-ref': 'koala', name: 'koala', version: release },
      properties: [property('koala:machine-agent', machineLock ? 'from its own lockfile' : 'as the repository resolves its packages')],
    },
    components: [
      ...npmComponents(lock, 'koala'),
      ...npmComponents(machineLock ?? closureOf(lock, RUNTIME, 'apps/local-agent'), 'machine-agent'),
      ...pinComponents(pins),
    ],
  };
}

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const machineLockFile = option('--machine-lock');
  const bom = inventory({
    lock: readJson(`${REPO}/package-lock.json`),
    machineLock: machineLockFile ? readJson(machineLockFile) : undefined,
    pins: readJson(`${REPO}/dependencies.pins.json`),
    release: option('--release') ?? 'unreleased',
  });
  const text = `${JSON.stringify(bom, null, 2)}\n`;
  const out = option('--out');
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
