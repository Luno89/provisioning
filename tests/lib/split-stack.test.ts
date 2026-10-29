import { describe, expect, it } from 'vitest';
import { envArgs, ownedBySplit, splitNames, splitPlace } from './split-stack.js';

describe('a split stack of its own', () => {
  const names = splitNames('abc123');

  it('names its databases, containers and Temporal namespace after one stamp, so two runs never meet', () => {
    expect(names.namespace).toBe('split-abc123');
    expect(names.databases).toEqual({ root: 'koala_split_root_abc123', instance: 'koala_split_instance_abc123', hub: 'koala_split_hub_abc123' });
    expect(Object.values(names.containers).every((name) => name.startsWith('nw-split-') && name.endsWith('-abc123'))).toBe(true);
    expect(splitNames('other').databases.root).not.toBe(names.databases.root);
  });

  it('places each side on its own port and database, the instance on one of its own too', () => {
    const place = splitPlace(names, { root: 1, instance: 2, hub: 3, instanceGateway: 4, rootGateway: 5, hubGateway: 6, smtp: 7, mailApi: 8, metrics: 9 });
    expect(place).toEqual({
      rootUrl: 'http://localhost:1', instanceUrl: 'http://localhost:2', hubUrl: 'http://localhost:3',
      rootApiPort: 1, instanceApiPort: 2, hubApiPort: 3,
      rootDatabase: 'koala_split_root_abc123', hubDatabase: 'koala_split_hub_abc123', instanceDatabase: 'koala_split_instance_abc123',
    });
  });

  it('drops only the databases it made, never the dev stack\'s', () => {
    expect(ownedBySplit('koala_split_root_abc123')).toBe(true);
    expect(ownedBySplit('provisioning')).toBe(false);
    expect(ownedBySplit('koala_root')).toBe(false);
  });

  it('hands each value to docker as its own -e', () => {
    expect(envArgs({ ROLE: 'root', PORT: '1' })).toEqual(['-e', 'ROLE=root', '-e', 'PORT=1']);
  });
});
