import { describe, expect, it } from 'vitest';
import { cdktfStateEnv, freedLease, lockHolderGone, MIRRORED_PROVIDERS, stateFilesOf, stateHomeIn, stateLockName, stateLockOf, stateMove, terraformCliConfig, terraformStateFrom } from './terraform-state.js';

describe('the files a stack keeps its Terraform state in', () => {
  it('is the state and the backup Terraform writes beside it, named for the stack as the CDKTF app names them', () => {
    expect(stateFilesOf('machine-desk-observability')).toEqual(['terraform.machine-desk-observability.tfstate', 'terraform.machine-desk-observability.tfstate.backup']);
  });
});

describe('where Terraform keeps a process\'s state', () => {
  const pod = { KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443', POD_NAMESPACE: 'koala' };

  it('is the data folder where the settings say local, and nowhere guessed when they say nothing', () => {
    expect(() => terraformStateFrom({})).toThrow('TERRAFORM_STATE is not set');
    expect(terraformStateFrom({ TERRAFORM_STATE: 'local' })).toEqual({ kind: 'local' });
    expect(stateHomeIn(terraformStateFrom({ ...pod, TERRAFORM_STATE: 'local' }), '/data/terraform')).toEqual({ kind: 'local', dir: '/data/terraform' });
    expect(cdktfStateEnv({ kind: 'local', dir: '/data/terraform' })).toEqual({ CDKTF_STATE_DIR: '/data/terraform' });
  });

  it('is the instance\'s own namespace in its cluster when the chart says kubernetes, the data folder kept to find state from before', () => {
    const home = stateHomeIn(terraformStateFrom({ ...pod, TERRAFORM_STATE: 'kubernetes' }), '/data/terraform');
    expect(home).toEqual({ kind: 'kubernetes', namespace: 'koala', api: { host: '10.43.0.1', port: '443' }, dir: '/data/terraform' });
    expect(cdktfStateEnv(home)).toEqual({ CDKTF_STATE_NAMESPACE: 'koala', KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' });
  });

  it('refuses kubernetes outside a pod or without its namespace, and any other kind, rather than keep state somewhere else', () => {
    expect(() => terraformStateFrom({ TERRAFORM_STATE: 'kubernetes', KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toThrow('POD_NAMESPACE is not set');
    expect(() => terraformStateFrom({ TERRAFORM_STATE: 'kubernetes', POD_NAMESPACE: 'koala' })).toThrow('not running in a pod');
    expect(() => terraformStateFrom({ TERRAFORM_STATE: 'kubernetes', POD_NAMESPACE: 'koala', KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toThrow('not running in a pod');
    expect(() => terraformStateFrom({ TERRAFORM_STATE: 's3' })).toThrow('either local or in kubernetes');
  });
});

describe('the Terraform settings that install providers from the mirror', () => {
  it('takes the providers Koala pins from the mirror alone, read only, and anything else from its registry', () => {
    const config = terraformCliConfig('/app/bin/terraform-providers');
    const list = `[${MIRRORED_PROVIDERS.map((name) => `"${name}"`).join(', ')}]`;
    expect(config).toBe([
      'provider_installation {',
      '  filesystem_mirror {',
      '    path    = "/app/bin/terraform-providers"',
      `    include = ${list}`,
      '  }',
      '  direct {',
      `    exclude = ${list}`,
      '  }',
      '}',
      '',
    ].join('\n'));
  });
});

describe('moving a stack\'s state from the data folder into the cluster', () => {
  const state = (lineage: string, serial: number, resources: number) => JSON.stringify({ version: 4, lineage, serial, resources: Array.from({ length: resources }, (_, at) => ({ name: `r${at}` })) });

  it('pushes it when the cluster holds nothing yet, whether Terraform made an empty state there or none at all', () => {
    expect(stateMove('desk', state('a', 7, 2), '')).toEqual({ step: 'push' });
    expect(stateMove('desk', state('a', 7, 2), state('b', 1, 0))).toEqual({ step: 'push' });
  });

  it('only forgets the file when the cluster already has it or something later from it, or the file holds nothing', () => {
    expect(stateMove('desk', state('a', 7, 2), state('a', 7, 2))).toEqual({ step: 'forget' });
    expect(stateMove('desk', state('a', 7, 2), state('a', 9, 3))).toEqual({ step: 'forget' });
    expect(stateMove('desk', state('a', 7, 0), state('b', 3, 4))).toEqual({ step: 'forget' });
  });

  it('refuses when the two disagree, naming each by lineage and serial and nothing they hold', () => {
    const behind = stateMove('desk', state('a', 7, 2), state('a', 5, 2));
    const other = stateMove('desk', state('a', 7, 2), state('b', 9, 2));
    for (const move of [behind, other]) {
      expect(move.step).toBe('refuse');
      expect(move.step === 'refuse' && move.reason).toMatch(/^desk has a state in the data folder and another in the cluster/);
      expect(move.step === 'refuse' && move.reason).not.toContain('r0');
    }
  });

  it('says which state could not be read rather than guess', () => {
    expect(() => stateMove('desk', 'not json', '')).toThrow('the state desk kept in the data folder is not a Terraform state');
    expect(() => stateMove('desk', state('a', 1, 1), '<html>')).toThrow('the state of desk in the cluster is not a Terraform state');
  });
});

describe('the lock Terraform holds on a stack\'s state in the cluster', () => {
  const leaseHeldBy = (who: string | undefined, id = '1849cacd-fa21-18c6-1a11-6427be1cd2db') => ({
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: {
      name: 'lock-tfstate-default-platform-egress-state',
      namespace: 'nowrinkles',
      resourceVersion: '4711',
      labels: { tfstate: 'true' },
      annotations: { 'app.terraform.io/lock-info': JSON.stringify({ ID: id, Operation: 'OperationTypeApply', Who: who, Version: '1.9.0' }), kept: 'yes' },
    },
    spec: { holderIdentity: id },
  });

  it('is the lease Terraform names after the stack\'s state', () => {
    expect(stateLockName('platform-egress')).toBe('lock-tfstate-default-platform-egress-state');
  });

  it('reads who holds it, and reads a lease nobody holds as free', () => {
    expect(stateLockOf(leaseHeldBy('node@instance-worker-cluster-6b78b5fd69-7rb9s'))).toEqual({ id: '1849cacd-fa21-18c6-1a11-6427be1cd2db', who: 'node@instance-worker-cluster-6b78b5fd69-7rb9s', host: 'instance-worker-cluster-6b78b5fd69-7rb9s' });
    expect(stateLockOf({ ...leaseHeldBy('node@a'), spec: {} })).toBeUndefined();
    expect(stateLockOf(leaseHeldBy(undefined))).toEqual({ id: '1849cacd-fa21-18c6-1a11-6427be1cd2db', who: '' });
  });

  it('was left by a run that is gone when its pod is gone, or when it is this pod and this process applies nothing to that stack', () => {
    const lock = { id: 'l', who: 'node@worker-old', host: 'worker-old' };
    expect(lockHolderGone(lock, { here: 'worker-new', applyingHere: false, holderPodThere: false })).toBe(true);
    expect(lockHolderGone(lock, { here: 'worker-new', applyingHere: true, holderPodThere: false })).toBe(true);
    expect(lockHolderGone(lock, { here: 'worker-new', applyingHere: false, holderPodThere: true })).toBe(false);
    expect(lockHolderGone(lock, { here: 'worker-old', applyingHere: false, holderPodThere: true })).toBe(true);
    expect(lockHolderGone(lock, { here: 'worker-old', applyingHere: true, holderPodThere: true })).toBe(false);
    expect(lockHolderGone({ id: 'l', who: '' }, { here: 'worker-new', applyingHere: false, holderPodThere: false })).toBe(false);
  });

  it('is freed as Terraform frees it, the holder and its lock info gone and the rest kept, only while the lease is as it was read', () => {
    expect(freedLease(leaseHeldBy('node@worker-old'))).toEqual({
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: 'lock-tfstate-default-platform-egress-state', namespace: 'nowrinkles', resourceVersion: '4711', labels: { tfstate: 'true' }, annotations: { kept: 'yes' } },
      spec: {},
    });
  });
});
