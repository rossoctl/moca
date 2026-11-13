# Stage 1: install + build pi-fork
FROM node:24-alpine AS builder
RUN apk add --no-cache build-base python3 pkgconfig pixman-dev cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Copy workspace manifests for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/session-backend/package.json ./packages/session-backend/
COPY packages/k8s-sandbox/package.json ./packages/k8s-sandbox/
COPY packages/knative-server/package.json ./packages/knative-server/
COPY packages/sandbox-relay/package.json ./packages/sandbox-relay/
COPY packages/ibac-stub/package.json ./packages/ibac-stub/
COPY packages/control-plane/package.json ./packages/control-plane/
COPY packages/supervisor/package.json ./packages/supervisor/
COPY packages/provisioner/package.json ./packages/provisioner/
COPY packages/config-bundle/package.json ./packages/config-bundle/
COPY packages/work-queue/package.json ./packages/work-queue/
COPY harness/package.json ./harness/

# Copy pi-fork (uses npm, not pnpm — has its own package-lock.json)
COPY pi-fork/ ./pi-fork/

# Install pi-fork deps (provides tsgo, tsx, etc.)
WORKDIR /app/pi-fork
RUN npm ci
WORKDIR /app

# Install pnpm workspace deps (links to pi-fork via relative paths)
RUN pnpm install --frozen-lockfile

# Copy workspace source
COPY packages/ ./packages/
COPY harness/ ./harness/

# Build pi-fork (required order per M1 gotcha; uses npm since pi-fork is an npm workspace)
WORKDIR /app/pi-fork
RUN npm run build -w packages/ai && \
    npm run build -w packages/agent && \
    npm run build -w packages/tui && \
    npm run build -w packages/coding-agent
WORKDIR /app

# The test runner is not shipped. vitest 2 pulls vite 5, whose esbuild 0.21.5 binary is built with
# Go 1.20.12 (CVE-2024-24790, critical), and a cluster admission policy that blocks images with old
# critical CVEs (RHACS "Block Critical CVE older than 180 days") then refuses every deployment of
# the image, rollbacks included. Nothing at runtime imports vite or vitest; tsx brings its own,
# current esbuild. The check fails the build if an esbuild older than 0.25 is still in the tree.
RUN rm -rf node_modules/.pnpm/vite@* node_modules/.pnpm/vite-node@* node_modules/.pnpm/vitest@* \
      node_modules/.pnpm/@vitest+* node_modules/.pnpm/esbuild@0.21.* node_modules/.pnpm/@esbuild+*@0.21.* && \
    test -z "$(find node_modules/.pnpm -maxdepth 1 \( -name 'esbuild@0.2[0-4].*' -o -name '@esbuild+*@0.2[0-4].*' \))"

# Stage 2: slim runtime
FROM node:24-alpine
# kubectl is spawned by the control plane's K8sSecretStore on deploy/k8s
# (packages/control-plane/src/kubectl.ts), so the runtime image must carry it.
RUN apk add --no-cache kubectl cairo pango libjpeg-turbo giflib librsvg pixman
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
# The file credential store's directory (SH_CREDENTIAL_STORE=file, deploy/compose). Created here,
# owned by the uid every compose service runs as, because a fresh named volume mounted over it
# copies this ownership -- a path the image lacks would be created root-owned and unwritable.
RUN mkdir -p /var/lib/moca/credentials && \
    chown 1000:1000 /var/lib/moca/credentials && \
    chmod 0700 /var/lib/moca/credentials
# The git tag (or sha) this image was built from, advertised by the control plane's /v1/discovery
# and the harness's /health so clients can show it. Build with --build-arg MOCA_VERSION=<tag>.
# Declared last: an ARG's value keys the cache of every RUN below it, so declaring it earlier
# would rebuild those layers on every version change.
ARG MOCA_VERSION=dev
ENV MOCA_VERSION=${MOCA_VERSION}
EXPOSE 8080
WORKDIR /app/packages/knative-server
# Default entrypoint: the HTTP server (package name historical — ADR-0041). The P6 supervisor
# forks src/worker.ts instead (deploy/vm, deploy/k8s, deploy/compose).
CMD ["node", "--import", "tsx", "src/server.ts"]
