# syntax=docker/dockerfile:1
# @app/admin — Next.js standalone server (Part 10). Context: the repo root.
#   docker build -f apps/admin/Dockerfile -t randomchat-admin \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .
# Run time: ADMIN_EVIDENCE_ORIGIN = origin of presigned evidence URLs (CSP img-src).

FROM node:24.22.2-alpine3.24 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS prune
RUN npm install --global turbo@2.11.10
COPY . .
RUN turbo prune @app/admin --docker

FROM base AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG S3_PUBLIC_ENDPOINT=http://localhost:9000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL S3_PUBLIC_ENDPOINT=$S3_PUBLIC_ENDPOINT NEXT_OUTPUT=standalone
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@app/admin

FROM node:24.22.2-alpine3.24 AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/login > /dev/null || exit 1
CMD ["node", "apps/admin/server.js"]
