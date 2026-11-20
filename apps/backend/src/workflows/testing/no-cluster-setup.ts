import type { ClusterSetup } from '../../worker-cluster.js';

export const NO_SETUP: ClusterSetup = { place: { koalaNamespace: 'koala', pool: false, dataDir: '/nowhere', crawl4aiToken: 'unused' }, lines: { heard: async () => { throw new Error('this test sets no Koala up') } }, provisioner: { ensure: async () => { throw new Error('this test sets no Koala up') }, settled: async () => { throw new Error('this test sets no Koala up') } } };
