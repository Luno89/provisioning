FROM node:22-bookworm-slim AS tools
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /tools
ARG KUBECTL_VERSION=v1.36.2
ARG HELM_VERSION=v3.15.1
ARG K3D_VERSION=v5.6.3
ARG TERRAFORM_VERSION=1.9.0
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" -o kubectl && \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" | tar -xz --strip-components=1 "linux-${ARCH}/helm" && \
    curl -fsSL "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-linux-${ARCH}" -o k3d && \
    curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${ARCH}.zip" -o terraform.zip && \
    unzip -q terraform.zip terraform && rm terraform.zip && \
    cp helm helm-linux && chmod +x kubectl helm helm-linux k3d terraform

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts/fix-dnd-kit-hoisting.js ./scripts/
COPY --chown=node:node apps/backend/package.json apps/backend/
COPY --chown=node:node apps/frontend/package.json apps/frontend/
COPY --chown=node:node apps/local-agent/package.json apps/local-agent/
COPY --chown=node:node packages/agent-engine/package.json packages/agent-engine/
COPY --chown=node:node packages/cdktf-infra/package.json packages/cdktf-infra/
COPY --chown=node:node packages/context-engine/package.json packages/context-engine/
COPY --chown=node:node packages/engine-core/package.json packages/engine-core/
COPY --chown=node:node packages/harness-types/package.json packages/harness-types/
RUN npm ci

FROM deps AS source
COPY --chown=node:node . .
COPY --chown=node:node --from=tools /tools/ ./bin/

FROM source AS frontend
RUN npm run build -w apps/frontend

FROM source
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client openssl tini && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint
USER node
COPY --chown=node:node --from=frontend /app/apps/frontend/dist ./apps/frontend/dist
RUN mkdir -p apps/backend/data/logs
ENV NODE_ENV=production PATH="/app/bin:${PATH}"
EXPOSE 3001
ENTRYPOINT ["tini", "--", "entrypoint"]
CMD ["backend"]
