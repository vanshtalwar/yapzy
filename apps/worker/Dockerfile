# syntax=docker/dockerfile:1
# @app/worker — multi-stage build (Part 10). Context: the repo root (see infra/docker/docker-compose.yml).
#   docker build -f apps/worker/Dockerfile -t randomchat-worker .
# Configuration comes from the environment at run time (no .env in the image).

FROM node:26.12.1-alpine3.24 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Only the workspace packages worker depends on (turbo prune keeps the pnpm catalog).
FROM base AS prune
RUN npm install --global turbo@2.11.10
COPY . .
RUN turbo prune @app/worker --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /repo/out/full/ .
# tsup bundles the workspace packages into dist/; npm dependencies stay external.
RUN pnpm turbo run build --filter=@app/worker
# Production dependencies only. @prisma/client's optional `prisma` peer (CLI, Studio, schema
# engines) comes along from the workspace lockfile; the runtime uses the query compiler and
# the pg driver adapter, so that tree is dropped.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @app/worker deploy --prod --store-dir /pnpm/store /prod/worker \
 && cd /prod/worker/node_modules/.pnpm \
 && rm -rf prisma@* @prisma+studio-core@* @prisma+engines@* @prisma+dev@* @electric-sql+pglite@* effect@*

FROM node:26.12.1-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/worker/package.json ./
COPY --from=build --chown=node:node /prod/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /prod/worker/dist ./dist
USER node
EXPOSE 4002
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4002/health > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/server.js"]
