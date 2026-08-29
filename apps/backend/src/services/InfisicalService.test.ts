import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InfisicalService } from './InfisicalService.js';

describe('InfisicalService', () => {
  const masterKey = 'test-jwt-secret-key-that-is-at-least-32-chars-long';
  const kubeconfigPath = '/tmp/test-kubeconfig.yaml';

  let mockKubectl: any;
  let service: InfisicalService;

  beforeEach(() => {
    mockKubectl = vi.fn().mockImplementation(async (args: string[]) => {
      if (args.includes('svc')) {
        return JSON.stringify({
          spec: {
            ports: [{ name: 'http', nodePort: 31738 }],
          },
        });
      }
      if (args.includes('nodes')) {
        return '192.168.1.100';
      }
      if (args.includes('deployment')) {
        return JSON.stringify({
          spec: {
            template: {
              spec: {
                containers: [{ name: 'web-app', envFrom: [] }],
              },
            },
          },
        });
      }
      return 'ok';
    });

    service = new InfisicalService(
      { runKubectl: mockKubectl },
      masterKey,
      kubeconfigPath,
    );
  });

  it('resolves base URL via kubectl NodePort and node IP', async () => {
    const url = await service.resolveBaseUrl();
    expect(url).toContain('31738');
  });

  it('stores and retrieves secrets with encryption at rest', async () => {
    const setRes = await service.setSecret(
      'proj-123',
      'GITHUB_TOKEN',
      'ghp_super_secret_personal_access_token',
      'GitHub token for cloning private repo',
    );

    expect(setRes.success).toBe(true);
    expect(setRes.secretReference).toBe('secret://proj-123/GITHUB_TOKEN');

    const retrieved = await service.getSecret('proj-123', 'GITHUB_TOKEN');
    expect(retrieved).toBe('ghp_super_secret_personal_access_token');
  });

  it('lists secrets with masked previews rather than raw plaintext', async () => {
    await service.setSecret('proj-abc', 'STRIPE_KEY', 'sk_live_1234567890abcdef');
    await service.setSecret('proj-abc', 'API_TOKEN', 'token-abcdef-123456');

    const list = await service.listSecrets('proj-abc');
    expect(list.length).toBe(2);

    const stripe = list.find((s) => s.key === 'STRIPE_KEY');
    expect(stripe).toBeDefined();
    expect(stripe?.maskedValue).not.toBe('sk_live_1234567890abcdef');
    expect(stripe?.maskedValue).toContain('****');
    expect(stripe?.secretReference).toBe('secret://proj-abc/STRIPE_KEY');
  });

  it('deletes secrets from vault', async () => {
    await service.setSecret('proj-del', 'TEMP_KEY', 'val123');
    expect(await service.getSecret('proj-del', 'TEMP_KEY')).toBe('val123');

    await service.deleteSecret('proj-del', 'TEMP_KEY');
    expect(await service.getSecret('proj-del', 'TEMP_KEY')).toBeNull();
  });

  it('injects secret into pod and triggers rolling restart', async () => {
    const res = await service.injectSecretToPod({
      projectId: 'proj-bot',
      key: 'WEBHOOK_SECRET',
      value: 'whsec_99999999',
      mountAs: 'env',
      restart: true,
    });

    expect(res.success).toBe(true);
    expect(res.podRestarted).toBe(true);
    expect(res.secretReference).toBe('secret://proj-bot/WEBHOOK_SECRET');

    expect(mockKubectl).toHaveBeenCalledWith(
      expect.arrayContaining(['rollout', 'restart', 'deployment/proj-bot', '-n', 'proj-bot']),
      kubeconfigPath,
    );
  });

  it('generates valid InfisicalSecret CRD manifest', () => {
    const manifest = service.generateInfisicalSecretManifest({
      name: 'analytics-sync',
      namespace: 'analytics',
      projectId: 'proj-analytics',
    });

    expect(manifest).toContain('apiVersion: secrets.infisical.com/v1alpha1');
    expect(manifest).toContain('kind: InfisicalSecret');
    expect(manifest).toContain('name: analytics-sync');
    expect(manifest).toContain('namespace: analytics');
  });
});
