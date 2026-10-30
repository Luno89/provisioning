const FLAGS = ['dev', 'devOptional', 'optional', 'peer', 'extraneous'];

function parentOf(location) {
  const nested = location.lastIndexOf('/node_modules/');
  if (nested >= 0) return location.slice(0, nested);
  if (location.startsWith('node_modules/')) return '';
  const up = location.lastIndexOf('/');
  return up >= 0 ? location.slice(0, up) : '';
}

export function resolveFrom(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return undefined;
    base = parentOf(base);
  }
}

function edgesOf(entry) {
  const optionalPeers = new Set(Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, meta]) => meta?.optional).map(([name]) => name));
  return [
    ...Object.keys(entry.dependencies ?? {}).map((name) => ({ name, optional: false })),
    ...Object.keys(entry.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
    ...Object.keys(entry.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name)).map((name) => ({ name, optional: false })),
  ];
}

const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function machineLock(repoLock, workspace, runtime, own) {
  const packages = repoLock.packages ?? {};
  const required = new Set();
  const reached = new Map();
  const versions = {};
  const queue = runtime.map((name) => ({ from: workspace, name, optional: false }));
  while (queue.length) {
    const { from, name, optional } = queue.shift();
    const location = resolveFrom(packages, from, name);
    if (!location) {
      if (optional) continue;
      throw new Error(`${name}, which ${from || 'the repository'} needs, is not in package-lock.json`);
    }
    const entry = packages[location];
    if (entry.link) throw new Error(`${name} is a workspace of this repository, not a package the machine agent can install`);
    if (from === workspace) versions[name] = entry.version;
    const firstTime = !reached.has(location);
    const nowRequired = !optional && !required.has(location);
    reached.set(location, entry);
    if (!optional) required.add(location);
    if (!firstTime && !nowRequired) continue;
    for (const edge of edgesOf(entry)) queue.push({ from: location, name: edge.name, optional: optional || edge.optional });
  }

  const prefix = `${workspace}/`;
  const placed = {};
  const from = {};
  for (const [location, entry] of reached) {
    const at = location.startsWith(prefix) ? location.slice(prefix.length) : location;
    if (!at.startsWith('node_modules/')) throw new Error(`${location} is outside any node_modules, so it cannot be laid out for the machine agent`);
    if (from[at]) throw new Error(`${from[at]} and ${location} would both be ${at} for the machine agent: package-lock.json gives the local-agent workspace its own copy of a package something outside it needs another version of`);
    from[at] = location;
    const kept = Object.fromEntries(Object.entries(entry).filter(([field]) => !FLAGS.includes(field)));
    placed[at] = required.has(location) ? kept : { ...kept, optional: true };
  }

  const dependencies = sorted(Object.fromEntries(runtime.map((name) => [name, versions[name]])));
  return {
    name: own.name,
    version: own.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: own.name, version: own.version, ...(own.engines ? { engines: own.engines } : {}), dependencies },
      ...sorted(placed),
    },
  };
}
