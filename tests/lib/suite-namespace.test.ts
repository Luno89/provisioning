import { describe, expect, it } from 'vitest';
import { suiteNamespaceSettings } from './suite-namespace.js';

describe('the settings a suite readies its own Temporal namespace with', () => {
  it('are the dev settings, pointed at the suite\'s namespace on the dev Temporal through its certificate authority', () => {
    const dev = 'TEMPORAL_NAMESPACE=default\nTEMPORAL_CONNECTION_ADDRESS=elsewhere:7233\nTEMPORAL_TLS_CA=/somewhere/else.crt\nKEPT=yes\n';
    expect(suiteNamespaceSettings(dev, 'split-abc', '/dev/ca.crt')).toEqual({
      KEPT: 'yes',
      TEMPORAL_NAMESPACE: 'split-abc',
      TEMPORAL_CONNECTION_ADDRESS: '127.0.0.1:7233',
      TEMPORAL_TLS_CA: '/dev/ca.crt',
    });
  });
});
