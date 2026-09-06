#!/usr/bin/env bash
# ensure-verdaccio.sh — in-cluster npm registry mirror (namespace koala-registry, service
# verdaccio — must match workspace-image-seeds.ts). Must run after ensure-cluster.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER_NAME="provisioning-lunorica"
CONTEXT="k3d-${CLUSTER_NAME}"
NAMESPACE="koala-registry"

KUBECTL="${ROOT}/bin/kubectl"
if [ ! -f "$KUBECTL" ] || ! "$KUBECTL" version --client >/dev/null 2>&1; then
  KUBECTL="kubectl"
fi

if ! "$KUBECTL" --context "$CONTEXT" get nodes >/dev/null 2>&1; then
  echo "  ❌  Management cluster (${CONTEXT}) not reachable — run ensure-cluster.sh first"
  exit 1
fi

echo "  ▶  Ensuring the in-cluster npm registry mirror is installed (kubectl apply is a cheap no-op when nothing changed)..."

"$KUBECTL" --context "$CONTEXT" apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: verdaccio-config
  namespace: ${NAMESPACE}
data:
  config.yaml: |
    storage: /verdaccio/storage

    uplinks:
      npmjs:
        url: https://registry.npmjs.org/
        timeout: 30s
        maxage: 2m
        cache: true

    packages:
      '@*/*':
        access: \$all
        publish: \$authenticated
        proxy: npmjs
      '**':
        access: \$all
        publish: \$authenticated
        proxy: npmjs

    auth:
      htpasswd:
        file: /verdaccio/storage/htpasswd
        max_users: -1

    log: { type: stdout, format: pretty-timestamped, level: warn }

    listen: 0.0.0.0:4873

    web:
      enable: true
      title: Koala package mirror
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: verdaccio-storage-pvc
  namespace: ${NAMESPACE}
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 20Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: verdaccio
  namespace: ${NAMESPACE}
  labels: { app: verdaccio }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: verdaccio } }
  template:
    metadata: { labels: { app: verdaccio } }
    spec:
      securityContext:
        runAsUser: 10001
        runAsGroup: 65533
        fsGroup: 65533
      containers:
        - name: verdaccio
          image: verdaccio/verdaccio:6
          command: ["/bin/sh", "-c"]
          args:
            - >-
              mkdir -p /verdaccio/conf &&
              cp /config-src/config.yaml /verdaccio/conf/config.yaml &&
              exec verdaccio --config /verdaccio/conf/config.yaml
          ports:
            - containerPort: 4873
          volumeMounts:
            - { name: storage, mountPath: /verdaccio/storage }
            - { name: config-src, mountPath: /config-src, readOnly: true }
            - { name: conf, mountPath: /verdaccio/conf }
          resources:
            limits: { memory: 1Gi, cpu: "1000m" }
            requests: { memory: 128Mi, cpu: "50m" }
          livenessProbe:
            httpGet: { path: /-/ping, port: 4873 }
            initialDelaySeconds: 20
            periodSeconds: 20
          readinessProbe:
            httpGet: { path: /-/ping, port: 4873 }
            initialDelaySeconds: 10
            periodSeconds: 10
      volumes:
        - { name: storage, persistentVolumeClaim: { claimName: verdaccio-storage-pvc } }
        - { name: config-src, configMap: { name: verdaccio-config } }
        - { name: conf, emptyDir: {} }
---
apiVersion: v1
kind: Service
metadata:
  name: verdaccio
  namespace: ${NAMESPACE}
spec:
  selector: { app: verdaccio }
  ports:
    - port: 4873
      targetPort: 4873
EOF

echo "  ▶  Waiting for the registry mirror to be ready..."
"$KUBECTL" --context "$CONTEXT" -n "$NAMESPACE" rollout status deployment/verdaccio --timeout=120s

echo "  ✅  npm registry mirror ready (verdaccio.${NAMESPACE}.svc.cluster.local:4873)"
