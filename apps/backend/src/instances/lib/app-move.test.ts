import { describe, expect, it } from 'vitest';
import { cleaned, copied, isMovedNamespace, restoreOrder, rewriteImage, volumeOfPart, volumePart, volumesOf, REPLICAS_ANNOTATION, type KubeObject } from './app-move.js';

const FROM = '127.0.0.1:35002';
const TO = '100.64.0.20:31737';

describe('copying an app\'s namespace to the new machine', () => {
  it('copies the namespaces apps live in, never the platform\'s own', () => {
    expect(['books', 'odoo-shop-1a2b', 'tree-abc'].every(isMovedNamespace)).toBe(true);
    expect(['kube-system', 'gitea', 'infisical', 'nowrinkles', 'monitoring', 'traefik', 'default', 'vcluster-x'].some(isMovedNamespace)).toBe(false);
  });

  it('names each volume as a part of its own, and reads one back only when it is one', () => {
    expect(volumePart('books', 'data-config')).toBe('volume:books:data-config');
    expect(volumeOfPart('volume:books:data-config')).toEqual({ namespace: 'books', claim: 'data-config' });
    expect(volumeOfPart('volume:books:../../etc')).toBeUndefined();
    expect(volumeOfPart('volume:Books:x')).toBeUndefined();
    expect(volumeOfPart('volume:books:x:y')).toBeUndefined();
  });

  it('leaves out what the new cluster makes for itself', () => {
    expect(copied({ kind: 'Secret', type: 'kubernetes.io/service-account-token', metadata: { name: 't' } })).toBe(false);
    expect(copied({ kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt' } })).toBe(false);
    expect(copied({ kind: 'ServiceAccount', metadata: { name: 'default' } })).toBe(false);
    expect(copied({ kind: 'Service', metadata: { name: 'made', ownerReferences: [{ kind: 'Thing' }] } })).toBe(false);
    expect(copied({ kind: 'Secret', type: 'helm.sh/release.v1', metadata: { name: 'sh.helm.release.v1.books.v1' } })).toBe(true);
  });

  it('keeps only the pull secrets of a namespace\'s default service account, so its pods pull from the new registry with a login', () => {
    const account: KubeObject = {
      apiVersion: 'v1', kind: 'ServiceAccount',
      metadata: { name: 'default', namespace: 'books', uid: 'u', resourceVersion: '3' },
      secrets: [{ name: 'default-token-abc' }],
      imagePullSecrets: [{ name: 'koala-registry-pull' }],
    };
    expect(copied(account)).toBe(true);
    expect(cleaned(account, FROM, TO)).toEqual({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: 'books' }, imagePullSecrets: [{ name: 'koala-registry-pull' }] });
    expect(copied({ kind: 'ServiceAccount', metadata: { name: 'default' }, imagePullSecrets: [] })).toBe(false);
  });

  it('starts each workload with the copies it had, from the old registry\'s images on the new one\'s', () => {
    const deployment: KubeObject = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'web', namespace: 'books', uid: 'u', resourceVersion: '9', annotations: { [REPLICAS_ANNOTATION]: '2', 'deployment.kubernetes.io/revision': '4' } },
      spec: { replicas: 0, template: { spec: { containers: [{ image: `${FROM}/bo/books:abc` }, { image: 'nginx:1.27' }], initContainers: [{ image: `${FROM}/bo/init:1` }] } } },
      status: { readyReplicas: 0 },
    };
    const moved = cleaned(deployment, FROM, TO) as any;
    expect(moved.spec.replicas).toBe(2);
    expect(moved.metadata).toEqual({ name: 'web', namespace: 'books', annotations: {} });
    expect(moved.status).toBeUndefined();
    expect(moved.spec.template.spec.containers.map((c: { image: string }) => c.image)).toEqual([`${TO}/bo/books:abc`, 'nginx:1.27']);
    expect(moved.spec.template.spec.initContainers[0].image).toBe(`${TO}/bo/init:1`);
    expect(rewriteImage('docker.io/library/postgres:17', FROM, TO)).toBe('docker.io/library/postgres:17');
  });

  it('lets the new cluster give services, claims and pull secrets what is its own', () => {
    const service = cleaned({ kind: 'Service', metadata: { name: 's' }, spec: { type: 'NodePort', clusterIP: '10.43.0.9', clusterIPs: ['10.43.0.9'], ports: [{ port: 80, nodePort: 30080 }] } }, FROM, TO) as any;
    expect(service.spec).toEqual({ type: 'NodePort', ports: [{ port: 80 }] });
    const claim = cleaned({ kind: 'PersistentVolumeClaim', metadata: { name: 'data', annotations: { 'pv.kubernetes.io/bind-completed': 'yes', keep: 'me' } }, spec: { volumeName: 'pvc-1', storageClassName: 'local-path', resources: { requests: { storage: '1Gi' } } } }, FROM, TO) as any;
    expect(claim.spec).toEqual({ resources: { requests: { storage: '1Gi' } } });
    expect(claim.metadata.annotations).toEqual({ keep: 'me' });
    const config = Buffer.from(JSON.stringify({ auths: { [FROM]: { auth: 'x' } } })).toString('base64');
    const pull = cleaned({ kind: 'Secret', type: 'kubernetes.io/dockerconfigjson', metadata: { name: 'pull', ownerReferences: [{ uid: 'gone' }] as never }, data: { '.dockerconfigjson': config } }, FROM, TO) as any;
    expect(JSON.parse(Buffer.from(pull.data['.dockerconfigjson'], 'base64').toString())).toEqual({ auths: { [TO]: { auth: 'x' } } });
    expect(pull.metadata.ownerReferences).toBeUndefined();
  });

  it('puts claims and settings first and workloads after them, and finds each claim\'s volume', () => {
    const objects: KubeObject[] = [{ kind: 'Deployment' }, { kind: 'IngressRoute' }, { kind: 'Service' }, { kind: 'PersistentVolumeClaim', metadata: { name: 'data' } }, { kind: 'Secret' }];
    expect(restoreOrder(objects).map((object) => object.kind)).toEqual(['PersistentVolumeClaim', 'Secret', 'Service', 'Deployment', 'IngressRoute']);
    expect(volumesOf(objects)).toEqual([{ claim: 'data' }]);
  });
});
